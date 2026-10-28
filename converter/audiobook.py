#!/usr/bin/env python3
"""Turn an EPUB, PDF or TXT book into an audiobook.

Each chapter becomes one MP3 file. A book.json file lists the chapters so the
Audio Book player shows proper chapter names, and player/books/index.json is
updated so the book appears on the website.

Examples:
    python converter/audiobook.py inbox/my-book.epub
    python converter/audiobook.py inbox/my-book.txt --voice en-GB-SoniaNeural
    python converter/audiobook.py inbox/my-book.pdf --dry-run
    python converter/audiobook.py inbox/my-book.epub --limit 1      # quick sample
    python converter/audiobook.py inbox/my-book.txt --engine espeak # offline voice
    python converter/audiobook.py --list-voices en
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
import warnings
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO_ROOT / "player" / "books"
DEFAULT_EDGE_VOICE = "en-US-AriaNeural"
DEFAULT_ESPEAK_VOICE = "en-us"
MIN_CHAPTER_CHARS = 200  # shorter sections (title pages, contents entries) are skipped
PART_WORDS = 4000  # books without chapter headings are split into parts of about this many words
EDGE_RETRIES = 3

BLOCK_TAGS = [
    "p", "div", "section", "article", "blockquote", "li", "tr", "pre",
    "h1", "h2", "h3", "h4", "h5", "h6", "dt", "dd", "figcaption",
]

NUMBER_WORDS = (
    "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|"
    "fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty"
)
_NUMBER = rf"(?:\d+|[ivxlcdm]+|(?:{NUMBER_WORDS})(?:[- ](?:{NUMBER_WORDS}))?)"
HEADING_RE = re.compile(
    rf"(?:(?:chapter|part|book)\s+{_NUMBER}\b[.:]?(?:\s.{{0,70}})?"
    r"|(?:prologue|epilogue|introduction|preface|foreword|afterword)[.:]?"
    r"|অধ্যায়\s*[\d০-৯]+.{0,70})",
    re.IGNORECASE,
)
ROMAN_RE = re.compile(r"[IVXLCDM]+\.?", re.IGNORECASE)


class ConverterError(Exception):
    """A problem the user can fix (bad file, missing tool, no network…)."""


@dataclass
class Chapter:
    title: str
    text: str


@dataclass
class Book:
    title: str
    author: str
    chapters: list[Chapter]
    cover: bytes | None = None
    cover_ext: str = "jpg"


# ---------- Text helpers ----------


def clean_text(text: str) -> str:
    """Tidy extracted text so it reads naturally aloud."""
    text = unicodedata.normalize("NFC", text).replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("­", "")  # soft hyphens
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)  # words split across lines
    text = re.sub(r"[ \t  ​]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"^\d{1,4}(?:\n|\Z)", "", text, flags=re.MULTILINE)  # lone page numbers
    paragraphs = re.split(r"\n{2,}", text)
    # Lines inside a paragraph are joined so the voice doesn't pause at every line break.
    paragraphs = [" ".join(p.split("\n")).strip() for p in paragraphs]
    return "\n\n".join(p for p in paragraphs if p)


def nice_title(line: str) -> str:
    """'CHAPTER IV. THE STORM' -> 'Chapter IV. The Storm'."""
    line = " ".join(line.split()).strip(" .:-")
    if not line.isupper():
        return line
    words = []
    for word in line.split(" "):
        words.append(word.upper() if ROMAN_RE.fullmatch(word) else word.capitalize())
    return " ".join(words)


def strip_gutenberg(text: str) -> str:
    """Remove the Project Gutenberg licence header and footer, if present."""
    start = re.search(r"^\*\*\* ?START OF (?:THE|THIS) PROJECT GUTENBERG.*$", text, re.I | re.M)
    if start:
        text = text[start.end():]
    end = re.search(r"^\*\*\* ?END OF (?:THE|THIS) PROJECT GUTENBERG.*$", text, re.I | re.M)
    if end:
        text = text[: end.start()]
    return text


def is_heading(lines: list[str], i: int) -> bool:
    line = lines[i].strip()
    if not line or len(line.split()) > 12:
        return False
    if i > 0 and lines[i - 1].strip():
        return False  # headings follow an empty line
    return HEADING_RE.fullmatch(line) is not None


def split_into_chapters(text: str) -> list[Chapter]:
    """Split plain text at chapter headings, or into equal parts if there are none."""
    text = unicodedata.normalize("NFC", text).replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    starts = [i for i in range(len(lines)) if is_heading(lines, i)]

    chapters: list[Chapter] = []
    if len(starts) >= 2:
        if starts[0] > 0:
            opening = clean_text("\n".join(lines[: starts[0]]))
            if len(opening) >= MIN_CHAPTER_CHARS:
                chapters.append(Chapter("Opening", opening))
        for n, start in enumerate(starts):
            end = starts[n + 1] if n + 1 < len(starts) else len(lines)
            title = nice_title(lines[start])
            body = clean_text("\n".join(lines[start + 1 : end]))
            if len(body) >= MIN_CHAPTER_CHARS:
                chapters.append(Chapter(title, f"{title}.\n\n{body}"))
        if chapters:
            return chapters

    return split_into_parts(clean_text(text))


def split_into_parts(text: str, part_words: int = PART_WORDS) -> list[Chapter]:
    pieces: list[str] = []
    for paragraph in text.split("\n\n"):
        if len(paragraph.split()) > part_words:
            pieces.extend(re.split(r"(?<=[.!?।])\s+", paragraph))
        else:
            pieces.append(paragraph)

    parts: list[list[str]] = [[]]
    count = 0
    for piece in pieces:
        words = len(piece.split())
        if count and count + words > part_words:
            parts.append([])
            count = 0
        parts[-1].append(piece)
        count += words

    texts = ["\n\n".join(p).strip() for p in parts]
    texts = [t for t in texts if t]
    if len(texts) == 1:
        return [Chapter("Full book", texts[0])]
    return [Chapter(f"Part {n}", t) for n, t in enumerate(texts, start=1)]


def slugify(title: str) -> str:
    ascii_title = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_title.lower()).strip("-")[:60].strip("-")
    if not slug:
        slug = "book-" + hashlib.sha1(title.encode()).hexdigest()[:8]
    return slug


def safe_filename(name: str, limit: int = 60) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f#%]+', " ", name)
    name = " ".join(name.split()).strip(" .")
    return name[:limit].rstrip(" .") or "chapter"


# ---------- Reading books ----------


def need(module: str):
    raise ConverterError(
        f"The Python package '{module}' is missing. Run: pip install -r converter/requirements.txt"
    )


def read_txt(path: Path) -> Book:
    raw = path.read_bytes()
    for encoding in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    title, author = path.stem.replace("_", " "), ""
    header = re.search(r"^Title:\s*(.+)$", text[:5000], re.M)
    if header:
        title = header.group(1).strip()
    by = re.search(r"^Author:\s*(.+)$", text[:5000], re.M)
    if by:
        author = by.group(1).strip()
    return Book(title, author, split_into_chapters(strip_gutenberg(text)))


def html_to_text(soup) -> str:
    for tag in soup(["script", "style", "head", "nav"]):
        tag.decompose()
    for br in soup.find_all("br"):
        br.replace_with("\n")
    for tag in soup.find_all(BLOCK_TAGS):
        tag.insert_after("\n\n")
    return clean_text(soup.get_text())


def _toc_titles(entries, out: dict[str, str]) -> None:
    for entry in entries:
        if isinstance(entry, (tuple, list)):
            section, children = entry[0], entry[1]
            href = getattr(section, "href", None)
            if href:
                out.setdefault(href.split("#")[0], section.title)
            _toc_titles(children, out)
        else:
            href = getattr(entry, "href", None)
            if href:
                out.setdefault(href.split("#")[0], entry.title)


def read_epub(path: Path) -> Book:
    try:
        import ebooklib
        from ebooklib import epub
    except ImportError:
        need("ebooklib")
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        need("beautifulsoup4")

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            book = epub.read_epub(str(path))
        except Exception as err:
            raise ConverterError(f"Couldn't open the EPUB file ({err}). Is it DRM-protected?") from err

    def meta(name: str) -> str:
        values = book.get_metadata("DC", name)
        return values[0][0].strip() if values and values[0][0] else ""

    toc: dict[str, str] = {}
    _toc_titles(book.toc, toc)

    chapters = []
    for idref, _linear in book.spine:
        item = book.get_item_with_id(idref)
        if item is None or item.get_type() != ebooklib.ITEM_DOCUMENT:
            continue
        soup = BeautifulSoup(item.get_content(), "html.parser")
        heading = soup.find(["h1", "h2", "h3"])
        heading_text = heading.get_text(" ", strip=True) if heading else ""
        text = html_to_text(soup)
        if len(text) < MIN_CHAPTER_CHARS:
            continue
        title = toc.get(item.get_name()) or heading_text or f"Section {len(chapters) + 1}"
        chapters.append(Chapter(nice_title(title), text))

    cover, cover_ext = None, "jpg"
    images = list(book.get_items_of_type(ebooklib.ITEM_COVER))
    images += [i for i in book.get_items_of_type(ebooklib.ITEM_IMAGE) if "cover" in i.get_name().lower()]
    if images:
        cover = images[0].get_content()
        cover_ext = "png" if images[0].get_name().lower().endswith(".png") else "jpg"

    return Book(meta("title") or path.stem, meta("creator"), chapters, cover, cover_ext)


def read_pdf(path: Path) -> Book:
    try:
        from pypdf import PdfReader
    except ImportError:
        need("pypdf")
    try:
        reader = PdfReader(str(path))
        if reader.is_encrypted:
            reader.decrypt("")
        pages = [page.extract_text() or "" for page in reader.pages]
    except Exception as err:
        raise ConverterError(f"Couldn't read the PDF ({err}).") from err
    pages = remove_running_lines(pages)

    if not "".join(pages).strip():
        raise ConverterError(
            "This PDF has no text to read (it is probably scanned images). "
            "Run it through OCR first, or use an EPUB or TXT version."
        )

    info = reader.metadata
    title = (info.title if info and info.title else "") or path.stem.replace("_", " ")
    author = (info.author if info and info.author else "") or ""

    chapters = chapters_from_pdf_outline(reader, pages)
    if not chapters:
        chapters = split_into_chapters("\n\n".join(pages))
    return Book(title.strip(), author.strip(), chapters)


def remove_running_lines(pages: list[str]) -> list[str]:
    """Remove running headers and footers (page numbers, the book or chapter title) that repeat
    at the top or bottom of many pages. Same rule as removeRunningLines in player/book-text.js."""
    if len(pages) < 4:
        return pages
    page_lines = [[line for line in page.split("\n") if line.strip()] for page in pages]

    def key(line: str) -> str:
        return " ".join(re.sub(r"\d+", "#", line.lower()).split())

    def edges(lines: list[str]) -> list[int]:
        return sorted({i for i in (0, 1, len(lines) - 2, len(lines) - 1) if 0 <= i < len(lines)})

    counts: dict[str, int] = {}
    for lines in page_lines:
        for k in {key(lines[i]) for i in edges(lines)}:
            counts[k] = counts.get(k, 0) + 1
    limit = max(3, len(pages) * 0.1)
    cleaned = []
    for lines in page_lines:
        drop = set()
        for i in edges(lines):
            line = lines[i].strip()
            # Headers and footers are short and don't end like a sentence.
            if (
                len(key(line)) < 70
                and not re.search(r"[.!?,;]$", line)
                and counts.get(key(line), 0) >= limit
                and not HEADING_RE.fullmatch(line)
            ):
                drop.add(i)
        cleaned.append("\n".join(line for i, line in enumerate(lines) if i not in drop))
    return cleaned


def chapters_from_pdf_outline(reader, pages: list[str]) -> list[Chapter]:
    """Use the PDF's bookmarks (top level only) as chapters when it has them."""
    try:
        marks = []
        for entry in reader.outline:
            if isinstance(entry, list):
                continue
            page = reader.get_destination_page_number(entry)
            if page is not None and page >= 0:
                marks.append((page, str(entry.title)))
    except Exception:
        return []
    marks = sorted(dict(marks).items())  # one bookmark per page, in page order
    if len(marks) < 2:
        return []

    chapters = []
    if marks[0][0] > 0:
        opening = clean_text("\n\n".join(pages[: marks[0][0]]))
        if len(opening) >= MIN_CHAPTER_CHARS:
            chapters.append(Chapter("Opening", opening))
    for n, (page, title) in enumerate(marks):
        end = marks[n + 1][0] if n + 1 < len(marks) else len(pages)
        text = clean_text("\n\n".join(pages[page:end]))
        if len(text) >= MIN_CHAPTER_CHARS:
            chapters.append(Chapter(nice_title(title), text))
    return chapters


def read_book(path: Path) -> Book:
    if not path.is_file():
        raise ConverterError(f"File not found: {path}")
    suffix = path.suffix.lower()
    if suffix == ".epub":
        book = read_epub(path)
    elif suffix == ".pdf":
        book = read_pdf(path)
    elif suffix in (".txt", ".text", ".md"):
        book = read_txt(path)
    else:
        raise ConverterError(f"Unsupported file type '{suffix}'. Use .epub, .pdf or .txt.")
    if not book.chapters:
        raise ConverterError("No readable text was found in this book.")
    return book


# ---------- Text to speech ----------


def rate_percent(rate: str) -> int:
    match = re.fullmatch(r"([+-]?\d+)%?", rate.strip())
    if not match:
        raise ConverterError(f"Speed '{rate}' should look like +10% or -15%.")
    return int(match.group(1))


async def speak_edge(text: str, voice: str, rate: str, out_file: Path) -> None:
    try:
        import edge_tts
    except ImportError:
        need("edge-tts")
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    percent = rate_percent(rate)
    options = {"rate": f"{percent:+d}%"}
    if proxy:
        options["proxy"] = proxy

    for attempt in range(1, EDGE_RETRIES + 1):
        try:
            await edge_tts.Communicate(text, voice, **options).save(str(out_file))
            return
        except Exception as err:
            if attempt == EDGE_RETRIES:
                raise ConverterError(
                    f"The online voice service failed ({type(err).__name__}: {err}).\n"
                    "Check the internet connection. In a Claude cloud session, the environment's "
                    "network access must allow speech.platform.bing.com. "
                    "Or use the offline voice: add --engine espeak"
                ) from err
            await asyncio.sleep(2 * attempt)


def speak_espeak(text: str, voice: str, rate: str, out_file: Path) -> None:
    exe = shutil.which("espeak-ng") or shutil.which("espeak")
    if not exe:
        raise ConverterError("eSpeak NG is not installed. Install it with: sudo apt-get install espeak-ng")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise ConverterError("ffmpeg is not installed. Install it with: sudo apt-get install ffmpeg")
    words_per_minute = max(80, round(170 * (1 + rate_percent(rate) / 100)))
    with tempfile.TemporaryDirectory() as tmp:
        text_file = Path(tmp) / "text.txt"
        wav_file = Path(tmp) / "speech.wav"
        text_file.write_text(text, encoding="utf-8")
        result = subprocess.run(
            [exe, "-v", voice, "-s", str(words_per_minute), "-f", str(text_file), "-w", str(wav_file)],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise ConverterError(f"eSpeak NG failed: {result.stderr.strip()}")
        subprocess.run(
            [ffmpeg, "-y", "-loglevel", "error", "-i", str(wav_file), "-ac", "1", "-b:a", "64k", str(out_file)],
            check=True,
        )


def mp3_duration(path: Path) -> float:
    try:
        from mutagen.mp3 import MP3

        return round(MP3(str(path)).info.length, 2)
    except Exception:
        return 0.0


async def list_voices(prefix: str) -> None:
    try:
        import edge_tts
    except ImportError:
        need("edge-tts")
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    try:
        voices = await edge_tts.list_voices(**({"proxy": proxy} if proxy else {}))
    except Exception as err:
        raise ConverterError(f"Couldn't reach the online voice service ({err}).") from err
    prefix = prefix.lower()
    for v in sorted(voices, key=lambda v: v["ShortName"]):
        if v["Locale"].lower().startswith(prefix) or v["ShortName"].lower().startswith(prefix):
            print(f"{v['ShortName']:<36} {v['Gender']:<7} {v['Locale']}")


# ---------- Output ----------


def plural(count: int, word: str) -> str:
    return f"{count} {word}" if count == 1 else f"{count} {word}s"


def write_index(out_dir: Path) -> None:
    """List every converted book in index.json so the player can show them."""
    books = []
    for manifest in sorted(out_dir.glob("*/book.json")):
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        books.append(
            {
                "id": manifest.parent.name,
                "title": data.get("title", manifest.parent.name),
                "author": data.get("author", ""),
                "cover": data.get("cover"),
                "chapters": data.get("chapters", []),
            }
        )
    books.sort(key=lambda b: b["title"].lower())
    (out_dir / "index.json").write_text(json.dumps({"books": books}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def convert(args: argparse.Namespace) -> Path | None:
    book = read_book(Path(args.input))
    if args.title:
        book.title = args.title
    if args.author:
        book.author = args.author

    voice = args.voice or (DEFAULT_EDGE_VOICE if args.engine == "edge" else DEFAULT_ESPEAK_VOICE)
    chapters = book.chapters[: args.limit] if args.limit else book.chapters
    total_words = sum(len(c.text.split()) for c in chapters)

    print(f"Book:     {book.title}" + (f" by {book.author}" if book.author else ""))
    print(f"Chapters: {len(book.chapters)}" + (f" (converting the first {len(chapters)})" if args.limit else ""))
    minutes = total_words / 150  # typical narration speed
    length = f"{minutes / 60:.1f} hours" if minutes >= 60 else f"{max(1, round(minutes))} minutes"
    print(f"Words:    {total_words:,} (about {length} of audio)")
    print(f"Voice:    {voice} ({args.engine})")

    if args.dry_run:
        print()
        for n, ch in enumerate(chapters, start=1):
            preview = ch.text[:70].replace("\n", " ")
            print(f"{n:>4}. {ch.title}  [{len(ch.text.split()):,} words]  {preview}…")
        print("\nDry run: no audio was made.")
        return None

    out_dir = Path(args.out)
    book_dir = out_dir / slugify(book.title)
    book_dir.mkdir(parents=True, exist_ok=True)

    cover_name = None
    if book.cover:
        cover_name = f"cover.{book.cover_ext}"
        (book_dir / cover_name).write_bytes(book.cover)

    entries = []
    started = time.monotonic()
    width = max(2, len(str(len(book.chapters))))
    for n, chapter in enumerate(book.chapters, start=1):
        file_name = f"{n:0{width}d} - {safe_filename(chapter.title)}.mp3"
        target = book_dir / file_name
        done = target.exists() and target.stat().st_size > 0
        if n > len(chapters):
            # Past --limit: keep chapters made by an earlier run in the list.
            if done:
                entries.append({"title": chapter.title, "file": file_name, "duration": mp3_duration(target)})
            continue
        label = f"[{n}/{len(chapters)}] {chapter.title}"
        if done and not args.force:
            print(f"{label}: already done, skipping")
        else:
            print(f"{label}: making audio…", flush=True)
            partial = target.with_suffix(".part.mp3")
            try:
                if args.engine == "edge":
                    asyncio.run(speak_edge(chapter.text, voice, args.rate, partial))
                else:
                    speak_espeak(chapter.text, voice, args.rate, partial)
            except BaseException:
                partial.unlink(missing_ok=True)
                raise
            partial.replace(target)
        entries.append({"title": chapter.title, "file": file_name, "duration": mp3_duration(target)})

    manifest = {
        "title": book.title,
        "author": book.author,
        "voice": voice,
        "engine": args.engine,
        "cover": cover_name,
        "chapters": entries,
    }
    (book_dir / "book.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    write_index(out_dir)

    audio_minutes = round(sum(e["duration"] for e in entries) / 60)
    took = (time.monotonic() - started) / 60
    print(
        f"\nDone: {plural(len(entries), 'chapter')}, {plural(audio_minutes, 'minute')} of audio, "
        f"made in {took:.1f} minutes."
    )
    print(f"Saved in: {book_dir}")
    return book_dir


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Turn an EPUB, PDF or TXT book into an audiobook (one MP3 per chapter).",
        epilog="Example: python converter/audiobook.py inbox/my-book.epub --voice en-GB-SoniaNeural",
    )
    parser.add_argument("input", nargs="?", help="the book file (.epub, .pdf or .txt)")
    parser.add_argument("--voice", help=f"voice name (default: {DEFAULT_EDGE_VOICE}, or {DEFAULT_ESPEAK_VOICE} for espeak)")
    parser.add_argument(
        "--engine",
        choices=["edge", "espeak"],
        default="edge",
        help="edge = natural online voices (default); espeak = robotic but works offline",
    )
    parser.add_argument("--rate", default="+0%", help="reading speed, e.g. +10%% or -10%% (default: +0%%)")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="output folder (default: player/books)")
    parser.add_argument("--title", help="use this title instead of the one in the file")
    parser.add_argument("--author", help="use this author instead of the one in the file")
    parser.add_argument("--limit", type=int, help="only convert the first N chapters (to try a voice)")
    parser.add_argument("--force", action="store_true", help="remake chapters that already exist")
    parser.add_argument("--dry-run", action="store_true", help="show the chapters found, without making audio")
    parser.add_argument(
        "--list-voices",
        nargs="?",
        const="",
        metavar="LANG",
        help="list online voices, optionally only those starting with LANG (e.g. en, en-GB, bn)",
    )
    args = parser.parse_args(argv)
    if args.list_voices is None and not args.input:
        parser.error("give a book file to convert, or use --list-voices")
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be 1 or more")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.list_voices is not None:
            asyncio.run(list_voices(args.list_voices))
        else:
            convert(args)
    except ConverterError as err:
        print(f"\nError: {err}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nStopped. Run the same command again to continue where it left off.", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
