'use strict';

// Extra parts for the Windows app (desktop/, Electron), which gives this page window.desktop.
// On the website this file does nothing.
// In the app, books are read straight from their folders on disk (no copying into the browser):
// open a file or folder, double-click a book in Explorer, drop it on the window, or add library folders.

(() => {
  const desktop = window.desktop;
  if (!desktop) return;
  document.documentElement.classList.add('desktop');

  const REMOVED_KEY = 'audio-book.desktop.removed'; // books removed from the library stay out of scans
  let removed = new Set();
  try {
    removed = new Set(JSON.parse(localStorage.getItem(REMOVED_KEY) || '[]'));
  } catch {
    // Start with none.
  }
  const saveRemoved = () => {
    try {
      localStorage.setItem(REMOVED_KEY, JSON.stringify([...removed]));
    } catch {
      // Not remembered.
    }
  };

  // Adds or refreshes a book read from disk, keeping its place, speed, bookmarks and any new name.
  async function upsert(found) {
    const saved = (await db.getBook(found.id)) || {};
    const book = {
      position: { chapter: 0, time: 0 },
      rate: 1,
      finished: false,
      addedAt: Date.now(),
      lastPlayedAt: 0,
      ...saved,
      id: found.id,
      onDisk: true,
      path: found.path,
      title: saved.renamed ? saved.title : found.title,
      author: saved.renamed ? saved.author : found.author,
      coverUrl: found.coverUrl,
      chapters: found.chapters,
    };
    if (book.position.chapter >= book.chapters.length) book.position = { chapter: 0, time: 0 };
    await db.putBook(book);
    return book;
  }

  // Opens files or folders (from Explorer, the menu, or a drop) and starts playing the last one.
  async function openPaths(paths) {
    let last = null;
    for (const target of paths) {
      const found = await desktop.readBook(target);
      if (!found) {
        toast(`No audiobook found in “${target.split(/[\\/]/).pop()}”.`);
        continue;
      }
      removed.delete(found.id);
      last = { book: await upsert(found), start: found.startChapter };
    }
    saveRemoved();
    await renderLibrary();
    if (!last) return;
    await openBook(last.book.id);
    if (last.start != null && last.start !== current.position.chapter) await loadChapter(last.start, 0, true);
    else play();
  }

  async function pickAndOpen(kind) {
    const paths = await desktop.pick(kind);
    if (paths.length) await openPaths(paths);
  }

  // ---------- Library folders ----------

  async function scanLibrary() {
    const books = await desktop.scanLibrary();
    for (const found of books) if (found && !removed.has(found.id)) await upsert(found);
    await renderLibrary();
    return books.length;
  }

  async function renderFolders() {
    const folders = await desktop.libraryFolders();
    const list = $('lib-folder-list');
    list.replaceChildren();
    for (const folder of folders) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = folder;
      name.title = folder;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        await desktop.setLibraryFolders(folders.filter(f => f !== folder));
        renderFolders();
      });
      li.append(name, remove);
      list.append(li);
    }
    $('lib-folders-empty').hidden = folders.length > 0;
  }

  async function addLibraryFolder() {
    const [folder] = await desktop.pick('folder');
    if (!folder) return;
    await desktop.setLibraryFolders([...(await desktop.libraryFolders()), folder]);
    await renderFolders();
    toast('Looking for audiobooks…');
    const count = await scanLibrary();
    toast(count ? `Found ${count} audiobook${count === 1 ? '' : 's'}.` : 'No audiobooks found in that folder yet.');
  }

  function buildLibraryParts() {
    // "Open" instead of the website's "Add audio files / Add a folder", which copy files into the browser.
    const row = $('pick-files').closest('.add-row');
    row.replaceChildren();
    const label = document.createElement('span');
    label.className = 'muted';
    label.textContent = 'Open an audiobook:';
    const openFile = document.createElement('button');
    openFile.type = 'button';
    openFile.className = 'btn';
    openFile.textContent = 'Open file…';
    openFile.addEventListener('click', () => pickAndOpen('file'));
    const openFolder = document.createElement('button');
    openFolder.type = 'button';
    openFolder.className = 'btn';
    openFolder.textContent = 'Open folder…';
    openFolder.addEventListener('click', () => pickAndOpen('folder'));
    row.append(label, openFile, openFolder);

    const panel = document.createElement('section');
    panel.id = 'lib-folders';
    panel.className = 'lib-folders';
    panel.innerHTML =
      '<h2>Library folders</h2>' +
      '<p class="muted small">Audiobooks in these folders (and folders inside them) appear in your library by themselves. ' +
      'Add the folder where your audiobooks are, for example the voice-clone tool’s save folder.</p>' +
      '<p id="lib-folders-empty" class="muted small">No library folders yet.</p>' +
      '<ul id="lib-folder-list"></ul>' +
      '<div class="actions"><button type="button" id="lib-add" class="btn primary">Add a folder…</button>' +
      '<button type="button" id="lib-scan" class="btn">Look for new books</button></div>';
    row.after(panel);
    $('lib-add').addEventListener('click', addLibraryFolder);
    $('lib-scan').addEventListener('click', async () => {
      toast('Looking for audiobooks…');
      const count = await scanLibrary();
      toast(`${count} audiobook${count === 1 ? '' : 's'} in your library folders.`);
    });

    // The empty library offers to open a book (the website's button goes to "Make audiobook").
    const old = $('empty-make');
    const open = old.cloneNode(false);
    open.textContent = 'Open an audiobook…';
    open.addEventListener('click', () => pickAndOpen('folder'));
    old.replaceWith(open);
    $('empty').querySelector('p').textContent =
      'Open an audiobook file or folder, drop one on this window, or add a library folder below.';
  }

  // ---------- Mini player ----------

  let readingBeforeMini = false;
  function setMini(on) {
    if (on && !current) {
      toast('Open a book first.');
      return;
    }
    const html = document.documentElement;
    if (on === html.classList.contains('mini')) return;
    if (on) {
      readingBeforeMini = isReading();
      if (readingBeforeMini) setReading(false);
      if ($('player').hidden) openBook(current.id);
    } else if (readingBeforeMini) {
      setReading(true);
    }
    html.classList.toggle('mini', on);
    desktop.setMini(on);
  }

  function buildMiniButtons() {
    const enter = document.createElement('button');
    enter.type = 'button';
    enter.id = 'mini-enter';
    enter.className = 'icon-btn';
    enter.title = 'Mini player (Ctrl+M)';
    enter.setAttribute('aria-label', 'Mini player');
    enter.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 11h-8v6h8v-6zm4 8V5a2 2 0 0 0-2-2H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2zm-2 0H3V5h18v14z"/></svg>';
    enter.addEventListener('click', () => setMini(true));
    document.querySelector('#player .stage').prepend(enter); // top corner of the player

    const leave = document.createElement('button');
    leave.type = 'button';
    leave.id = 'mini-leave';
    leave.className = 'icon-btn';
    leave.title = 'Back to the full window';
    leave.setAttribute('aria-label', 'Back to the full window');
    leave.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h7v2H5v5H3zm11 0h7v7h-2V5h-5zM3 14h2v5h5v2H3zm16 0h2v7h-7v-2h5z"/></svg>';
    leave.addEventListener('click', () => setMini(false));
    $('player').prepend(leave);
  }

  // ---------- Commands from the menu, taskbar buttons, tray ----------

  function command(name) {
    const actions = {
      toggle: () => togglePlay(),
      back: () => skip(-SKIP_BACK),
      forward: () => skip(SKIP_FORWARD),
      next: () => nextChapter(),
      prev: () => prevChapter(),
      bookmark: () => current && addMark('bookmark'),
      read: () => {
        if (!current) return;
        if (document.documentElement.classList.contains('mini')) setMini(false);
        if ($('player').hidden) openBook(current.id);
        setReading(!isReading());
      },
      mini: () => setMini(!document.documentElement.classList.contains('mini')),
      library: () => {
        setMini(false);
        showView('library');
        renderLibrary();
      },
      'library-folders': () => {
        setMini(false);
        showView('library');
        $('lib-folders').scrollIntoView({ behavior: 'smooth' });
      },
      shortcuts: () => $('shortcuts').showModal(),
    };
    actions[name]?.();
  }

  // ---------- Start ----------

  buildLibraryParts();
  buildMiniButtons();
  document.addEventListener('book-removed', e => {
    removed.add(e.detail);
    saveRemoved();
  });

  // Dropping files or folders opens them from where they are (the website copies them in instead).
  window.addEventListener('drop', e => {
    e.preventDefault();
    e.stopImmediatePropagation();
    dragDepth = 0;
    $('drop-hint').hidden = true;
    const paths = [...e.dataTransfer.files].map(file => desktop.pathOf(file)).filter(Boolean);
    if (paths.length) openPaths(paths);
  }, true);

  audio.addEventListener('play', () => desktop.setPlaying(true));
  audio.addEventListener('pause', () => desktop.setPlaying(false));
  desktop.onCommand(command);
  desktop.onOpenPaths(openPaths);

  document.addEventListener('DOMContentLoaded', async () => {
    await renderFolders();
    await scanLibrary();
    const paths = await desktop.ready(); // a book double-clicked to start the app
    if (paths.length) await openPaths(paths);
  });
})();
