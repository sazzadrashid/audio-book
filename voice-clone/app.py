"""The voice-clone page. start.bat runs this; it opens in the web browser on this PC only."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys

os.environ.setdefault("GRADIO_ANALYTICS_ENABLED", "False")

from pathlib import Path  # noqa: E402

# voiceclone first: it sets where the voice models are kept, which must happen before gradio loads huggingface_hub.
from voiceclone import HERE, OUTPUT_DIR, PAGE_MARK, WORK_DIR, unfinished_books  # noqa: E402

import gradio as gr  # noqa: E402

MODEL_CHOICES = {
    "Turbo: fastest (recommended)": "turbo",
    "Original: a little closer to the voice, about twice as slow": "original",
}
SETTINGS_FILE = HERE / "settings.json"  # remembers the chosen save folder
STOP_FILE = WORK_DIR / "stop-requested"  # the helper program checks for this before each piece


# ---------- Save folder ----------


def saved_folder() -> str:
    try:
        return json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))["output_dir"]
    except (OSError, KeyError, json.JSONDecodeError):
        return str(OUTPUT_DIR)


def use_folder(text: str) -> Path:
    """Check the folder typed or picked on the page, create it if needed, and remember it."""
    folder = Path(text.strip().strip('"') or OUTPUT_DIR).expanduser()
    if not folder.is_absolute():
        raise gr.Error("Use a full folder path, like D:\\Audiobooks (or press Browse…).")
    try:
        folder.mkdir(parents=True, exist_ok=True)
    except OSError as err:
        raise gr.Error(f"Can't use the folder {folder}: {err.strerror or err}.") from err
    SETTINGS_FILE.write_text(json.dumps({"output_dir": str(folder)}), encoding="utf-8")
    return folder


def browse(current: str) -> str:
    """Open the Windows folder picker (the page runs on this PC, so the window appears here)."""
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)  # in front of the browser
    start = current if current and Path(current).is_dir() else str(OUTPUT_DIR)
    chosen = filedialog.askdirectory(parent=root, initialdir=start, title="Choose where to save audiobooks")
    root.destroy()
    if not chosen:
        return current
    return str(use_folder(chosen))


def open_folder(current: str):
    os.startfile(use_folder(current))


# ---------- Unfinished books ----------


def unfinished_choices():
    jobs = unfinished_books()
    choices = [(f"{job['title']}: {job['done']} of {len(job['names'])} chapters done", job["slug"]) for job in jobs]
    return gr.update(choices=choices, value=choices[0][1] if choices else None)


# ---------- Making ----------


def preview_copy(chapter: Path) -> str:
    """A copy of the chapter for the page's player (the page can only play files inside this folder)."""
    folder = WORK_DIR / "preview"
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True)
    return str(shutil.copy(chapter, folder / chapter.name))


def run(book_path, voice_path, model, sample, start_over, out_root, progress):
    """Make the audiobook in a separate helper program, streaming its progress to the page.

    The helper loads the voice model, makes the audio and then closes, which hands all of its memory
    (graphics card and RAM) back to Windows. Loading a model twice in one program crashes, and if the
    voice software ever does crash, only the helper goes down, not the page.
    """
    STOP_FILE.parent.mkdir(parents=True, exist_ok=True)
    STOP_FILE.unlink(missing_ok=True)
    command = [
        sys.executable, "-u", str(HERE / "voiceclone.py"), str(book_path), str(voice_path),
        "--model", model, "--out", str(out_root), "--for-page", "--stop-file", str(STOP_FILE),
    ]
    command += ["--sample"] if sample else []
    command += ["--start-over"] if start_over else []
    helper = subprocess.Popen(
        command, cwd=HERE, stdout=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )
    log: list[str] = []
    chapter = None
    folder = ""
    error = None
    stopped = finished = False
    progress(0, desc="Reading the book")
    try:
        for line in helper.stdout:
            if not line.startswith(PAGE_MARK):
                print(line, end="")  # the voice software's own messages go to the black window
                continue
            update = json.loads(line[len(PAGE_MARK):])
            if "error" in update:
                error = update["error"]
                continue
            if update["status"]:
                progress(update["fraction"], desc=update["status"])
            if update["book_dir"]:
                folder = f"**Saved in:** `{update['book_dir']}`"
            if update["chapter_file"]:
                chapter = preview_copy(Path(update["chapter_file"]))
            stopped = stopped or update["stopped"]
            if update["message"] or update["chapter_file"]:
                if update["message"]:
                    log.append(update["message"])
                yield "\n".join(log), chapter, folder, gr.update()
        finished = True
    finally:
        if not finished and helper.poll() is None:  # the page was closed mid-way: let the helper save and stop
            STOP_FILE.touch()
            try:
                helper.wait(timeout=120)
            except subprocess.TimeoutExpired:
                helper.kill()
    code = helper.wait()
    if error:
        raise gr.Error(error + (" The black start.bat window has the details." if error.startswith("Something") else ""))
    if code != 0:
        raise gr.Error(
            f"The voice software stopped unexpectedly (code {code}). Everything finished before that is kept: "
            "press Continue to carry on. If it happens again, send a screenshot of the black start.bat window."
        )
    if stopped:
        log.append("The graphics card is free for other programs now.")
    yield "\n".join(log), chapter, folder, unfinished_choices()


def make(book_file, voice_file, consent, model_label, sample_only, start_over, out_dir, progress=gr.Progress()):
    if not book_file:
        raise gr.Error("Add a book file first (.epub, .pdf or .txt).")
    if not voice_file:
        raise gr.Error("Add a voice sample first: upload a recording or record one with the microphone.")
    if not consent:
        raise gr.Error("Tick the box to confirm the speaker agreed to having their voice cloned.")
    out_root = use_folder(out_dir)
    yield from run(book_file, voice_file, MODEL_CHOICES[model_label], sample_only, start_over, out_root, progress)


def carry_on(slug, progress=gr.Progress()):
    job = next((job for job in unfinished_books() if job["slug"] == slug), None)
    if job is None:
        raise gr.Error("Pick a book from the list first.")
    # Continue makes the rest of the book, with the same voice, model and folder as before.
    yield from run(job["book_path"], job["voice_path"], job["model"], False, False, Path(job["out_dir"]), progress)


def request_stop():
    STOP_FILE.parent.mkdir(parents=True, exist_ok=True)
    STOP_FILE.touch()
    gr.Info("Stopping after the piece being made now (a few seconds). Everything made so far is kept.")


with gr.Blocks(title="Voice clone audiobooks") as page:
    gr.Markdown(
        "# Audiobook in your own voice\n"
        "1. Add a book. 2. Add a clean 10–30 second recording of one person speaking (no music or noise). "
        "3. Tick the consent box and press **Make audiobook**.\n\n"
        "Start with **First chapter only** to hear how it sounds. You can press **Stop** at any time: "
        "everything made so far is kept, and **Continue** carries on from there."
    )
    with gr.Row(equal_height=True):
        unfinished = gr.Dropdown(label="Continue where you left off", choices=[], scale=4)
        carry_on_button = gr.Button("Continue", scale=1)
    with gr.Row():
        book = gr.File(label="Book (.epub, .pdf or .txt)", file_types=[".epub", ".pdf", ".txt"], type="filepath")
        voice = gr.Audio(label="Voice sample (upload, or record with the microphone)", sources=["upload", "microphone"], type="filepath")
    consent = gr.Checkbox(
        label="This is my own voice, or the speaker has agreed to have their voice cloned for this audiobook."
    )
    with gr.Row():
        model = gr.Radio(list(MODEL_CHOICES), value=next(iter(MODEL_CHOICES)), label="Voice model")
        with gr.Column():
            sample_only = gr.Checkbox(value=True, label="First chapter only (a quick sample)")
            start_over = gr.Checkbox(label="Start over (delete the chapters made before and make them again)")
    with gr.Row(equal_height=True):
        out_dir = gr.Textbox(label="Save audiobooks in", value=saved_folder, scale=4)
        browse_button = gr.Button("Browse…", scale=1)
    with gr.Row():
        go = gr.Button("Make audiobook", variant="primary")
        stop = gr.Button("Stop")
        folder_button = gr.Button("Open the save folder")
    folder = gr.Markdown()
    latest = gr.Audio(label="Latest finished chapter", type="filepath", interactive=False)
    log = gr.Textbox(label="Progress", lines=12, max_lines=30, autoscroll=True)
    gr.Markdown(
        "To listen on the Audio Book website: **Library → Add a folder**, then pick the book's folder "
        "inside your save folder. Every file made here carries an inaudible watermark that marks it as AI-made."
    )

    outputs = [log, latest, folder, unfinished]
    # Both buttons use the graphics card, so only one of them runs at a time.
    go.click(make, [book, voice, consent, model, sample_only, start_over, out_dir], outputs, concurrency_id="gpu")
    carry_on_button.click(carry_on, [unfinished], outputs, concurrency_id="gpu")
    stop.click(request_stop, concurrency_limit=None)
    browse_button.click(browse, [out_dir], [out_dir])
    folder_button.click(open_folder, [out_dir])
    page.load(unfinished_choices, None, [unfinished])


if __name__ == "__main__":
    print("Opening the voice-clone page in your web browser (only this PC can see it).")
    print("Keep this window open while you use it. Close it to stop.")
    _app, url, _share = page.queue(default_concurrency_limit=1).launch(
        server_name="127.0.0.1", inbrowser=True, quiet=True, prevent_thread_lock=True
    )
    print(f"If the page doesn't open by itself, go to {url} in your web browser.")
    page.block_thread()
