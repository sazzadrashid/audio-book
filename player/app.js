'use strict';

// Audio Book player.
// Books you add or make are stored in this browser (IndexedDB), so nothing is uploaded.
// Books made with the command-line converter and published with the site are listed in books/index.json.

const DB_NAME = 'audio-book';
const DB_VERSION = 2;
const SKIP_BACK = 15;
const SKIP_FORWARD = 30;
const SAVE_EVERY_MS = 5000;
const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac|webm)$/i;
const COVER_NAME = /^(cover|folder|front)\.(jpe?g|png|webp)$/i;

const $ = id => document.getElementById(id);
const audio = $('audio');

// ---------- Storage (IndexedDB) ----------

const dbPromise = new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    // jobs: the text of books still being turned into audio, so making them can continue later.
    for (const name of ['books', 'files', 'jobs']) {
      if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

function done(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function objectStore(name, mode = 'readonly') {
  const db = await dbPromise;
  return db.transaction(name, mode).objectStore(name);
}

const db = {
  allBooks: async () => done((await objectStore('books')).getAll()),
  getBook: async id => done((await objectStore('books')).get(id)),
  putBook: async book => done((await objectStore('books', 'readwrite')).put(book)),
  getFile: async id => done((await objectStore('files')).get(id)),
  putFile: async rec => done((await objectStore('files', 'readwrite')).put(rec)),
  getJob: async id => done((await objectStore('jobs')).get(id)),
  putJob: async job => done((await objectStore('jobs', 'readwrite')).put(job)),
  deleteJob: async id => done((await objectStore('jobs', 'readwrite')).delete(id)),
  // Read, change and save a book in one step, so two changes at once can't overwrite each other.
  async updateBook(id, change) {
    const conn = await dbPromise;
    const t = conn.transaction('books', 'readwrite');
    const store = t.objectStore('books');
    let book;
    store.get(id).onsuccess = e => {
      book = e.target.result;
      if (book) {
        change(book);
        store.put(book);
      }
    };
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve(book);
      t.onerror = () => reject(t.error);
    });
  },
  async deleteBook(book) {
    const conn = await dbPromise;
    const t = conn.transaction(['books', 'files', 'jobs'], 'readwrite');
    t.objectStore('books').delete(book.id);
    t.objectStore('jobs').delete(book.id);
    for (const ch of book.chapters) {
      if (ch.fileId) t.objectStore('files').delete(ch.fileId);
      if (ch.textFileId) t.objectStore('files').delete(ch.textFileId);
    }
    if (book.coverId) t.objectStore('files').delete(book.coverId);
    return new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  },
};

// ---------- Helpers ----------

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  seconds = Math.floor(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function formatLong(seconds) {
  if (seconds < 30) return 'less than 1 min';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  return `${m} min`;
}

function safeFileName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f#%]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[ .]+$/, '').slice(0, 60) || 'audiobook';
}

function prettyName(fileName) {
  return fileName.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function hueOf(text) {
  let hash = 0;
  for (const c of text) hash = (hash * 31 + c.codePointAt(0)) | 0;
  return Math.abs(hash) % 360;
}

// A cover for books without one: a deep gradient in a colour made from the title.
function colorFor(text) {
  const hue = hueOf(text);
  return `linear-gradient(150deg, hsl(${hue} 55% 46%), hsl(${(hue + 35) % 360} 60% 22%))`;
}

function initialOf(text) {
  return ([...text.trim()][0] || '?').toUpperCase();
}

let toastTimer;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

function readDuration(src) {
  return new Promise(resolve => {
    const probe = new Audio();
    const finish = d => {
      clearTimeout(timer);
      probe.removeAttribute('src');
      resolve(Number.isFinite(d) ? d : 0);
    };
    const timer = setTimeout(() => finish(0), 15000);
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => finish(probe.duration);
    probe.onerror = () => finish(0);
    probe.src = src;
  });
}

function totalDuration(book) {
  return book.chapters.reduce((sum, ch) => sum + (ch.duration || 0), 0);
}

function listenedSeconds(book) {
  const pos = book.position || { chapter: 0, time: 0 };
  if (book.finished) return totalDuration(book);
  let sum = 0;
  for (let i = 0; i < pos.chapter && i < book.chapters.length; i++) sum += book.chapters[i].duration || 0;
  return sum + (pos.time || 0);
}

// Object URLs for covers stored in IndexedDB, reused between renders.
const coverUrls = new Map();
async function coverUrl(book) {
  if (book.coverUrl) return book.coverUrl;
  if (!book.coverId) return null;
  if (coverUrls.has(book.coverId)) return coverUrls.get(book.coverId);
  const rec = await db.getFile(book.coverId);
  if (!rec) return null;
  const url = URL.createObjectURL(rec.blob);
  coverUrls.set(book.coverId, url);
  return url;
}

// ---------- Adding books ----------

// Each item is { file, path }. Audio files in the same folder become one book.
async function importItems(items) {
  const groups = new Map();
  for (const item of items) {
    const dir = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(item.file);
  }

  let added = 0;
  for (const [dir, files] of groups) {
    const audioFiles = files.filter(f => AUDIO_EXT.test(f.name) || f.type.startsWith('audio/'));
    if (!audioFiles.length) continue;
    toast(`Adding ${audioFiles.length} file${audioFiles.length > 1 ? 's' : ''}…`);
    await importBook(dir, files, audioFiles);
    added++;
  }

  if (!added) {
    toast('No audio files found. Pick MP3, M4A, M4B or similar files.');
    return;
  }
  toast(added === 1 ? 'Book added to your library.' : `${added} books added to your library.`);
  navigator.storage?.persist?.();
  await renderLibrary();
}

async function importBook(dir, files, audioFiles) {
  let manifest = {};
  const manifestFile = files.find(f => f.name.toLowerCase() === 'book.json');
  if (manifestFile) {
    try {
      manifest = JSON.parse(await manifestFile.text());
    } catch {
      toast('book.json could not be read, so file names are used instead.');
    }
  }

  // Use the chapter order from book.json when there is one, otherwise sort by file name.
  const byName = new Map(audioFiles.map(f => [f.name, f]));
  const allByName = new Map(files.map(f => [f.name, f]));
  // A chapter's text for reading along: named in book.json, or a .json file with the audio file's name.
  const textFor = (file, name) => allByName.get(name) || allByName.get(file.name.replace(/\.[^.]+$/, '.json')) || null;
  let ordered = [];
  if (Array.isArray(manifest.chapters)) {
    for (const ch of manifest.chapters) {
      const file = byName.get(ch.file);
      if (file) {
        ordered.push({ file, title: ch.title, text: textFor(file, ch.text) });
        byName.delete(ch.file);
      }
    }
  }
  const rest = [...byName.values()].sort((a, b) => naturalCompare(a.name, b.name));
  ordered = ordered.concat(rest.map(file => ({ file, title: null, text: textFor(file) })));

  const folderName = dir ? dir.split('/').pop() : '';
  const fallbackTitle = folderName || (ordered.length === 1 ? prettyName(ordered[0].file.name) : 'New audiobook');

  const book = {
    id: newId(),
    title: manifest.title || fallbackTitle,
    author: manifest.author || '',
    chapters: [],
    position: { chapter: 0, time: 0 },
    rate: 1,
    finished: false,
    addedAt: Date.now(),
    lastPlayedAt: 0,
  };

  for (const { file, title, text } of ordered) {
    const fileId = newId();
    await db.putFile({ id: fileId, blob: file });
    const url = URL.createObjectURL(file);
    const duration = await readDuration(url);
    URL.revokeObjectURL(url);
    const chapter = { title: title || prettyName(file.name), fileId, duration };
    if (text) {
      chapter.textFileId = newId();
      await db.putFile({ id: chapter.textFileId, blob: text });
    }
    book.chapters.push(chapter);
  }

  const cover = files.find(f => COVER_NAME.test(f.name)) || files.find(f => f.type.startsWith('image/'));
  if (cover) {
    book.coverId = newId();
    await db.putFile({ id: book.coverId, blob: cover });
  }

  await db.putBook(book);
}

// Books published with the website (made by the converter) are listed in books/index.json.
async function loadPublishedBooks() {
  let index;
  try {
    const res = await fetch('books/index.json', { cache: 'no-cache' });
    if (!res.ok) return;
    index = await res.json();
  } catch {
    return; // No published books, or the page was opened straight from disk.
  }

  for (const entry of index.books || []) {
    const id = `site:${entry.id}`;
    const saved = (await db.getBook(id)) || {};
    const base = `books/${entry.id}/`;
    await db.putBook({
      position: { chapter: 0, time: 0 },
      rate: 1,
      finished: false,
      addedAt: Date.now(),
      lastPlayedAt: 0,
      ...saved,
      id,
      published: true,
      title: entry.title,
      author: entry.author || '',
      coverUrl: entry.cover ? base + entry.cover : null,
      chapters: entry.chapters.map(ch => ({
        title: ch.title,
        url: base + encodeURIComponent(ch.file),
        textUrl: ch.text ? base + encodeURIComponent(ch.text) : null,
        duration: ch.duration || 0,
      })),
    });
  }
}

async function itemsFromDrop(dataTransfer) {
  const entries = [...dataTransfer.items]
    .map(item => item.webkitGetAsEntry?.())
    .filter(Boolean);
  if (!entries.length) return [...dataTransfer.files].map(file => ({ file, path: file.name }));

  const items = [];
  async function walk(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      items.push({ file, path: prefix + file.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      } while (batch.length);
    }
  }
  for (const entry of entries) await walk(entry, '');
  return items;
}

// ---------- Library view ----------

const SORT_KEY = 'audio-book.sort';
const SORTS = {
  recent: (a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0) || b.addedAt - a.addedAt,
  added: (a, b) => b.addedAt - a.addedAt,
  title: (a, b) => naturalCompare(a.title, b.title),
  author: (a, b) => naturalCompare(a.author || '~', b.author || '~') || naturalCompare(a.title, b.title),
};

function playIcon() {
  const span = document.createElement('span');
  span.className = 'cover-play';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  return span;
}

let libraryRenders = 0;
async function renderLibrary() {
  // Two redraws can overlap (start-up and the desktop app's folder scan): only the newest one is shown.
  const token = ++libraryRenders;
  renderStats();
  const all = await db.allBooks();
  const query = $('lib-search').value.trim().toLowerCase();
  const books = all
    .filter(b => !query || `${b.title} ${b.author || ''}`.toLowerCase().includes(query))
    .sort(SORTS[$('lib-sort').value] || SORTS.recent);

  const items = [];
  for (const book of books) {
    const total = totalDuration(book);
    const listened = listenedSeconds(book);
    const pct = total ? Math.min(100, (listened / total) * 100) : 0;

    const li = document.createElement('li');
    const card = document.createElement('article');
    card.className = 'book-card';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'book-open';
    open.setAttribute('aria-label', `Open ${book.title}`);
    open.addEventListener('click', () => openBook(book.id));

    const cover = document.createElement('span');
    cover.className = 'thumb';
    await showCover(cover, book);
    cover.append(playIcon());

    const info = document.createElement('span');
    info.className = 'book-info';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = book.title;
    const meta = document.createElement('span');
    meta.className = 'meta';
    const ready = book.chapters.filter(ch => ch.fileId || ch.url).length;
    meta.textContent = book.making
      ? `Making audio: ${ready} of ${book.chapters.length} chapters`
      : book.finished
        ? 'Finished'
        : listened > 0
          ? `${formatLong(Math.max(0, total - listened))} left`
          : [book.author, total ? formatLong(total) : ''].filter(Boolean).join(' · ');
    info.append(title, meta);
    if (listened > 0 || book.making) {
      const bar = document.createElement('span');
      bar.className = 'bar';
      const fill = document.createElement('span');
      fill.style.width = `${book.making ? (ready / book.chapters.length) * 100 : pct}%`;
      if (book.making) bar.classList.add('making');
      bar.append(fill);
      info.append(bar);
    }
    open.append(cover, info);

    // Less common actions sit in a "more" menu, so the shelf stays calm.
    const menu = document.createElement('details');
    menu.className = 'card-menu';
    const summary = document.createElement('summary');
    summary.setAttribute('aria-label', `More for ${book.title}`);
    summary.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"/></svg>';
    const actions = document.createElement('div');
    actions.className = 'menu';
    const action = (label, handler, className = '') => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.className = className;
      btn.addEventListener('click', () => {
        menu.open = false;
        handler();
      });
      actions.append(btn);
    };
    if (!book.published && !book.onDisk && ready) action('Download MP3 files', () => downloadBook(book.id));
    // Books in the desktop app play from their folder on disk (desktop.js).
    if (book.onDisk && window.desktop) action('Show in folder', () => window.desktop.showInFolder(book.path));
    action('Rename', () => renameBook(book.id));
    if (!book.published) action('Remove', () => removeBook(book.id), 'delete');
    menu.append(summary, actions);
    card.append(open, menu);

    if (book.making && !Converter.isMaking(book.id)) {
      const resume = document.createElement('button');
      resume.type = 'button';
      resume.className = 'btn primary card-continue';
      resume.textContent = 'Continue making';
      resume.addEventListener('click', () => Converter.resume(book.id));
      card.append(resume);
    }
    if (book.published) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'Online';
      card.append(badge);
    }
    li.append(card);
    items.push(li);
  }
  const hero = await renderContinue(all);
  if (token !== libraryRenders) return;
  $('empty').hidden = all.length > 0;
  $('lib-tools').hidden = all.length < 2;
  $('no-match').hidden = !all.length || books.length > 0;
  $('continue').replaceChildren(...hero);
  $('continue').hidden = !hero.length;
  $('books').replaceChildren(...items);
}

// The book you're in the middle of, big, in its own colours, with a Resume button.
async function renderContinue(all) {
  const book = [...all]
    .filter(b => b.lastPlayedAt && !b.finished && !b.making && b.chapters.length)
    .sort(SORTS.recent)[0];
  if (!book) return [];
  const total = totalDuration(book);
  const listened = listenedSeconds(book);
  const chapter = book.chapters[Math.min(book.position?.chapter || 0, book.chapters.length - 1)];
  applyTone($('continue'), await toneOf(book));

  const cover = document.createElement('button');
  cover.type = 'button';
  cover.className = 'hero-cover';
  cover.setAttribute('aria-label', `Open ${book.title}`);
  await showCover(cover, book);
  cover.addEventListener('click', () => openBook(book.id));

  const info = document.createElement('div');
  info.className = 'hero-info';
  const eyebrow = document.createElement('span');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = 'Continue listening';
  const title = document.createElement('h3');
  title.textContent = book.title;
  const author = document.createElement('p');
  author.className = 'hero-author';
  author.textContent = book.author || '';
  const meta = document.createElement('p');
  meta.className = 'hero-meta';
  meta.textContent = [chapter?.title, total ? `${formatLong(Math.max(0, total - listened) / (book.rate || 1))} left` : ''].filter(Boolean).join(' · ');
  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('div');
  fill.style.width = `${total ? Math.min(100, (listened / total) * 100) : 0}%`;
  bar.append(fill);
  const resume = document.createElement('button');
  resume.type = 'button';
  resume.className = 'btn hero-play';
  resume.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg> Resume';
  resume.addEventListener('click', async () => {
    await openBook(book.id);
    play();
  });
  info.append(eyebrow, title, author, meta, bar, resume);
  return [cover, info];
}

async function renameBook(id) {
  const old = await db.getBook(id);
  const title = prompt('Book title', old.title);
  if (title === null) return;
  const author = prompt('Author (optional)', old.author || '');
  const book = await db.updateBook(id, b => {
    b.title = title.trim() || b.title;
    if (author !== null) b.author = author.trim();
    b.renamed = true; // keep the new name when the desktop app reads the folder again
  });
  if (current?.id === id) {
    current.title = book.title;
    current.author = book.author;
    renderPlayerHeader();
  }
  await renderLibrary();
}

// Save all chapters of a book as MP3 files in one .zip file.
async function downloadBook(id) {
  const book = await db.getBook(id);
  const width = Math.max(2, String(book.chapters.length).length);
  const zip = new JSZip();
  const folder = zip.folder(safeFileName(book.title));
  toast('Preparing the download\u2026');
  const chapters = [];
  for (const [i, ch] of book.chapters.entries()) {
    if (!ch.fileId) continue;
    const rec = await db.getFile(ch.fileId);
    if (!rec) continue;
    const ext = (rec.blob.name || '').match(/\.[a-z0-9]+$/i)?.[0] || '.mp3';
    const file = `${String(i + 1).padStart(width, '0')} - ${safeFileName(ch.title)}${ext}`;
    folder.file(file, rec.blob, { compression: 'STORE' });
    const entry = { title: ch.title, file, duration: ch.duration || 0 };
    const textRec = ch.textFileId && (await db.getFile(ch.textFileId));
    if (textRec) {
      entry.text = file.replace(/\.[^.]+$/, '.json');
      folder.file(entry.text, textRec.blob);
    }
    chapters.push(entry);
  }
  let cover = null;
  if (book.coverId) {
    const rec = await db.getFile(book.coverId);
    if (rec) {
      cover = `cover.${(rec.blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg')}`;
      folder.file(cover, rec.blob, { compression: 'STORE' });
    }
  }
  // book.json lets the player (and the command-line converter) read the chapter names back.
  folder.file('book.json', JSON.stringify({ title: book.title, author: book.author, cover, chapters }, null, 2));
  const blob = await zip.generateAsync({ type: 'blob' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${safeFileName(book.title)}.zip`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60000);
}

async function removeBook(id) {
  const book = await db.getBook(id);
  const question = book.onDisk
    ? `Remove "${book.title}" from the library? Its files stay on your computer.`
    : `Remove "${book.title}" from this device? This can't be undone.`;
  if (!confirm(question)) return;
  Converter.stop(id);
  if (current?.id === id) closeBook();
  if (book.coverId && coverUrls.has(book.coverId)) {
    URL.revokeObjectURL(coverUrls.get(book.coverId));
    coverUrls.delete(book.coverId);
  }
  await db.deleteBook(book);
  document.dispatchEvent(new CustomEvent('book-removed', { detail: book.id }));
  toast('Book removed.');
  await renderLibrary();
}

// ---------- Player ----------

let current = null; // the open book
let chapterUrl = null; // object URL for the current chapter (local books)
let loadToken = 0;
let lastSave = 0;
let seeking = false;
let waitingForChapter = null; // chapter to play as soon as it has been made
let lastTab = 'library';
let pausedAt = null; // when playback was paused, for smart rewind
const VIEW_KEY = 'audio-book.view';
const textCache = new Map(); // chapter timing files of the open book, by chapter index

// The chapter's text and timings for reading along (its timing file), or null if it has none.
async function chapterText(index) {
  if (!current) return null;
  const key = `${current.id}:${index}`;
  if (!textCache.has(key)) {
    const ch = current.chapters[index];
    textCache.set(key, (async () => {
      try {
        if (ch?.textFileId) return JSON.parse(await (await db.getFile(ch.textFileId)).blob.text());
        if (ch?.textUrl) {
          const res = await fetch(ch.textUrl);
          return res.ok ? await res.json() : null;
        }
      } catch {
        // A damaged or missing file: the chapter can still be listened to.
      }
      return null;
    })());
  }
  return textCache.get(key);
}

async function showChapterText(index) {
  const data = await chapterText(index);
  if (!current || current.position.chapter !== index) return;
  const ch = current.chapters[index];
  Reader.show(data, ch.duration || chapterLength(), ch.title);
  $('view-read').classList.toggle('no-text', !data);
}

// A chapter is usually a whole audio file, but can also be part of one: an M4B audiobook keeps all its
// chapters in one file, with { start, end } in seconds. Times in the player are within the chapter.
function chapterStart() {
  return current?.chapters[current.position.chapter]?.start || 0;
}

function chapterTime() {
  return Math.max(0, (audio.currentTime || 0) - chapterStart());
}

function chapterLength() {
  const ch = current?.chapters[current.position.chapter];
  if (ch?.end) return ch.end - (ch.start || 0);
  return Number.isFinite(audio.duration) ? Math.max(0, audio.duration - (ch?.start || 0)) : 0;
}

// Moves to `time` in the current chapter, e.g. after a click on a word.
function seekTo(time) {
  if (!Number.isFinite(time)) return;
  pausedAt = null;
  audio.currentTime = chapterStart() + Math.max(0, time);
  Reader.sync(chapterTime());
}

// Moves to a spot anywhere in the book (search results, bookmarks).
function jumpTo(chapter, time) {
  if (!current) return;
  if (chapter === current.position.chapter && audio.src) seekTo(time);
  else loadChapter(chapter, time, !audio.paused);
}

function isReading() {
  return $('player').classList.contains('reading');
}

// The player's side panel shows one of: 'read' (read along), 'chapters' or 'marks' (bookmarks and quotes).
let panel = 'chapters';
function setPanel(tab) {
  panel = tab;
  const reading = tab === 'read';
  $('player').classList.toggle('reading', reading);
  $('reader').hidden = !reading;
  $('chapters').hidden = tab !== 'chapters';
  $('marks').hidden = tab !== 'marks';
  $('view-read').setAttribute('aria-pressed', String(reading));
  $('tab-chapters').setAttribute('aria-pressed', String(tab === 'chapters'));
  $('tab-marks').setAttribute('aria-pressed', String(tab === 'marks'));
  try {
    localStorage.setItem(VIEW_KEY, tab);
  } catch {
    // Not remembered in private browsing.
  }
  if (!reading) setFocus(false);
  if (reading && current) {
    Reader.sync(chapterTime(), true);
    Reader.follow();
    Reader.loop();
  }
}

function setReading(on) {
  setPanel(on ? 'read' : panel === 'read' ? 'chapters' : panel);
}

function showList(which) {
  setPanel(which);
}

// Focus: only the text, with the player bar at the bottom.
function setFocus(on) {
  $('player').classList.toggle('focus', on);
  $('focus-toggle').setAttribute('aria-pressed', String(on));
  updateNowPlaying();
  if (on) Reader.follow();
}

const VIEW_TITLES = { library: 'Library', convert: 'Make audiobook', player: 'Now playing' };

function showView(view) {
  const inPlayer = view === 'player';
  if (!inPlayer) lastTab = view;
  for (const name of ['library', 'convert', 'player']) $(name).hidden = name !== view;
  $('back').hidden = !inPlayer;
  $('heading').textContent = VIEW_TITLES[view];
  for (const tab of document.querySelectorAll('#tabs button')) {
    if (tab.dataset.view === view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  updateNowPlaying();
  window.scrollTo(0, 0);
}

// Called by the converter each time a chapter of a book has been made.
async function chapterReady(bookId, index) {
  if (current?.id !== bookId) return;
  const book = await db.getBook(bookId);
  if (!book || current?.id !== bookId) return;
  current.chapters[index] = book.chapters[index];
  current.making = book.making;
  renderChapters();
  updateTimes();
  if (waitingForChapter === index) {
    waitingForChapter = null;
    loadChapter(index, 0, true);
  }
}

async function openBook(id) {
  if (current?.id === id) {
    showView('player');
    return;
  }
  if (current) await saveProgress();
  const book = await db.getBook(id);
  if (!book) return;
  if (!book.chapters.length) {
    toast('This book has no chapters.');
    return;
  }
  current = book;
  if (book.finished) {
    book.finished = false;
    book.position = { chapter: 0, time: 0 };
  }
  textCache.clear();
  Reader.clear();
  renderPlayerHeader();
  renderChapters();
  renderMarks();
  showView('player');
  let view = 'chapters';
  try {
    view = localStorage.getItem(VIEW_KEY) || 'chapters';
  } catch {
    // Private browsing: start with the chapters.
  }
  setPanel(['read', 'chapters', 'marks'].includes(view) ? view : 'chapters');
  history.pushState({ view: 'player' }, '');
  const pos = book.position || { chapter: 0, time: 0 };
  await loadChapter(Math.min(pos.chapter, book.chapters.length - 1), pos.time, false);
  pausedAt = book.lastPlayedAt || null; // so smart rewind steps back a little after a long break
}

function closeBook() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (chapterUrl) URL.revokeObjectURL(chapterUrl);
  chapterUrl = null;
  current = null;
  setSleep('0');
  showView(lastTab);
}

async function renderPlayerHeader() {
  $('book-title').textContent = current.title;
  $('book-author').textContent = current.author || '';
  $('book-author').hidden = !current.author;
  const url = await coverUrl(current);
  const img = $('cover');
  const fallback = $('cover-fallback');
  if (url) {
    img.src = url;
    img.hidden = false;
    fallback.hidden = true;
  } else {
    img.hidden = true;
    fallback.hidden = false;
    fallback.style.background = colorFor(current.title);
    fallback.textContent = initialOf(current.title);
  }
  showRate();
  const book = current;
  const tone = await toneOf(book);
  if (current === book) applyTone(document.documentElement, tone); // the player and the bar take the book's colour
}

// The whole book as one line, with a mark where each chapter starts. Click to jump anywhere.
function renderTimeline() {
  const line = $('book-timeline');
  for (const tick of line.querySelectorAll('.tick')) tick.remove();
  const total = totalDuration(current);
  if (!total) return;
  let at = 0;
  current.chapters.forEach((ch, i) => {
    if (i > 0) {
      const tick = document.createElement('span');
      tick.className = 'tick';
      tick.style.left = `${(at / total) * 100}%`;
      line.append(tick);
    }
    at += ch.duration || 0;
  });
}

function jumpToBookFraction(fraction) {
  if (!current) return;
  let target = fraction * totalDuration(current);
  for (let i = 0; i < current.chapters.length; i++) {
    const length = current.chapters[i].duration || 0;
    if (target < length || i === current.chapters.length - 1) {
      jumpTo(i, Math.max(0, Math.min(target, length - 1)));
      return;
    }
    target -= length;
  }
}

function renderChapters() {
  const list = $('chapters');
  list.replaceChildren();
  current.chapters.forEach((ch, i) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.index = i;
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = i + 1;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = ch.title;
    const dur = document.createElement('span');
    dur.className = 'dur';
    if (!ch.fileId && !ch.url) {
      dur.textContent = 'being made…';
      btn.classList.add('pending');
    } else {
      dur.textContent = ch.duration ? formatTime(ch.duration) : '';
    }
    btn.append(num, name, dur);
    btn.addEventListener('click', () => loadChapter(i, 0, true));
    li.append(btn);
    list.append(li);
  });
  highlightChapter();
  renderTimeline();
}

function highlightChapter() {
  const index = current?.position?.chapter ?? -1;
  for (const btn of $('chapters').querySelectorAll('button')) {
    const isCurrent = Number(btn.dataset.index) === index;
    btn.classList.toggle('current', isCurrent);
    if (isCurrent) btn.setAttribute('aria-current', 'true');
    else btn.removeAttribute('aria-current');
  }
}

async function loadChapter(index, startAt = 0, autoplay = false) {
  if (!current || index < 0 || index >= current.chapters.length) return;
  const token = ++loadToken;
  const ch = current.chapters[index];
  pausedAt = null;

  let src = ch.url;
  if (!src && !ch.fileId) {
    waitingForChapter = index;
    audio.pause();
    toast('This chapter is still being made. It will start by itself when it\u2019s ready.');
    return;
  }
  waitingForChapter = null;
  if (!src) {
    const rec = await db.getFile(ch.fileId);
    if (token !== loadToken) return;
    if (!rec) {
      toast('This chapter’s audio file is missing.');
      return;
    }
    if (chapterUrl) URL.revokeObjectURL(chapterUrl);
    chapterUrl = src = URL.createObjectURL(rec.blob);
  }

  // The next chapter of an M4B is in the same file: keep playing, no need to load it again.
  const sameFile = Boolean(ch.url) && audio.src === new URL(src, location.href).href && audio.readyState > 0;

  current.position = { chapter: index, time: startAt };
  current.finished = false;
  $('chapter-title').textContent = ch.title;
  highlightChapter();
  updateNowPlaying();

  if (sameFile) {
    const target = (ch.start || 0) + startAt;
    if (Math.abs(audio.currentTime - target) > 0.3) audio.currentTime = target;
    updateMediaSession();
    updateTimes();
    showChapterText(index);
    if (autoplay && audio.paused) play();
    await saveProgress();
    return;
  }

  audio.defaultPlaybackRate = current.rate;
  audio.src = src;

  const ok = await new Promise(resolve => {
    const cleanup = () => {
      audio.removeEventListener('loadedmetadata', onLoad);
      audio.removeEventListener('error', onError);
    };
    const onLoad = () => { cleanup(); resolve(true); };
    const onError = () => { cleanup(); resolve(false); };
    audio.addEventListener('loadedmetadata', onLoad);
    audio.addEventListener('error', onError);
  });
  if (token !== loadToken) return;
  if (!ok) {
    toast('This chapter can’t be played in this browser.');
    return;
  }

  if (!ch.duration && !ch.end && Number.isFinite(audio.duration)) {
    ch.duration = audio.duration;
    renderChapters();
  }
  const target = (ch.start || 0) + startAt;
  if (target > 0 && target < audio.duration - 1) audio.currentTime = target;
  audio.playbackRate = current.rate;
  updateMediaSession();
  updateTimes();
  showChapterText(index);
  if (autoplay) play();
  await saveProgress();
}

// Smart rewind: after a break, start a few seconds back so it's easy to pick up the thread.
function rewindAfter(pausedMs) {
  const minutes = pausedMs / 60000;
  if (minutes >= 60) return 30;
  if (minutes >= 10) return 15;
  if (minutes >= 2) return 5;
  return 0;
}

function play() {
  if (pausedAt && current && chapterTime() > 1) {
    const back = rewindAfter(Date.now() - pausedAt);
    if (back) {
      audio.currentTime = chapterStart() + Math.max(0, chapterTime() - back);
      if (back >= 15) toast(`Went back ${back} seconds to help you pick up the thread.`);
    }
  }
  pausedAt = null;
  audio.play().catch(() => {});
}

function togglePlay() {
  if (!current) return;
  if (audio.paused) play();
  else audio.pause();
}

function skip(seconds) {
  if (!current || !Number.isFinite(audio.duration)) return;
  pausedAt = null;
  const target = chapterTime() + seconds;
  if (target < 0 && current.position.chapter > 0) {
    // Going back past the start of a chapter continues into the previous one.
    const prev = current.position.chapter - 1;
    const prevDuration = current.chapters[prev].duration || 0;
    loadChapter(prev, Math.max(0, prevDuration + target), !audio.paused);
    return;
  }
  seekTo(Math.max(0, Math.min(target, chapterLength() - 0.5)));
}

function nextChapter(autoplay = !audio.paused) {
  if (current && current.position.chapter < current.chapters.length - 1) {
    loadChapter(current.position.chapter + 1, 0, autoplay);
  }
}

function prevChapter() {
  if (!current) return;
  // Like most players: restart the chapter first, then go to the previous one.
  if (chapterTime() > 5 || current.position.chapter === 0) {
    seekTo(0);
  } else {
    loadChapter(current.position.chapter - 1, 0, !audio.paused);
  }
}

function formatRate(rate) {
  return `${Number(rate.toFixed(2))}×`;
}

function showRate() {
  const rate = current?.rate || 1;
  $('speed').textContent = formatRate(rate);
  $('speed-value').textContent = formatRate(rate);
  $('speed-range').value = rate;
}

function setRate(rate) {
  if (!current) return;
  current.rate = rate;
  audio.playbackRate = rate;
  audio.defaultPlaybackRate = rate;
  showRate();
  updateTimes();
  saveProgress();
}

function toggleSpeedPanel(open = $('speed-panel').hidden) {
  $('speed-panel').hidden = !open;
  $('speed').setAttribute('aria-expanded', String(open));
}

// Speed sliders: the − / + buttons move them in small steps, and preset buttons jump to a value.
function setupSpeedControls() {
  const round = x => Math.round(x * 100) / 100;
  const set = (input, value) => {
    input.value = Math.min(Number(input.max), Math.max(Number(input.min), round(value)));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  for (const btn of document.querySelectorAll('.step-btn')) {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.for);
      set(input, Number(input.value) + Number(btn.dataset.step));
    });
  }
  for (const group of document.querySelectorAll('.speed-presets')) {
    group.addEventListener('click', e => {
      const btn = e.target.closest('[data-rate]');
      if (btn) set($(group.dataset.for), Number(btn.dataset.rate));
    });
  }
}

function updateTimes() {
  const duration = chapterLength();
  const time = chapterTime();
  const seek = $('seek');
  seek.max = Math.floor(duration);
  if (!seeking) seek.value = Math.floor(time);
  $('elapsed').textContent = formatTime(seeking ? Number(seek.value) : time);
  // Time left in the chapter at the chosen speed, the way you'll actually hear it.
  const rate = current?.rate || 1;
  $('remaining').textContent = `-${formatTime((duration - (seeking ? Number(seek.value) : time)) / rate)}`;
  $('remaining').title = rate === 1 ? 'Time left in this chapter' : `Time left in this chapter at ${formatRate(rate)}`;

  if (current) {
    const total = totalDuration(current);
    const listened = listenedSeconds(current);
    const pct = total ? Math.min(100, (listened / total) * 100) : 0;
    $('book-progress-fill').style.width = `${pct}%`;
    const rate = current.rate || 1;
    $('book-progress').textContent = total
      ? `Chapter ${current.position.chapter + 1} of ${current.chapters.length} · ${Math.floor(pct)}% · ${formatLong(Math.max(0, total - listened) / rate)} left`
      : `Chapter ${current.position.chapter + 1} of ${current.chapters.length}`;
    // The player bar: progress through the chapter, and its time left.
    $('np-fill').style.width = duration ? `${Math.min(100, (time / duration) * 100)}%` : '0';
    $('np-time').textContent = duration ? `-${formatTime((duration - time) / rate)}` : '';
  }
}

async function saveProgress() {
  if (!current) return;
  if (audio.src && Number.isFinite(audio.currentTime) && audio.readyState > 0) {
    current.position.time = chapterTime();
  }
  lastSave = Date.now();
  const { position, rate, finished, chapters } = current;
  await db.updateBook(current.id, saved => {
    saved.position = { ...position };
    saved.rate = rate;
    saved.finished = finished;
    saved.lastPlayedAt = Date.now();
    // Keep durations learned while playing, without touching chapters the converter is still making.
    saved.chapters.forEach((ch, i) => {
      if (!ch.duration && chapters[i]?.duration) ch.duration = chapters[i].duration;
    });
  });
}

function updatePlayState() {
  const playing = !audio.paused;
  $('play').classList.toggle('playing', playing);
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('np-play').classList.toggle('playing', playing);
  $('np-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

// The player bar at the bottom: on every page except the full player (and with it in focus mode).
function updateNowPlaying() {
  const bar = $('now-playing');
  const inPlayer = !$('player').hidden;
  bar.hidden = !current || (inPlayer && !$('player').classList.contains('focus'));
  document.body.classList.toggle('has-bar', !bar.hidden);
  $('nav-player').hidden = !current;
  if (!current) return;
  $('np-title').textContent = current.title;
  $('np-chapter').textContent = current.chapters[current.position.chapter]?.title || '';
  showCover($('np-cover'), current);
}

// Puts a book's cover into an element: the picture, or its initial on the book's colour.
async function showCover(el, book) {
  const url = await coverUrl(book);
  if (el.dataset.book === book.id && el.dataset.url === String(url)) return;
  el.dataset.book = book.id;
  el.dataset.url = String(url);
  el.replaceChildren();
  if (url) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = url;
    el.append(img);
    el.style.background = '';
  } else {
    el.textContent = initialOf(book.title);
    el.style.background = colorFor(book.title);
  }
}

// ---------- Book colours ----------

// The main colour of a book's cover (hue and saturation), so the player can take on the book's mood.
// Books without a cover use a colour made from their title.
const tones = new Map();
async function toneOf(book) {
  const url = await coverUrl(book);
  const key = url || `title:${book.title}`;
  if (!tones.has(key)) {
    tones.set(key, url ? await toneOfImage(url) : null);
    if (!tones.get(key)) tones.set(key, { h: hueOf(book.title), s: 42 });
  }
  return tones.get(key);
}

function toneOfImage(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onerror = () => resolve(null);
    img.onload = () => {
      try {
        const size = 32;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        // Average the hue of the colourful pixels (as angles, so red at 350° and 10° average to red).
        let x = 0;
        let y = 0;
        let weight = 0;
        let sat = 0;
        for (let i = 0; i < data.length; i += 4) {
          const [r, g, b] = [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255];
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const l = (max + min) / 2;
          const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
          if (s < 0.08) continue;
          let h = 0;
          if (max === r) h = ((g - b) / (max - min)) % 6;
          else if (max === g) h = (b - r) / (max - min) + 2;
          else h = (r - g) / (max - min) + 4;
          const w = s * (1 - Math.abs(2 * l - 1)); // vivid, mid-light pixels count most
          x += Math.cos(h * Math.PI / 3) * w;
          y += Math.sin(h * Math.PI / 3) * w;
          sat += s * w;
          weight += w;
        }
        if (weight < 2) {
          resolve({ h: 220, s: 8 }); // a grey or black-and-white cover
          return;
        }
        const h = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
        resolve({ h: Math.round(h), s: Math.round(Math.min(70, Math.max(18, (sat / weight) * 70))) });
      } catch {
        resolve(null); // a cover from another site the browser won't let us read
      }
    };
    img.src = url;
  });
}

function applyTone(el, tone) {
  el.style.setProperty('--tone-h', tone.h);
  el.style.setProperty('--tone-s', `${tone.s}%`);
}

async function updateMediaSession() {
  if (!('mediaSession' in navigator) || !current) return;
  const url = await coverUrl(current);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: current.chapters[current.position.chapter].title,
    artist: current.author || '',
    album: current.title,
    artwork: url ? [{ src: new URL(url, location.href).href, sizes: '512x512' }] : [],
  });
}

function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const duration = chapterLength();
  if (!(duration > 0)) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: audio.playbackRate,
      position: Math.min(chapterTime(), duration),
    });
  } catch {
    // Some browsers reject position updates while loading.
  }
}

// ---------- Sleep timer ----------

let sleepTimer = null;
let sleepEndsAt = 0;
let sleepAtChapterEnd = false;
const SLEEP_FADE = 10; // seconds of fading out before the sleep timer stops playback

function setSleep(value) {
  clearInterval(sleepTimer);
  sleepTimer = null;
  sleepAtChapterEnd = value === 'chapter';
  audio.volume = 1;
  $('sleep').value = value;
  $('sleep-left').textContent = '';
  const minutes = Number(value);
  if (!minutes) return;
  sleepEndsAt = Date.now() + minutes * 60 * 1000;
  const tick = () => {
    const left = Math.max(0, (sleepEndsAt - Date.now()) / 1000);
    $('sleep-left').textContent = formatTime(left);
    if (!audio.paused) audio.volume = Math.max(0.05, Math.min(1, left / SLEEP_FADE));
    if (left <= 0) {
      audio.pause();
      setSleep('0');
      toast('Sleep timer: playback paused.');
    }
  };
  tick();
  sleepTimer = setInterval(tick, 250);
}

// "Sleep at end of chapter" fades out over the chapter's last seconds.
function fadeAtChapterEnd() {
  if (!sleepAtChapterEnd || !(chapterLength() > 0)) return;
  audio.volume = Math.max(0.05, Math.min(1, (chapterLength() - chapterTime()) / SLEEP_FADE));
}

// ---------- Bookmarks and quotes ----------

function sortedMarks() {
  return [...(current?.marks || [])].sort((a, b) => a.chapter - b.chapter || a.time - b.time);
}

async function saveMarks(change) {
  change(current.marks ||= []);
  const marks = current.marks;
  await db.updateBook(current.id, saved => { saved.marks = marks; });
  renderMarks();
}

// kind: 'bookmark' or 'quote'. Called by the Bookmark button, the B key, and the reader's Save quote.
async function addMark(kind, time = chapterTime(), text = '') {
  if (!current) return;
  const mark = {
    id: newId(),
    kind,
    chapter: current.position.chapter,
    time,
    text: text || Reader.currentSentence(),
    note: '',
    createdAt: Date.now(),
  };
  await saveMarks(marks => marks.push(mark));
  toast(kind === 'quote' ? 'Quote saved under Bookmarks & quotes.' : `Bookmark added at ${formatTime(time)}.`);
}

function renderMarks() {
  if (!current) return;
  const marks = sortedMarks();
  $('marks-count').textContent = marks.length ? `(${marks.length})` : '';
  $('marks-empty').hidden = marks.length > 0;
  $('marks-export').hidden = !marks.length;
  const list = $('marks-list');
  list.replaceChildren();
  for (const mark of marks) {
    const li = document.createElement('li');
    li.className = `mark ${mark.kind}`;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'mark-open';
    open.title = 'Play from here';
    const where = document.createElement('span');
    where.className = 'mark-where';
    where.textContent = `${mark.kind === 'quote' ? 'Quote' : 'Bookmark'} · ${current.chapters[mark.chapter]?.title || ''} · ${formatTime(mark.time)}`;
    open.append(where);
    if (mark.text) {
      const text = document.createElement('span');
      text.className = 'mark-text';
      text.textContent = mark.kind === 'quote' ? `“${mark.text}”` : mark.text;
      open.append(text);
    }
    if (mark.note) {
      const note = document.createElement('span');
      note.className = 'mark-note';
      note.textContent = mark.note;
      open.append(note);
    }
    open.addEventListener('click', () => jumpTo(mark.chapter, mark.time));
    const actions = document.createElement('div');
    actions.className = 'book-actions';
    const action = (label, handler, className = '') => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.className = className;
      btn.addEventListener('click', handler);
      actions.append(btn);
    };
    action(mark.note ? 'Edit note' : 'Add note', () => {
      const note = prompt('Note', mark.note || '');
      if (note !== null) saveMarks(marks => { marks.find(m => m.id === mark.id).note = note.trim(); });
    });
    action('Delete', () => {
      if (confirm('Delete this ' + (mark.kind === 'quote' ? 'quote?' : 'bookmark?'))) {
        saveMarks(marks => marks.splice(marks.findIndex(m => m.id === mark.id), 1));
      }
    }, 'delete');
    li.append(open, actions);
    list.append(li);
  }
}

// Saves all bookmarks, quotes and notes of the open book as a plain text file.
function exportMarks() {
  const lines = [current.title, current.author || '', ''];
  for (const mark of sortedMarks()) {
    lines.push(`${current.chapters[mark.chapter]?.title || `Chapter ${mark.chapter + 1}`} · ${formatTime(mark.time)}`);
    if (mark.text) lines.push(mark.kind === 'quote' ? `“${mark.text}”` : mark.text);
    if (mark.note) lines.push(`Note: ${mark.note}`);
    lines.push('');
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' }));
  link.download = `${safeFileName(current.title)} - bookmarks and quotes.txt`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60000);
}

// ---------- Listening stats ----------

const STATS_KEY = 'audio-book.stats';
let lastListenTick = 0;
let statsSavedAt = 0;
let stats = { days: {} }; // seconds listened per day, kept in this browser
try {
  const saved = JSON.parse(localStorage.getItem(STATS_KEY) || '{}');
  if (saved.days) stats = saved;
} catch {
  // Private browsing: start counting from zero.
}

function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Adds the time since the last call to today's listening time (called while playing).
function countListening() {
  const now = Date.now();
  if (lastListenTick && !audio.paused) {
    const key = dayKey();
    stats.days[key] = (stats.days[key] || 0) + Math.min(5, (now - lastListenTick) / 1000);
    if (now - statsSavedAt > 15000) saveStats();
  }
  lastListenTick = audio.paused ? 0 : now;
}

function saveStats() {
  statsSavedAt = Date.now();
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(stats));
  } catch {
    // Not remembered in private browsing.
  }
}

function renderStats() {
  const day = new Date();
  const seconds = offset => {
    const d = new Date(day);
    d.setDate(d.getDate() - offset);
    return stats.days[dayKey(d)] || 0;
  };
  let week = 0;
  for (let i = 0; i < 7; i++) week += seconds(i);
  let streak = 0;
  for (let i = seconds(0) >= 60 ? 0 : 1; seconds(i) >= 60; i++) streak++;
  const el = $('stats');
  el.hidden = week < 60;
  if (el.hidden) return;
  const parts = [`Today ${seconds(0) >= 60 ? formatLong(seconds(0)) : '0 min'}`, `last 7 days ${formatLong(week)}`];
  if (streak >= 2) parts.push(`${streak} days in a row`);
  el.textContent = `Listening: ${parts.join(' · ')}`;
}

// ---------- Events ----------

audio.addEventListener('timeupdate', () => {
  if (!current) return;
  current.position.time = chapterTime();
  updateTimes();
  updatePositionState();
  countListening();
  fadeAtChapterEnd();
  Reader.sync(chapterTime()); // also while playing, in case the browser slows Reader.loop() down
  if (Date.now() - lastSave > SAVE_EVERY_MS) saveProgress();
  // A chapter inside a bigger file (M4B) ends before the file does.
  const ch = current.chapters[current.position.chapter];
  if (ch?.end && !audio.paused && current.position.chapter < current.chapters.length - 1 && audio.currentTime >= ch.end - 0.05) {
    chapterFinished();
  }
});

audio.addEventListener('play', () => {
  updatePlayState();
  lastListenTick = Date.now();
  Reader.loop();
});
audio.addEventListener('pause', () => {
  pausedAt = Date.now();
  countListening();
  saveStats();
  updatePlayState();
  saveProgress();
});
audio.addEventListener('seeked', () => Reader.sync(chapterTime()));

audio.addEventListener('ended', chapterFinished);

function chapterFinished() {
  if (!current) return;
  if (sleepAtChapterEnd) {
    audio.pause();
    setSleep('0');
    toast('Sleep timer: stopped at the end of the chapter.');
    if (current.position.chapter < current.chapters.length - 1) {
      loadChapter(current.position.chapter + 1, 0, false);
    }
    return;
  }
  if (current.position.chapter < current.chapters.length - 1) {
    nextChapter(true);
  } else {
    current.finished = true;
    saveProgress();
    toast('You finished the book!');
  }
}

$('play').addEventListener('click', togglePlay);
$('np-play').addEventListener('click', togglePlay);
$('np-back').addEventListener('click', () => skip(-SKIP_BACK));
$('np-forward').addEventListener('click', () => skip(SKIP_FORWARD));
$('np-open').addEventListener('click', () => {
  if (!current) return;
  if (!$('player').hidden) setFocus(false); // in focus mode, the bar brings the full player back
  else openBook(current.id);
});
$('focus-toggle').addEventListener('click', () => setFocus(!$('player').classList.contains('focus')));
$('book-timeline').addEventListener('click', e => {
  const box = e.currentTarget.getBoundingClientRect();
  jumpToBookFraction((e.clientX - box.left) / box.width);
});
$('rewind').addEventListener('click', () => skip(-SKIP_BACK));
$('forward').addEventListener('click', () => skip(SKIP_FORWARD));
$('prev').addEventListener('click', prevChapter);
$('next').addEventListener('click', () => nextChapter());
$('speed').addEventListener('click', () => toggleSpeedPanel());
$('speed-range').addEventListener('input', e => setRate(Number(e.target.value)));
document.addEventListener('click', e => {
  if (!$('speed-panel').hidden && !e.target.closest('.speed-wrap')) toggleSpeedPanel(false);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('speed-panel').hidden) toggleSpeedPanel(false);
});
setupSpeedControls();
$('sleep').addEventListener('change', e => setSleep(e.target.value));

$('seek').addEventListener('input', () => {
  seeking = true;
  updateTimes();
});
$('seek').addEventListener('change', () => {
  seekTo(Number($('seek').value));
  seeking = false;
});

$('view-read').addEventListener('click', () => setPanel('read'));
$('add-bookmark').addEventListener('click', () => addMark('bookmark'));
$('tab-chapters').addEventListener('click', () => showList('chapters'));
$('tab-marks').addEventListener('click', () => showList('marks'));
$('marks-export').addEventListener('click', exportMarks);
$('show-shortcuts').addEventListener('click', () => $('shortcuts').showModal());
Reader.setup();

$('back').addEventListener('click', () => {
  if (history.state?.view === 'player') history.back();
  else showView(lastTab);
});

window.addEventListener('popstate', () => {
  if (!$('player').hidden) {
    showView(lastTab);
    renderLibrary();
  }
});

for (const tab of document.querySelectorAll('#tabs button')) {
  tab.addEventListener('click', () => {
    if (tab.dataset.view === 'player') {
      if (current) openBook(current.id);
      return;
    }
    showView(tab.dataset.view);
    if (tab.dataset.view === 'library') renderLibrary();
  });
}

$('lib-search').addEventListener('input', () => renderLibrary());
$('lib-sort').addEventListener('change', e => {
  try {
    localStorage.setItem(SORT_KEY, e.target.value);
  } catch {
    // Not remembered.
  }
  renderLibrary();
});
try {
  $('lib-sort').value = localStorage.getItem(SORT_KEY) || 'recent';
} catch {
  // Recently played first.
}
// Close a book's "more" menu when clicking anywhere else.
document.addEventListener('click', e => {
  for (const menu of document.querySelectorAll('.card-menu[open]')) if (!menu.contains(e.target)) menu.open = false;
});

$('empty-make').addEventListener('click', () => showView('convert'));

$('pick-files').addEventListener('change', async e => {
  const items = [...e.target.files].map(file => ({ file, path: file.name }));
  e.target.value = '';
  if (items.length) await importItems(items);
});

$('pick-folder').addEventListener('change', async e => {
  const items = [...e.target.files].map(file => ({ file, path: file.webkitRelativePath || file.name }));
  e.target.value = '';
  if (items.length) await importItems(items);
});

let dragDepth = 0;
window.addEventListener('dragenter', e => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  $('drop-hint').hidden = false;
});
window.addEventListener('dragover', e => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('drop-hint').hidden = true;
});
window.addEventListener('drop', async e => {
  e.preventDefault();
  dragDepth = 0;
  $('drop-hint').hidden = true;
  const items = await itemsFromDrop(e.dataTransfer);
  if (items.length) await importItems(items);
});

document.addEventListener('keydown', e => {
  if (e.target.closest?.('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey || $('shortcuts').open) return;
  if (e.key === '?') {
    $('shortcuts').showModal();
    return;
  }
  if (!current) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const inPlayer = !$('player').hidden;
  if (key === ' ' || key === 'k') {
    if (e.target.closest?.('button')) return; // let the focused button handle Space
    e.preventDefault();
    togglePlay();
  } else if (key === 'ArrowLeft' || key === 'j') {
    skip(-SKIP_BACK);
  } else if (key === 'ArrowRight' || key === 'l') {
    skip(SKIP_FORWARD);
  } else if (key === 'n') {
    nextChapter();
  } else if (key === 'p') {
    prevChapter();
  } else if (key === '[' || key === ']') {
    setRate(Math.min(3, Math.max(0.5, Math.round((current.rate + (key === ']' ? 0.05 : -0.05)) * 100) / 100)));
    toast(`Speed ${formatRate(current.rate)}`);
  } else if (key === 'b') {
    addMark('bookmark');
  } else if (key === 'r' && inPlayer) {
    setReading(!isReading());
  } else if (key === 'f' && inPlayer) {
    if (!isReading()) setPanel('read');
    setFocus(!$('player').classList.contains('focus'));
  } else if (key === '/' && inPlayer) {
    e.preventDefault();
    setReading(true);
    Reader.toggleSearch(true);
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveProgress();
});
window.addEventListener('pagehide', saveProgress);

if ('mediaSession' in navigator) {
  const handlers = {
    play: () => play(),
    pause: () => audio.pause(),
    seekbackward: d => skip(-(d.seekOffset || SKIP_BACK)),
    seekforward: d => skip(d.seekOffset || SKIP_FORWARD),
    previoustrack: () => prevChapter(),
    nexttrack: () => nextChapter(),
    seekto: d => seekTo(d.seekTime),
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      // Action not supported by this browser.
    }
  }
}

// ---------- Install as an app, and work offline ----------

let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  $('install').hidden = false;
});
$('install').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('install').hidden = true;
});
window.addEventListener('appinstalled', () => { $('install').hidden = true; });

// The service worker keeps a copy of the app so it opens without internet. Browsers only allow it on
// https:// sites (like GitHub Pages) and on this computer (localhost).
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  navigator.serviceWorker.register('service-worker.js').catch(() => {});
}

// ---------- Start ----------

// Runs after all scripts (including convert.js) have loaded.
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await renderLibrary();
    await loadPublishedBooks();
    await renderLibrary();
    await Converter.showUnfinished();
  } catch (err) {
    console.error(err);
    toast('This browser blocked storage, so the library can’t be saved.');
  }
});
