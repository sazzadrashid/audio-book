'use strict';

// Audio Book Player for Windows. The window shows the same player as the website (copied from ../player
// by scripts/copy-player.js); books play straight from where they are on disk.
//   app://player/...      the player's own files
//   app://disk/<path>     audio, text and cover files of books, with range requests for seeking

const { app, BrowserWindow, ipcMain, dialog, protocol, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Readable } = require('node:stream');
const books = require('./books');

// Tests run with their own library and settings, apart from yours.
if (process.env.AUDIO_BOOK_PLAYER_DATA) app.setPath('userData', process.env.AUDIO_BOOK_PLAYER_DATA);

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

const PLAYER = path.join(__dirname, 'player');
const ICONS = path.join(__dirname, 'icons');
const MINI = { width: 400, height: 176 }; // the inside of the mini player window
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.webm': 'audio/webm',
};
// Only these kinds of files on disk can be read by the window.
const DISK_FILES = /\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac|webm|json|jpe?g|png|webp)$/i;

let win = null;
let tray = null;
let quitting = false;
let playing = false;
let rendererReady = false;
let pendingPaths = [];
let normalBounds = null; // window size before the mini player
let settings = loadSettings();

// ---------- Settings (window size, library folders, tray) ----------

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    return { libraryFolders: [], closeToTray: false, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    return { libraryFolders: [], closeToTray: false };
  }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

// ---------- Serving files to the window ----------

function serveFile(file, request) {
  let stat;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const headers = {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*', // lets the player read a cover's colours
  };
  const size = stat.size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    const body = Readable.toWeb(fs.createReadStream(file, { start, end }));
    return new Response(body, {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
}

function handleAppProtocol() {
  protocol.handle('app', request => {
    const url = new URL(request.url);
    if (url.host === 'player') {
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.join(PLAYER, relative);
      if (!file.startsWith(PLAYER)) return new Response('Not found', { status: 404 });
      return serveFile(file, request);
    }
    if (url.host === 'disk') {
      const file = decodeURIComponent(url.pathname.slice(1));
      if (!path.isAbsolute(file) || !DISK_FILES.test(file)) return new Response('Not allowed', { status: 403 });
      return serveFile(file, request);
    }
    return new Response('Not found', { status: 404 });
  });
}

// ---------- Opening books given on the command line (double-click, "Open with", a folder's right-click menu) ----------

function pathsFrom(argv) {
  return argv.slice(app.isPackaged ? 1 : 2).filter(arg => !arg.startsWith('-') && arg !== '.' && fs.existsSync(arg));
}

function openPaths(paths) {
  if (!paths.length) return;
  if (win && rendererReady) win.webContents.send('open-paths', paths);
  else pendingPaths.push(...paths);
  showWindow();
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function send(command) {
  if (win) win.webContents.send('command', command);
}

// ---------- Window ----------

function icon(name) {
  return nativeImage.createFromPath(path.join(ICONS, name));
}

function createWindow() {
  const bounds = settings.bounds || { width: 1180, height: 820 };
  win = new BrowserWindow({
    ...bounds,
    minWidth: 340,
    minHeight: 180,
    title: 'Audio Book Player',
    backgroundColor: '#0b0d10',
    icon: path.join(ICONS, 'app.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
      spellcheck: false,
    },
  });
  if (settings.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadURL('app://player/index.html');

  // Links to websites open in the normal browser, never inside the player.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://')) {
      event.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  const remember = () => {
    if (!win || normalBounds || win.isMinimized()) return;
    settings.maximized = win.isMaximized();
    if (!settings.maximized) settings.bounds = win.getBounds();
    saveSettings();
  };
  win.on('resize', remember);
  win.on('move', remember);

  win.on('close', event => {
    if (!quitting && settings.closeToTray && playing) {
      // Keep listening with the window closed; the tray icon brings it back.
      event.preventDefault();
      win.hide();
      showTray();
    }
  });
  win.on('closed', () => {
    win = null;
    rendererReady = false;
  });
  updateThumbar();
}

// Buttons under the window's preview when you hover over its taskbar icon.
function updateThumbar() {
  if (!win || process.platform !== 'win32') return;
  win.setThumbarButtons([
    { tooltip: 'Back 15 seconds', icon: icon('back.png'), click: () => send('back') },
    { tooltip: playing ? 'Pause' : 'Play', icon: icon(playing ? 'pause.png' : 'play.png'), click: () => send('toggle') },
    { tooltip: 'Forward 30 seconds', icon: icon('forward.png'), click: () => send('forward') },
  ]);
}

function showTray() {
  if (tray) return;
  tray = new Tray(icon('tray.png'));
  tray.setToolTip('Audio Book Player');
  tray.on('click', () => {
    showWindow();
    hideTray();
  });
  updateTray();
}

function hideTray() {
  tray?.destroy();
  tray = null;
}

function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Audio Book Player', click: () => { showWindow(); hideTray(); } },
    { label: playing ? 'Pause' : 'Play', click: () => send('toggle') },
    { label: 'Back 15 seconds', click: () => send('back') },
    { label: 'Forward 30 seconds', click: () => send('forward') },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

function setMini(on) {
  if (!win) return;
  if (on && !normalBounds) {
    normalBounds = win.isMaximized() ? null : win.getBounds();
    if (win.isMaximized()) win.unmaximize();
    normalBounds ||= win.getBounds();
    win.setMenuBarVisibility(false);
    win.setMinimumSize(320, 150);
    win.setContentSize(MINI.width, MINI.height);
    win.setAlwaysOnTop(true, 'floating');
  } else if (!on && normalBounds) {
    win.setAlwaysOnTop(false);
    win.setMenuBarVisibility(true);
    win.setMinimumSize(340, 180);
    win.setBounds(normalBounds);
    normalBounds = null;
  }
  buildMenu();
}

// ---------- Menu ----------

async function pick(kind) {
  const result = await dialog.showOpenDialog(win, kind === 'folder'
    ? { title: 'Open an audiobook folder', properties: ['openDirectory'] }
    : {
      title: 'Open an audiobook',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audiobooks and audio', extensions: ['m4b', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wav'] }],
    });
  return result.canceled ? [] : result.filePaths;
}

function buildMenu() {
  const mini = Boolean(normalBounds);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '&File',
      submenu: [
        { label: 'Open audiobook file…', accelerator: 'CmdOrCtrl+O', click: async () => openPaths(await pick('file')) },
        { label: 'Open audiobook folder…', accelerator: 'CmdOrCtrl+Shift+O', click: async () => openPaths(await pick('folder')) },
        { label: 'Library folders…', click: () => send('library-folders') },
        { type: 'separator' },
        {
          label: 'Keep playing in the tray when the window is closed',
          type: 'checkbox',
          checked: settings.closeToTray,
          click: item => { settings.closeToTray = item.checked; saveSettings(); },
        },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } },
      ],
    },
    {
      label: '&Playback',
      submenu: [
        { label: 'Play / pause', click: () => send('toggle') },
        { label: 'Back 15 seconds', click: () => send('back') },
        { label: 'Forward 30 seconds', click: () => send('forward') },
        { label: 'Previous chapter', click: () => send('prev') },
        { label: 'Next chapter', click: () => send('next') },
        { label: 'Add a bookmark', click: () => send('bookmark') },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Library', click: () => send('library') },
        { label: 'Read along', accelerator: 'CmdOrCtrl+R', click: () => send('read') },
        { label: 'Mini player', type: 'checkbox', checked: mini, accelerator: 'CmdOrCtrl+M', click: () => send('mini') },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Keyboard shortcuts', click: () => send('shortcuts') },
        { label: 'Developer tools', accelerator: 'F12', click: () => win?.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: `Audio Book Player ${app.getVersion()}`, enabled: false },
      ],
    },
  ]));
}

// ---------- Messages from the window ----------

ipcMain.handle('ready', () => {
  rendererReady = true;
  const paths = pendingPaths;
  pendingPaths = [];
  return paths;
});
ipcMain.handle('pick', (_e, kind) => pick(kind));
ipcMain.handle('read-book', (_e, target) => books.read(target, app.getPath('userData')));
ipcMain.handle('scan-library', () => books.scan(settings.libraryFolders, app.getPath('userData')));
ipcMain.handle('library-folders', () => settings.libraryFolders);
ipcMain.handle('set-library-folders', (_e, folders) => {
  settings.libraryFolders = [...new Set(folders.filter(f => typeof f === 'string' && path.isAbsolute(f)))];
  saveSettings();
  return settings.libraryFolders;
});
ipcMain.handle('show-in-folder', (_e, target) => {
  if (typeof target === 'string' && fs.existsSync(target)) shell.showItemInFolder(target);
});
ipcMain.on('playing', (_e, isPlaying) => {
  playing = Boolean(isPlaying);
  updateThumbar();
  updateTray();
});
ipcMain.on('mini', (_e, on) => setMini(Boolean(on)));

// ---------- Start ----------

if (!app.requestSingleInstanceLock()) {
  app.quit(); // already running: the running player opens the file instead
} else {
  app.on('second-instance', (_event, argv) => {
    openPaths(pathsFrom(argv));
    showWindow();
  });
  app.setAppUserModelId('io.github.sazzadrashid.audiobookplayer');
  app.whenReady().then(() => {
    handleAppProtocol();
    buildMenu();
    pendingPaths = pathsFrom(process.argv);
    createWindow();
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => app.quit());
}
