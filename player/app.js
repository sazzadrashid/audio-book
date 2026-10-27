'use strict';

// Audio Book player.
// Books you add are stored in this browser (IndexedDB), so nothing is uploaded.
// Books made with the converter and published with the site are listed in books/index.json.

const DB_NAME = 'audio-book';
const DB_VERSION = 1;
const SKIP_BACK = 15;
const SKIP_FORWARD = 30;
const SPEEDS = [0.75, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];
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
    db.createObjectStore('books', { keyPath: 'id' });
    db.createObjectStore('files', { keyPath: 'id' });
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
  async deleteBook(book) {
    const conn = await dbPromise;
    const t = conn.transaction(['books', 'files'], 'readwrite');
    t.objectStore('books').delete(book.id);
    for (const ch of book.chapters) if (ch.fileId) t.objectStore('files').delete(ch.fileId);
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

function prettyName(fileName) {
  return fileName.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function colorFor(text) {
  let hash = 0;
  for (const c of text) hash = (hash * 31 + c.codePointAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  return `linear-gradient(135deg, hsl(${hue} 45% 42%), hsl(${(hue + 40) % 360} 50% 30%))`;
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
  let ordered = [];
  if (Array.isArray(manifest.chapters)) {
    for (const ch of manifest.chapters) {
      const file = byName.get(ch.file);
      if (file) {
        ordered.push({ file, title: ch.title });
        byName.delete(ch.file);
      }
    }
  }
  const rest = [...byName.values()].sort((a, b) => naturalCompare(a.name, b.name));
  ordered = ordered.concat(rest.map(file => ({ file, title: null })));

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

  for (const { file, title } of ordered) {
    const fileId = newId();
    await db.putFile({ id: fileId, blob: file });
    const url = URL.createObjectURL(file);
    const duration = await readDuration(url);
    URL.revokeObjectURL(url);
    book.chapters.push({ title: title || prettyName(file.name), fileId, duration });
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

async function renderLibrary() {
  const books = await db.allBooks();
  books.sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0) || b.addedAt - a.addedAt);

  $('empty').hidden = books.length > 0;
  const list = $('books');
  list.replaceChildren();

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
    open.addEventListener('click', () => openBook(book.id));

    const url = await coverUrl(book);
    let thumb;
    if (url) {
      thumb = document.createElement('img');
      thumb.className = 'thumb';
      thumb.alt = '';
      thumb.src = url;
    } else {
      thumb = document.createElement('div');
      thumb.className = 'thumb fallback';
      thumb.style.background = colorFor(book.title);
      thumb.textContent = initialOf(book.title);
    }

    const info = document.createElement('div');
    info.className = 'book-info';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = book.title;
    const meta = document.createElement('span');
    meta.className = 'meta muted';
    meta.textContent = book.finished
      ? 'Finished'
      : listened > 0
        ? `${formatLong(Math.max(0, total - listened))} left`
        : [book.author, total ? formatLong(total) : ''].filter(Boolean).join(' · ');
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('div');
    fill.style.width = `${pct}%`;
    bar.append(fill);
    info.append(title, meta, bar);
    open.append(thumb, info);

    const actions = document.createElement('div');
    actions.className = 'book-actions';
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.textContent = 'Rename';
    rename.addEventListener('click', () => renameBook(book.id));
    actions.append(rename);
    if (!book.published) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'delete';
      del.textContent = 'Remove';
      del.addEventListener('click', () => removeBook(book.id));
      actions.append(del);
    }

    card.append(open, actions);
    if (book.published) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'Online';
      card.append(badge);
    }
    li.append(card);
    list.append(li);
  }
}

async function renameBook(id) {
  const book = await db.getBook(id);
  const title = prompt('Book title', book.title);
  if (title === null) return;
  const author = prompt('Author (optional)', book.author || '');
  book.title = title.trim() || book.title;
  if (author !== null) book.author = author.trim();
  await db.putBook(book);
  if (current?.id === id) {
    current.title = book.title;
    current.author = book.author;
    renderPlayerHeader();
  }
  await renderLibrary();
}

async function removeBook(id) {
  const book = await db.getBook(id);
  if (!confirm(`Remove "${book.title}" from this device? This can't be undone.`)) return;
  if (current?.id === id) closeBook();
  if (book.coverId && coverUrls.has(book.coverId)) {
    URL.revokeObjectURL(coverUrls.get(book.coverId));
    coverUrls.delete(book.coverId);
  }
  await db.deleteBook(book);
  toast('Book removed.');
  await renderLibrary();
}

// ---------- Player ----------

let current = null; // the open book
let chapterUrl = null; // object URL for the current chapter (local books)
let loadToken = 0;
let lastSave = 0;
let seeking = false;

function showView(view) {
  const inPlayer = view === 'player';
  $('library').hidden = inPlayer;
  $('player').hidden = !inPlayer;
  $('back').hidden = !inPlayer;
  $('add-buttons').hidden = inPlayer;
  $('heading').textContent = inPlayer ? 'Now playing' : 'Library';
  updateNowPlaying();
  window.scrollTo(0, 0);
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
  renderPlayerHeader();
  renderChapters();
  showView('player');
  history.pushState({ view: 'player' }, '');
  const pos = book.position || { chapter: 0, time: 0 };
  await loadChapter(Math.min(pos.chapter, book.chapters.length - 1), pos.time, false);
}

function closeBook() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (chapterUrl) URL.revokeObjectURL(chapterUrl);
  chapterUrl = null;
  current = null;
  setSleep('0');
  showView('library');
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
  $('speed').textContent = `${current.rate}×`;
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
    dur.textContent = ch.duration ? formatTime(ch.duration) : '';
    btn.append(num, name, dur);
    btn.addEventListener('click', () => loadChapter(i, 0, true));
    li.append(btn);
    list.append(li);
  });
  highlightChapter();
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

  let src = ch.url;
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

  current.position = { chapter: index, time: startAt };
  current.finished = false;
  $('chapter-title').textContent = ch.title;
  highlightChapter();
  updateNowPlaying();

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

  if (!ch.duration && Number.isFinite(audio.duration)) {
    ch.duration = audio.duration;
    renderChapters();
  }
  if (startAt > 0 && startAt < audio.duration - 1) audio.currentTime = startAt;
  audio.playbackRate = current.rate;
  updateMediaSession();
  updateTimes();
  if (autoplay) play();
  await saveProgress();
}

function play() {
  audio.play().catch(() => {});
}

function togglePlay() {
  if (!current) return;
  if (audio.paused) play();
  else audio.pause();
}

function skip(seconds) {
  if (!current || !Number.isFinite(audio.duration)) return;
  const target = audio.currentTime + seconds;
  if (target < 0 && current.position.chapter > 0) {
    // Going back past the start of a chapter continues into the previous one.
    const prev = current.position.chapter - 1;
    const prevDuration = current.chapters[prev].duration || 0;
    loadChapter(prev, Math.max(0, prevDuration + target), !audio.paused);
    return;
  }
  audio.currentTime = Math.max(0, Math.min(target, audio.duration - 0.5));
}

function nextChapter(autoplay = !audio.paused) {
  if (current && current.position.chapter < current.chapters.length - 1) {
    loadChapter(current.position.chapter + 1, 0, autoplay);
  }
}

function prevChapter() {
  if (!current) return;
  // Like most players: restart the chapter first, then go to the previous one.
  if (audio.currentTime > 5 || current.position.chapter === 0) {
    audio.currentTime = 0;
  } else {
    loadChapter(current.position.chapter - 1, 0, !audio.paused);
  }
}

function cycleSpeed() {
  if (!current) return;
  const i = SPEEDS.indexOf(current.rate);
  current.rate = SPEEDS[(i + 1) % SPEEDS.length];
  audio.playbackRate = current.rate;
  audio.defaultPlaybackRate = current.rate;
  $('speed').textContent = `${current.rate}×`;
  saveProgress();
}

function updateTimes() {
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  const time = audio.currentTime || 0;
  const seek = $('seek');
  seek.max = Math.floor(duration);
  if (!seeking) seek.value = Math.floor(time);
  $('elapsed').textContent = formatTime(seeking ? Number(seek.value) : time);
  $('remaining').textContent = `-${formatTime(duration - (seeking ? Number(seek.value) : time))}`;

  if (current) {
    const total = totalDuration(current);
    const listened = listenedSeconds(current);
    const pct = total ? Math.min(100, (listened / total) * 100) : 0;
    $('book-progress-fill').style.width = `${pct}%`;
    const rate = current.rate || 1;
    $('book-progress').textContent = total
      ? `Chapter ${current.position.chapter + 1} of ${current.chapters.length} · ${Math.floor(pct)}% · ${formatLong(Math.max(0, total - listened) / rate)} left`
      : `Chapter ${current.position.chapter + 1} of ${current.chapters.length}`;
  }
}

async function saveProgress() {
  if (!current) return;
  if (audio.src && Number.isFinite(audio.currentTime) && audio.readyState > 0) {
    current.position.time = audio.currentTime;
  }
  lastSave = Date.now();
  const saved = await db.getBook(current.id);
  if (!saved) return; // removed meanwhile
  saved.position = { ...current.position };
  saved.rate = current.rate;
  saved.finished = current.finished;
  saved.lastPlayedAt = Date.now();
  saved.chapters = current.chapters;
  await db.putBook(saved);
}

function updatePlayState() {
  const playing = !audio.paused;
  $('play').classList.toggle('playing', playing);
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('np-play').classList.toggle('playing', playing);
  $('np-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

function updateNowPlaying() {
  const bar = $('now-playing');
  bar.hidden = !current || !$('player').hidden;
  if (!current) return;
  $('np-title').textContent = current.title;
  $('np-chapter').textContent = current.chapters[current.position.chapter]?.title || '';
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
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate,
      position: Math.min(audio.currentTime, audio.duration),
    });
  } catch {
    // Some browsers reject position updates while loading.
  }
}

// ---------- Sleep timer ----------

let sleepTimer = null;
let sleepEndsAt = 0;
let sleepAtChapterEnd = false;

function setSleep(value) {
  clearInterval(sleepTimer);
  sleepTimer = null;
  sleepAtChapterEnd = value === 'chapter';
  $('sleep').value = value;
  $('sleep-left').textContent = '';
  const minutes = Number(value);
  if (!minutes) return;
  sleepEndsAt = Date.now() + minutes * 60 * 1000;
  const tick = () => {
    const left = Math.max(0, (sleepEndsAt - Date.now()) / 1000);
    $('sleep-left').textContent = formatTime(left);
    if (left <= 0) {
      audio.pause();
      setSleep('0');
      toast('Sleep timer: playback paused.');
    }
  };
  tick();
  sleepTimer = setInterval(tick, 1000);
}

// ---------- Events ----------

audio.addEventListener('timeupdate', () => {
  if (!current) return;
  current.position.time = audio.currentTime;
  updateTimes();
  updatePositionState();
  if (Date.now() - lastSave > SAVE_EVERY_MS) saveProgress();
});

audio.addEventListener('play', updatePlayState);
audio.addEventListener('pause', () => {
  updatePlayState();
  saveProgress();
});

audio.addEventListener('ended', () => {
  if (!current) return;
  if (sleepAtChapterEnd) {
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
});

$('play').addEventListener('click', togglePlay);
$('np-play').addEventListener('click', togglePlay);
$('np-open').addEventListener('click', () => {
  if (current) openBook(current.id);
});
$('rewind').addEventListener('click', () => skip(-SKIP_BACK));
$('forward').addEventListener('click', () => skip(SKIP_FORWARD));
$('prev').addEventListener('click', prevChapter);
$('next').addEventListener('click', () => nextChapter());
$('speed').addEventListener('click', cycleSpeed);
$('sleep').addEventListener('change', e => setSleep(e.target.value));

$('seek').addEventListener('input', () => {
  seeking = true;
  updateTimes();
});
$('seek').addEventListener('change', () => {
  audio.currentTime = Number($('seek').value);
  seeking = false;
});

$('back').addEventListener('click', () => {
  if (history.state?.view === 'player') history.back();
  else showView('library');
});

window.addEventListener('popstate', () => {
  if (!$('player').hidden) {
    showView('library');
    renderLibrary();
  }
});

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
  if (!current || e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === ' ' || e.key === 'k') {
    if (e.target.closest('button')) return; // let the focused button handle Space
    e.preventDefault();
    togglePlay();
  } else if (e.key === 'ArrowLeft' || e.key === 'j') {
    skip(-SKIP_BACK);
  } else if (e.key === 'ArrowRight' || e.key === 'l') {
    skip(SKIP_FORWARD);
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
    seekto: d => { audio.currentTime = d.seekTime; },
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      // Action not supported by this browser.
    }
  }
}

// ---------- Start ----------

(async () => {
  try {
    await renderLibrary();
    await loadPublishedBooks();
    await renderLibrary();
  } catch (err) {
    console.error(err);
    toast('This browser blocked storage, so the library can’t be saved.');
  }
})();
