"""SQLite store.

One file, WAL mode, plain sqlite3 - no ORM. The whole config of a LifeBoard
appliance is a handful of small tables, and keeping it dependency-free means
the recovery story is "copy lifeboard.db off the box", which matters a lot when
there is deliberately no local login.

Everything the admin UI writes lands here; the renderer only ever reads.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

DB_PATH = Path(os.environ.get("LIFEBOARD_DB", "/var/lib/lifeboard/lifeboard.db"))

# One connection per thread. FastAPI runs sync endpoints in a threadpool, and
# sqlite3 connections are not shareable across threads.
_local = threading.local()

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- A screen is one physical display. Multi-screen is supported from day one
-- because retrofitting it later would mean rewriting every layout reference.
CREATE TABLE IF NOT EXISTS screens (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    -- 'normal' | 'left' | 'right' | 'inverted'  (maps to xrandr/wlr-randr)
    orientation  TEXT NOT NULL DEFAULT 'normal',
    width        INTEGER NOT NULL DEFAULT 1920,
    height       INTEGER NOT NULL DEFAULT 1080,
    -- which output this drives, e.g. 'HDMI-1'. NULL = the only/primary output.
    output       TEXT,
    active_layout_id INTEGER REFERENCES layouts(id) ON DELETE SET NULL,
    -- Screen loop: rotate through several layouts on a timer. NULL/empty =
    -- show active_layout_id and nothing else.
    loop_enabled INTEGER NOT NULL DEFAULT 0,
    -- JSON list of {"layout_id":n,"seconds":30}
    loop_items   TEXT NOT NULL DEFAULT '[]',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A layout is a named arrangement of widgets for one screen.
CREATE TABLE IF NOT EXISTS layouts (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    -- CSS background of the whole board; kept as free text so gradients work.
    background  TEXT NOT NULL DEFAULT '#101014',
    -- A full-bleed image behind everything. Almost every community template
    -- built for one of these boards is a photo with translucent panels
    -- floating on it, so this is a first-class layout property rather than a
    -- widget you have to remember to send to the back.
    background_image TEXT NOT NULL DEFAULT '',
    -- 'none' | 'url' | 'source'  - a static image, or a rotating photo album.
    background_kind  TEXT NOT NULL DEFAULT 'none',
    background_source_id INTEGER,
    -- 0-100. Darkens the photo so white text stays readable over a bright sky.
    background_dim   INTEGER NOT NULL DEFAULT 35,
    background_blur  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A widget instance placed on a layout.
--
-- Geometry is stored in PERCENT of the screen, never pixels. The same layout
-- then survives a resolution change or a rotation without every block needing
-- to be dragged again - which is the single most annoying thing about editing
-- these boards.
CREATE TABLE IF NOT EXISTS widgets (
    id         INTEGER PRIMARY KEY,
    layout_id  INTEGER NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,          -- 'clock' | 'calendar' | 'weather' | ...
    x          REAL NOT NULL DEFAULT 0,
    y          REAL NOT NULL DEFAULT 0,
    w          REAL NOT NULL DEFAULT 25,
    h          REAL NOT NULL DEFAULT 25,
    z          INTEGER NOT NULL DEFAULT 0,
    -- Per-widget settings, shape defined by the widget itself.
    config     TEXT NOT NULL DEFAULT '{}',
    -- Panel chrome, so a widget can float over a background photo:
    -- 'auto' (the widget decides) | 'none' | 'solid' | 'glass' | 'outline'
    panel      TEXT NOT NULL DEFAULT 'auto',

    -- ---- the generic envelope -------------------------------------------
    -- Every widget carries these regardless of kind, so scheduling, styling,
    -- refresh and error reporting are written once instead of per widget.
    name       TEXT NOT NULL DEFAULT '',      -- label in the editor, not on screen
    -- 0 = let the widget choose its own cadence.
    refresh_seconds INTEGER NOT NULL DEFAULT 0,
    -- Presentation overrides: font, colour, size, border, radius, shadow,
    -- opacity, padding, alignment. JSON so a new style property does not need
    -- a migration.
    style      TEXT NOT NULL DEFAULT '{}',
    -- When this widget is allowed on screen. JSON:
    --   {"enabled":bool,"days":[0-6],"from":"HH:MM","to":"HH:MM",
    --    "start_date":"YYYY-MM-DD","end_date":"YYYY-MM-DD"}
    schedule   TEXT NOT NULL DEFAULT '{}',
    -- Hidden without being deleted - the editor's eye toggle.
    visible    INTEGER NOT NULL DEFAULT 1,
    -- Locked widgets cannot be dragged or resized. Stops a full-bleed
    -- background photo being grabbed every time you click near it.
    locked     INTEGER NOT NULL DEFAULT 0,
    -- Which data source feeds this widget, for kinds that take one.
    source_id  INTEGER REFERENCES sources(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_widgets_layout ON widgets(layout_id);

-- An external data source. Calendars, RSS feeds and weather locations all
-- live here so that several widgets can share one source without fetching it
-- twice, and so credentials sit in exactly one place.
CREATE TABLE IF NOT EXISTS sources (
    id         INTEGER PRIMARY KEY,
    kind       TEXT NOT NULL,          -- 'ical' | 'google' | 'graph' | 'rss' | 'weather'
    name       TEXT NOT NULL,
    colour     TEXT NOT NULL DEFAULT '#5b9dd9',
    enabled    INTEGER NOT NULL DEFAULT 1,
    -- Non-secret settings (URL, calendar id, units...).
    config     TEXT NOT NULL DEFAULT '{}',
    -- OAuth tokens etc. Encrypted at rest - see secrets.py.
    secret     BLOB,
    refresh_seconds INTEGER NOT NULL DEFAULT 900,
    last_ok    TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Display power schedule. Multiple rules per screen; the renderer is not
-- involved at all, this drives DPMS/CEC directly - see display/.
CREATE TABLE IF NOT EXISTS power_rules (
    id        INTEGER PRIMARY KEY,
    screen_id INTEGER NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
    -- 0=Mon .. 6=Sun, stored as a CSV of ints so one rule can cover weekdays.
    days      TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6',
    on_time   TEXT NOT NULL DEFAULT '07:00',
    off_time  TEXT NOT NULL DEFAULT '23:00',
    enabled   INTEGER NOT NULL DEFAULT 1
);

-- Task lists, owned by LifeBoard itself rather than a third-party service.
-- Having a first-party list matters: it is the only task source that works
-- with no account, no OAuth and no internet, and it is what makes
-- touch-to-complete on the wall useful out of the box.
CREATE TABLE IF NOT EXISTS todo_lists (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    colour     TEXT NOT NULL DEFAULT '#5b9dd9',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS todo_items (
    id         INTEGER PRIMARY KEY,
    list_id    INTEGER NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0,
    due        TEXT NOT NULL DEFAULT '',
    priority   INTEGER NOT NULL DEFAULT 0,
    assignee   TEXT NOT NULL DEFAULT '',
    position   INTEGER NOT NULL DEFAULT 0,
    done_at    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_todo_items_list ON todo_items(list_id, position);

-- Uploaded images and video. Kept as files on disk with a row per item so
-- they can be renamed, foldered and referenced by id rather than by a path
-- that breaks the moment somebody reorganises anything.
CREATE TABLE IF NOT EXISTS media (
    id          INTEGER PRIMARY KEY,
    filename    TEXT NOT NULL,          -- on-disk name, generated, never user input
    original    TEXT NOT NULL,          -- what it was called when uploaded
    folder      TEXT NOT NULL DEFAULT '',
    mime        TEXT NOT NULL DEFAULT '',
    bytes       INTEGER NOT NULL DEFAULT 0,
    width       INTEGER,
    height      INTEGER,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_media_folder ON media(folder);

-- Layout revision history, so a board can be rolled back after a bad edit.
-- Bounded: only the last N per layout are kept, because an appliance with a
-- 7GB disk must not accumulate history forever.
CREATE TABLE IF NOT EXISTS layout_revisions (
    id         INTEGER PRIMARY KEY,
    layout_id  INTEGER NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
    snapshot   TEXT NOT NULL,           -- full JSON of the layout + widgets
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rev_layout ON layout_revisions(layout_id, id);

-- Free-form key/value for everything that is genuinely global.
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

DEFAULT_SETTINGS = {
    "timezone": "America/New_York",
    "admin_password_hash": "",       # empty = setup not yet done
    # Single administrator by design. This is residential signage, not a
    # multi-tenant product; a user table would add a password-reset flow with
    # no local console to run it from.
    "admin_username": "admin",
    "setup_complete": "",            # ISO timestamp once the wizard finished
    "display_backend": "auto",       # auto | dpms | cec | none
    "cec_device": "0",               # CEC logical address of the TV
    # Admin UI appearance. These theme the CONFIGURATION pages only - the board
    # itself is styled per layout and per widget.
    "admin_theme": "dark",           # dark | light | system
    "admin_colours": "{}",           # JSON of CSS variable overrides
    "admin_radius": "10",
}


# Columns added after the first release. CREATE TABLE IF NOT EXISTS will not
# add a column to a table that already exists, so an appliance upgraded in
# place needs these applied explicitly. Each entry is (table, column, DDL).
MIGRATIONS = [
    ("layouts", "background_image", "TEXT NOT NULL DEFAULT ''"),
    ("layouts", "background_kind", "TEXT NOT NULL DEFAULT 'none'"),
    ("layouts", "background_source_id", "INTEGER"),
    ("layouts", "background_dim", "INTEGER NOT NULL DEFAULT 35"),
    ("layouts", "background_blur", "INTEGER NOT NULL DEFAULT 0"),
    ("widgets", "panel", "TEXT NOT NULL DEFAULT 'auto'"),
    # The generic widget envelope.
    ("widgets", "name", "TEXT NOT NULL DEFAULT ''"),
    ("widgets", "refresh_seconds", "INTEGER NOT NULL DEFAULT 0"),
    ("widgets", "style", "TEXT NOT NULL DEFAULT '{}'"),
    ("widgets", "schedule", "TEXT NOT NULL DEFAULT '{}'"),
    ("widgets", "visible", "INTEGER NOT NULL DEFAULT 1"),
    ("widgets", "locked", "INTEGER NOT NULL DEFAULT 0"),
    ("widgets", "source_id", "INTEGER"),
    # A frame is a mount rather than a container - a photo usually wants no
    # panel AND a white border - so it cannot share the `panel` column.
    ("widgets", "frame", "TEXT NOT NULL DEFAULT ''"),
    # 'window' = on at one time, off at another. 'off_at' = turn off and say
    # nothing else, for a display whose device is powered BY the display.
    ("power_rules", "mode", "TEXT NOT NULL DEFAULT 'window'"),
    ("screens", "loop_enabled", "INTEGER NOT NULL DEFAULT 0"),
    ("screens", "loop_items", "TEXT NOT NULL DEFAULT '[]'"),
]

# Columns every widget row carries, in the order the API returns them. Kept
# here so main.py's insert and the editor's payload cannot drift apart.
WIDGET_COLUMNS = (
    "kind", "x", "y", "w", "h", "z", "config", "panel",
    "name", "refresh_seconds", "style", "schedule", "visible", "locked",
    "source_id", "frame",
)


def insert_widget(conn: sqlite3.Connection, layout_id: int,
                  widget: dict, index: int) -> int:
    """Write one widget row.

    Built from WIDGET_COLUMNS rather than written out, because writing it out
    is how a new column ends up in the tuple and not in the statement - which
    is exactly what adding `frame` did: 16 placeholders, 17 values.

    It lives here, beside the column list, because there are now two callers -
    the editor's save and the bundle restore - and a second hand-written
    INSERT is the same drift with an extra place to forget.
    """
    columns = ("layout_id",) + WIDGET_COLUMNS
    cur = conn.execute(
        f"INSERT INTO widgets ({', '.join(columns)}) "
        f"VALUES ({', '.join('?' * len(columns))})",
        (
            layout_id,
            widget.get("kind", "text"),
            float(widget.get("x", 0)),
            float(widget.get("y", 0)),
            float(widget.get("w", 25)),
            float(widget.get("h", 25)),
            int(widget.get("z", index)),
            json.dumps(widget.get("config") or {}),
            widget.get("panel", "auto"),
            widget.get("name", "") or "",
            int(widget.get("refresh_seconds", 0) or 0),
            json.dumps(widget.get("style") or {}),
            json.dumps(widget.get("schedule") or {}),
            0 if widget.get("visible") is False else 1,
            1 if widget.get("locked") else 0,
            widget.get("source_id"),
            widget.get("frame", "") or "",
        ),
    )
    return cur.lastrowid


def hydrate_widget(row: dict) -> dict:
    """Turn the stored JSON columns back into objects for the API."""
    row = dict(row)
    for key in ("config", "style", "schedule"):
        try:
            row[key] = json.loads(row.get(key) or "{}")
        except (TypeError, ValueError):
            row[key] = {}
    row["visible"] = bool(row.get("visible", 1))
    row["locked"] = bool(row.get("locked", 0))
    return row


def _migrate(conn: sqlite3.Connection) -> None:
    """Add any column this build expects that the file does not have yet.

    Deliberately additive only. An appliance in a hallway must survive a
    software update without anyone reflashing it, and a migration that can
    drop or rewrite data is not something to run unattended.
    """
    for table, column, ddl in MIGRATIONS:
        existing = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        if column not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


def connect() -> sqlite3.Connection:
    """Thread-local connection, schema applied on first use."""
    conn = getattr(_local, "conn", None)
    if conn is not None:
        return conn
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    _migrate(conn)
    _local.conn = conn
    _seed(conn)
    return conn


def _seed(conn: sqlite3.Connection) -> None:
    for key, value in DEFAULT_SETTINGS.items():
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (key, value)
        )
    # A fresh appliance must show *something* on first boot rather than a black
    # screen, which is indistinguishable from a broken install.
    if not conn.execute("SELECT 1 FROM screens LIMIT 1").fetchone():
        cur = conn.execute(
            "INSERT INTO layouts (name, background) VALUES (?, ?)",
            ("Default", "#101014"),
        )
        layout_id = cur.lastrowid
        conn.execute(
            "INSERT INTO widgets (layout_id, kind, x, y, w, h, config) "
            "VALUES (?, 'clock', 5, 8, 90, 40, ?)",
            (layout_id, json.dumps({"format": "%-I:%M", "show_seconds": False})),
        )
        conn.execute(
            "INSERT INTO widgets (layout_id, kind, x, y, w, h, config) "
            "VALUES (?, 'text', 5, 55, 90, 20, ?)",
            (
                layout_id,
                json.dumps(
                    {
                        "text": "LifeBoard is running.\nOpen http://<this-device>:8080 to set it up.",
                        "size": 3,
                    }
                ),
            ),
        )
        conn.execute(
            "INSERT INTO screens (name, active_layout_id) VALUES (?, ?)",
            ("Main", layout_id),
        )


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    """Explicit transaction. isolation_level=None means autocommit otherwise."""
    conn = connect()
    conn.execute("BEGIN")
    try:
        yield conn
    except Exception:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")


def query(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    return [dict(r) for r in connect().execute(sql, params).fetchall()]


def one(sql: str, params: tuple = ()) -> dict[str, Any] | None:
    row = connect().execute(sql, params).fetchone()
    return dict(row) if row else None


def execute(sql: str, params: tuple = ()) -> int:
    cur = connect().execute(sql, params)
    return cur.lastrowid


def get_setting(key: str, default: str = "") -> str:
    row = one("SELECT value FROM settings WHERE key = ?", (key,))
    return row["value"] if row else default


def set_setting(key: str, value: str) -> None:
    execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, str(value)),
    )
