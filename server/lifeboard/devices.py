"""Device registry, API keys, webhooks and pushed variables.

DEVICES
-------
Each display registers itself the first time it loads the renderer and keeps a
token in its own browser storage. That gives the admin UI a real list of
screens — name, last seen, what they are showing — and makes **remote refresh**
possible: the server bumps a counter, the device notices on its next poll and
reloads itself. No push channel to keep alive, which matters for a device that
may be asleep half the day.

A device that has not been seen for a while is *stale*, not deleted. A board in
a spare room that gets switched on at Christmas should still be itself.

API KEYS AND WEBHOOKS
---------------------
Two different things for two different callers:

* An **API key** is for a script that wants to drive LifeBoard — read layouts,
  create a task, flip a screen. It is a long random string, stored hashed, and
  it grants the same access a session does.
* A **webhook** is for something that just wants to *push a value in*: a
  Grafana alert, a Home Assistant automation, a cron job reporting a backup
  result. It has its own single-purpose token, can only write one named
  variable, and cannot read anything at all.

That split matters. Most integrations only need to push, and handing them a
full API key to do it would be careless.

Pushed values land in `variables`, and any widget can read one through the
`variable` data source — so a script writing a number is indistinguishable, to
the board, from an API returning one.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import secrets
import threading
from datetime import datetime, timedelta, timezone

from . import db

log = logging.getLogger("lifeboard.devices")

SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
    id           INTEGER PRIMARY KEY,
    token        TEXT NOT NULL UNIQUE,   -- the device holds this; never shown in full
    name         TEXT NOT NULL DEFAULT '',
    screen_id    INTEGER REFERENCES screens(id) ON DELETE SET NULL,
    user_agent   TEXT NOT NULL DEFAULT '',
    address      TEXT NOT NULL DEFAULT '',
    resolution   TEXT NOT NULL DEFAULT '',
    -- Bumped by the admin UI. The device compares it to what it last saw and
    -- reloads when it changes, which is remote refresh with no push channel.
    refresh_seq  INTEGER NOT NULL DEFAULT 0,
    first_seen   TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen    TEXT NOT NULL DEFAULT (datetime('now')),
    notes        TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS api_keys (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    -- Hashed. The plaintext is shown exactly once, at creation.
    key_hash   TEXT NOT NULL,
    prefix     TEXT NOT NULL DEFAULT '',   -- first 8 chars, so keys are identifiable
    read_only  INTEGER NOT NULL DEFAULT 0,
    last_used  TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhooks (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    token      TEXT NOT NULL UNIQUE,
    -- The single variable this hook may write. That limit is the whole point.
    variable   TEXT NOT NULL,
    -- 'variable' pushes a value; 'task' adds a task to one list. Same token
    -- machinery either way, because a second token concept would mean a second
    -- place to leak one from.
    kind       TEXT NOT NULL DEFAULT 'variable',
    -- For kind='task': the todo_lists row it may add to, and nothing else.
    target     INTEGER,
    -- Where to POST when a task that arrived through this link is completed.
    -- A Teams Incoming Webhook URL goes straight in here; so does an n8n or
    -- Power Automate URL, which is how this reaches email without the board
    -- having to hold SMTP credentials.
    notify_url TEXT NOT NULL DEFAULT '',
    last_used  TEXT,
    hits       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS variables (
    name       TEXT PRIMARY KEY,
    value      TEXT NOT NULL DEFAULT '',   -- JSON
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    source     TEXT NOT NULL DEFAULT ''    -- 'webhook:name' or 'api'
);
"""

# A device that has not checked in for this long is shown as offline. Ten
# minutes is comfortably longer than the renderer's poll interval plus a
# reboot, so a healthy board never flickers between states.
OFFLINE_AFTER = timedelta(minutes=10)


# Columns added after these tables first shipped. CREATE TABLE IF NOT EXISTS
# does nothing to a table that already exists, so a board that has been running
# since before task inboxes needs these applied explicitly - otherwise every
# webhook read fails on a column that is in the schema text and not in the
# database.
_ADDED_COLUMNS = [
    ("webhooks", "kind", "TEXT NOT NULL DEFAULT 'variable'"),
    ("webhooks", "target", "INTEGER"),
    ("webhooks", "notify_url", "TEXT NOT NULL DEFAULT ''"),
    # Who sent a task, and through which link - so that when somebody crosses
    # it off the board, the answer to "tell whoever asked for this" exists.
    ("todo_items", "created_by", "TEXT NOT NULL DEFAULT ''"),
    ("todo_items", "created_email", "TEXT NOT NULL DEFAULT ''"),
    ("todo_items", "source_hook", "INTEGER"),
]


def ensure_schema() -> None:
    conn = db.connect()
    conn.executescript(SCHEMA)
    for table, column, ddl in _ADDED_COLUMNS:
        have = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        if column not in have:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


# --------------------------------------------------------------------------
#  Devices
# --------------------------------------------------------------------------

def register(token: str, info: dict) -> dict:
    """Called by the renderer on load and on every heartbeat.

    An unknown token creates a device rather than being rejected: the whole
    point is that plugging in a new screen just works, and there is no console
    on it to type a pairing code into.
    """
    ensure_schema()
    row = db.one("SELECT * FROM devices WHERE token = ?", (token,))
    if not row:
        db.execute(
            "INSERT INTO devices (token, name, screen_id, user_agent, address, resolution) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                token,
                info.get("name") or "",
                info.get("screen_id"),
                (info.get("user_agent") or "")[:250],
                (info.get("address") or "")[:60],
                (info.get("resolution") or "")[:24],
            ),
        )
        row = db.one("SELECT * FROM devices WHERE token = ?", (token,))
    else:
        db.execute(
            "UPDATE devices SET last_seen = datetime('now'), user_agent = ?, "
            "address = ?, resolution = ?, screen_id = COALESCE(?, screen_id) WHERE id = ?",
            (
                (info.get("user_agent") or row["user_agent"])[:250],
                (info.get("address") or row["address"])[:60],
                (info.get("resolution") or row["resolution"])[:24],
                info.get("screen_id"),
                row["id"],
            ),
        )
        row = db.one("SELECT * FROM devices WHERE id = ?", (row["id"],))

    return {"device_id": row["id"], "refresh_seq": row["refresh_seq"], "name": row["name"]}


def listing() -> list[dict]:
    ensure_schema()
    now = datetime.now(timezone.utc)
    out = []
    for row in db.query("SELECT * FROM devices ORDER BY last_seen DESC"):
        seen = _parse(row["last_seen"])
        out.append({
            "id": row["id"],
            "name": row["name"] or f"Display {row['id']}",
            "screen_id": row["screen_id"],
            "user_agent": row["user_agent"],
            "address": row["address"],
            "resolution": row["resolution"],
            "first_seen": row["first_seen"],
            "last_seen": row["last_seen"],
            "online": bool(seen and (now - seen) < OFFLINE_AFTER),
            "seen_seconds_ago": int((now - seen).total_seconds()) if seen else None,
            # Never the whole token: it is a credential, and the admin UI only
            # needs enough of it to tell two displays apart.
            "token_hint": row["token"][:6],
            "notes": row["notes"],
        })
    return out


def _parse(stamp: str | None) -> datetime | None:
    if not stamp:
        return None
    try:
        return datetime.fromisoformat(stamp).replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def request_refresh(device_id: int | None = None) -> int:
    """Bump the refresh counter. No id means every device."""
    ensure_schema()
    if device_id:
        db.execute("UPDATE devices SET refresh_seq = refresh_seq + 1 WHERE id = ?", (device_id,))
        return 1
    rows = db.query("SELECT id FROM devices")
    db.execute("UPDATE devices SET refresh_seq = refresh_seq + 1")
    return len(rows)


# --------------------------------------------------------------------------
#  API keys
# --------------------------------------------------------------------------

def _hash_key(raw: str) -> str:
    # A key is already 32 bytes of entropy, so a slow KDF buys nothing and
    # would be paid on every single request. A plain SHA-256 is right here.
    return hashlib.sha256(raw.encode()).hexdigest()


def create_key(name: str, read_only: bool = False) -> dict:
    ensure_schema()
    raw = "lb_" + secrets.token_urlsafe(32)
    db.execute(
        "INSERT INTO api_keys (name, key_hash, prefix, read_only) VALUES (?, ?, ?, ?)",
        (name or "API key", _hash_key(raw), raw[:11], 1 if read_only else 0),
    )
    # Returned exactly once. There is no way to recover it afterwards, which is
    # the point of storing only the hash.
    return {"key": raw, "name": name, "read_only": read_only}


def check_key(raw: str) -> dict | None:
    if not raw:
        return None
    ensure_schema()
    digest = _hash_key(raw)
    for row in db.query("SELECT * FROM api_keys"):
        if hmac.compare_digest(row["key_hash"], digest):
            db.execute("UPDATE api_keys SET last_used = datetime('now') WHERE id = ?", (row["id"],))
            return dict(row)
    return None


# --------------------------------------------------------------------------
#  Webhooks and variables
# --------------------------------------------------------------------------

def create_webhook(name: str, variable: str, kind: str = "variable",
                   target: int | None = None, notify_url: str = "") -> dict:
    ensure_schema()
    token = secrets.token_urlsafe(24)
    variable = (variable or name or "value").strip().replace(" ", "_")
    db.execute(
        "INSERT INTO webhooks (name, token, variable, kind, target, notify_url) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (name or "Webhook", token, variable,
         "task" if kind == "task" else "variable", target, notify_url or ""),
    )
    out = {"token": token, "variable": variable, "kind": kind,
           "url": f"/api/hook/{token}"}
    if kind == "task":
        # The page a phone opens, not the endpoint a script posts to. This is
        # the one that goes in a QR code on the wall.
        out["add_url"] = f"/add/{token}"
    return out


# Words people put in front of a task when they send one, which are addressing
# rather than content. "Add milk" is a task called "milk", not "Add milk".
_LEADING = ("add ", "todo ", "to do ", "task ", "remind me to ", "remember to ")


# Teams wraps an @mention in markup and sends it inside the message text, so
# "@Board milk" arrives as "<at>LifeBoard</at> Order more ribbon".
#
# The mention needs its CONTENTS removed, not just its tags: stripping tags
# alone leaves the bot's own name at the front of every task, so the board
# fills up with "LifeBoard order more ribbon". Mentions go first, then any
# other markup.
# No word-boundary escape in this pattern on purpose: carrying a "\b"
# through a generated patch turned it into a literal backspace byte, and
# the regex then quietly matched nothing. It is not needed - "<at" is
# followed by ">" or an attribute either way.
_MENTION = re.compile(r"<at[^>]*>.*?</at>", re.I | re.S)
_TAG = re.compile(r"<[^>]{0,200}>")


def task_creator(payload) -> tuple[str, str]:
    """Who sent this, as (name, email). Empty strings when unknown.

    Teams puts it in `from`; a Power Automate flow or an n8n node usually sends
    something flatter. Both are worth reading, because the whole point of
    recording it is being able to tell that person when their task is done.
    """
    if not isinstance(payload, dict):
        return "", ""
    name = email = ""
    sender = payload.get("from")
    if isinstance(sender, dict):
        name = str(sender.get("name") or "").strip()
        user = sender.get("user")
        if isinstance(user, dict):
            name = name or str(user.get("displayName") or "").strip()
            email = str(user.get("email") or user.get("userPrincipalName") or "").strip()
        email = email or str(sender.get("email") or "").strip()
    elif isinstance(sender, str):
        name = sender.strip()

    for key in ("by", "author", "sender", "user", "name", "from_name"):
        if not name and isinstance(payload.get(key), str):
            name = payload[key].strip()
    for key in ("email", "from_email", "reply_to", "mail"):
        if not email and isinstance(payload.get(key), str):
            email = payload[key].strip()
    return name[:120], email[:200]


def task_text(payload) -> str:
    """Pull the task out of whatever a sender happened to send.

    The things that push a task - an iOS Shortcut, a Home Assistant automation,
    an n8n node forwarding an email, a curl one-liner - all send something
    different, and none of them should have to care what shape this expects.
    """
    text = ""
    if isinstance(payload, str):
        text = payload
    elif isinstance(payload, dict):
        for key in ("text", "title", "task", "value", "message", "subject",
                    "body", "content", "name"):
            if isinstance(payload.get(key), str) and payload[key].strip():
                text = payload[key]
                break
    elif isinstance(payload, list) and payload:
        return task_text(payload[0])

    # Strip markup before anything else: a Teams message carries the bot
    # mention inside the text, and HTML entities come through a forwarded email.
    text = _TAG.sub(" ", _MENTION.sub(" ", str(text)))
    text = (text.replace("&nbsp;", " ").replace("&amp;", "&")
                .replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"'))
    text = " ".join(text.split())          # collapse newlines and runs
    low = text.lower()
    for word in _LEADING:
        if low.startswith(word):
            text = text[len(word):]
            break
    # A forwarded email subject line is the useful part; the rest is noise.
    return text.strip()[:300]


def add_task(hook: dict, payload) -> dict:
    """Put one task into the list this hook is tied to."""
    text = task_text(payload)
    who, email = task_creator(payload)
    if not text:
        return {"error": "nothing to add"}
    list_id = hook.get("target")
    if not list_id:
        return {"error": "this link is not pointed at a list"}
    if not db.one("SELECT id FROM todo_lists WHERE id = ?", (list_id,)):
        return {"error": "that list no longer exists"}

    # Newest at the top: on a wall the thing somebody just sent is the thing
    # they are standing there waiting to see appear.
    db.execute(
        "UPDATE todo_items SET position = position + 1 WHERE list_id = ?",
        (list_id,))
    item_id = db.execute(
        "INSERT INTO todo_items (list_id, text, position, created_by, "
        "created_email, source_hook) VALUES (?, ?, 0, ?, ?, ?)",
        (list_id, text, who, email, hook.get("id")))
    return {"ok": True, "id": item_id, "text": text, "created_by": who}


# --------------------------------------------------------------------------
#  Telling whoever asked that it is done
# --------------------------------------------------------------------------

def notify_completed(item_id: int) -> None:
    """Post back when a task from an inbox is crossed off the board.

    FIRE AND FORGET, ON A THREAD, and that is not laziness. This runs from the
    handler behind a checkbox on a wall display: if a Teams endpoint is slow or
    down, the tap must still feel instant. A notification that fails is worth
    strictly less than the tick that triggered it, so it never gets to hold it
    up and never gets to make it fail.

    The body carries a Teams MessageCard AND the same facts as flat fields, so
    the URL can be a Teams Incoming Webhook (which renders the card) or an n8n
    / Power Automate flow (which reads the fields and can send the email this
    deliberately does not - the board holds no SMTP credentials).
    """
    row = db.one(
        "SELECT i.*, l.name AS list_name FROM todo_items i "
        "JOIN todo_lists l ON l.id = i.list_id WHERE i.id = ?", (item_id,))
    if not row or not row.get("source_hook"):
        return
    hook = db.one("SELECT * FROM webhooks WHERE id = ?", (row["source_hook"],))
    if not hook or not (hook.get("notify_url") or "").strip():
        return

    who = row.get("created_by") or ""
    text = row["text"]
    summary = f"Done: {text}"
    line = f"**{text}**" + (f"\n\nAsked for by {who}" if who else "")

    body = {
        # Teams renders this. Anything else can ignore it.
        "@type": "MessageCard",
        "@context": "https://schema.org/extensions",
        "summary": summary,
        "themeColor": "7FB069",
        "title": "Crossed off the board",
        "text": line + f"\n\nList: {row['list_name']}",
        # And the same thing as plain fields, for a flow that wants to email
        # the person rather than post a card.
        "event": "task.completed",
        "task": text,
        "list": row["list_name"],
        "created_by": who,
        "created_email": row.get("created_email") or "",
        "completed_at": row.get("done_at") or "",
    }

    def send():
        try:
            import httpx
            httpx.post(hook["notify_url"], json=body, timeout=10.0)
        except Exception:  # noqa: BLE001 - a failed notice must not matter
            log.exception("could not post completion notice for task %s", item_id)

    threading.Thread(target=send, daemon=True,
                     name=f"lifeboard-notify-{item_id}").start()


def receive(token: str, payload) -> dict:
    """Store whatever was pushed, against this hook's one variable."""
    ensure_schema()
    hook = db.one("SELECT * FROM webhooks WHERE token = ?", (token,))
    if not hook:
        return {"error": "unknown webhook"}

    if hook.get("kind") == "task":
        result = add_task(hook, payload)
        if "error" not in result:
            db.execute(
                "UPDATE webhooks SET last_used = datetime('now'), hits = hits + 1 "
                "WHERE id = ?", (hook["id"],))
        return result

    db.execute(
        "INSERT INTO variables (name, value, source) VALUES (?, ?, ?) "
        "ON CONFLICT(name) DO UPDATE SET value = excluded.value, "
        "updated_at = datetime('now'), source = excluded.source",
        (hook["variable"], json.dumps(payload), f"webhook:{hook['name']}"),
    )
    db.execute(
        "UPDATE webhooks SET last_used = datetime('now'), hits = hits + 1 WHERE id = ?",
        (hook["id"],),
    )
    return {"ok": True, "variable": hook["variable"]}


def get_variable(name: str):
    ensure_schema()
    row = db.one("SELECT * FROM variables WHERE name = ?", (name,))
    if not row:
        return None
    try:
        value = json.loads(row["value"])
    except (TypeError, ValueError):
        value = row["value"]
    return {"name": row["name"], "value": value,
            "updated_at": row["updated_at"], "source": row["source"]}


def set_variable(name: str, value, source: str = "api") -> dict:
    ensure_schema()
    db.execute(
        "INSERT INTO variables (name, value, source) VALUES (?, ?, ?) "
        "ON CONFLICT(name) DO UPDATE SET value = excluded.value, "
        "updated_at = datetime('now'), source = excluded.source",
        (name, json.dumps(value), source),
    )
    return {"ok": True, "name": name}
