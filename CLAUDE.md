# Audio Book

A static website (`player/`, published with GitHub Pages) that turns PDF/EPUB/TXT books into MP3 audiobooks **in the browser** and plays them. There's also a command-line converter (`converter/audiobook.py`). The owner is not a programmer: explain things in plain words, avoid jargon, and give click-by-click steps for anything they have to do on GitHub.

## How the website works

- `book-text.js` reads the book (PDF.js for PDF, JSZip for EPUB) and splits it into chapters. Its rules mirror `converter/audiobook.py`; keep the two in step.
- `convert.js` stores the chapter texts in IndexedDB (`jobs` store), then runs several `tts-worker.js` workers. Each loads a Piper voice from `player/voices/` with ONNX Runtime Web, phonemizes with piper-phonemize (WASM), and encodes MP3 with lamejs. Finished chapters are saved straight into the library, so playback can start early and making can resume after a reload.
- `app.js` holds the library (IndexedDB `books` + `files`), the player, and the zip download. Use `db.updateBook` for read-modify-write so the converter and player don't overwrite each other.
- Plain HTML/CSS/JS with no build step and no CDN. Third-party code is vendored in `player/vendor/` (see its README for versions and licences). Keep it that way.

## Testing

- Serve with `npx http-server player -p 8766` (it needs range requests; `python -m http.server` breaks audio seeking), then drive it with Playwright. Chromium is preinstalled.
- Converter tests: `pytest -q`. The end-to-end test needs `espeak-ng` and `ffmpeg`.

## Command-line converter

`python converter/audiobook.py <file>` writes to `player/books/<slug>/` and rebuilds `player/books/index.json`. The site then lists those books as "Online". Its default voices (edge-tts) need network access to `speech.platform.bing.com`. If a cloud session blocks that host, tell the owner how to allow it (environment settings → Network access → Allowed domains) instead of quietly switching to `--engine espeak`. Remind the owner that published books are public on a free GitHub account.
