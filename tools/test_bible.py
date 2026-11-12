"""The verse block, against book names that do not match on sight.

The board once reported "Psalm 37:4 is not in the local NLT" while holding a
complete NLT - because the citation says "Psalm" and the file says "Psalms".
These tests pin the matching, and the rebuild of an index left over from
before book names were normalised.

Run: python tools/test_bible.py
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

failures: list[str] = []


def check(name: str, got, want) -> None:
    if got == want:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name}\n       got:  {got!r}\n       want: {want!r}")
        failures.append(name)


def check_raises(name: str, fn, fragment: str) -> None:
    try:
        fn()
    except Exception as exc:  # noqa: BLE001
        if fragment in str(exc):
            print(f"  ok   {name}")
        else:
            print(f"  FAIL {name}: raised {exc!r}, expected to mention {fragment!r}")
            failures.append(name)
        return
    print(f"  FAIL {name}: did not raise")
    failures.append(name)


BOOKS = [
    {"book": "Psalms", "chapters": [
        {"chapter": 37, "verses": [
            {"verse": 3, "text": "Trust in the LORD and do good."},
            {"verse": 4, "text": "⁴ Take delight in the LORD, and he will give you your heart’s desires."},
        ]},
    ]},
    {"book": "Song of Songs", "chapters": [
        {"chapter": 2, "verses": [{"verse": 1, "text": "I am the rose of Sharon."}]},
    ]},
    {"book": "I John", "chapters": [
        {"chapter": 4, "verses": [{"verse": 8, "text": "God is love."}]},
    ]},
    {"book": "Judges", "chapters": [
        {"chapter": 1, "verses": [{"verse": 1, "text": "After Joshua died."}]},
    ]},
    {"book": "Jude", "chapters": [
        {"chapter": 1, "verses": [{"verse": 1, "text": "This letter is from Jude."}]},
    ]},
]

tmp = Path(tempfile.mkdtemp(prefix="lifeboard-bible-"))
os.environ["LIFEBOARD_NLT_JSON"] = str(tmp / "nlt.json")
(tmp / "nlt.json").write_text(json.dumps(BOOKS), encoding="utf8")

from lifeboard.providers import bible  # noqa: E402

print("canon_book")
check("Psalm -> psalms", bible.canon_book("Psalm"), "psalms")
check("Psalms stays", bible.canon_book("Psalms"), "psalms")
check("I John -> 1 john", bible.canon_book("I John"), "1 john")
check("First John -> 1 john", bible.canon_book("First John"), "1 john")
check("1 John stays", bible.canon_book("1 John"), "1 john")
check("II Timothy -> 2 timothy", bible.canon_book("II Timothy"), "2 timothy")
check("Song of Songs -> song of solomon",
      bible.canon_book("Song of Songs"), "song of solomon")
check("Revelations -> revelation", bible.canon_book("Revelations"), "revelation")
check("Acts of the Apostles -> acts",
      bible.canon_book("Acts of the Apostles"), "acts")
check("stray punctuation", bible.canon_book(" St.  Mark. "), "st mark")

print("parse_reference")
check("Psalm 37:4", bible.parse_reference("Psalm 37:4"), ("psalms", 37, 4, 4))
check("range", bible.parse_reference("1 John 4:7-8"), ("1 john", 4, 7, 8))
check("nonsense", bible.parse_reference("not a reference"), None)

print("lookup against a file that spells books differently")
check("the verse that failed on the board (Psalm vs Psalms)",
      bible._from_nlt("Psalm 37:4"),
      "Take delight in the LORD, and he will give you your heart’s desires.")
check("superscript verse numbers are stripped",
      any(c in bible._from_nlt("Psalm 37:4") for c in "⁰¹²³⁴⁵⁶⁷⁸⁹"), False)
check("range joins verses",
      bible._from_nlt("Psalms 37:3-4").startswith("Trust in the LORD"), True)
check("Song of Solomon finds Song of Songs",
      bible._from_nlt("Song of Solomon 2:1"), "I am the rose of Sharon.")
check("1 John finds I John", bible._from_nlt("1 John 4:8"), "God is love.")
check("an abbreviation resolves when it is unambiguous",
      bible._from_nlt("Ps 37:3"), "Trust in the LORD and do good.")
check_raises("an ambiguous abbreviation is refused, not guessed",
             lambda: bible._from_nlt("Jud 1:1"), "has no Jud 1:1")
check_raises("a verse that really is absent still says so",
             lambda: bible._from_nlt("Psalm 119:1"), "has no Psalm 119:1")

print("an index from the previous version is rebuilt, not trusted")
old = sqlite3.connect(bible.NLT_DB)
old.execute("DROP TABLE IF EXISTS verse")
old.execute("DROP TABLE IF EXISTS meta")
old.execute("CREATE TABLE verse (book TEXT, chapter INT, verse INT, text TEXT)")
old.execute("INSERT INTO verse VALUES ('psalms', 37, 4, 'stale text')")
old.commit()
old.close()
check("schema of a pre-normalisation index reads as 0", bible._db_schema(), 0)
check("it rebuilds on the next lookup",
      bible._from_nlt("Psalm 37:3"), "Trust in the LORD and do good.")
check("and records the current schema", bible._db_schema(), bible.DB_SCHEMA)

print("with no NLT installed at all")
bible.NLT_PATH.unlink()
bible.NLT_DB.unlink(missing_ok=True)
check_raises("says so plainly", lambda: bible._from_nlt("Psalm 37:4"),
             "no NLT file is installed")

real = Path.home() / "Downloads" / "Bible" / "complete_bible_nlt.json"
if real.exists():
    print("against the real NLT file")
    bible.NLT_PATH.write_bytes(real.read_bytes())
    bible.NLT_DB.unlink(missing_ok=True)
    check("Psalm 37:4 (the reported failure)",
          bible._from_nlt("Psalm 37:4").startswith("Take delight in the Lord"), True)
    for ref in ("John 3:16", "1 John 4:8", "Revelation 21:4", "II Timothy 1:7",
                "Psalms 23:1", "Acts 2:38", "Genesis 1:1", "Jude 1:24"):
        check(f"{ref} resolves", bool(bible._from_nlt(ref)), True)
    # A book present in name only reads as a working Bible until something
    # cites it, so the file itself gets checked rather than assumed.
    empty = [b["book"] for b in json.loads(real.read_text(encoding="utf8"))
             if not b.get("chapters")]
    if empty:
        print(f"  note: this NLT file has no text for: {', '.join(empty)}")
else:
    print(f"(skipped the real-file check: {real} not present)")

print()
if failures:
    print(f"{len(failures)} failed: {', '.join(failures)}")
    sys.exit(1)
print("all bible checks passed")
