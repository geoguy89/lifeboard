"""Verse of the day, in a choice of translations.

The daily REFERENCE and the TEXT are deliberately separate problems. ourmanna
picks the verse of the day and hands back both, but only in NIV. So the
reference is taken from there and the text is then fetched in whichever
translation was asked for.

Which translations are actually possible, and why the list is what it is:

* **NLT** - from a local JSON file. Supply your own, and a local copy means
  no key, no rate limit, and a verse block that keeps working with the
  internet down. Not shipped: a copyrighted text is not ours to
  redistribute.
* **NIV** - ourmanna's own text, which is what it returns anyway.
* **KJV / WEB / BBE** - bible-api.com. Public domain, no key.
* **NASB** is deliberately absent. It is copyrighted with no free API, and an
  option that can never work is worse than an option that is not offered.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import unicodedata
from datetime import date
from pathlib import Path

import httpx

from .base import CACHE, FetchResult

USER_AGENT = "LifeBoard/0.1 (+local dashboard)"
TIMEOUT = 15.0
TTL = 6 * 3600.0

def _default_bible_dir() -> Path:
    """Beside the database, wherever that is.

    This was hard-coded to /var/lib/lifeboard/bible, which is right on the Pi
    and on the x86 image and IMPOSSIBLE inside the Android app: there the
    board's data lives in the app's private files directory, and nothing may be
    written to /var/lib at all. So on a TV the NLT file could never be found,
    the lookup failed every single day, and the block quietly served NIV to
    somebody who had explicitly chosen NLT.

    Deriving it from LIFEBOARD_DB - which every platform already sets, because
    the database has the same problem - means one rule that is correct
    everywhere instead of a per-platform variable somebody has to remember.
    """
    db_path = os.environ.get("LIFEBOARD_DB")
    if db_path:
        return Path(db_path).parent / "bible"
    return Path("/var/lib/lifeboard/bible")


# Overridable so a box can put it somewhere else without editing code.
NLT_PATH = Path(os.environ.get(
    "LIFEBOARD_NLT_JSON", str(_default_bible_dir() / "nlt.json")))

OURMANNA = "https://beta.ourmanna.com/api/v1/get"
BIBLE_API = "https://bible-api.com/"

# What bible-api.com calls each of these.
FREE_TRANSLATIONS = {"kjv": "kjv", "web": "web", "bbe": "bbe"}

TRANSLATIONS = ("nlt", "niv", "kjv", "web", "bbe")

# Book names have to be matched across two sources that do not agree.
#
# ourmanna cites "Psalm 37:4". Every NLT JSON in circulation calls that book
# "Psalms". Nothing is wrong with either, but a straight string comparison
# misses, and the board then says the verse is not in a Bible that plainly
# contains it. The same split exists for Song of Solomon / Song of Songs, for
# Revelation / Revelations, and for numbered books written "1 John" in one
# place and "I John" or "First John" in the other.
#
# So both sides are put through canon_book() - the file when it is indexed and
# the reference when it is looked up - and only then compared.
_NUMERALS = {
    "i": "1", "1st": "1", "first": "1",
    "ii": "2", "2nd": "2", "second": "2",
    "iii": "3", "3rd": "3", "third": "3",
}

_BOOK_ALIASES = {
    "psalm": "psalms",
    "psalter": "psalms",
    "song of songs": "song of solomon",
    "songs of solomon": "song of solomon",
    "canticles": "song of solomon",
    "canticle of canticles": "song of solomon",
    "ecclesiastes the preacher": "ecclesiastes",
    "revelations": "revelation",
    "revelation of john": "revelation",
    "revelation to john": "revelation",
    "revelation of jesus christ": "revelation",
    "acts of the apostles": "acts",
    "the acts": "acts",
}


def canon_book(name: str) -> str:
    """'I  John.' / 'First John' / '1 John' -> '1 john'. Plus the aliases above."""
    text = unicodedata.normalize("NFKC", str(name or "")).lower()
    text = text.replace(".", " ").replace("'", "").replace("’", "")
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    if text.startswith("the "):
        text = text[4:]
    parts = text.split(" ")
    if parts and parts[0] in _NUMERALS:
        parts[0] = _NUMERALS[parts[0]]
    # "John, First" and "John 1" also happen in hand-made files.
    elif len(parts) > 1 and parts[-1] in _NUMERALS:
        parts = [_NUMERALS[parts[-1]]] + parts[:-1]
    text = " ".join(parts).strip()
    return _BOOK_ALIASES.get(text, text)

_SUPERSCRIPT = {ord(c): None for c in "⁰¹²³⁴⁵⁶⁷⁸⁹"}
_REF = re.compile(r"^\s*(?P<book>(?:[123]\s+)?[A-Za-z ]+?)\s+"
                  r"(?P<chapter>\d+):(?P<start>\d+)(?:\s*-\s*(?P<end>\d+))?\s*$")

# The JSON is converted ONCE into a small SQLite file beside it.
#
# Parsing 6.4MB of JSON on a Pi 3 takes about twenty seconds, and it happened
# on the first request after every restart - long enough for the widget's own
# fetch to give up. SQLite turns that into a one-time cost and then indexed
# lookups that need no memory held open at all.
NLT_DB = NLT_PATH.with_suffix(".sqlite")

# Bumped whenever the way books are stored changes, so a board that already
# has an index rebuilds it instead of carrying yesterday's spelling forever.
# Schema 1 stored book names exactly as the JSON wrote them, which is why
# "Psalm 37:4" could not find a book stored as "psalms".
DB_SCHEMA = 2


def _clean(text: str) -> str:
    """Strip the superscript verse numbers the local NLT embeds in its text.

    They read as noise mid-sentence on a wall, and a verse that begins with a
    stray digit looks like a rendering bug rather than a citation.
    """
    text = str(text or "").translate(_SUPERSCRIPT)
    text = unicodedata.normalize("NFKC", text)
    return re.sub(r"\s+", " ", text).strip()


def _build_db() -> None:
    """One pass over the JSON into an indexed table. Written to a temporary
    file and renamed, so an interrupted build never leaves a half-populated
    database that would then be trusted."""
    if not NLT_PATH.exists():
        raise FileNotFoundError(
            f"No NLT file at {NLT_PATH}. Copy a complete NLT JSON there, or "
            "pick a different translation.")

    tmp = NLT_DB.with_suffix(".building")
    tmp.unlink(missing_ok=True)
    with NLT_PATH.open(encoding="utf8") as fh:
        raw = json.load(fh)

    conn = sqlite3.connect(tmp)
    try:
        conn.execute("CREATE TABLE verse (book TEXT, chapter INT, verse INT, text TEXT)")
        conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
        conn.execute("INSERT INTO meta VALUES ('schema', ?)", (str(DB_SCHEMA),))
        rows = []
        for book in raw:
            name = canon_book(book["book"])
            for chapter in book.get("chapters", []):
                c = int(chapter["chapter"])
                for v in chapter.get("verses", []):
                    rows.append((name, c, int(v["verse"]), _clean(v["text"])))
        conn.executemany("INSERT INTO verse VALUES (?,?,?,?)", rows)
        conn.execute("CREATE INDEX ref ON verse (book, chapter, verse)")
        conn.commit()
    finally:
        conn.close()
    tmp.replace(NLT_DB)


def nlt_status() -> dict:
    """Whether a local NLT is installed, and whether it indexed.

    A verse block set to NLT on a board with no NLT file works perfectly and
    shows the wrong translation. That is the hardest kind of fault to notice,
    so the admin gets to state it plainly instead of leaving somebody to spot
    that their scripture changed version.
    """
    verses = 0
    if NLT_DB.exists():
        try:
            conn = sqlite3.connect(f"file:{NLT_DB}?mode=ro", uri=True)
            try:
                verses = int(conn.execute("SELECT COUNT(*) FROM verse").fetchone()[0])
            finally:
                conn.close()
        except sqlite3.Error:
            verses = 0
    return {
        "path": str(NLT_PATH),
        "installed": NLT_PATH.exists(),
        "bytes": NLT_PATH.stat().st_size if NLT_PATH.exists() else 0,
        "indexed": NLT_DB.exists(),
        "verses": verses,
    }


def install_nlt(raw: bytes) -> dict:
    """Accept an uploaded NLT JSON, index it, and keep the old one until it works.

    WHY AN UPLOAD EXISTS AT ALL
    ---------------------------
    On the Pi you copy a file next to the database and you are done. Inside the
    Android app you cannot: the board's data lives in the app's private
    directory, which no file manager reaches and nothing writes to without
    developer access to the TV. Without this, choosing NLT on a television is a
    setting that can never come true - which is exactly what was happening.

    INDEXED BEFORE IT IS TRUSTED
    ----------------------------
    The new file is only kept if it builds. Writing first and discovering at
    the next lookup means a board that quietly returns to NIV with a broken
    file sitting on disk looking installed - the same silent-wrong-answer
    failure this whole endpoint exists to end.
    """
    try:
        parsed = json.loads(raw.decode("utf8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"that file is not readable JSON: {exc}") from exc
    if not isinstance(parsed, list):
        raise ValueError(
            "an NLT file should be a JSON array of books, each with a `book` "
            "name and a `chapters` list")

    NLT_PATH.parent.mkdir(parents=True, exist_ok=True)
    previous = NLT_PATH.with_suffix(".previous")
    previous.unlink(missing_ok=True)
    if NLT_PATH.exists():
        NLT_PATH.replace(previous)

    try:
        NLT_PATH.write_bytes(raw)
        NLT_DB.unlink(missing_ok=True)
        _build_db()
    except Exception as exc:  # noqa: BLE001
        # Put back whatever was working: a board that had a verse this morning
        # must not end up with neither the old file nor a usable new one.
        NLT_PATH.unlink(missing_ok=True)
        NLT_DB.unlink(missing_ok=True)
        if previous.exists():
            previous.replace(NLT_PATH)
        raise ValueError(f"that file could not be read as an NLT: {exc}") from exc

    previous.unlink(missing_ok=True)
    return nlt_status()


def _db_schema() -> int:
    """The schema an existing index was built with; 0 if it predates the meta
    table or cannot be read."""
    try:
        conn = sqlite3.connect(f"file:{NLT_DB}?mode=ro", uri=True)
        try:
            row = conn.execute("SELECT value FROM meta WHERE key='schema'").fetchone()
            return int(row[0]) if row else 0
        finally:
            conn.close()
    except (sqlite3.Error, ValueError, TypeError):
        return 0


def _resolve_book(conn: sqlite3.Connection, book: str) -> str | None:
    """The stored book name for a citation, allowing for harmless differences.

    canon_book() settles the disagreements that are known. This catches the
    rest without a table of every abbreviation anyone might ship: if exactly
    one book in the file starts with what was asked for (or the other way
    round), that is the book. "ps" finds Psalms; "jud" matches both Judges and
    Jude, so it deliberately finds nothing rather than guessing.
    """
    hit = conn.execute("SELECT 1 FROM verse WHERE book=? LIMIT 1", (book,)).fetchone()
    if hit:
        return book
    books = [r[0] for r in conn.execute("SELECT DISTINCT book FROM verse")]
    near = [b for b in books if b.startswith(book) or book.startswith(b)]
    return near[0] if len(near) == 1 else None


def _nlt_lookup(book: str, chapter: int, start: int, end: int) -> str:
    # An index built by an older version stored book names as the JSON spelled
    # them, so it has to be rebuilt before it can be trusted to answer.
    if not NLT_DB.exists() or _db_schema() < DB_SCHEMA:
        _build_db()
    conn = sqlite3.connect(f"file:{NLT_DB}?mode=ro", uri=True)
    try:
        stored = _resolve_book(conn, book)
        if stored is None:
            return ""
        rows = conn.execute(
            "SELECT text FROM verse WHERE book=? AND chapter=? "
            "AND verse BETWEEN ? AND ? ORDER BY verse",
            (stored, chapter, start, end),
        ).fetchall()
    finally:
        conn.close()
    return " ".join(r[0] for r in rows if r[0])


def parse_reference(ref: str) -> tuple[str, int, int, int] | None:
    """'John 3:16-17' -> ('john', 3, 16, 17). Returns None if unparseable."""
    m = _REF.match(str(ref or ""))
    if not m:
        return None
    book = canon_book(m.group("book"))
    start = int(m.group("start"))
    end = int(m.group("end") or start)
    return book, int(m.group("chapter")), start, max(start, end)


def _from_nlt(ref: str) -> str:
    parsed = parse_reference(ref)
    if not parsed:
        raise ValueError(f"could not read the reference {ref!r}")
    book, chapter, start, end = parsed
    if not NLT_PATH.exists():
        raise ValueError("no NLT file is installed on this board")
    text = _nlt_lookup(book, chapter, start, end)
    if not text:
        raise ValueError(f"the installed NLT file has no {ref}")
    return text


def _from_bible_api(ref: str, translation: str) -> str:
    with httpx.Client(timeout=TIMEOUT, follow_redirects=True,
                      headers={"User-Agent": USER_AGENT}) as client:
        resp = client.get(BIBLE_API + ref.replace(" ", "+"),
                          params={"translation": FREE_TRANSLATIONS[translation]})
        resp.raise_for_status()
        data = resp.json()
    text = _clean(data.get("text", ""))
    if not text:
        raise ValueError(f"{ref} came back empty from bible-api.com")
    return text


def _daily_reference() -> tuple[str, str, str]:
    """(reference, niv_text, version) for today, from ourmanna."""
    with httpx.Client(timeout=TIMEOUT, follow_redirects=True,
                      headers={"User-Agent": USER_AGENT}) as client:
        resp = client.get(OURMANNA, params={"format": "json", "order": "daily"})
        resp.raise_for_status()
        details = ((resp.json() or {}).get("verse") or {}).get("details") or {}
    return (
        _clean(details.get("reference", "")),
        _clean(details.get("text", "")),
        _clean(details.get("version", "NIV")),
    )


def verse_of_the_day(translation: str = "nlt", *, ttl: float = TTL) -> FetchResult:
    translation = (translation or "nlt").lower()
    if translation not in TRANSLATIONS:
        translation = "nlt"

    # The NLT file's timestamp is part of the key, so installing one takes
    # effect immediately instead of at the end of the six-hour cache. Without
    # it, uploading a Bible and still seeing NIV reads as a failed upload.
    stamp = ""
    if translation == "nlt" and NLT_PATH.exists():
        try:
            stamp = str(int(NLT_PATH.stat().st_mtime))
        except OSError:
            stamp = ""
    cache_key = ("verse", translation, date.today().isoformat(), stamp)
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached

    try:
        reference, niv_text, _version = _daily_reference()
        if not reference:
            raise ValueError("no verse reference for today")

        note = ""
        if translation == "niv":
            text, shown = niv_text, "NIV"
        elif translation == "nlt":
            try:
                text, shown = _from_nlt(reference), "NLT"
            except Exception as exc:  # noqa: BLE001
                # Falling back silently would leave a block quietly showing the
                # wrong translation, which is exactly the thing someone who
                # picked a translation would want to know about.
                text, shown = niv_text, "NIV"
                note = f"NLT unavailable ({exc}); showing NIV"
        else:
            text, shown = _from_bible_api(reference, translation), translation.upper()

        if not text:
            raise ValueError(f"{reference} produced no text")

        result = FetchResult(payload={
            "text": text,
            "attribution": reference,
            "extra": shown,
            "note": note,
            "kind": "bible_verse",
        })
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=f"{type(exc).__name__}: {exc}")
    return CACHE.put(cache_key, result)
