# Audio Book

A static website (`player/`, published with GitHub Pages) that turns PDF/EPUB/TXT books into MP3 audiobooks **in the browser** and plays them. There's also a command-line converter (`converter/audiobook.py`). The owner is not a programmer: explain things in plain words, avoid jargon, and give click-by-click steps for anything they have to do on GitHub.

## How the website works

- `book-text.js` reads the book (PDF.js for PDF, JSZip for EPUB) and splits it into chapters. For PDFs it rebuilds paragraphs from indents, gaps and short last lines, and drops running headers and footers. Its rules mirror `converter/audiobook.py` (the converter can't see indents, but does drop headers); keep the two in step.
- `speech-text.js` prepares text for the voice ("Natural" delivery): rewrites things Piper reads badly ($10M, Chapter IV, U.S., 10:30 a.m., big numbers), splits sentences, and plans pauses and pace. Headings are spoken together with the next sentence, because several voices mumble a heading on its own; the worker then widens the gap after the heading. It's plain functions, tested with `node --test tests/*.test.js`.
- Piper's expression settings (noise_scale, noise_w) barely change the pitch and add mistakes, so they stay at the voice defaults. Norman and John (LibriVox-trained) drag out "Chapter One"; `synthesizeChecked` remakes overly long sentences faster instead of dropping them.
- `convert.js` stores the chapter texts in IndexedDB (`jobs` store), then runs several `tts-worker.js` workers. Each loads a Piper voice from `player/voices/` with ONNX Runtime Web, phonemizes with piper-phonemize (WASM), and encodes MP3 with lamejs. Finished chapters are saved straight into the library, so playback can start early and making can resume after a reload.
- `app.js` holds the library (IndexedDB `books` + `files`), the player, and the zip download. Use `db.updateBook` for read-modify-write so the converter and player don't overwrite each other.
- Plain HTML/CSS/JS with no build step and no CDN. Third-party code is vendored in `player/vendor/` (see its README for versions and licences). Keep it that way.

## Testing

- Serve with `npx http-server player -p 8766` (it needs range requests; `python -m http.server` breaks audio seeking), then drive it with Playwright. Chromium is preinstalled.
- Converter tests: `pytest -q`. The end-to-end test needs `espeak-ng` and `ffmpeg`. Speech text tests: `node --test tests/*.test.js`.

## Command-line converter

`python converter/audiobook.py <file>` writes to `player/books/<slug>/` and rebuilds `player/books/index.json`. The site then lists those books as "Online". Its default voices (edge-tts) need network access to `speech.platform.bing.com`. If a cloud session blocks that host, tell the owner how to allow it (environment settings → Network access → Allowed domains) instead of quietly switching to `--engine espeak`. Remind the owner that published books are public on a free GitHub account.
