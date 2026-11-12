"""Notes from an Obsidian vault, over the Local REST API plugin.

Why the REST API and not a folder path: the vault usually lives on another
machine, and the appliance is a Pi. Mounting the vault over SMB would mean
credentials on the board, a mount that breaks when the server reboots, and a
widget that hangs on a dead mount rather than failing cleanly. The plugin is
already installed and already used by n8n, so this is the route that exists.

What this is FOR: taking long-form notes - Sunday sermon notes, which
a local AI writes from audio each week - and putting readable excerpts on a
wall, either cycling through them or scrolling one whole note. So the work
here is mostly EXTRACTION: a 4,000-word markdown note is not a wall display
until something has chosen what part of it to show.

STRICTLY READ-ONLY. Every call here is a GET. Nothing in this module writes,
renames, moves or deletes anything in the vault, and the widget has no path
that could - the notes are somebody's own writing and the board is a viewer.
"""

from __future__ import annotations

import html
import random
import re
from datetime import date
from urllib.parse import quote

import httpx

from .base import CACHE, FetchResult

USER_AGENT = "LifeBoard/0.1 (+local dashboard)"
TIMEOUT = 20.0


def _client(config: dict) -> httpx.Client:
    base = (config.get("base_url") or "").rstrip("/")
    key = config.get("api_key") or ""
    if not base or not key:
        raise ValueError("Obsidian needs base_url and api_key")
    return httpx.Client(
        base_url=base,
        timeout=TIMEOUT,
        headers={"Authorization": f"Bearer {key}", "User-Agent": USER_AGENT},
        # The plugin's HTTPS listener uses a self-signed certificate, which is
        # the normal case on a LAN. The HTTP port is the simpler choice.
        verify=not config.get("insecure", True),
    )


def _folder_path(folder: str) -> str:
    """Vault-relative folder to the plugin's URL form.

    Every segment is escaped separately: the folders here are things like
    "🌊 Areas/Personal/..." and quoting the whole string would escape the
    slashes into %2F and address a file that does not exist.
    """
    parts = [p for p in str(folder or "").strip("/").split("/") if p]
    return "/".join(quote(p, safe="") for p in parts)


def list_notes(config: dict, *, ttl: float = 300.0) -> FetchResult:
    """Markdown files directly in the configured folder."""
    folder = config.get("folder") or ""
    cache_key = ("obsidian-list", config.get("base_url"), folder)
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached

    try:
        with _client(config) as client:
            resp = client.get(f"/vault/{_folder_path(folder)}/" if folder else "/vault/")
            resp.raise_for_status()
            files = resp.json().get("files", [])
        notes = sorted(f for f in files if str(f).lower().endswith(".md"))
        if not notes:
            raise ValueError(f"no markdown notes in {folder or 'the vault root'!r}")
        result = FetchResult(payload={"folder": folder, "notes": notes})
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=_friendly(exc))
    return CACHE.put(cache_key, result)


def read_note(config: dict, path: str, *, ttl: float = 300.0) -> FetchResult:
    cache_key = ("obsidian-note", config.get("base_url"), path)
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached
    try:
        with _client(config) as client:
            resp = client.get(f"/vault/{_folder_path(path)}",
                              headers={"Accept": "text/markdown"})
            resp.raise_for_status()
            result = FetchResult(payload={"path": path, "text": resp.text})
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=_friendly(exc))
    return CACHE.put(cache_key, result)


def _friendly(exc: Exception) -> str:
    text = str(exc)
    if "401" in text or "403" in text:
        return ("Obsidian refused the API key. Copy it again from the Local "
                "REST API plugin's settings.")
    if "ConnectError" in type(exc).__name__ or "ConnectTimeout" in type(exc).__name__:
        return ("Could not reach Obsidian. It has to be RUNNING for the API to "
                "answer - the plugin lives inside the app, not beside it.")
    return f"{type(exc).__name__}: {text}"[:300]


# --------------------------------------------------------------------------
#  Turning a long note into things worth putting on a wall
# --------------------------------------------------------------------------

_FRONTMATTER = re.compile(r"^---\n.*?\n---\n", re.S)
_HEADING = re.compile(r"^#{1,6}\s+(.*)$")
_BULLET = re.compile(r"^\s*[-*+]\s+(.+)$")
_QUOTE = re.compile(r"^\s*>\s?(.*)$")
_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)|!\[\[[^\]]*\]\]")
_WIKILINK = re.compile(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]")
_MDLINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_EMPHASIS = re.compile(r"(\*\*|__|\*|_|`|~~)")
# Zero-width characters. The AI that writes these notes sprinkles them through
# headings, and they turn into visible boxes in some fonts on the board.
_INVISIBLE = re.compile(r"[​-‏  ﻿­]")


def _lf(text: str) -> str:
    """CRLF to LF.

    These notes are written on Windows and are CRLF, so the frontmatter fence
    never matched and the YAML block was showing up as the note's first
    excerpt. Every line-anchored pattern in this module depends on this.
    """
    return str(text or "").replace("\r\n", "\n").replace("\r", "\n")


def plain(text: str) -> str:
    """Markdown to something a wall can read.

    Links keep their LABEL rather than their target: "[[2026-01-25 Sermon|last
    week]]" is meaningful on a wall, the path is not.
    """
    text = html.unescape(_lf(text))
    text = _INVISIBLE.sub("", text)
    text = _IMAGE.sub("", text)
    text = _WIKILINK.sub(lambda m: m.group(2) or m.group(1), text)
    text = _MDLINK.sub(r"\1", text)
    text = _EMPHASIS.sub("", text)
    return re.sub(r"[ \t]+", " ", text).strip()


def _body_text(markdown: str) -> str:
    """The whole note, for the scrolling mode.

    Line by line rather than plain() over the lot: plain() collapses
    whitespace, which is right for a single excerpt and wrong here - it would
    turn the entire note into one unbroken paragraph.
    """
    body = _FRONTMATTER.sub("", _lf(markdown))
    lines = [plain(line) for line in body.split("\n")]
    # Never more than one blank line in a row, or the scroller spends most of
    # its travel on whitespace.
    tidy: list[str] = []
    for line in lines:
        if not line and tidy and not tidy[-1]:
            continue
        tidy.append(line)
    return "\n".join(tidy).strip()


def excerpts(markdown: str, *, kinds: str = "all", min_chars: int = 40,
             max_chars: int = 400) -> list[dict]:
    """Break a note into individually showable pieces.

    Each piece carries the heading it sat under, because "Day 3: The Glue of
    the Universe" is most of the context a single bullet needs to make sense
    out of its note.

    Pieces shorter than `min_chars` are dropped: a two-word bullet on a wall
    reads as a rendering fault, not as content.
    """
    # Normalise line endings FIRST. These notes are CRLF, so the
    # frontmatter fence never matched and the YAML block was being shown
    # as the note's first excerpt.
    body = _FRONTMATTER.sub("", _lf(markdown))
    want = {k.strip() for k in str(kinds or "all").split(",") if k.strip()}
    take_all = "all" in want or not want

    out: list[dict] = []
    heading = ""
    para: list[str] = []
    quote_buf: list[str] = []

    def flush_para():
        if not para:
            return
        joined = plain(" ".join(para))
        para.clear()
        if (take_all or "paragraph" in want) and len(joined) >= min_chars:
            out.append({"kind": "paragraph", "heading": heading, "text": joined[:max_chars]})

    def flush_quote():
        if not quote_buf:
            return
        joined = plain(" ".join(quote_buf))
        quote_buf.clear()
        if (take_all or "quote" in want) and len(joined) >= min_chars:
            out.append({"kind": "quote", "heading": heading, "text": joined[:max_chars]})

    for raw in body.splitlines():
        line = raw.rstrip()

        m = _HEADING.match(line)
        if m:
            flush_para(); flush_quote()
            heading = plain(m.group(1))
            continue

        q = _QUOTE.match(line)
        if q:
            flush_para()
            quote_buf.append(q.group(1))
            continue
        flush_quote()

        b = _BULLET.match(line)
        if b:
            flush_para()
            text = plain(b.group(1))
            if (take_all or "bullet" in want) and len(text) >= min_chars:
                out.append({"kind": "bullet", "heading": heading, "text": text[:max_chars]})
            continue

        if not line.strip():
            flush_para()
            continue
        para.append(line)

    flush_para(); flush_quote()
    return out


def title_of(markdown: str, fallback: str = "") -> str:
    """The note's own H1 if it has one, else its filename without the date."""
    body = _FRONTMATTER.sub("", _lf(markdown))
    for line in body.splitlines():
        m = _HEADING.match(line.rstrip())
        if m:
            return plain(m.group(1))
    name = re.sub(r"\.md$", "", fallback or "", flags=re.I)
    # These are filed as "05.03.26 - What Is This Power"; the date is already
    # shown elsewhere and only costs width here.
    return plain(re.sub(r"^[\d.\-_ ]+[-–]\s*", "", name)).strip() or name


def pick_note(notes: list[str], how: str) -> str:
    """Which note to show.

    'daily' is seeded by the DATE so the whole day shows one note and it
    changes at midnight - the difference between a feature and a flicker.
    """
    if not notes:
        return ""
    if how == "newest":
        return sorted(notes)[-1]
    if how == "random":
        return random.choice(notes)
    return notes[date.today().toordinal() % len(notes)]


def fetch(config: dict, *, ttl: float = 300.0) -> FetchResult:
    """Everything a note widget needs: the chosen note, and its excerpts."""
    listing = list_notes(config, ttl=ttl)
    if listing.error:
        return listing

    notes = listing.payload["notes"]
    folder = config.get("folder") or ""
    chosen = pick_note(notes, config.get("pick", "daily"))
    path = f"{folder}/{chosen}" if folder else chosen

    note = read_note(config, path, ttl=ttl)
    if note.error:
        return note

    text = note.payload["text"]
    pieces = excerpts(
        text,
        kinds=config.get("kinds", "all"),
        min_chars=int(config.get("min_chars", 40) or 40),
        max_chars=int(config.get("max_chars", 400) or 400),
    )
    return FetchResult(payload={
        "note": chosen,
        "path": path,
        "title": title_of(text, chosen),
        "excerpts": pieces,
        "total_notes": len(notes),
        # The whole note, cleaned, for the "scroll one note" mode.
        "body": _body_text(text),
    })
