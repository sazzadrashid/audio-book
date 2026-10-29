# Audiobooks in your own voice

This folder turns a book (EPUB, PDF or TXT) into an audiobook read in a voice copied from a short recording.
It runs on this PC's NVIDIA graphics card, with the free [Chatterbox](https://github.com/resemble-ai/chatterbox)
voice model. Nothing is uploaded anywhere.

**Only use voices you're allowed to:** your own, or someone who has agreed. Every file made here carries an
inaudible watermark that marks it as AI-made.

## First time: install

Double-click **`install.bat`**. It downloads about 10 GB (Python, the voice software and the voice models) into
this folder, then checks the graphics card. It takes 30–90 minutes. When it says **All done**, close the window.

## Making an audiobook

1. Double-click **`start.bat`**. A page opens in your web browser. Keep the black window open while you use it.
2. Add the book.
3. Add a voice sample: one person talking clearly, with no music or background noise. Upload a recording
   (any format, including `.m4a` from a phone) or press the microphone button and read a paragraph aloud.
   The voice is mostly copied from the **first 10–15 seconds**, so use the ✂ button to keep your best 20–30
   seconds: drag the orange box over them (drag its edges to make it longer) and press **Trim**.
4. Tick the consent box. Leave **First chapter only** ticked for a quick try, then press **Make audiobook**.
5. Listen to the chapter on the page. If you like it, untick **First chapter only** and press the button again:
   it keeps the chapter it already made and carries on with the rest.

## Stopping and carrying on

Press **Stop** whenever you need the PC for something else. The piece being made is finished (a few seconds),
everything made so far is kept, and the graphics card is free again.

To carry on, pick the book under **Continue where you left off** at the top of the page and press **Continue**.
You don't need to add the book or the voice again; it uses the same voice, model and save folder as before.
This also works after closing the page or restarting the PC.

## Where the audiobook goes

In the folder shown under **Save audiobooks in** (press **Browse…** to choose another one; the page remembers
it). Each book gets its own folder there with one MP3 per chapter, a `.json` file per chapter with its text and
when each sentence and word is spoken (for reading along in the player), and `book.json` (the chapter list).
Keep the same save folder until a book is finished: the page warns you if you pick another one part-way.

To play a book on the Audio Book website: **Library → Add a folder**, then pick the book's folder.

## If something goes wrong

- **install.bat says the graphics card check failed:** update the NVIDIA driver (version 570 or newer) from
  nvidia.com, restart the PC and run `install.bat` again.
- **The voice doesn't sound like the sample:** use a cleaner recording in a quiet room, speaking the way you'd
  read a story aloud, at the pace you want the book read (the copy keeps the sample's pace).
- **A word is mumbled or repeated:** the voice model does this now and then. The tool listens back to every
  piece (with Whisper, a speech-to-text model) and makes it again when it doesn't match the book. If a piece
  still isn't right after 3 tries, the progress box lists where it is (chapter and minute) so you can listen.
- **"made before with a different voice":** tick **Start over** to remake the book with the new voice.
- **Any other error:** the message on the page says what happened; the black `start.bat` window has the details.

## Speed and quality on the RTX 5060 Ti (October 2026 test)

| Voice model | Audio made per minute of work | A 300-page novel (90,000 words, 9–10 hours of audio) |
|---|---|---|
| Turbo (recommended) | 3.2 minutes | about 3 hours |
| Original | 1.5 minutes | about 6½ hours |

Each Make or Continue first spends 20–30 seconds loading the voice model. In a 10-minute test chapter both
models made no mumbled stretches once the listen-back check was on (Turbo made two without it). The Original
model sounds a little more like the voice sample.
