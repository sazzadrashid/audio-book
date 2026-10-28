# Audio Book

A website that **turns PDF, EPUB and text books into audiobooks** and lets you listen to them.

- Choose a book. A natural-sounding computer voice reads it aloud and saves it as **MP3 files, one per chapter**.
- **Start listening after the first chapter**, while the rest is still being made.
- **Download** the finished MP3s as one `.zip` file to keep, share, or play in any app.
- **Everything happens in your browser.** Your books are never uploaded, and there's no account, server or fee.

You don't need to know how to code to use it.

---

## Using it

### Make an audiobook

1. Open the website and press **Make audiobook**.
2. Press **Choose a book** and pick a `.pdf`, `.epub` or `.txt` file (English).
3. Check the title and author, and pick one of the **10 voices** (female and male, American and British). Press **Play a sample** to hear it. Then set the reading speed: any speed from 0.6× to 2×, such as 0.75× or 1.3×.
   - **Delivery: Natural** (the default) reads one sentence at a time, the way a person reads aloud: short breaths at commas, proper pauses between sentences, longer ones between paragraphs and after chapter titles, with small changes in pace. It also reads things like "$10M", "Dr.", "Chapter IV" and "10:30 a.m." as words. **Classic** is the original, faster delivery; switch between them and play a sample to compare.
4. Press **Make audiobook**.
   - The first time, the voice is downloaded (about 63 MB). After that it's saved in the browser.
   - **Keep the page open** while it works. On a phone, keep the screen on.
   - Press **Start listening** as soon as the first chapter is ready.
5. When it's finished, press **Download MP3 files** to save them.

If you close the page or press **Stop**, the chapters made so far are kept. Press **Continue making** on the book in the Library to finish it later.

**How long does it take?** It depends on the device. On a recent computer, making the audio usually takes about a quarter of the listening time (a 10-hour book takes around 2–3 hours). Phones are slower.

### Listen

The **Library** shows all your books and how much of each is left. The player has:

- A chapter list. It moves to the next chapter by itself.
- Back 15 seconds and forward 30 seconds
- Any playback speed from 0.5× to 3× (slider, − / + in 0.05 steps, or quick picks)
- Sleep timer (5–60 minutes, or at the end of the chapter)
- **Remembers where you stopped** in every book
- Lock-screen and headphone controls on phones
- Keyboard shortcuts on a computer: <kbd>Space</kbd> play/pause, <kbd>←</kbd> back 15 s, <kbd>→</kbd> forward 30 s

Already have audiobook files (MP3, M4A, M4B)? Use **Add audio files** or **Add a folder** at the bottom of the Library.

### Good to know

- Books and audio are stored **in that browser on that device**. A book made on your laptop isn't on your phone. Download the MP3s and copy them over, or make it again there.
- **Copy-protected e-books** (most books bought from Kindle, Apple Books, etc.) can't be read.
- **Scanned PDFs** (photos of pages) have no text to read. Use an EPUB or text version instead.
- Free public-domain books in EPUB and text format: [Project Gutenberg](https://www.gutenberg.org), [Standard Ebooks](https://standardebooks.org).
- The voices are free for personal, non-commercial use (see [player/vendor/README.md](player/vendor/README.md)).

---

## Putting the website online (one-time setup)

This makes the app a website you can open on any device, at
`https://<your-github-name>.github.io/audio-book/`.

1. On GitHub, open this repository and go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Go to the **Actions** tab, open **Publish website**, and press **Run workflow**.
4. After a minute the website address shows on the **Settings → Pages** page.

The website updates by itself every time something in the `player` folder changes.

> **Tip:** On your phone, open the website and choose **Add to Home Screen**. It then opens like an app.

---

## Advanced: command-line converter

`converter/audiobook.py` does the same job from a terminal. It can also use Microsoft's online voices, which cover many more languages, including Bangla (`bn-BD-NabanitaNeural`, `bn-BD-PradeepNeural`). Books it makes go into `player/books/` and appear on the website for everyone, marked **Online**.

```bash
pip install -r converter/requirements.txt
python converter/audiobook.py my-book.epub                      # make it
python converter/audiobook.py my-book.pdf --dry-run             # only show the chapters found
python converter/audiobook.py my-book.txt --voice en-GB-SoniaNeural --rate +10%
python converter/audiobook.py --list-voices bn                  # list voices for a language
```

Other options: `--limit 1` (first chapter only), `--title`, `--author`, `--out`, `--force`, and `--engine espeak` (offline robotic voice). Run `python converter/audiobook.py --help` for details.

Books published this way are **public** on a free GitHub account, so only publish books you're allowed to share.

---

## For developers

```
player/                 The website (plain HTML/CSS/JS, no build step)
  index.html, style.css
  app.js                Library (IndexedDB), player, downloads
  convert.js            "Make audiobook" page: job queue, worker pool, resume
  book-text.js          PDF/EPUB/TXT text extraction, PDF paragraphs and running headers, chapters
  speech-text.js        Text clean-up for speech, sentence splitting, pauses and pacing
  tts-worker.js         Piper text-to-speech + MP3 encoding in a Web Worker
  voices/               Piper voice models (.onnx + .onnx.json)
  vendor/               ONNX Runtime Web, piper-phonemize, lamejs, PDF.js, JSZip
  books/                Books published with the site (from the CLI converter) + index.json
converter/audiobook.py  Command-line converter (edge-tts or eSpeak NG)
tests/                  pytest tests for the command-line converter
```

- Run the website locally: `npx http-server player`. You need a server that supports range requests, or seeking in audio breaks; `python -m http.server` doesn't support them.
- Run the tests: `pip install -r converter/requirements.txt pytest && pytest -q` and `node --test tests/*.test.js`
- Adding a voice: put a Piper `.onnx` and `.onnx.json` in `player/voices/` and add it to `VOICES` in `player/convert.js`.
