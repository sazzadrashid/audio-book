# Audio Book

Two parts: a static audiobook player website (`player/`) and a Python converter that turns EPUB/PDF/TXT into one MP3 per chapter (`converter/audiobook.py`). The owner is not a programmer — explain things in plain words and avoid jargon.

## Converting a book (the usual request)

1. `pip install -r converter/requirements.txt`
2. Check chapters first: `python converter/audiobook.py inbox/<file> --dry-run`. If the chapters look wrong (one huge "Full book", contents entries, etc.), say so before making audio.
3. Convert: `python converter/audiobook.py inbox/<file>` (add `--voice`, `--rate`, `--title`, `--author` as asked). Output goes to `player/books/<slug>/` and `player/books/index.json` is rebuilt.
4. Commit the new `player/books/` files and push. Pushing to `main` republishes the website (`.github/workflows/pages.yml`).

Voices: online voices via edge-tts need network access to `speech.platform.bing.com`. If the cloud environment blocks it, tell the owner how to allow that host (environment settings → Network access → Allowed domains) rather than silently switching voices. The offline fallback is `--engine espeak` (needs `apt-get install -y espeak-ng ffmpeg`); only use it if the owner agrees, since it sounds robotic.

Remind the owner that a free GitHub account makes the site public, so only public-domain or their own books should be published.

## Development

- Player: plain HTML/CSS/JS, no build step, no dependencies. Keep it that way. Local books live in IndexedDB; published books come from `player/books/index.json`.
- Preview the player with `npx http-server player` — `python -m http.server` doesn't support range requests, so audio seeking breaks there.
- Tests: `pytest -q` (the end-to-end test needs `espeak-ng` and `ffmpeg`).
