// Copies the website's player (../player) into desktop/player, which the app shows in its window.
// Leaves out what only the website's "Make audiobook" page needs: the voices (about 600 MB) and the
// libraries that run them. Run by `npm start` and `npm run dist`.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const from = path.resolve(__dirname, '..', '..', 'player');
const to = path.resolve(__dirname, '..', 'player');
const SKIP = new Set(['voices', 'books', path.join('vendor', 'ort'), path.join('vendor', 'piper'), path.join('vendor', 'pdfjs'), path.join('vendor', 'lame')]);

fs.rmSync(to, { recursive: true, force: true });
let count = 0;
(function copy(relative) {
  for (const entry of fs.readdirSync(path.join(from, relative), { withFileTypes: true })) {
    const rel = path.join(relative, entry.name);
    if (SKIP.has(rel)) continue;
    if (entry.isDirectory()) {
      fs.mkdirSync(path.join(to, rel), { recursive: true });
      copy(rel);
    } else {
      fs.mkdirSync(path.join(to, relative), { recursive: true });
      fs.copyFileSync(path.join(from, rel), path.join(to, rel));
      count++;
    }
  }
})('');
console.log(`Copied ${count} player files into desktop/player.`);
