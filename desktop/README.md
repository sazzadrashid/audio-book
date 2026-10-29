# Audio Book Player for Windows

An audiobook player you install like any other program (like VLC). It plays audiobooks straight from your
folders, and shows the book's text while you listen when the book was made with the voice-clone tool.

## Installing

1. Double-click **`Audio Book Player Setup 1.0.0.exe`** (in `desktop\dist` after building, see below).
2. Windows may say **"Windows protected your PC"**, because the app isn't signed with a paid certificate.
   Click **More info → Run anyway**. You only see this once.
3. Choose where to install it (the suggested place is fine) and press **Install**.

It adds **Audio Book Player** to the Start menu and the desktop. To remove it: **Settings → Apps → Installed apps
→ Audio Book Player → Uninstall**.

## Opening audiobooks

- **Double-click an `.m4b` file**: it opens in the player.
- **Right-click an audio file → Open with → Audio Book Player** (MP3, M4A, FLAC, OGG and more). It doesn't take
  over your normal music player. Opening one chapter file of a book opens the whole book at that chapter.
- **Right-click a folder → Open with Audio Book Player** (on Windows 11: **Show more options** first).
- **Drag** files or folders onto the window, or use **File → Open audiobook file / folder** (Ctrl+O, Ctrl+Shift+O).
- **Library folders:** on the Library page, press **Add a folder…** and pick the folder where you keep audiobooks,
  for example the voice-clone tool's save folder. Books in it (and in folders inside it) appear by themselves;
  press **Look for new books** after adding more.

Books play from where they are: nothing is copied. The player remembers your place, speed and bookmarks for
every book. **Remove** takes a book out of the library but never deletes its files.

**M4B audiobooks** keep all their chapters in one file; the player reads the chapter marks, cover and title from it.

## While listening

Everything from the Audio Book website: **Read along** (text with the sentence and word being spoken highlighted;
tap a word to jump there), text size, fonts and colours, search, bookmarks and quotes, smart rewind, sleep timer,
any speed from 0.5× to 3×. Press <kbd>?</kbd> for keyboard shortcuts. Also:

- The **media keys** on your keyboard (play/pause, next, previous) work even when the player is in the background,
  and the player shows in Windows' media controls (the volume pop-up and the lock screen).
- **Taskbar buttons:** hover over the player's taskbar icon for back 15 s, play/pause and forward 30 s.
- **Mini player** (the button at the top right, or Ctrl+M): a small window that stays on top of other windows.
- **Keep playing with the window closed:** turn on **File → Keep playing in the tray when the window is closed**.
  The player then waits in the system tray (the small icons by the clock); click it to bring the window back.

## Building the installer (for developers)

```bash
cd desktop
npm install
node node_modules/electron/install.js   # newer npm doesn't run Electron's own download step
npm start                                # try it
npm run dist                             # makes dist/Audio Book Player Setup 1.0.0.exe
```

The window shows the website's player: `npm start` and `npm run dist` copy `../player` into `desktop/player`
first (without the voices and the libraries only "Make audiobook" needs). Desktop-only parts are in
`player/desktop.js`, which does nothing on the website. `main.js` serves the player as `app://player/` and book
files as `app://disk/<path>` (with range requests, for seeking), and handles opening files, menus, taskbar
buttons, mini player and tray. `books.js` reads books from disk (book.json, tags, M4B chapters, covers).
`build/installer.nsh` adds the "Open with" entries and the folder menu.

Set `AUDIO_BOOK_PLAYER_DATA=<folder>` to run with a separate library and settings (used for testing), and
`--remote-debugging-port=9333` to inspect the window with Playwright's `connectOverCDP`.
