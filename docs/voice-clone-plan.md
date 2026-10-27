# Plan: audiobooks in a cloned voice (runs on the owner's PC)

Handoff notes from a cloud session (no GPU there), so a session on the owner's PC can build and test this.

## Goal

The owner uploads a book (PDF/EPUB/TXT) and a short voice recording (10–30 s, one speaker, clean). They get an
audiobook read in that voice: one MP3 per chapter plus `book.json`. The folder must open in the Audio Book
website via **Library → Add a folder**. The owner is not a programmer, so everything is double-click: no typing commands.

Only clone voices the speaker has agreed to (the owner's own, or a voice artist who consented). Show a consent
checkbox before making audio.

## Owner's PC

- Windows, NVIDIA **RTX 5060 Ti 16 GB** (Blackwell, sm_120), Ryzen 7 7700, 16 GB RAM.

## Chosen model: Chatterbox (resemble-ai/chatterbox)

- MIT licence. Every output carries an inaudible PerTh watermark.
- English: Chatterbox / Turbo. The multilingual version covers 23 languages; Bangla is not confirmed.
- **Pitfall:** `chatterbox-tts` pins `torch==2.6.0` / `torchaudio==2.6.0`, which has no sm_120 kernels, so it fails on
  RTX 50-series ("no kernel image is available"). Fix: install chatterbox, then reinstall torch/torchaudio from the
  CUDA 12.8 index (`--index-url https://download.pytorch.org/whl/cu128`, torch 2.7+). Verify that
  `torch.cuda.get_arch_list()` contains `sm_120` and that a small CUDA operation runs.
- Needs a recent NVIDIA driver (570+).

## What to build (in `voice-clone/`)

1. `install.bat`, run once:
   - installs uv (which provides Python 3.11) and creates `.venv`
   - installs chatterbox-tts, then overrides torch with the cu128 build
   - runs a GPU check and prints a plain-English success or failure message
2. `start.bat`: starts a local Gradio page (localhost only) with these controls:
   - book upload
   - voice-sample upload
   - consent checkbox
   - "first chapter only" sample option
   - Make audiobook button
   - per-chapter progress display
   - resume: skip chapters already made
3. Reuse the chapter splitting from `converter/audiobook.py` (`read_book`). Split chapter text into sentence chunks
   (Chatterbox works best on short inputs), generate each, join them with short pauses, and encode MP3 (ffmpeg via
   `imageio-ffmpeg`, or `lameenc`).
4. Write the output to `voice-clone/output/<book>/` with `NN - Title.mp3` files and a `book.json` in the same format
   as `converter/audiobook.py`.

## Test on the PC

- GPU check passes. A one-chapter sample sounds like the reference voice. Measure the speed (seconds of audio per
  second of work) and tell the owner how long a whole book will take.
