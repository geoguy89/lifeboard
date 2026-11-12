# -*- coding: utf-8 -*-
"""Nothing shipped should carry one person's private details.

    python tools/test_no_secrets.py

Templates live in the repo AND inside every flashed image, so a template made
from somebody's real board publishes their details to everyone who flashes it.
That is not hypothetical: regenerating a template from a live board carried
a guest Wi-Fi SSID and PASSWORD into a committed file, and it took a human
noticing to catch it.

This is the check that should have caught it. It runs over the templates and
the tracked source, and fails on anything that looks like a credential, a
private address, or a real account.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

failures: list[str] = []
checked = 0


def fail(where: str, what: str) -> None:
    failures.append(f"{where}: {what}")


# Config keys that must never hold a real value in a shipped template. The
# placeholders the scrubber writes are allowed; anything else is not.
SECRET_KEYS = {
    "password": {"", "your-wifi-password"},
    "ssid": {"", "Your Wi-Fi name"},
    "api_key": {""},
    "access_key": {""},
    "token": {""},
    "share_url": {""},
    "share_urls": {""},
    "base_url": {""},
    "folder": {""},
    "entity": {""},
    "entities": {""},
}

# Shapes that are private wherever they appear.
# Addresses that are SUPPOSED to be in the source. Loopback is how the kiosk
# reaches its own server; 10.42.0.1 is the address NetworkManager gives the
# setup hotspot; the 192.0.2 / 198.51.100 / 203.0.113 ranges exist precisely so
# documentation can name an address without naming anybody's.
ALLOWED_ADDRESSES = re.compile(
    r"^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}"
    r"|10\.42\.0\.1"
    r"|0\.0\.0\.0"
    r"|192\.0\.2\.\d{1,3}"
    r"|198\.51\.100\.\d{1,3}"
    r"|203\.0\.113\.\d{1,3})$")

PATTERNS = [
    (re.compile(r"\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b"), "a private IP address"),
    (re.compile(r"\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b"), "a private IP address"),
    (re.compile(r"\b192\.168\.\d{1,3}\.\d{1,3}\b"), "a private IP address"),
    # Not a systemd unit: "getty@tty1.service" is the same shape as an address
    # and is not one. A guard that cries wolf gets skimmed, and skimming is how
    # the real thing gets through.
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(?!service\b|socket\b|timer\b|target\b)[A-Za-z]{2,}"),
     "an email address"),
    (re.compile(r"\bBearer\s+[A-Za-z0-9._-]{16,}"), "a bearer token"),
    (re.compile(r"\b[a-f0-9]{40,}\b"), "a long hex string (key or token?)"),
    (re.compile(r"\bsk-[A-Za-z0-9]{16,}"), "an API key"),
]

# Words that only appear if somebody's real board leaked in. Kept as a list so
# a new one can be added the moment it is noticed.
# Words that only appear if somebody's real board leaked in: household names,
# hostnames, network names, passwords. Kept OUT of the repo - a published list
# of the strings to protect would publish them - in tools/personal-words.txt,
# one per line, which .gitignore excludes. Without that file this still runs
# every pattern check below.
PERSONAL: list[str] = []
_WORDS = Path(__file__).with_name("personal-words.txt")
if _WORDS.exists():
    PERSONAL = [w.strip() for w in _WORDS.read_text(encoding="utf8").splitlines()
                if w.strip() and not w.lstrip().startswith("#")]

# Words that are only a problem in PROSE. "Tower" appears inside perfectly
# ordinary English, so it cannot go in PERSONAL without failing on the word
# itself; it is checked as a standalone capitalised noun instead.
HOSTNAMES = [re.compile(r"\bTower\b")]


def scan_text(where: str, text: str) -> None:
    # Tests and docs legitimately use made-up private addresses and
    # example.com mailboxes - that is what a test of the address scrubber is
    # made of. They are still checked for names, hostnames and credentials.
    fixtures = where.startswith(("tools/", "docs/"))
    if where != "tools/test_no_secrets.py":
        for pattern in HOSTNAMES:
            m = pattern.search(text)
            if m:
                fail(where, f"names a machine: {m.group(0)!r}")
    for word in PERSONAL:
        if word.lower() in text.lower():
            fail(where, f"contains {word!r}")
    for pattern, label in PATTERNS:
        for m in pattern.finditer(text):
            if label == "a private IP address" and (fixtures or ALLOWED_ADDRESSES.match(m.group(0))):
                continue
            if label == "an email address" and m.group(0).lower().endswith("@example.com"):
                continue
            fail(where, f"{label}: {m.group(0)!r}")
            break


def main() -> int:
    global checked

    # --- templates ---------------------------------------------------------
    for path in sorted((ROOT / "templates").glob("*.json")):
        checked += 1
        data = json.loads(path.read_text(encoding="utf8"))
        where = f"templates/{path.name}"
        scan_text(where, json.dumps(data))

        for widget in data.get("widgets", []):
            config = widget.get("config") or {}
            for key, allowed in SECRET_KEYS.items():
                if key in config and str(config[key]) not in allowed:
                    fail(where, f"{widget.get('kind')}.{key} = "
                                f"{str(config[key])[:40]!r} is a real value")
            # A source id is meaningless elsewhere and hints the template was
            # exported without being converted.
            # These all name something that exists only on the board the
            # template came from: an account, a SharePoint site, a Planner
            # plan, a list. A template carrying one points at a stranger's
            # tenant, or at nothing.
            for key in ("source_id", "source_ids", "site_id", "list_id",
                        "plan_id", "list_ids", "todo_list_id", "obsidian_source",
                        # Home Assistant person entities are literally people's
                        # names - "person.jane_smith" - and a template that
                        # ships them asks a stranger's board for a stranger.
                        # The widget's own help says an empty list shows
                        # everyone the installation knows, which is the right
                        # thing for a template anyway.
                        "entity_ids"):
                if key in config and config[key] not in ("", None, []):
                    fail(where, f"{widget.get('kind')}.{key} should have been stripped")

    # --- the code that ships ----------------------------------------------
    for path in sorted(ROOT.glob("*.md")):
        checked += 1
        scan_text(path.name, path.read_text(encoding="utf8"))
    for sub in ("server", "web", "deploy", "image", "android", "tools", "docs"):
        for path in sorted((ROOT / sub).rglob("*")):
            if not path.is_file() or "__pycache__" in path.parts:
                continue
            if path.name == "personal-words.txt" or path.suffix.lower() not in {
                    ".py", ".js", ".mjs", ".html", ".css", ".sh", ".json", ".service",
                    ".java", ".kt", ".gradle", ".xml", ".md", ".txt", ".conf", ".rules"}:
                continue
            checked += 1
            try:
                text = path.read_text(encoding="utf8")
            except UnicodeDecodeError:
                continue
            rel = path.relative_to(ROOT).as_posix()
            # scan_text, NOT just the word list.
            #
            # This loop used to check PERSONAL only, so every regex above -
            # private addresses, email addresses, bearer tokens, API keys -
            # was applied to templates and to nothing else. A real LAN address
            # sat in server/lifeboard/backup.py through every green run of this
            # file. A guard that skips most of its own checks on most of the
            # files it reads is worse than none, because it is trusted.
            scan_text(rel, text)

    print(f"checked {checked} files")
    if failures:
        print()
        for f in failures:
            print(f"  LEAK  {f}")
        print(f"\n{len(failures)} problem(s) - these would ship in every image")
        return 1
    print("no personal details in anything that ships")
    return 0


if __name__ == "__main__":
    sys.exit(main())
