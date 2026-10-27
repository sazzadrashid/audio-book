# Audio Book

Listen to audiobooks in your browser, and turn e-books into audiobooks.

This project has two parts:

| Part | What it does |
| --- | --- |
| **Player** (`player/`) | A website for listening to audiobooks on your phone or computer. It remembers where you stopped. |
| **Converter** (`converter/`) | Turns an e-book (EPUB, PDF or TXT) into an audiobook with a natural-sounding voice, one MP3 file per chapter. |

You don't need to know how to code to use either one.

---

## The player

### What it can do

- A library of all your books, with how much of each is left
- Chapter list. It moves to the next chapter by itself.
- Back 15 seconds and forward 30 seconds
- Playback speed from 0.75× to 2.5×
- Sleep timer (5–60 minutes, or at the end of the chapter)
- **Remembers where you stopped** in every book, even after closing the browser
- Lock-screen and headphone controls on phones
- Light and dark mode
- Keyboard shortcuts on a computer: <kbd>Space</kbd> play/pause, <kbd>←</kbd> back 15 s, <kbd>→</kbd> forward 30 s

### Adding books

There are two ways to add books:

1. **Your own audio files.** Press **Add files** and choose all the MP3/M4A/M4B files of one book, or press **Add folder** and choose a folder. On a computer you can also drag files onto the page.
   These books are stored **only in that browser on that device**. Nothing is uploaded.
2. **Books made with the converter.** These are published with the website, so they show up on every device with an **Online** label.

### Putting the player online (one-time setup)

This makes the player a website you can open on your phone, at
`https://<your-github-name>.github.io/audio-book/`.

1. On GitHub, open this repository and go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Go to the **Actions** tab, open **Publish website**, and press **Run workflow**.
4. After a minute the website address shows on the **Settings → Pages** page.

The website updates by itself every time something in the `player` folder changes.

> **Tip:** On your phone, open the website and choose **Add to Home Screen**. It then opens like an app.

---

## The converter

### The easy way: ask Claude

1. **Upload your book.** On GitHub, open the `inbox` folder, press **Add file → Upload files**, drop in your `.epub`, `.pdf` or `.txt` file and press **Commit changes**.
2. **Open a Claude Code cloud session** on this repository (at [claude.ai/code](https://claude.ai/code)) and ask something like:
   > Convert inbox/my-book.epub into an audiobook and publish it.
3. Claude makes the audio, saves it in the repository, and the book appears on your player website a minute later.

Other things you can ask:

- *"Show me which chapters you find in inbox/my-book.pdf"*: checks the chapters first without making any audio
- *"Make just the first chapter so I can hear the voice"*
- *"Use a British female voice"* or *"Read it in Bangla"*
- *"Read a bit faster"*

**Cloud network setting needed.** The natural voices come from Microsoft's online speech service. A cloud session must be allowed to reach it. In the session's environment settings (the environment menu in the title bar → **Edit** → **Network access**), add `speech.platform.bing.com` under **Allowed domains**, or choose a broader access level. ([How to change it](https://code.claude.com/docs/en/cloud-environments#network-access).)
Without that, Claude can still use the offline voice (`--engine espeak`), but it sounds robotic.

### Voices

The default voice is `en-US-AriaNeural`. There are hundreds of voices in many languages. A few examples:

| Voice | Language |
| --- | --- |
| `en-US-AriaNeural`, `en-US-GuyNeural` | English (US) |
| `en-GB-SoniaNeural`, `en-GB-RyanNeural` | English (UK) |
| `en-IN-NeerjaNeural` | English (India) |
| `bn-BD-NabanitaNeural`, `bn-BD-PradeepNeural` | Bangla (Bangladesh) |
| `bn-IN-TanishaaNeural` | Bangla (India) |
| `hi-IN-SwaraNeural` | Hindi |

To see them all: `python converter/audiobook.py --list-voices en` (or `bn`, `fr`, …).

### Running it on your own computer

You need [Python](https://www.python.org/downloads/) 3.9 or newer. In a terminal, inside this folder:

```bash
pip install -r converter/requirements.txt
python converter/audiobook.py inbox/my-book.epub
```

Useful options:

| Option | What it does |
| --- | --- |
| `--dry-run` | Only show the chapters it found |
| `--limit 1` | Only make the first chapter (to try a voice) |
| `--voice en-GB-SoniaNeural` | Choose the voice |
| `--rate +10%` | Read 10% faster (`-10%` for slower) |
| `--title "..."` / `--author "..."` | Fix the title or author |
| `--engine espeak` | Offline robotic voice (needs `espeak-ng` and `ffmpeg` installed) |
| `--out some/folder` | Save somewhere other than `player/books` |
| `--force` | Remake chapters that already exist |

If it stops part-way (for example, the internet drops), run the same command again. It continues where it left off.

The result is a folder in `player/books/` with one MP3 per chapter and a `book.json` file. You can also copy that folder to any device and open it in the player with **Add folder**.

### Good to know

- **Only convert books you're allowed to.** A free GitHub account makes the repository and the website public, so anyone with the link can listen. Public-domain books (for example from [Project Gutenberg](https://www.gutenberg.org)) and your own writing are fine.
- **DRM-protected e-books** (most books bought from Kindle, Apple Books, etc.) can't be read.
- **Scanned PDFs** (photos of pages) have no text to read. Use an EPUB or TXT version instead.
- **Size:** an hour of audio is about 20 MB. GitHub Pages sites can be up to 1 GB, which is roughly 50 hours of audio.

---

## For developers

```
player/              Static website (plain HTML/CSS/JS, no build step)
  index.html
  style.css
  app.js             Library (IndexedDB), playback, sleep timer, media session
  books/             Converted books + index.json, published with the site
converter/
  audiobook.py       EPUB/PDF/TXT → chapters → MP3 (edge-tts or eSpeak NG)
  requirements.txt
tests/               pytest tests for the converter
inbox/               Drop books to convert here
```

- Run the player locally: `npx http-server player` (a server that supports range requests is needed for seeking; `python -m http.server` does not).
- Run the tests: `pip install -r converter/requirements.txt pytest && pytest -q`
