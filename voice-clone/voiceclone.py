#!/usr/bin/env python3
"""Make an audiobook in a cloned voice with Chatterbox, on the local NVIDIA graphics card.

app.py (the page start.bat opens) uses this. It also runs on its own:
    .venv\\Scripts\\python voiceclone.py book.epub my-voice.wav --sample
    .venv\\Scripts\\python voiceclone.py --download      # fetch the voice models
"""

from __future__ import annotations

import argparse
import contextlib
import difflib
import hashlib
import io
import json
import os
import re
import shutil
import sys
import textwrap
import time
import traceback
import warnings
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterator, NamedTuple

HERE = Path(__file__).resolve().parent
OUTPUT_DIR = HERE / "output"
WORK_DIR = HERE / "work"  # half-made chapters, kept outside the book folder so the player never sees them

# Keep the voice models inside this folder, and keep the console quiet.
os.environ.setdefault("HF_HOME", str(HERE / "models"))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_VERBOSITY", "error")  # hides "unauthenticated requests": no account is neededwarnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", category=UserWarning)

sys.path.insert(0, str(HERE.parent / "converter"))
from audiobook import ConverterError, read_book, safe_filename, slugify  # noqa: E402

import numpy as np  # noqa: E402

MODELS = {  # name, where it is on Hugging Face, and the files it needs (the folders hold other models too)
    "turbo": (
        "Chatterbox Turbo",
        "ResembleAI/chatterbox-turbo",
        ["ve.safetensors", "t3_turbo_v1.safetensors", "s3gen_meanflow.safetensors", "conds.pt", "*.json", "*.txt"],
    ),
    "original": (
        "Chatterbox",
        "ResembleAI/chatterbox",
        ["ve.safetensors", "t3_cfg.safetensors", "s3gen.safetensors", "tokenizer.json", "conds.pt"],
    ),
}
DEFAULT_MODEL = "turbo"
CHUNK_CHARS = 250  # Chatterbox is most reliable on a sentence or two at a time
HEADING_CHARS = 40  # paragraphs shorter than this are treated as headings
CLAUSE_PAUSE = 0.12  # seconds of silence where a long sentence was split
SENTENCE_PAUSE = 0.3  # between sentences in one paragraph
PARAGRAPH_PAUSE = 0.75  # and between paragraphs
SAMPLE_MIN_WORDS = 300  # "first chapter only" skips title pages and contents shorter than this
MIN_VOICE_SECONDS = 5
MP3_KBPS = 64
CHARS_PER_SECOND = 15  # typical narration pace, used to spot runaway or cut-off audio
MAX_TRIES = 3  # times a piece is made before keeping the best try
PAGE_MARK = "@@voiceclone "  # starts each progress line sent to the page (other output goes to the console)
WHISPER_MODEL = "base.en"  # listens back to each piece (about 140 MB)
WHISPER_DIR = HERE / "models" / "whisper"
ABBREVIATIONS = re.compile(r"\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|Prof|Rev|Gen|Col|Capt|Lt|Mt|vs|etc|e\.g|i\.e|No)\.$", re.I)


# ---------- Text ----------


def roman_to_int(numeral: str) -> int:
    values = {"i": 1, "v": 5, "x": 10, "l": 50, "c": 100, "d": 500, "m": 1000}
    digits = [values[ch] for ch in numeral.lower()]
    return sum(-d if d < nxt else d for d, nxt in zip(digits, digits[1:] + [0]))


def speakable(text: str) -> str:
    """'CHAPTER IV.' -> 'Chapter 4.', so the voice doesn't say 'chapter eye vee'.
    Also drops the _underscores_ and *asterisks* some books use for italics: the voice says them as noises."""
    text = re.sub(r"[_*]+", "", text)
    return re.sub(
        r"\b(chapter|part|book)\s+([IVXLCDM]+)\b",
        lambda m: f"{m[1].capitalize()} {roman_to_int(m[2])}",
        text,
        flags=re.I,
    )


def split_sentences(paragraph: str) -> list[str]:
    # A sentence ends at . ! ? (maybe followed by a closing quote) when the next one starts with a capital.
    parts = re.split(r"(?:(?<=[.!?…])|(?<=[.!?…][\"'”’)\]]))\s+(?=[\"'“‘(\[]?[A-Z0-9])", paragraph.strip())
    sentences: list[str] = []
    for part in parts:
        if sentences and ABBREVIATIONS.search(sentences[-1]):
            sentences[-1] += " " + part  # "Mr. Smith" is one sentence
        elif part:
            sentences.append(part)
    return sentences


def split_long(sentence: str, limit: int) -> list[str]:
    """Break a sentence that's too long at commas, semicolons or dashes, then at spaces."""
    if len(sentence) <= limit:
        return [sentence]
    pieces: list[str] = []
    for clause in re.split(r"(?<=[,;:—–])\s+", sentence):
        for part in textwrap.wrap(clause, limit, break_long_words=False, break_on_hyphens=False):
            if pieces and len(pieces[-1]) + len(part) + 1 <= limit:
                pieces[-1] += " " + part
            else:
                pieces.append(part)
    return pieces


class Piece(NamedTuple):
    text: str
    pause: float  # seconds of silence after it
    heading: int = 0  # how many characters at the start are a heading, shown on its own line when reading along


def chunk_text(text: str, limit: int = CHUNK_CHARS) -> list[Piece]:
    """Split chapter text into short pieces, each with the pause that follows it."""
    chunks: list[Piece] = []
    heading = ""
    for paragraph in speakable(text).split("\n\n"):
        paragraph = paragraph.strip()
        if len(paragraph) < HEADING_CHARS:
            # Headings are spoken with the paragraph after them: on their own they come out mumbled.
            if re.search(r"\w", paragraph):
                heading += paragraph + ("" if re.search(r"[.!?:;…]$", paragraph) else ".") + " "
            continue
        first = len(chunks)
        current = ""
        for sentence in split_sentences(heading + paragraph):
            for piece in split_long(sentence, limit):
                if current and len(current) + len(piece) + 1 > limit:
                    chunks.append(Piece(current, pause_after(current)))
                    current = piece
                else:
                    current = f"{current} {piece}".strip()
        if current:
            chunks.append(Piece(current, PARAGRAPH_PAUSE))
        heading = heading.strip()
        if heading and first < len(chunks) and (chunks[first].text + " ").startswith(heading + " "):
            chunks[first] = chunks[first]._replace(heading=len(heading))
        heading = ""
    if heading:
        chunks.append(Piece(heading.strip(), PARAGRAPH_PAUSE))
    return chunks


def pause_after(chunk: str) -> float:
    """A full pause after a sentence, a short one where a long sentence was split at a comma."""
    return SENTENCE_PAUSE if re.search(r"[.!?…][\"'”’)\]]*$", chunk) else CLAUSE_PAUSE


# ---------- Audio ----------


def trim_silence(audio: np.ndarray, sr: int) -> np.ndarray:
    """Cut the quiet start and end of a piece, so our own pauses set the rhythm."""
    frame = sr // 100
    frames = len(audio) // frame
    if frames < 3:
        return audio
    rms = np.sqrt((audio[: frames * frame].reshape(frames, frame) ** 2).mean(axis=1))
    loud = np.flatnonzero(rms > rms.max() * 0.02)  # 34 dB below the loudest part
    if not len(loud):
        return audio
    start = max(0, loud[0] - 2) * frame
    end = min(frames, loud[-1] + 6) * frame
    return audio[start:end]


def encode_mp3(audio: np.ndarray, sr: int, path: Path) -> None:
    import lameenc

    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
    encoder = lameenc.Encoder()
    encoder.set_bit_rate(MP3_KBPS)
    encoder.set_in_sample_rate(sr)
    encoder.set_channels(1)
    encoder.set_quality(2)
    path.write_bytes(encoder.encode(pcm.tobytes()) + encoder.flush())


def prepare_voice(sample: Path) -> Path:
    """Convert any recording (.m4a from a phone, .mp3, .ogg, .wav…) to a plain WAV file the voice model can read."""
    import subprocess

    import imageio_ffmpeg

    target = WORK_DIR / "voices" / f"{file_id(sample)}.wav"
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_suffix(".part.wav")
        result = subprocess.run(
            [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-i", str(sample), "-ac", "1", "-ar", "24000", str(partial)],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            partial.unlink(missing_ok=True)
            raise ConverterError(f"Couldn't read the voice sample. Is it an audio file? ({result.stderr.strip()[-200:]})")
        os.replace(partial, target)
    return target


def voice_seconds(path: Path) -> float:
    import librosa

    return float(librosa.get_duration(path=str(path)))


# ---------- The voice model ----------


class Narrator:
    """Loads a Chatterbox model once, then speaks text in the voice of a sample recording."""

    def __init__(self, model: str = DEFAULT_MODEL, check: bool = True):
        import torch

        if not torch.cuda.is_available():
            raise ConverterError("No NVIDIA graphics card found. Run install.bat again and read its message.")
        self.model_name = model
        path = download_model(model)
        # Load a model at most once per program: loading one again crashes Windows (access violation in
        # safetensors' memory-mapped reader) and leaves gigabytes of RAM behind. The page runs each job in
        # its own program for this reason.
        if model == "turbo":
            from chatterbox.tts_turbo import ChatterboxTurboTTS

            self.tts = ChatterboxTurboTTS.from_local(path, "cuda")
        else:
            from chatterbox.tts import ChatterboxTTS

            self.tts = ChatterboxTTS.from_local(path, "cuda")
        self.sr = self.tts.sr
        self.voice_id = ""
        self.listener = Listener() if check else None

    def set_voice(self, sample: Path) -> None:
        voice_id = file_id(sample)
        if voice_id != self.voice_id:
            self.tts.prepare_conditionals(str(sample))
            self.voice_id = voice_id

    def speak(self, text: str) -> tuple[np.ndarray, int, int]:
        """Speak text. Returns the audio, how many tries it took, and how many words still sound wrong."""
        import torch

        best, best_errors = None, 0
        for tries in range(1, MAX_TRIES + 1):
            # Chatterbox prints progress bars for every piece, which would flood the start.bat window.
            with torch.inference_mode(), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                wav = self.tts.generate(text)
            audio = trim_silence(wav.squeeze(0).float().cpu().numpy(), self.sr)
            # Now and then the model mumbles, repeats words or babbles on; another try usually fixes it.
            errors = self.problems(text, audio)
            if best is None or errors < best_errors:
                best, best_errors = audio, errors
            if not errors:
                break
        return best, tries, best_errors

    def problems(self, text: str, audio: np.ndarray) -> int:
        """0 if the audio says the text, otherwise roughly how many words are wrong."""
        expected = len(text) / CHARS_PER_SECOND
        seconds = len(audio) / self.sr
        length_wrong = not expected * 0.4 <= seconds <= expected * 2.5 + 2
        if self.listener is None:
            return 100 if length_wrong else 0
        wanted = words_of(text)
        errors, longest = compare_words(wanted, words_of(self.listener.hear(audio, self.sr)))
        # Whisper itself mishears the odd word (names, numbers), so allow a little slack.
        if not length_wrong and longest < 3 and errors <= max(1, len(wanted) * 0.15):
            return 0
        return errors + (100 if length_wrong else 0)


class Listener:
    """Whisper, a speech-to-text model, used to check each piece says what the book says."""

    def __init__(self):
        import whisper

        self.model = whisper.load_model(WHISPER_MODEL, device="cuda", download_root=str(WHISPER_DIR))

    def mel(self, audio: np.ndarray, sr: int):
        import librosa
        import whisper

        audio16k = librosa.resample(audio, orig_sr=sr, target_sr=16000).astype(np.float32)
        mel = whisper.log_mel_spectrogram(whisper.pad_or_trim(audio16k), self.model.dims.n_mels)
        return mel.to(self.model.device), len(audio16k)

    def hear(self, audio: np.ndarray, sr: int) -> str:
        import whisper

        mel, _samples = self.mel(audio, sr)
        options = whisper.DecodingOptions(language="en", without_timestamps=True, fp16=True)
        return whisper.decode(self.model, mel, options).text

    def word_times(self, text: str, audio: np.ndarray, sr: int) -> list[list]:
        """When each word of text is spoken in audio: [[first char, last char + 1, seconds], ...].

        Whisper lines up the book's own words with the audio (rather than writing down what it hears),
        so the read-along highlight follows exactly the text on screen.
        """
        import whisper
        from whisper.timing import find_alignment
        from whisper.tokenizer import get_tokenizer

        mel, samples = self.mel(audio, sr)
        tokenizer = get_tokenizer(self.model.is_multilingual, language="en", task="transcribe")
        frames = min(samples // whisper.audio.HOP_LENGTH, whisper.audio.N_FRAMES)
        aligned = find_alignment(self.model, tokenizer, tokenizer.encode(" " + text), mel, frames)
        words, cursor = [], 0
        for timing in aligned:
            word = timing.word.strip()
            start = text.find(word, cursor) if re.search(r"\w", word) else -1
            if start < 0:
                continue  # punctuation, or a word the tokenizer spelled differently
            cursor = start + len(word)
            words.append([start, cursor, round(float(timing.start), 2)])
        return words


def words_of(text: str) -> list[str]:
    text = text.lower().replace("’", "'").replace("‘", "'")
    return re.findall(r"[a-z0-9]+(?:'[a-z]+)?", text)


def compare_words(wanted: list[str], heard: list[str]) -> tuple[int, int]:
    """How many words differ, and the longest run of differing words."""
    errors = longest = 0
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, wanted, heard, autojunk=False).get_opcodes():
        if op == "equal":
            continue
        if op == "replace":
            # Only spelling or spacing differs ("to-night"/"tonight", "Dinah'll"/"Dina'll"): that's fine.
            said, written = "".join(heard[j1:j2]), "".join(wanted[i1:i2])
            if difflib.SequenceMatcher(None, written, said).ratio() >= 0.8:
                continue
        run = max(i2 - i1, j2 - j1)
        errors += run
        longest = max(longest, run)
    return errors, longest


def download_model(model: str) -> str:
    from huggingface_hub import snapshot_download

    _name, repo, files = MODELS[model]
    # Use the copy on disk when it's complete, without asking the internet (which can hang on a slow connection).
    try:
        path = snapshot_download(repo, allow_patterns=files, local_files_only=True)
        if all((Path(path) / name).exists() for name in files if "*" not in name):
            return path
    except Exception:
        pass  # not downloaded yet
    # token=False: these models are public, so no Hugging Face account is needed.
    return snapshot_download(repo, allow_patterns=files, token=False)


def file_id(path: Path) -> str:
    return hashlib.sha1(path.read_bytes()).hexdigest()[:12]


# ---------- Reading along ----------


class ReadAlong:
    """The chapter's text and when each sentence and word is spoken, saved next to the chapter's MP3
    ("01 - Chapter One.json") so the player can show the text and highlight it while it plays.

    {"version": 1, "title": ..., "text": paragraphs separated by blank lines,
     "sentences": [[first char, last char + 1, start seconds], ...], "words": [same, for each word]}
    Without word timings (Whisper switched off) "words" is empty and the player spreads the words
    of each sentence evenly over its time.
    """

    def __init__(self):
        self.text = ""
        self.separator = ""
        self.sentences: list[list] = []
        self.words: list[list] = []

    def add(self, piece: Piece, words: list[list], start: float, seconds: float) -> None:
        text = piece.text
        shifted = None  # a heading goes on its own line: the space after it becomes a blank line
        if piece.heading and text[piece.heading:piece.heading + 1] == " ":
            shifted = piece.heading
            text = text[:shifted] + "\n\n" + text[shifted + 1:]
        self.text += self.separator
        base = len(self.text)
        self.text += text
        heading_only = piece.heading >= len(piece.text)
        self.separator = "\n\n" if piece.pause == PARAGRAPH_PAUSE or heading_only else " "

        def place(i: int) -> int:
            return base + i + (1 if shifted is not None and i > shifted else 0)

        for first, last, at in words:
            self.words.append([place(first), place(last), round(start + at, 2)])
        cursor = 0
        for sentence in split_sentences(piece.text):
            first = piece.text.find(sentence, cursor)
            if first < 0:
                continue
            last = cursor = first + len(sentence)
            spoken = [at for w_first, _w_last, at in words if first <= w_first < last]
            at = start + (spoken[0] if spoken else seconds * first / max(1, len(piece.text)))
            if self.sentences:
                at = max(at, self.sentences[-1][2])
            self.sentences.append([place(first), place(last), round(at, 2)])

    def save(self, path: Path, title: str) -> None:
        data = {"version": 1, "title": title, "text": self.text, "sentences": self.sentences, "words": self.words}
        partial = path.with_name(path.name + ".part")
        partial.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        os.replace(partial, path)


# ---------- Making the audiobook ----------


@dataclass
class Update:
    message: str = ""  # a line for the log, if any
    fraction: float = 0.0  # how much of the work is done (0 to 1)
    status: str = ""  # short text for the progress bar
    chapter_file: Path | None = None  # set when a chapter has just been finished
    book_dir: Path | None = None
    stopped: bool = False  # set on the last update when making was stopped part-way


def describe_time(seconds: float) -> str:
    minutes = seconds / 60
    if minutes < 1:
        return f"{max(1, round(seconds))} seconds"
    if minutes < 90:
        return f"{round(minutes)} minute" + ("" if round(minutes) == 1 else "s")
    return f"{minutes / 60:.1f} hours"


def unfinished_books() -> list[dict]:
    """Books started before and not finished yet, with what's needed to continue them."""
    jobs = []
    for job_file in sorted(WORK_DIR.glob("*/job.json")):
        try:
            job = json.loads(job_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        job["slug"] = job_file.parent.name
        book_dir = Path(job["out_dir"]) / job["slug"]
        job["done"] = sum((book_dir / name).exists() for name in job["names"])
        job["book_path"] = job_file.parent / "source" / job["book"]
        job["voice_path"] = job_file.parent / "voice" / job["voice"]
        if job["done"] < len(job["names"]) and job["book_path"].exists() and job["voice_path"].exists():
            jobs.append(job)
    return jobs


def keep_copy(source: Path, folder: Path) -> None:
    """Keep a copy of the book or voice sample, so the book can be continued later without adding them again."""
    target = folder / source.name
    if target.exists() and target.resolve() == source.resolve():
        return
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True)
    shutil.copyfile(source, target)


def make_audiobook(
    book_path: Path,
    voice_path: Path,
    narrator_for,
    sample: bool = False,
    start_over: bool = False,
    model: str = DEFAULT_MODEL,
    out_root: Path = OUTPUT_DIR,
    should_stop=lambda: False,
) -> Iterator[Update]:
    """Make the audiobook chapter by chapter, yielding progress as it goes.

    narrator_for(model) returns a loaded Narrator (so the page can keep one loaded between runs).
    sample=True makes only the first real chapter, to try the voice.
    The book goes in out_root/<book name>/. Chapters that already exist are skipped, and a chapter
    that was stopped carries on from the last finished piece. should_stop() is checked before each piece.
    """
    book_path, voice_path, out_root = Path(book_path), Path(voice_path), Path(out_root)
    book = read_book(book_path)
    voice_wav = prepare_voice(voice_path)
    length = voice_seconds(voice_wav)
    if length < MIN_VOICE_SECONDS:
        raise ConverterError(
            f"The voice sample is only {length:.0f} seconds long. Use a clean recording of 10 to 30 seconds."
        )
    if length > 45:
        yield Update(
            f"Note: the voice sample is {describe_time(length)} long. The voice model mostly copies its first "
            "10-15 seconds, so those should be clear speech (use the ✂ trim button to pick your best part)."
        )

    book_dir = out_root / slugify(book.title)
    work = WORK_DIR / slugify(book.title)
    voice_key = f"{model}-{file_id(voice_path)}"
    width = max(2, len(str(len(book.chapters))))
    names = [f"{n:0{width}d} - {safe_filename(c.title)}.mp3" for n, c in enumerate(book.chapters, start=1)]
    wanted = list(range(len(book.chapters)))
    if sample:
        # The first "chapter" is often a title page or table of contents, which makes a poor sample.
        wanted = [next((n for n, c in enumerate(book.chapters) if len(c.text.split()) >= SAMPLE_MIN_WORDS), 0)]

    yield Update(f"Book: {book.title}" + (f" by {book.author}" if book.author else ""), book_dir=book_dir)
    words = sum(len(book.chapters[n].text.split()) for n in wanted)
    yield Update(
        f"Chapters: {len(book.chapters)}"
        + (f" (making a sample: chapter {wanted[0] + 1}, {book.chapters[wanted[0]].title})" if sample else "")
        + f". {words:,} words to read, about {describe_time(words / 150 * 60)} of audio."
    )

    job_file = work / "job.json"
    job = json.loads(job_file.read_text(encoding="utf-8")) if job_file.exists() else {}
    made = [n for n in names if (book_dir / n).exists()]
    if not start_over:
        # Chapters made in another folder would be made again here without anyone noticing.
        old_dir = Path(job.get("out_dir", out_root)) / book_dir.name
        made_there = [n for n in names if (old_dir / n).exists()]
        if old_dir.resolve() != book_dir.resolve() and made_there and not made:
            raise ConverterError(
                f"This book was started in another folder ({old_dir.parent}), where {len(made_there)} chapter(s) "
                "are already made. Choose that folder to carry on, or tick 'Start over' to begin again here."
            )
        # A book started with a different voice or model shouldn't get a mix of voices.
        if made and job.get("voice_key", voice_key) != voice_key:
            raise ConverterError(
                f"{len(made)} chapter(s) of this book were made before with a different voice or model. "
                "Tick 'Start over' to replace them, or use the same voice sample and model as last time."
            )
    if start_over:
        for name in made:
            (book_dir / name).unlink()
            (book_dir / name).with_suffix(".json").unlink(missing_ok=True)
        shutil.rmtree(work, ignore_errors=True)
    book_dir.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)
    keep_copy(book_path, work / "source")
    keep_copy(voice_path, work / "voice")
    # Half-made chapters are kept per voice, so a different voice never reuses pieces of the old one.
    pieces_dir = work / f"pieces-{voice_key}"
    for old in work.glob("pieces-*"):
        if old != pieces_dir:
            shutil.rmtree(old, ignore_errors=True)
    job = {
        "title": book.title,
        "book": book_path.name,
        "voice": voice_path.name,
        "voice_key": voice_key,
        "model": model,
        "out_dir": str(out_root),
        "names": names,
    }
    job_file.write_text(json.dumps(job, indent=2, ensure_ascii=False), encoding="utf-8")

    cover_name = None
    if book.cover:
        cover_name = f"cover.{book.cover_ext}"
        (book_dir / cover_name).write_bytes(book.cover)

    plans = {n: chunk_text(book.chapters[n].text) for n in wanted if not (book_dir / names[n]).exists()}
    total_chars = sum(len(piece.text) for pieces in plans.values() for piece in pieces) or 1
    if not plans:
        yield Update("All these chapters are already made.", 1.0, "Done", book_dir=book_dir)
    else:
        yield Update("Loading the voice model…", 0.0, "Loading the voice model")
        narrator = narrator_for(model)
        narrator.set_voice(voice_wav)

    done_chars = 0
    audio_seconds = 0.0
    work_seconds = 0.0
    redone = 0  # pieces that were made again because they didn't say the text
    unsure: list[str] = []  # pieces that still didn't after MAX_TRIES
    for k, n in enumerate(wanted, start=1):
        chapter = book.chapters[n]
        target = book_dir / names[n]
        label = f"[{k}/{len(wanted)}] {chapter.title}"
        if n not in plans:
            yield Update(f"{label}: already made, skipping", chapter_file=target)
            continue

        pieces = plans[n]
        cache = pieces_dir / f"{n + 1:04d}"
        cache.mkdir(parents=True, exist_ok=True)
        saved_files = [cache / f"{i:05d}-{hashlib.sha1(p.text.encode()).hexdigest()[:8]}.npy" for i, p in enumerate(pieces)]
        already = sum(f.exists() for f in saved_files)
        if already:
            yield Update(f"{label}: carrying on where it stopped, {already} of {len(pieces)} pieces were already made")
        else:
            yield Update(f"{label}: {len(pieces)} piece{'' if len(pieces) == 1 else 's'} to speak")
        parts: list[np.ndarray] = []
        position = 0  # samples so far, to say where in the chapter a doubtful piece is
        reading = ReadAlong()
        for i, piece in enumerate(pieces):
            text, pause = piece.text, piece.pause
            saved = saved_files[i]
            words_file = saved.with_suffix(".words.json")
            if saved.exists():
                audio = np.load(saved)
            elif should_stop():
                write_manifest(book, names, book_dir, cover_name, model, voice_path)
                done = sum((book_dir / name).exists() for name in names)
                yield Update(
                    f"\nStopped. Everything made so far is kept: {done} of {len(names)} chapters finished, "
                    f"and {i} of {len(pieces)} pieces of {chapter.title}. Press Continue to carry on later.",
                    done_chars / total_chars,
                    "Stopped",
                    book_dir=book_dir,
                    stopped=True,
                )
                return
            else:
                started = time.perf_counter()
                audio, tries, errors = narrator.speak(text)
                work_seconds += time.perf_counter() - started
                audio_seconds += len(audio) / narrator.sr
                redone += tries > 1
                if errors:
                    minutes, seconds = divmod(int(position / narrator.sr), 60)
                    unsure.append(f"  {chapter.title} at {minutes}:{seconds:02d}: “{text[:60]}…”")
                np.save(saved, audio)
            if words_file.exists():
                words = json.loads(words_file.read_text(encoding="utf-8"))
            else:
                started = time.perf_counter()
                words = narrator.listener.word_times(text, audio, narrator.sr) if narrator.listener else []
                work_seconds += time.perf_counter() - started
                words_file.write_text(json.dumps(words), encoding="utf-8")
            reading.add(piece, words, position / narrator.sr, len(audio) / narrator.sr)
            parts += [audio, np.zeros(int(pause * narrator.sr), dtype=np.float32)]
            position += len(parts[-2]) + len(parts[-1])
            done_chars += len(text)
            if i + 1 < already:
                continue  # loading saved pieces takes no time; no need to report each one
            fraction = done_chars / total_chars
            status = f"Chapter {k} of {len(wanted)}: piece {i + 1} of {len(pieces)}"
            if work_seconds > 5:
                left = work_seconds / max(1, audio_seconds) * (total_chars - done_chars) / CHARS_PER_SECOND
                status += f" · about {describe_time(left)} left"
            yield Update(fraction=min(fraction, 0.999), status=status)

        # Made next to the chapter (renaming can't cross drives); ".part" so the player doesn't list it as a chapter.
        partial = target.with_name(target.name + ".part")
        encode_mp3(np.concatenate(parts), narrator.sr, partial)
        reading.save(target.with_suffix(".json"), chapter.title)
        os.replace(partial, target)
        shutil.rmtree(cache, ignore_errors=True)
        write_manifest(book, names, book_dir, cover_name, model, voice_path)
        speed = f" (speed so far: {audio_seconds / work_seconds:.1f}× real time)" if work_seconds else ""
        yield Update(f"{label}: done{speed}", chapter_file=target, book_dir=book_dir)

    write_manifest(book, names, book_dir, cover_name, model, voice_path)
    if work_seconds:
        speed = audio_seconds / work_seconds
        book_words = sum(len(c.text.split()) for c in book.chapters)
        whole = book_words / 150 * 60 / speed
        yield Update(
            f"\nMade {describe_time(audio_seconds)} of audio in {describe_time(work_seconds)}: "
            f"{speed:.1f}× real time. The whole book ({book_words:,} words) would take about {describe_time(whole)}."
        )
        if narrator.listener:
            yield Update(f"Every piece was listened back to: {redone} had to be made again.")
            if unsure:
                yield Update(f"{len(unsure)} may still have a mumbled or wrong word. Worth a listen:\n" + "\n".join(unsure))
    yield Update(f"Saved in: {book_dir}", 1.0, "Done", book_dir=book_dir)


def write_manifest(book, names, book_dir: Path, cover_name, model: str, voice_path: Path) -> None:
    """book.json in the same format as converter/audiobook.py, listing the chapters made so far."""
    import mutagen.mp3

    entries = []
    for chapter, name in zip(book.chapters, names):
        path = book_dir / name
        if path.exists():
            duration = round(mutagen.mp3.MP3(str(path)).info.length, 2)
            entry = {"title": chapter.title, "file": name, "duration": duration}
            if path.with_suffix(".json").exists():
                entry["text"] = path.with_suffix(".json").name  # for reading along in the player
            entries.append(entry)
    manifest = {
        "title": book.title,
        "author": book.author,
        "voice": f"Cloned from {voice_path.name}",
        "engine": "chatterbox-turbo" if model == "turbo" else "chatterbox",
        "cover": cover_name,
        "chapters": entries,
    }
    text = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"
    (book_dir / "book.json").write_text(text, encoding="utf-8")


# ---------- Command line ----------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Make an audiobook in a cloned voice (Chatterbox).")
    parser.add_argument("book", nargs="?", help="the book file (.epub, .pdf or .txt)")
    parser.add_argument("voice", nargs="?", help="a clean 10-30 second recording of the voice (.wav or .mp3)")
    parser.add_argument("--model", choices=list(MODELS), default=DEFAULT_MODEL)
    parser.add_argument("--sample", action="store_true", help="only make the first real chapter")
    parser.add_argument("--start-over", action="store_true", help="remake chapters that already exist")
    parser.add_argument("--out", default=str(OUTPUT_DIR), help="folder to save audiobooks in (default: output)")
    parser.add_argument("--no-check", action="store_true", help="don't listen back to each piece (faster, more slips)")
    parser.add_argument("--download", action="store_true", help="only download the voice models")
    # Used by the page, which runs each job as a separate program (see Narrator.__init__):
    parser.add_argument("--for-page", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--stop-file", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    if args.download:
        for key, (name, _repo, _files) in MODELS.items():
            print(f"Downloading {name}…", flush=True)
            download_model(key)
        print("Downloading Whisper (checks each piece)…", flush=True)
        import whisper

        whisper._download(whisper._MODELS[WHISPER_MODEL], str(WHISPER_DIR), in_memory=False)
        print("Voice models are ready.")
        return 0
    if not (args.book and args.voice):
        parser.error("give a book file and a voice sample")

    loaded: dict[str, Narrator] = {}

    def narrator_for(model: str) -> Narrator:
        if model not in loaded:
            loaded[model] = Narrator(model, check=not args.no_check)
        return loaded[model]

    stop_file = Path(args.stop_file) if args.stop_file else None
    try:
        for update in make_audiobook(
            Path(args.book),
            Path(args.voice),
            narrator_for,
            args.sample,
            args.start_over,
            args.model,
            Path(args.out),
            should_stop=lambda: stop_file is not None and stop_file.exists(),
        ):
            if args.for_page:
                report = {k: (str(v) if isinstance(v, Path) else v) for k, v in asdict(update).items()}
                print(PAGE_MARK + json.dumps(report), flush=True)
            elif update.message:
                print(update.message, flush=True)
    except ConverterError as err:
        if args.for_page:
            print(PAGE_MARK + json.dumps({"error": str(err)}), flush=True)
        else:
            print(f"\nError: {err}", file=sys.stderr)
        return 1
    except Exception as err:
        if not args.for_page:
            raise
        traceback.print_exc()  # shows in the black start.bat window
        print(PAGE_MARK + json.dumps({"error": f"Something went wrong: {type(err).__name__}: {err}."}), flush=True)
        return 1
    except KeyboardInterrupt:
        print("\nStopped. Run it again to carry on where it left off.", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
