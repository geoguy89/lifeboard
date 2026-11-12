# -*- coding: utf-8 -*-
"""Turning a sermon note into things worth putting on a wall.

    python tools/test_obsidian.py

Stdlib only - it loads the provider directly rather than importing the
package, so it runs without httpx.

The extraction is the part that will break on a real note. These notes are
written by a local AI from audio each week, and they are full of things that
look fine in Obsidian and terrible on a wall: zero-width characters in every
heading, wiki links, images, bold markers mid-sentence, and one-word bullets.
"""
from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROV = ROOT / "server" / "lifeboard" / "providers"

# base.py is stdlib-only; the provider imports httpx at module scope, so a
# stub keeps this runnable on a machine that has not installed it.
sys.modules.setdefault("httpx", types.ModuleType("httpx"))
spec = importlib.util.spec_from_file_location("base", PROV / "base.py")
base = importlib.util.module_from_spec(spec)
sys.modules["base"] = base
spec.loader.exec_module(base)

pkg = types.ModuleType("lifeboard"); pkg.__path__ = [str(ROOT / "server" / "lifeboard")]
sys.modules["lifeboard"] = pkg
sub = types.ModuleType("lifeboard.providers"); sub.__path__ = [str(PROV)]
sys.modules["lifeboard.providers"] = sub
sys.modules["lifeboard.providers.base"] = base

spec2 = importlib.util.spec_from_file_location(
    "lifeboard.providers.obsidian", PROV / "obsidian.py")
ob = importlib.util.module_from_spec(spec2)
spec2.loader.exec_module(ob)

checks = 0


def check(cond: bool, what: str) -> None:
    global checks
    if not cond:
        raise AssertionError(what)
    checks += 1


# A note in the shape the sermon notes actually take, including the awkward
# parts: zero-width space in a heading, a wiki link, an image, a short bullet.
NOTE = """---
date: "2026-01-25"
themes: "faith, transformation"
---

# ​The Stabilizing Power of the Word

​**Context:** Based on your notes from Jan 25, 2026, after the service.

### ​**Day 1: The Alpha and Omega**

**Scripture:** _John 1:1-5_

> ​_"In the beginning was the Word, and the Word was with God, and the Word
> was God. The light shines in the darkness."_

![a picture](attachments/pic.png)

The Greek term used here is _Logos_. To the Greek mind it was the stabilizing,
rational principle of the universe and the source of all reality.

- **Insight:** You cannot have a revelation of who you are until you have a
  revelation of who He is.
- short
- See [[2026-01-18 Last Week|last week's note]] for the setup to this one.
"""


def main() -> int:
    pieces = ob.excerpts(NOTE)
    kinds = [p["kind"] for p in pieces]
    text = " ".join(p["text"] for p in pieces)

    check("quote" in kinds, "the blockquote became a quote excerpt")
    check("bullet" in kinds, "bullets became excerpts")
    check("paragraph" in kinds, "prose became paragraph excerpts")

    # Frontmatter is metadata, not content.
    check("themes" not in text and "2026-01-25" not in text,
          "frontmatter is not shown as content")

    # Markdown syntax must not reach the wall.
    check("**" not in text and "_" not in text, "emphasis markers are stripped")
    check("![" not in text and "attachments/pic.png" not in text,
          "images are dropped, not shown as a broken path")
    check("[[" not in text, "wiki link syntax is stripped")
    check("last week's note" in text,
          "a wiki link keeps its LABEL - the path means nothing on a wall")

    # Zero-width characters come through in every heading these notes have and
    # render as visible boxes in some fonts.
    check("​" not in text, "zero-width characters are removed from text")
    headings = " ".join(p["heading"] for p in pieces)
    check("​" not in headings, "zero-width characters are removed from headings")

    # A two-word bullet on a wall reads as a rendering fault.
    check(not any(p["text"] == "short" for p in pieces),
          "a too-short bullet is skipped")

    # Context is what makes a lone bullet make sense.
    bullet = next(p for p in pieces if p["kind"] == "bullet")
    check(bullet["heading"].startswith("Day 1"),
          f"an excerpt carries its section heading (got {bullet['heading']!r})")

    # --- the two things the REAL notes broke on -----------------------------
    #
    # They are written on Windows and are CRLF, so the frontmatter fence never
    # matched and the YAML was being shown as the note's first excerpt. And
    # they carry HTML entities, which read as a literal &quot; on a wall.
    crlf = NOTE.replace("\n", "\r\n")
    crlf_pieces = ob.excerpts(crlf)
    crlf_text = " ".join(x["text"] for x in crlf_pieces)
    check("themes" not in crlf_text and "2026-01-25" not in crlf_text,
          "frontmatter is stripped from a CRLF note")
    check(len(crlf_pieces) == len(pieces),
          f"CRLF and LF give the same excerpts ({len(crlf_pieces)} vs {len(pieces)})")

    entity_note = (
        "## Key Scriptures\n\n"
        "- Ephesians 2:10: &quot;For we are his workmanship, created in "
        "Christ Jesus&quot; &amp; called to good works.\n"
    )
    entities = ob.excerpts(entity_note)
    check(entities, "an entity-laden bullet still produces an excerpt")
    check("&quot;" not in entities[0]["text"] and "&amp;" not in entities[0]["text"],
          f"HTML entities are decoded (got {entities[0]['text'][:60]!r})")
    check('"For we are his workmanship' in entities[0]["text"],
          "the decoded text reads as real punctuation")

    # The whole-note mode must KEEP its paragraph breaks - plain() collapsing
    # whitespace is right for one excerpt and wrong for a whole note.
    body = ob._body_text(crlf)
    check("\n" in body, "the whole-note text keeps line breaks")
    check("\n\n\n" not in body, "runs of blank lines are collapsed to one")
    check("themes" not in body, "the whole-note text has no frontmatter")

    check(ob.title_of(NOTE, "01-25-2026 Whatever.md") == "The Stabilizing Power of the Word",
          "the title comes from the note's own H1")
    check(ob.title_of("no heading here", "05.03.26 - What Is This Power.md")
          == "What Is This Power",
          "without an H1 the filename is used, with the date stripped")

    # kinds= filters to one sort of excerpt.
    only_quotes = ob.excerpts(NOTE, kinds="quote")
    check(only_quotes and all(p["kind"] == "quote" for p in only_quotes),
          "kinds=quote returns only quotes")

    # Long excerpts are cut, not allowed to overrun the block.
    capped = ob.excerpts(NOTE, max_chars=60)
    check(all(len(p["text"]) <= 60 for p in capped), "max_chars is honoured")

    # Folder paths carry emoji and spaces; each SEGMENT is escaped, or the
    # slashes become %2F and address a file that does not exist.
    path = ob._folder_path("\U0001f30a Areas/Personal/Sunday Sermons")
    check("/" in path and "%2F" not in path, "slashes stay slashes")
    check("%F0%9F%8C%8A" in path, "emoji are percent-encoded")
    check("%20" in path, "spaces are encoded")

    # 'daily' must be stable for the whole day, or the block flickers.
    notes = [f"note{i}.md" for i in range(7)]
    check(ob.pick_note(notes, "daily") == ob.pick_note(notes, "daily"),
          "the daily pick is stable within a day")
    check(ob.pick_note(notes, "newest") == "note6.md", "newest is the last by name")
    check(ob.pick_note([], "daily") == "", "an empty folder picks nothing rather than raising")

    print(f"obsidian: {checks} checks passed, {len(pieces)} excerpts from the sample note")
    return 0


if __name__ == "__main__":
    sys.exit(main())
