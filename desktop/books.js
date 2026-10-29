'use strict';

// Reads audiobooks from disk for the player window:
//   a folder of chapter files (with or without book.json from the voice-clone tool or the converter),
//   a single audiobook file, usually M4B, with its chapters marked inside,
//   or a library folder holding many of these.
// A book is { id, path, title, author, coverUrl, chapters: [{ title, url, textUrl?, duration, start?, end? }] }.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const AUDIO = /\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac|webm)$/i;
const SINGLE_BOOK = /\.m4b$/i; // each M4B file is a whole book
const COVER = /^(cover|folder|front)\.(jpe?g|png|webp)$/i;
const IMAGE = /\.(jpe?g|png|webp)$/i;
const MAX_DEPTH = 3; // how deep library folders are searched (Author / Book / files)
const MAX_BOOKS = 2000;

let metadata = null; // music-metadata is an ES module
async function tags(file, options) {
  metadata ||= await import('music-metadata');
  try {
    return await metadata.parseFile(file, { skipCovers: true, ...options });
  } catch {
    return null; // a damaged or unusual file: use its name instead
  }
}

const url = file => `app://disk/${encodeURIComponent(file)}`;
const idOf = target => `disk:${path.resolve(target).toLowerCase()}`;
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const prettyName = name => name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(e => !e.name.startsWith('.'));
  } catch {
    return [];
  }
}

// A cover built into an audio file is saved once, so the window can show it.
function saveCover(picture, cacheDir, key) {
  if (!picture?.data) return null;
  const ext = /png/i.test(picture.format) ? 'png' : 'jpg';
  const folder = path.join(cacheDir, 'covers');
  const file = path.join(folder, `${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}.${ext}`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(file, picture.data);
  }
  return url(file);
}

// One file holding a whole book: its chapter markers become the chapters.
async function readFile(file, cacheDir) {
  const info = await tags(file, { includeChapters: true, skipCovers: false, duration: true });
  const total = info?.format.duration || 0;
  const common = info?.common || {};
  const marks = (info?.format.chapters || [])
    .map(c => ({ title: c.title, start: c.start / (c.timeScale || 1), end: c.end != null ? c.end / (c.timeScale || 1) : null }))
    .filter(c => Number.isFinite(c.start))
    .sort((a, b) => a.start - b.start);
  let chapters;
  if (marks.length > 1) {
    chapters = marks.map((c, i) => {
      const end = c.end || marks[i + 1]?.start || total || null;
      return { title: c.title || `Chapter ${i + 1}`, url: url(file), start: c.start, end, duration: end ? end - c.start : 0 };
    });
  } else {
    chapters = [{ title: common.title || prettyName(path.basename(file)), url: url(file), duration: total }];
  }
  return {
    id: idOf(file),
    path: file,
    title: common.album || common.title || prettyName(path.basename(file)),
    author: common.albumartist || common.artist || '',
    coverUrl: saveCover(common.picture?.[0], cacheDir, file),
    chapters,
  };
}

// A folder of chapter files. Uses book.json (from the voice-clone tool or the converter) when there is one.
async function readFolder(dir, cacheDir) {
  const entries = listDir(dir).filter(e => e.isFile());
  const names = entries.map(e => e.name);
  const audio = names.filter(n => AUDIO.test(n) && !SINGLE_BOOK.test(n)).sort(natural);
  if (!audio.length) {
    const single = names.filter(n => SINGLE_BOOK.test(n)).sort(natural)[0];
    return single ? readFile(path.join(dir, single), cacheDir) : null;
  }

  let manifest = {};
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'book.json'), 'utf8'));
  } catch {
    // No book.json: use the files' names and tags.
  }
  const listed = Array.isArray(manifest.chapters) ? manifest.chapters.filter(c => audio.includes(c.file)) : [];
  const order = listed.map(c => c.file).concat(audio.filter(n => !listed.some(c => c.file === n)));
  const has = name => name && names.includes(name);

  const firstTags = await tags(path.join(dir, order[0]), { skipCovers: false });
  const chapters = [];
  for (const name of order) {
    const entry = listed.find(c => c.file === name) || {};
    const file = path.join(dir, name);
    const info = entry.duration && entry.title ? null : await tags(file, { duration: false });
    const text = has(entry.text) ? entry.text : has(name.replace(/\.[^.]+$/, '.json')) ? name.replace(/\.[^.]+$/, '.json') : null;
    chapters.push({
      title: entry.title || info?.common.title || prettyName(name),
      url: url(file),
      textUrl: text ? url(path.join(dir, text)) : null,
      duration: entry.duration || info?.format.duration || 0,
    });
  }

  const coverName = has(manifest.cover) ? manifest.cover : names.find(n => COVER.test(n)) || names.find(n => IMAGE.test(n));
  return {
    id: idOf(dir),
    path: dir,
    title: manifest.title || firstTags?.common.album || path.basename(dir),
    author: manifest.author || firstTags?.common.albumartist || firstTags?.common.artist || '',
    coverUrl: coverName ? url(path.join(dir, coverName)) : saveCover(firstTags?.common.picture?.[0], cacheDir, dir),
    chapters,
  };
}

// Opens whatever was double-clicked, dropped or picked: a folder, a book file, or one chapter file of a
// book (then the whole book opens at that chapter: startChapter).
async function read(target, cacheDir) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return readFolder(target, cacheDir);
  if (!AUDIO.test(target)) return null;
  if (!SINGLE_BOOK.test(target)) {
    const dir = path.dirname(target);
    const siblings = listDir(dir).filter(e => e.isFile() && AUDIO.test(e.name) && !SINGLE_BOOK.test(e.name));
    if (siblings.length > 1 || fs.existsSync(path.join(dir, 'book.json'))) {
      const book = await readFolder(dir, cacheDir);
      if (book) {
        const index = book.chapters.findIndex(c => c.url === url(target));
        return { ...book, startChapter: Math.max(0, index) };
      }
    }
  }
  return readFile(target, cacheDir);
}

// Every book in the library folders: folders of chapter files, and each M4B file on its own.
async function scan(folders, cacheDir) {
  const found = [];
  async function visit(dir, depth) {
    if (found.length >= MAX_BOOKS) return;
    const entries = listDir(dir);
    const files = entries.filter(e => e.isFile()).map(e => e.name);
    if (files.some(n => AUDIO.test(n) && !SINGLE_BOOK.test(n))) {
      const book = await readFolder(dir, cacheDir);
      if (book) found.push(book);
    }
    for (const name of files.filter(n => SINGLE_BOOK.test(n)).sort(natural)) {
      found.push(await readFile(path.join(dir, name), cacheDir));
    }
    if (depth < MAX_DEPTH) {
      for (const sub of entries.filter(e => e.isDirectory()).map(e => e.name).sort(natural)) {
        await visit(path.join(dir, sub), depth + 1);
      }
    }
  }
  for (const folder of folders) await visit(folder, 0);
  return found;
}

module.exports = { read, scan };
