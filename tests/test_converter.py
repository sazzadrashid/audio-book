import json
import shutil
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "converter"))

import audiobook  # noqa: E402

PARAGRAPH = "It was a quiet morning in the village and nobody expected anything to happen. " * 5


def test_clean_text_joins_lines_and_hyphenated_words():
    raw = "The quick brown\nfox jumps over the lazy dog's back-\nyard.\n\n\nNew   paragraph here."
    assert audiobook.clean_text(raw) == (
        "The quick brown fox jumps over the lazy dog's backyard.\n\nNew paragraph here."
    )


def test_clean_text_drops_lone_page_numbers():
    assert audiobook.clean_text("First page text.\n12\nSecond page text.") == "First page text. Second page text."


def test_split_into_chapters_finds_headings():
    text = f"My Book\n\nCHAPTER I.\n\n{PARAGRAPH}\n\nCHAPTER II. THE STORM\n\n{PARAGRAPH}\n\nChapter Three\n\n{PARAGRAPH}"
    chapters = audiobook.split_into_chapters(text)
    assert [c.title for c in chapters] == ["Chapter I", "Chapter II. The Storm", "Chapter Three"]
    assert chapters[0].text.startswith("Chapter I.\n\nIt was a quiet morning")


def test_split_into_chapters_ignores_heading_words_inside_sentences():
    text = f"{PARAGRAPH}\nChapter 1 was the best part.\n\n{PARAGRAPH}"
    chapters = audiobook.split_into_chapters(text)
    assert len(chapters) == 1
    assert chapters[0].title == "Full book"


def test_split_into_chapters_skips_contents_entries():
    contents = "Contents\n\nChapter 1\n\nChapter 2\n\n"
    text = f"{contents}Chapter 1\n\n{PARAGRAPH}\n\nChapter 2\n\n{PARAGRAPH}"
    chapters = audiobook.split_into_chapters(text)
    assert [c.title for c in chapters] == ["Chapter 1", "Chapter 2"]


def test_split_into_parts_without_headings():
    text = "\n\n".join(["word " * 300] * 10)
    parts = audiobook.split_into_parts(text, part_words=1000)
    assert [p.title for p in parts] == ["Part 1", "Part 2", "Part 3", "Part 4"]
    assert sum(len(p.text.split()) for p in parts) == 3000


def test_strip_gutenberg():
    text = "Licence blah\n*** START OF THE PROJECT GUTENBERG EBOOK X ***\nStory.\n*** END OF THE PROJECT GUTENBERG EBOOK X ***\nMore licence"
    assert audiobook.strip_gutenberg(text).strip() == "Story."


def test_slugify_and_safe_filename():
    assert audiobook.slugify("Pride & Prejudice!") == "pride-prejudice"
    assert audiobook.slugify("পথের পাঁচালী").startswith("book-")
    assert audiobook.safe_filename('What? A "test": part/2') == "What A test part 2"


def test_remove_running_lines_drops_headers_and_page_numbers():
    body = "It was a quiet morning in the village.\nNobody expected anything to happen."
    pages = [f"THE HARD THING ABOUT HARD THINGS\n{body}\nChapter 1 ends here, maybe.\n{n}" for n in range(1, 7)]
    cleaned = audiobook.remove_running_lines(pages)
    assert all("HARD THING" not in p for p in cleaned)
    assert all(not p.rstrip().endswith(str(n)) for n, p in enumerate(cleaned, 1))
    assert all(body in p and "maybe." in p for p in cleaned)


def test_nice_title_keeps_roman_numerals():
    assert audiobook.nice_title("CHAPTER XIV. A NEW HOPE") == "Chapter XIV. A New Hope"
    assert audiobook.nice_title("Chapter 3: Mixed Case") == "Chapter 3: Mixed Case"


def test_rate_percent():
    assert audiobook.rate_percent("+10%") == 10
    assert audiobook.rate_percent("-5") == -5
    with pytest.raises(audiobook.ConverterError):
        audiobook.rate_percent("fast")


@pytest.mark.skipif(
    not (shutil.which("espeak-ng") or shutil.which("espeak")) or not shutil.which("ffmpeg"),
    reason="needs espeak-ng and ffmpeg",
)
def test_convert_txt_offline(tmp_path):
    book = tmp_path / "tiny.txt"
    book.write_text(
        f"Title: A Tiny Tale\nAuthor: Test Writer\n\nChapter 1\n\n{PARAGRAPH}\n\nChapter 2\n\n{PARAGRAPH}",
        encoding="utf-8",
    )
    out = tmp_path / "books"
    assert audiobook.main([str(book), "--engine", "espeak", "--out", str(out)]) == 0

    manifest = json.loads((out / "a-tiny-tale" / "book.json").read_text())
    assert manifest["title"] == "A Tiny Tale"
    assert manifest["author"] == "Test Writer"
    assert [c["file"] for c in manifest["chapters"]] == ["01 - Chapter 1.mp3", "02 - Chapter 2.mp3"]
    assert all(c["duration"] > 1 for c in manifest["chapters"])

    index = json.loads((out / "index.json").read_text())
    assert [b["id"] for b in index["books"]] == ["a-tiny-tale"]
