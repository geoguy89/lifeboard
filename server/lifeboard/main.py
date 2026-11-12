"""LifeBoard HTTP service: admin API, admin UI, and the renderer the TV loads.

Two audiences, one process:

* ``/admin``  - the configuration UI. Password protected.
* ``/render`` - what Chromium shows on the wall. Deliberately **not**
  authenticated, because the kiosk browser boots before anyone can log in and
  a password prompt on a wall-mounted TV is unusable. It is read-only and
  binds to the LAN only, which is the same trust boundary DAKboard-style
  appliances assume.

The renderer never talks to Google/Outlook/OpenMeteo directly. Every external
call happens here, server side, so credentials never reach the browser and one
cache serves every widget.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import subprocess
import shutil
import httpx
import logging
import os
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from pathlib import Path

from fastapi import Cookie, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    RedirectResponse,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles

from . import backup, db, devices, secrets_store
from .display import control, scheduler
from .video import agent as video_agent
from .system import network, onboarding
from .providers import (
    planner,
    stream,
    sharepoint,
    tasks as taskhub,
    mstodo,
    aggregate,
    bible,
    daily,
    gtasks,
    local_info,
    obsidian,
    oauth,
    oauth_calendars,
    finance as finance_provider,
    restdata,
    homeassistant as ha,
    photos as photos_provider,
    rss,
    weather,
    weather_extra,
)

logging.basicConfig(
    level=os.environ.get("LIFEBOARD_LOG", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("lifeboard")

WEB_ROOT = Path(os.environ.get("LIFEBOARD_WEB", Path(__file__).resolve().parents[2] / "web"))

app = FastAPI(title="LifeBoard", docs_url=None, redoc_url=None)


# --------------------------------------------------------------------------
#  Captive portal for the setup hotspot
#
#  On the hotspot, every DNS name resolves to this device and port 80 is
#  forwarded here (deploy/nm-dispatcher-lifeboard-setup). A phone that joins
#  checks a known URL - generate_204, hotspot-detect.html, connecttest.txt -
#  and, getting a redirect instead of the expected answer, opens the setup
#  page by itself. So any request addressed to a name that is not this device
#  is redirected to the wizard - but only while the hotspot is up.
# --------------------------------------------------------------------------
SETUP_URL = "http://10.42.0.1:8080/admin/"
_captive = {"t": 0.0, "on": False}


def _addressed_to_us(host: str) -> bool:
    host = host.strip().lower().rsplit(":", 1)[0] if not host.startswith("[") else host
    if not host or host.startswith("["):
        return True                       # IPv6 literal
    if host.replace(".", "").isdigit():
        return True                       # IPv4 literal
    import socket as _socket
    own = _socket.gethostname().lower()
    return host in ("localhost", own, f"{own}.local", "lifeboard", "lifeboard.local")


def _hotspot_up() -> bool:
    now = time.monotonic()
    if now - _captive["t"] > 5:
        try:
            _captive["on"] = network.hotspot_active()
        except Exception:  # noqa: BLE001 - no nmcli: never a portal
            _captive["on"] = False
        _captive["t"] = now
    return _captive["on"]


@app.middleware("http")
async def captive_portal(request: Request, call_next):
    host = request.headers.get("host", "")
    if (request.method == "GET" and not _addressed_to_us(host)
            and not network.managed_elsewhere()):
        from starlette.concurrency import run_in_threadpool
        if await run_in_threadpool(_hotspot_up):
            return RedirectResponse(SETUP_URL, status_code=302)
    return await call_next(request)


# --------------------------------------------------------------------------
#  Auth
#
#  Single shared password, PBKDF2, signed cookie. No user accounts: this is an
#  appliance on a home LAN, and inventing a user table would add a password
#  reset flow with no local console to run it from.
# --------------------------------------------------------------------------

SESSION_COOKIE = "lifeboard_session"


def _secret_key() -> bytes:
    key = db.get_setting("session_key", "")
    if not key:
        key = secrets.token_hex(32)
        db.set_setting("session_key", key)
    return key.encode()


def hash_password(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 240_000)
    return f"pbkdf2_sha256$240000${salt}${base64.b64encode(digest).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, iterations, salt, expected = stored.split("$")
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), salt.encode(), int(iterations)
        )
        return hmac.compare_digest(base64.b64encode(digest).decode(), expected)
    except Exception:  # noqa: BLE001
        return False


def _sign(value: str) -> str:
    mac = hmac.new(_secret_key(), value.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{value}.{mac}"


def _unsign(token: str) -> str | None:
    value, _, mac = token.rpartition(".")
    if not value or not hmac.compare_digest(
        hmac.new(_secret_key(), value.encode(), hashlib.sha256).hexdigest()[:32], mac
    ):
        return None
    return value


def setup_needed() -> bool:
    return not db.get_setting("admin_password_hash", "")


def require_admin(
    request: Request,
    lifeboard_session: str | None = Cookie(default=None),
) -> bool:
    """A session cookie OR an API key. Both mean "an administrator".

    Before the first password is set the API is open so the setup page can
    complete; the admin UI makes that state loud rather than hiding it.
    """
    if setup_needed():
        return True
    if lifeboard_session and _unsign(lifeboard_session):
        return True

    raw = request.headers.get("x-api-key") or ""
    if not raw:
        auth = request.headers.get("authorization") or ""
        if auth.lower().startswith("bearer "):
            raw = auth[7:].strip()
    if raw:
        key = devices.check_key(raw)
        if key:
            # A read-only key must not be able to write. Checking the method
            # here covers every endpoint at once rather than relying on each
            # one to remember.
            if key["read_only"] and request.method not in ("GET", "HEAD", "OPTIONS"):
                raise HTTPException(status_code=403, detail="this API key is read-only")
            return True

    raise HTTPException(status_code=401, detail="not authenticated")


@app.post("/api/setup")
def api_setup(payload: dict):
    if not setup_needed():
        raise HTTPException(status_code=409, detail="already configured")
    password = (payload.get("password") or "").strip()
    username = (payload.get("username") or "admin").strip()
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="password must be at least 8 characters")
    if not username or len(username) > 40:
        raise HTTPException(status_code=400, detail="pick a username")
    db.set_setting("admin_username", username)
    db.set_setting("admin_password_hash", hash_password(password))
    resp = JSONResponse({"ok": True})
    resp.set_cookie(SESSION_COOKIE, _sign("admin"), httponly=True, samesite="lax", max_age=30 * 86400)
    return resp


@app.post("/api/login")
def api_login(payload: dict):
    stored = db.get_setting("admin_password_hash", "")
    expected_user = db.get_setting("admin_username", "admin")
    supplied_user = (payload.get("username") or expected_user).strip()
    # Constant-time on the password; the username is not a secret, but a
    # mismatch must still fail with the same message so it cannot be probed.
    ok = bool(stored) and verify_password(payload.get("password") or "", stored)
    if not ok or supplied_user.lower() != expected_user.lower():
        raise HTTPException(status_code=401, detail="wrong username or password")
    resp = JSONResponse({"ok": True})
    resp.set_cookie(SESSION_COOKIE, _sign("admin"), httponly=True, samesite="lax", max_age=30 * 86400)
    return resp


@app.post("/api/logout")
def api_logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(SESSION_COOKIE)
    return resp


@app.get("/api/session")
def api_session(lifeboard_session: str | None = Cookie(default=None)):
    return {
        "setup_needed": setup_needed(),
        "authenticated": bool(lifeboard_session and _unsign(lifeboard_session)),
        "username": db.get_setting("admin_username", "admin"),
        "setup_complete": bool(db.get_setting("setup_complete", "")),
    }


@app.get("/api/setup/state")
def api_setup_state():
    """What the first-run wizard still has to collect.

    Unauthenticated by necessity: before a password exists there is nothing to
    authenticate with, and this returns only whether each step is outstanding.
    """
    try:
        net = network.status()
    except Exception:  # noqa: BLE001
        net = {"online": False, "addresses": [], "has_wifi": False}

    screen = db.one("SELECT * FROM screens ORDER BY id LIMIT 1") or {}
    return {
        "account": not setup_needed(),
        "network": bool(net.get("online")),
        "addresses": net.get("addresses", []),
        "has_wifi": bool(net.get("has_wifi")),
        "hotspot_active": bool(net.get("hotspot_active")),
        # The last join attempt from the setup page. The phone that made it
        # was on the hotspot being torn down, so this is where it finds out.
        "wifi_attempt": network.last_attempt(),
        "timezone": db.get_setting("timezone", ""),
        "orientation": screen.get("orientation", "normal"),
        "complete": bool(db.get_setting("setup_complete", "")),
        "screen_id": screen.get("id", 1),
    }


@app.post("/api/setup/finish")
def api_setup_finish(payload: dict, _: bool = Depends(require_admin)):
    """Apply the wizard's display answers and mark first-run done."""
    screen_id = int(payload.get("screen_id", 1))

    if payload.get("timezone"):
        # Reject a bad zone here rather than letting every widget fall back to
        # UTC later with no explanation.
        try:
            ZoneInfo(payload["timezone"])
        except Exception:  # noqa: BLE001
            raise HTTPException(status_code=400,
                                detail=f"unknown timezone {payload['timezone']!r}") from None
        db.set_setting("timezone", payload["timezone"])
        _apply_system_timezone(payload["timezone"])

    rotation = None
    if payload.get("orientation"):
        db.execute("UPDATE screens SET orientation = ? WHERE id = ?",
                   (payload["orientation"], screen_id))
        rotation = control.set_orientation(payload["orientation"])

    if payload.get("width") and payload.get("height"):
        db.execute("UPDATE screens SET width = ?, height = ? WHERE id = ?",
                   (int(payload["width"]), int(payload["height"]), screen_id))

    db.set_setting("setup_complete", datetime.now(timezone.utc).isoformat(timespec="seconds"))
    return {"ok": True, "rotation": rotation}


def _apply_system_timezone(timezone_name: str) -> bool:
    """Push the chosen timezone to the OS clock.

    The database value is what the widgets use; this is what the display
    schedule, the logs and every systemd timer use. They have to agree, or a
    board set to New York turns its screen off on London's clock.

    Best effort: a board whose OS clock is wrong is worse than one whose OS
    clock is wrong AND refuses to finish setup.
    """
    if not shutil.which("timedatectl"):
        return False
    try:
        result = subprocess.run(
            ["timedatectl", "set-timezone", timezone_name],
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode == 0:
            log.info("system timezone set to %s", timezone_name)
            return True
        log.warning("could not set the system timezone: %s",
                    (result.stderr or "").strip()[:200])
    except Exception as exc:  # noqa: BLE001
        log.warning("could not set the system timezone: %s", exc)
    return False


@app.get("/api/system/timezones")
def api_timezones(q: str = ""):
    """Timezone list for the wizard's picker."""
    import zoneinfo

    zones = sorted(zoneinfo.available_timezones())
    if q:
        needle = q.lower()
        zones = [z for z in zones if needle in z.lower()]
    # Common ones first so the usual answer is one click, not a scroll.
    common = [z for z in (
        "America/New_York", "America/Chicago", "America/Denver",
        "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu",
        "Europe/London", "Europe/Paris", "Australia/Sydney", "UTC",
    ) if z in zones]
    return {"common": common, "all": zones[:400], "count": len(zones)}


# --------------------------------------------------------------------------
#  Screens, layouts, widgets
# --------------------------------------------------------------------------

@app.get("/api/screens")
def api_screens(_: bool = Depends(require_admin)):
    return db.query("SELECT * FROM screens ORDER BY id")


@app.patch("/api/screens/{screen_id}")
def api_update_screen(screen_id: int, payload: dict, _: bool = Depends(require_admin)):
    allowed = {"name", "orientation", "width", "height", "output", "active_layout_id"}
    fields = {k: v for k, v in payload.items() if k in allowed}
    if not fields:
        raise HTTPException(status_code=400, detail="nothing to update")
    sets = ", ".join(f"{k} = ?" for k in fields)
    db.execute(f"UPDATE screens SET {sets} WHERE id = ?", (*fields.values(), screen_id))

    # Rotation has to be applied to the display server, not just recorded.
    if "orientation" in fields:
        screen = db.one("SELECT * FROM screens WHERE id = ?", (screen_id,))
        result = control.set_orientation(fields["orientation"], screen.get("output") if screen else None)
        return {"ok": True, "rotation": result}
    return {"ok": True}


@app.get("/api/layouts")
def api_layouts(_: bool = Depends(require_admin)):
    layouts = db.query("SELECT * FROM layouts ORDER BY id")
    for layout in layouts:
        layout["widgets"] = db.query(
            "SELECT * FROM widgets WHERE layout_id = ? ORDER BY z, id", (layout["id"],)
        )
        layout["widgets"] = [_hydrate_widget(w) for w in layout["widgets"]]
    return layouts


@app.post("/api/layouts")
def api_create_layout(payload: dict, _: bool = Depends(require_admin)):
    layout_id = db.execute(
        "INSERT INTO layouts (name, background) VALUES (?, ?)",
        (payload.get("name") or "Untitled", payload.get("background") or "#101014"),
    )
    return {"id": layout_id}


@app.put("/api/layouts/{layout_id}")
def api_save_layout(layout_id: int, payload: dict, _: bool = Depends(require_admin)):
    """Replace a layout's widgets wholesale.

    The editor sends the entire widget list on save rather than diffing. For
    boards of this size (tens of widgets, not thousands) the simplicity is
    worth far more than the saved writes, and it makes undo trivial: the
    client just re-sends the previous array.
    """
    # Snapshot first so a bad edit is recoverable. Cheap: a board is a few KB.
    if "widgets" in payload:
        _snapshot(layout_id, note=payload.get("_note", ""))

    with db.tx() as conn:
        bg_fields = ("name", "background", "background_image", "background_kind",
                     "background_source_id", "background_dim", "background_blur")
        if any(f in payload for f in bg_fields):
            sets = ", ".join(f"{f} = COALESCE(?, {f})" for f in bg_fields)
            conn.execute(
                f"UPDATE layouts SET {sets}, updated_at = datetime('now') WHERE id = ?",
                (*[payload.get(f) for f in bg_fields], layout_id),
            )
        if "widgets" in payload:
            conn.execute("DELETE FROM widgets WHERE layout_id = ?", (layout_id,))
            for index, widget in enumerate(payload["widgets"]):
                _insert_widget(conn, layout_id, widget, index)
    # Native video windows are positioned from the layout, so they have to be
    # re-placed whenever it changes. Unchanged widgets are left playing.
    try:
        video_agent.AGENT.sync()
    except Exception:  # noqa: BLE001 - never fail a save because mpv is unhappy
        log.exception("video resync after layout save failed")
    return {"ok": True}


@app.delete("/api/layouts/{layout_id}")
def api_delete_layout(layout_id: int, _: bool = Depends(require_admin)):
    in_use = db.one("SELECT id FROM screens WHERE active_layout_id = ?", (layout_id,))
    if in_use:
        raise HTTPException(status_code=409, detail="layout is in use by a screen")
    db.execute("DELETE FROM layouts WHERE id = ?", (layout_id,))
    return {"ok": True}


# --------------------------------------------------------------------------
#  Sources
# --------------------------------------------------------------------------

@app.get("/api/sources")
def api_sources(_: bool = Depends(require_admin)):
    rows = db.query("SELECT id, kind, name, colour, enabled, config, refresh_seconds, "
                    "last_ok, last_error, secret FROM sources ORDER BY id")
    for row in rows:
        row["config"] = json.loads(row["config"] or "{}")
        # Whether an account is linked decides which button the admin shows.
        # The tokens themselves stay here - only the boolean is published.
        secret = row.pop("secret", None)
        tokens = secrets_store.open_(secret) if secret else None
        row["connected"] = bool(tokens and (tokens.get("refresh_token")
                                            or tokens.get("access_token")))
    return rows


@app.post("/api/sources")
def api_create_source(payload: dict, _: bool = Depends(require_admin)):
    source_id = db.execute(
        "INSERT INTO sources (kind, name, colour, config, refresh_seconds) "
        "VALUES (?, ?, ?, ?, ?)",
        (
            payload.get("kind", "ical"),
            payload.get("name", "Untitled"),
            payload.get("colour", "#5b9dd9"),
            json.dumps(payload.get("config") or {}),
            int(payload.get("refresh_seconds", 900)),
        ),
    )
    return {"id": source_id}


@app.patch("/api/sources/{source_id}")
def api_update_source(source_id: int, payload: dict, _: bool = Depends(require_admin)):
    allowed = {"name", "colour", "enabled", "refresh_seconds"}
    fields = {k: v for k, v in payload.items() if k in allowed}
    if "config" in payload:
        fields["config"] = json.dumps(payload["config"])
    if not fields:
        raise HTTPException(status_code=400, detail="nothing to update")
    sets = ", ".join(f"{k} = ?" for k in fields)
    db.execute(f"UPDATE sources SET {sets} WHERE id = ?", (*fields.values(), source_id))
    return {"ok": True}


def forget_source(source_id: int) -> tuple[int, int]:
    """Clear every reference to a source id, without deleting the source.

    A source id hides in three places, and only one of them is a plain column:

      * `widgets.config` as `source_ids`, a JSON list;
      * `widgets.config` as `source_id`, the single form older boards stored;
      * `layouts.background_source_id`, for a board using an album as wallpaper.

    Two of those live inside JSON, which is exactly why the database cannot
    keep them honest for us: a foreign key cannot reach inside a text column.
    So it is swept by hand, in one place, used both when a source is deleted
    and at startup for boards that were left dangling by an older version.

    Returns (widgets changed, backgrounds changed).
    """
    cleaned = 0
    for widget in db.query("SELECT id, config FROM widgets"):
        try:
            config = json.loads(widget["config"] or "{}")
        except (TypeError, ValueError):
            continue
        if not isinstance(config, dict):
            continue

        changed = False

        ids = config.get("source_ids")
        if isinstance(ids, list):
            kept = [i for i in ids if str(i) != str(source_id)]
            if len(kept) != len(ids):
                config["source_ids"] = kept
                changed = True

        if "source_id" in config and str(config.get("source_id")) == str(source_id):
            # Removed rather than set to null: an absent key is already what
            # "no source chosen" means everywhere that reads this.
            config.pop("source_id", None)
            changed = True

        if changed:
            db.execute("UPDATE widgets SET config = ? WHERE id = ?",
                       (json.dumps(config), widget["id"]))
            cleaned += 1

    backgrounds = db.execute(
        "UPDATE layouts SET background_source_id = NULL, background_kind = 'none' "
        "WHERE background_source_id = ?", (source_id,))

    return cleaned, backgrounds


def sweep_dangling_sources() -> int:
    """Forget sources that are referenced but no longer exist.

    Deleting a source used to remove the row and nothing else, so any board
    configured before that was fixed still has widgets asking for an id that
    is gone. The endpoint answers 404 forever and the block wears the error -
    and since the source is already deleted, there is no longer anything on the
    Sources page to click to make it stop. The board cannot be repaired from
    the outside, so it repairs itself on the way up.

    Cheap: one pass over the widgets at startup, and on a healthy board it
    changes nothing and says nothing.
    """
    alive = {str(row["id"]) for row in db.query("SELECT id FROM sources")}

    referenced: set[str] = set()
    for widget in db.query("SELECT config FROM widgets"):
        try:
            config = json.loads(widget["config"] or "{}")
        except (TypeError, ValueError):
            continue
        if not isinstance(config, dict):
            continue
        ids = config.get("source_ids")
        if isinstance(ids, list):
            referenced.update(str(i) for i in ids if i not in (None, ""))
        single = config.get("source_id")
        if single not in (None, ""):
            referenced.add(str(single))

    for layout in db.query(
            "SELECT background_source_id FROM layouts "
            "WHERE background_source_id IS NOT NULL"):
        referenced.add(str(layout["background_source_id"]))

    missing = sorted(referenced - alive)
    for source_id in missing:
        if not source_id.isdigit():
            continue
        widgets, backgrounds = forget_source(int(source_id))
        log.info("source %s no longer exists; cleared %s widget(s), %s background(s)",
                 source_id, widgets, backgrounds)
    return len(missing)


@app.delete("/api/sources/{source_id}")
def api_delete_source(source_id: int, _: bool = Depends(require_admin)):
    """Delete a source, AND stop every widget pointing at it.

    Deleting the row alone leaves dangling references: the widget goes on
    asking for source 6 forever, the endpoint answers 404, and the block wears
    an error about an album that no longer exists. The reported symptom is
    exactly that - "I removed the album and the message is still there" - and
    from the outside it looks as though the delete silently failed.
    """
    db.execute("DELETE FROM sources WHERE id = ?", (source_id,))
    cleaned, backgrounds = forget_source(source_id)
    if cleaned or backgrounds:
        log.info("source %s deleted; cleared from %s widget(s) and %s background(s)",
                 source_id, cleaned, backgrounds)
    return {"ok": True, "widgets_updated": cleaned, "backgrounds_updated": backgrounds}


# --------------------------------------------------------------------------
#  Data the renderer consumes
# --------------------------------------------------------------------------

@app.get("/api/data/calendar")
def api_calendar(days: int = 60, sources: str = ""):
    ids = [int(s) for s in sources.split(",") if s.strip().isdigit()] or None
    start = datetime.now(timezone.utc) - timedelta(days=1)
    end = datetime.now(timezone.utc) + timedelta(days=max(1, min(days, 400)))
    events, errors = aggregate.calendar_events(start, end, ids)
    return {
        "events": [e.to_json() for e in events],
        "errors": errors,
        "timezone": db.get_setting("timezone", "UTC"),
    }


def _record_source(source_id: int, error: str = "") -> None:
    """Write a source's outcome to the Status column in the admin UI.

    Weather and RSS were the two kinds that never called this, so their pill
    was frozen at whatever the last manual Test left behind - a weather source
    that had been failing for hours still read "ok". That matters more now
    that a failed fetch keeps serving its last good answer: the board stays
    correct-looking, so the admin table is the only place an outage shows.
    """
    if error:
        db.execute("UPDATE sources SET last_error = ? WHERE id = ?",
                   (error[:500], source_id))
    else:
        db.execute("UPDATE sources SET last_ok = datetime('now'), last_error = '' "
                   "WHERE id = ?", (source_id,))


@app.get("/api/data/weather")
def api_weather(source_id: int):
    src = db.one("SELECT * FROM sources WHERE id = ? AND kind = 'weather'", (source_id,))
    if not src:
        raise HTTPException(status_code=404, detail="weather source not found")
    cfg = json.loads(src["config"] or "{}")
    result = weather.fetch(
        float(cfg.get("latitude", 0)),
        float(cfg.get("longitude", 0)),
        units=cfg.get("units", "imperial"),
        timezone_name=db.get_setting("timezone", "auto"),
        days=int(cfg.get("days", 5)),
        ttl=float(src["refresh_seconds"] or 900),
    )
    _record_source(source_id, result.error or result.degraded)
    if result.error:
        return JSONResponse({"error": result.error}, status_code=502)
    return result.payload


@app.get("/api/data/daily")
def api_daily(kind: str = "quote", translation: str = ""):
    """A quote, verse, word, joke, piece of advice or date fact.

    Unauthenticated like the other /api/data routes - the wall reads it. There
    is no source row behind these: they take no configuration at all, which is
    the point of the family, so the widget names the kind directly.
    """
    # The verse block has its own provider because a translation choice means
    # the reference and the text come from different places - see bible.py.
    if kind == "bible_verse":
        result = bible.verse_of_the_day(translation or "nlt")
    else:
        result = daily.fetch(kind)
    if result.error and not result.payload:
        return JSONResponse({"error": result.error}, status_code=502)
    return result.payload


@app.get("/api/data/obsidian")
def api_obsidian(source_id: int):
    """A note from the vault, broken into showable excerpts.

    Unauthenticated like the other /api/data routes - the wall reads it. The
    vault token stays on the server; it is never sent to the board.
    """
    src = db.one("SELECT * FROM sources WHERE id = ? AND kind = 'obsidian'", (source_id,))
    if not src:
        raise HTTPException(status_code=404, detail="obsidian source not found")
    cfg = json.loads(src["config"] or "{}")
    result = obsidian.fetch(cfg, ttl=float(src["refresh_seconds"] or 600))
    _record_source(source_id, result.error or result.degraded)
    if result.error and not result.payload:
        return JSONResponse({"error": result.error}, status_code=502)
    return result.payload


@app.get("/api/data/rss")
def api_rss(source_id: int):
    src = db.one("SELECT * FROM sources WHERE id = ? AND kind = 'rss'", (source_id,))
    if not src:
        raise HTTPException(status_code=404, detail="rss source not found")
    cfg = json.loads(src["config"] or "{}")
    # fetch_many handles one URL as well as several, so there is a single
    # path rather than a branch that only the multi case exercises.
    result = rss.fetch_many(cfg, ttl=float(src["refresh_seconds"] or 900))
    # A feed that errored but still has items is degraded, not down, and the
    # widget renders it - so record the error without hiding the payload.
    _record_source(source_id, result.error or result.degraded)
    if result.error and not result.payload:
        return JSONResponse({"error": result.error}, status_code=502)
    return result.payload


@app.get("/api/geocode")
def api_geocode(q: str, _: bool = Depends(require_admin)):
    hits = weather.geocode(q)
    return {"results": hits or []}


# --------------------------------------------------------------------------
#  Display control
# --------------------------------------------------------------------------

@app.get("/api/display/status")
def api_display_status(_: bool = Depends(require_admin)):
    return control.status(db.get_setting("display_backend", "auto"))


@app.post("/api/display/power")
def api_display_power(payload: dict, _: bool = Depends(require_admin)):
    on = bool(payload.get("on"))
    screen_id = int(payload.get("screen_id", 1))
    result = control.set_power(
        on,
        preference=db.get_setting("display_backend", "auto"),
        cec_device=db.get_setting("cec_device", "0"),
    )
    scheduler.SCHEDULER.note_manual(screen_id, on)
    return result


@app.get("/api/display/rules")
def api_power_rules(_: bool = Depends(require_admin)):
    return db.query("SELECT * FROM power_rules ORDER BY screen_id, id")


def _day_list(days) -> str:
    """Normalise a days value to "0,1,2" form.

    Accepts a list of numbers, which is what the admin UI sends, or the
    comma-separated string this API hands out on GET. Without the second,
    reading a rule and writing it straight back is a 500: iterating the
    string yields characters and int(",") raises.
    """
    if isinstance(days, str):
        parts = [d.strip() for d in days.split(",") if d.strip() != ""]
    else:
        parts = list(days)
    out = []
    for d in parts:
        try:
            n = int(d)
        except (TypeError, ValueError):
            continue
        if 0 <= n <= 6 and n not in out:
            out.append(n)
    # An empty set of days would silently disable the rule, which is not what
    # a malformed field should mean. Fall back to every day.
    return ",".join(str(n) for n in (out or [0, 1, 2, 3, 4, 5, 6]))


@app.put("/api/display/rules")
def api_save_power_rules(payload: dict, _: bool = Depends(require_admin)):
    """Replace all rules for one screen."""
    screen_id = int(payload.get("screen_id", 1))
    with db.tx() as conn:
        conn.execute("DELETE FROM power_rules WHERE screen_id = ?", (screen_id,))
        for rule in payload.get("rules", []):
            conn.execute(
                "INSERT INTO power_rules (screen_id, days, on_time, off_time, enabled, mode) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    screen_id,
                    _day_list(rule.get("days", [0, 1, 2, 3, 4, 5, 6])),
                    rule.get("on_time", "07:00"),
                    rule.get("off_time", "23:00"),
                    1 if rule.get("enabled", True) else 0,
                    # 'off_at' turns the screen off and says nothing else,
                    # for a board powered BY the screen; 'shutdown_at' halts
                    # the board itself, for a TV that ignores CEC and has to
                    # be starved of signal instead. Anything unrecognised
                    # falls back to the on/off window.
                    (rule.get("mode")
                     if rule.get("mode") in ("off_at", "shutdown_at")
                     else "window"),
                ),
            )
    return {"ok": True}


@app.post("/api/system/power")
def api_system_power(payload: dict, _: bool = Depends(require_admin)):
    """Halt or restart the board itself.

    Separate from /api/display/power, which is about the screen. On this
    appliance the two are easy to confuse and the consequences differ: the
    screen comes back, and the board may not - it is powered by the TV, so
    once it has halted only a power cycle starts it again.
    """
    action = str(payload.get("action", "")).strip()
    if action not in ("reboot", "shutdown"):
        raise HTTPException(status_code=400, detail="action must be 'reboot' or 'shutdown'")
    return control.halt_board(reboot=action == "reboot")


# --------------------------------------------------------------------------
#  Settings
# --------------------------------------------------------------------------

@app.get("/api/settings")
def api_get_settings(_: bool = Depends(require_admin)):
    rows = db.query("SELECT key, value FROM settings")
    # Never hand secrets back to the browser.
    hidden = {"admin_password_hash", "session_key"}
    return {r["key"]: r["value"] for r in rows if r["key"] not in hidden}


@app.put("/api/settings")
def api_put_settings(payload: dict, _: bool = Depends(require_admin)):
    blocked = {"admin_password_hash", "session_key"}
    for key, value in payload.items():
        if key in blocked:
            continue
        db.set_setting(key, str(value))
    return {"ok": True}


# --------------------------------------------------------------------------
#  What the wall actually loads
# --------------------------------------------------------------------------

def _is_local_request(request: Request) -> bool:
    """Is this the kiosk on the appliance itself?

    The kiosk loads the board over loopback. Anything else is a person on
    another machine, for whom an mpv window over the appliance's screen is not
    a video player - it is a black rectangle.
    """
    host = (request.client.host if request.client else "") or ""
    return host in {"127.0.0.1", "::1", "localhost"}


@app.get("/api/board")
def api_board(request: Request, screen_id: int = 1):
    """Everything the renderer needs for one screen, in a single request.

    One call rather than several because the renderer reloads this on a timer
    and on config change; doing it atomically means the board can never show a
    half-applied layout.
    """
    screen = db.one("SELECT * FROM screens WHERE id = ?", (screen_id,))
    if not screen:
        raise HTTPException(status_code=404, detail="no such screen")
    onboarding_state = _onboarding(screen)
    if _is_local_request(request):
        # The wall is about to show the setup screen: native video windows sit
        # above the page and would cover it.
        video_agent.AGENT.hold(onboarding_state is not None)
    layout = None
    if screen.get("active_layout_id"):
        layout = db.one("SELECT * FROM layouts WHERE id = ?", (screen["active_layout_id"],))
    # --- screen loop -------------------------------------------------------
    # Rotating through several layouts is computed here, not in the browser, so
    # every client attached to this screen shows the same thing and a reload
    # does not restart the rotation from the beginning.
    loop_items = []
    loop_position = None
    if screen.get("loop_enabled"):
        try:
            loop_items = json.loads(screen.get("loop_items") or "[]")
        except (TypeError, ValueError):
            loop_items = []
    if loop_items:
        total = sum(max(5, int(i.get("seconds", 30))) for i in loop_items) or 1
        offset = int(time.time()) % total
        for index, item in enumerate(loop_items):
            span = max(5, int(item.get("seconds", 30)))
            if offset < span:
                chosen = db.one("SELECT * FROM layouts WHERE id = ?", (item.get("layout_id"),))
                if chosen:
                    layout = chosen
                    loop_position = {
                        "index": index,
                        "of": len(loop_items),
                        "seconds_left": span - offset,
                    }
                break
            offset -= span

    widgets = []
    if layout:
        now = datetime.now(_tz())
        rows = db.query(
            "SELECT * FROM widgets WHERE layout_id = ? ORDER BY z, id", (layout["id"],)
        )
        for row in rows:
            widget = _hydrate_widget(row)
            # A widget that is hidden or out of schedule is dropped SERVER-SIDE,
            # so the renderer never receives its config and never fetches its
            # data. Filtering in the browser would still pay for both.
            if not widget["visible"]:
                continue
            if not _widget_due(widget.get("schedule") or {}, now):
                continue
            widgets.append(widget)
    # Resolve a rotating background album to a concrete image server-side, so
    # the renderer does not need album logic just to paint a backdrop.
    if layout and layout.get("background_kind") == "source" and layout.get("background_source_id"):
        try:
            src = db.one("SELECT * FROM sources WHERE id = ?", (layout["background_source_id"],))
            if src:
                cfg = json.loads(src["config"] or "{}")
                cfg["_source_id"] = src["id"]
                result = photos_provider.fetch(dict(src, config=json.dumps(cfg)))
                shots = (result.payload or {}).get("photos") or []
                if shots:
                    import random
                    layout["background_image"] = random.choice(shots)
        except Exception:  # noqa: BLE001
            log.exception("background album lookup failed")

    return {
        "screen": screen,
        "layout": layout,
        "widgets": widgets,
        "timezone": db.get_setting("timezone", "UTC"),
        # Tells a video widget set to 'auto' whether to render a hole for mpv
        # to paint into, or fall back to an in-page embed.
        # Whether native playback is right depends on WHO is asking, not
        # only on whether mpv exists. Anyone but the local kiosk needs the
        # in-page player or they get an empty rectangle.
        # Can the SERVER turn a YouTube page link into a direct H.264 stream?
        # Separate from native_video: that asks whether mpv will paint over the
        # page, this asks whether the browser can be handed something playable.
        # On Android the first is false and the second is true, which is the
        # whole point of having both.
        "stream_resolver": stream.available(),
        "native_video": (bool(video_agent.available().get("mpv"))
                         and _is_local_request(request)),
        # When the appliance is not yet usable, the renderer shows onboarding
        # instructions instead of an empty board. A wall display is the ONLY
        # output this device has, so it has to be able to explain itself.
        # Passed the screen so it can tell "no layout yet" from "ready".
        "onboarding": onboarding_state,
        "loop": loop_position,
        # The renderer polls this; a change means "reload the layout". Loop
        # position is part of it so a rotation actually advances, and the
        # schedule bucket is too, so a scheduled widget appears without anyone
        # touching the board.
        "revision": "|".join(str(x) for x in [
            (layout or {}).get("updated_at", ""),
            (layout or {}).get("id", ""),
            len(widgets),
            (loop_position or {}).get("index", ""),
        ]),
    }


# --------------------------------------------------------------------------
#  Photos
# --------------------------------------------------------------------------


@app.get("/api/data/stream")
def api_stream(widget_id: int, max_height: int = 0):
    """A direct, playable stream URL for one video widget.

    BY WIDGET ID, NOT BY URL, and that is a security decision rather than a
    convenience. This endpoint is unauthenticated because the renderer has no
    session, so taking a URL would turn the board into a fetch-anything proxy
    for anyone on the network - point it at an internal address and yt-dlp
    would happily go and look. Resolving only what a widget is already
    configured to show means the answer set is exactly the videos somebody
    with admin access chose.
    """
    row = db.one("SELECT config FROM widgets WHERE id = ? AND kind = 'video'",
                 (widget_id,))
    if not row:
        raise HTTPException(status_code=404, detail="no such video widget")
    try:
        config = json.loads(row["config"] or "{}")
    except (TypeError, ValueError):
        config = {}

    cap = int(max_height) or int(config.get("max_height") or 0) or 720
    result = stream.resolve(
        config.get("url", ""),
        max_height=cap,
        muted=config.get("muted", True) is not False,
    )
    if result.error and not result.payload:
        return JSONResponse({"error": result.error}, status_code=502)
    return result.payload


@app.get("/api/data/photos")
def api_photos(source_id: int):
    """The list of image URLs for one album."""
    src = db.one("SELECT * FROM sources WHERE id = ? AND kind = 'photos'", (source_id,))
    if not src:
        raise HTTPException(status_code=404, detail="photo source not found")

    # The provider needs its own id to build back-references to /api/photo.
    config = json.loads(src["config"] or "{}")
    config["_source_id"] = source_id
    src = dict(src, config=json.dumps(config))

    result = photos_provider.fetch(src, ttl=float(src["refresh_seconds"] or 3600))
    if result.error:
        db.execute("UPDATE sources SET last_error = ? WHERE id = ?", (result.error[:500], source_id))
        return JSONResponse({"error": result.error}, status_code=502)
    db.execute(
        "UPDATE sources SET last_ok = datetime('now'), last_error = '' WHERE id = ?",
        (source_id,),
    )
    return result.payload


@app.get("/api/photo")
def api_photo(
    request: Request,
    source_id: int,
    index: int | None = None,
    asset_id: str | None = None,
    kind: str | None = None,
):
    """Serve one photo's - or one video's - bytes.

    Local albums are addressed by INDEX, never by path, so a crafted request
    cannot be turned into an arbitrary file read. Immich assets are proxied so
    the API key never reaches the browser.

    VIDEO NEEDS RANGE REQUESTS. The slideshow starts a long clip somewhere in
    the middle, and a browser can only do that if the server answers a Range
    header. FileResponse does; the Immich branch forwards it explicitly rather
    than reading a whole video into memory on a Pi with a gigabyte of RAM.
    """
    src = db.one("SELECT * FROM sources WHERE id = ? AND kind = 'photos'", (source_id,))
    if not src:
        raise HTTPException(status_code=404, detail="photo source not found")
    config = json.loads(src["config"] or "{}")
    backend = config.get("backend", "local")

    if backend == "local" and index is not None:
        path = photos_provider.local_file_at(config, index)
        if not path:
            raise HTTPException(status_code=404, detail="no such photo")
        return FileResponse(path, media_type=photos_provider.guess_type(path))

    if backend == "immich" and asset_id:
        if kind == "video":
            opened = photos_provider.immich_video_request(
                config, asset_id, request.headers.get("range")
            )
            if not opened:
                raise HTTPException(status_code=404, detail="asset not available")
            client, proxied = opened
            upstream = client.send(proxied, stream=True)
            if upstream.status_code >= 400:
                upstream.close()
                client.close()
                raise HTTPException(status_code=404, detail="video not available")

            def stream():
                try:
                    yield from upstream.iter_bytes()
                finally:
                    upstream.close()
                    client.close()

            # Content-Range and Accept-Ranges have to survive the proxy, or the
            # browser believes the whole file arrived and refuses to seek.
            passthrough = {
                name: upstream.headers[name]
                for name in ("content-range", "accept-ranges", "content-length")
                if name in upstream.headers
            }
            return StreamingResponse(
                stream(),
                status_code=upstream.status_code,
                media_type=upstream.headers.get("content-type", "video/mp4"),
                headers=passthrough,
            )

        got = photos_provider.immich_asset(config, asset_id)
        if not got:
            raise HTTPException(status_code=404, detail="asset not available")
        body, content_type = got
        return Response(content=body, media_type=content_type)

    raise HTTPException(status_code=400, detail="bad photo request")


# --------------------------------------------------------------------------
#  Home Assistant
#
#  One 'homeassistant' source holds the base URL and long-lived token. Widgets
#  reference it by id, so the token lives in exactly one place and never
#  reaches the browser.
#
#  Life360 is deliberately NOT a separate integration: set it up inside Home
#  Assistant and its members arrive here as person.* entities like any other
#  tracker. See providers/homeassistant.py.
# --------------------------------------------------------------------------

def _ha_config(source_id: int) -> dict:
    src = db.one(
        "SELECT * FROM sources WHERE id = ? AND kind = 'homeassistant'", (source_id,)
    )
    if not src:
        raise HTTPException(status_code=404, detail="Home Assistant source not found")
    return json.loads(src["config"] or "{}")


def _ha_result(source_id: int, result):
    if result.error:
        db.execute(
            "UPDATE sources SET last_error = ? WHERE id = ?", (result.error[:500], source_id)
        )
        return JSONResponse({"error": result.error}, status_code=502)
    db.execute(
        "UPDATE sources SET last_ok = datetime('now'), last_error = '' WHERE id = ?",
        (source_id,),
    )
    return result.payload


@app.get("/api/data/ha/entities")
def api_ha_entities(source_id: int, _: bool = Depends(require_admin)):
    """Full entity list, for the admin UI's picker."""
    return _ha_result(source_id, ha.list_entities(_ha_config(source_id)))


@app.get("/api/data/ha/states")
def api_ha_states(source_id: int, entities: str = ""):
    ids = [e.strip() for e in entities.split(",") if e.strip()]
    if not ids:
        return {"entities": [], "missing": []}
    return _ha_result(source_id, ha.states(_ha_config(source_id), ids))


@app.get("/api/data/ha/history")
def api_ha_history(source_id: int, entity: str, hours: int = 24, points: int = 60):
    """Recent values for a numeric entity, downsampled for a sparkline."""
    if not entity:
        return {"points": [], "error": "no entity selected"}
    return _ha_result(source_id, ha.history(
        _ha_config(source_id), entity, hours=hours, points=points))


@app.get("/api/data/ha/media")
def api_ha_media(source_id: int, entities: str = ""):
    ids = [e.strip() for e in entities.split(",") if e.strip()]
    if not ids:
        return {"players": [], "missing": []}
    return _ha_result(source_id, ha.media_players(_ha_config(source_id), ids))


@app.get("/api/data/ha/camera")
def api_ha_camera(source_id: int, entity: str):
    """One frame from a camera entity, proxied.

    Proxied rather than linked because the HA token must not reach the
    renderer: the wall page has no login and anyone on the LAN can read it.
    No-store because a cached frame is a camera that appears frozen.
    """
    try:
        data, content_type = ha.camera_image(_ha_config(source_id), entity)
    except Exception as exc:  # noqa: BLE001
        # Home Assistant answers camera_proxy with a 500 for cameras whose
        # integration cannot produce a STILL - several stream-only ones do,
        # even while the entity reads "streaming". That is not a fault in the
        # board, and the message should not imply it is.
        detail = str(exc)
        if "500" in detail:
            detail = (f"{entity} did not return a still image. Some camera "
                      "integrations only provide a live stream, which a wall "
                      "display cannot show - try another camera entity.")
        raise HTTPException(status_code=502, detail=detail) from exc
    return Response(content=data, media_type=content_type,
                    headers={"Cache-Control": "no-store"})


@app.get("/api/data/ha/art")
def api_ha_art(entity: str, source_id: int = 0):
    """Album art for a media player. Same token reasoning as the camera."""
    try:
        sid = source_id or _first_ha_source_id()
        data, content_type = ha.entity_picture(_ha_config(sid), entity)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return Response(content=data, media_type=content_type,
                    headers={"Cache-Control": "max-age=300"})


def _first_ha_source_id() -> int:
    """The media widget builds art URLs server-side, where the source id it
    was asked with is not to hand. With one HA source - which is the normal
    case - this resolves it; with several, the widget passes its own."""
    row = db.one("SELECT id FROM sources WHERE kind = 'homeassistant' ORDER BY id LIMIT 1")
    if not row:
        raise ValueError("no Home Assistant source configured")
    return int(row["id"])


# Cached avatar bytes: entity picture path -> (fetched_at, content_type, data).
_AVATARS: dict[str, tuple[float, str, bytes]] = {}
_AVATAR_TTL = 3600.0


@app.get("/api/data/ha/avatar")
def api_ha_avatar(source_id: int, path: str):
    """Proxy a Home Assistant entity picture.

    HA returns entity_picture as a PATH, which needs its base URL and a bearer
    token - and the token is deliberately not in the page. Without this the
    browser asks the BOARD for /api/image/serve/... and gets a 404, which is
    exactly how both avatars came out blank.

    Unauthenticated on purpose, like the rest of /api/data: the board itself
    has no session. What keeps it safe is the restriction below, not a login.
    """
    # Relative paths only. A full URL here would make this an open proxy that
    # authenticates with the user's Home Assistant token - a much worse
    # outcome than a missing picture.
    if not path.startswith("/") or path.startswith("//") or "://" in path:
        raise HTTPException(status_code=400, detail="only relative HA paths are allowed")

    cache_key = f"{source_id}:{path}"
    hit = _AVATARS.get(cache_key)
    if hit and time.time() - hit[0] < _AVATAR_TTL:
        return Response(content=hit[2], media_type=hit[1],
                        headers={"Cache-Control": "public, max-age=3600"})

    config = _ha_config(source_id)
    base = (config.get("base_url") or "").rstrip("/")
    token = config.get("token") or ""
    if not base:
        raise HTTPException(status_code=400, detail="that source has no Home Assistant URL")

    try:
        with httpx.Client(timeout=15, follow_redirects=True,
                          verify=not config.get("insecure")) as client:
            resp = client.get(f"{base}{path}",
                              headers={"Authorization": f"Bearer {token}"})
            resp.raise_for_status()
            data = resp.content
            media = resp.headers.get("content-type", "image/jpeg").split(";")[0]
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"could not fetch avatar: {exc}") from None

    _AVATARS[cache_key] = (time.time(), media, data)
    return Response(content=data, media_type=media,
                    headers={"Cache-Control": "public, max-age=3600"})


@app.get("/api/data/ha/trackers")
def api_ha_trackers(source_id: int, entities: str = ""):
    ids = [e.strip() for e in entities.split(",") if e.strip()] or None
    return _ha_result(source_id, ha.trackers(_ha_config(source_id), ids))


# --------------------------------------------------------------------------
#  QR codes
#
#  Generated server-side. For wifi mode that is a security property, not a
#  convenience: the password is turned into an image here, so it never appears
#  in the renderer's DOM or page source on a kiosk that has no login.
# --------------------------------------------------------------------------

def _wifi_payload(ssid: str, password: str, security: str, hidden: bool) -> str:
    def esc(text: str) -> str:
        # The WIFI: scheme delimits on ; , : and \, so those must be escaped
        # or a password containing one silently produces an unjoinable code.
        out = []
        for ch in text:
            if ch in "\\;,:\"":
                out.append("\\" + ch)
            else:
                out.append(ch)
        return "".join(out)

    auth = "nopass" if security == "nopass" else security
    parts = [f"T:{auth}", f"S:{esc(ssid)}"]
    if auth != "nopass":
        parts.append(f"P:{esc(password)}")
    if hidden:
        parts.append("H:true")
    return "WIFI:" + ";".join(parts) + ";;"


@app.get("/api/qr")
def api_qr(
    mode: str = "text",
    text: str = "",
    ssid: str = "",
    password: str = "",
    security: str = "WPA",
    hidden: int = 0,
    scale: int = 8,
):
    import io

    import qrcode
    from qrcode.image.pil import PilImage

    payload = (
        _wifi_payload(ssid, password, security, bool(hidden))
        if mode == "wifi"
        else text
    )
    if not payload:
        raise HTTPException(status_code=400, detail="nothing to encode")

    qr = qrcode.QRCode(
        version=None,
        # High correction: a wall display is photographed at an angle, in bad
        # light, sometimes with glare across part of the code.
        error_correction=qrcode.constants.ERROR_CORRECT_H,
        box_size=max(2, min(int(scale), 20)),
        border=2,
    )
    qr.add_data(payload)
    qr.make(fit=True)
    img = qr.make_image(image_factory=PilImage, fill_color="black", back_color="white")

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return Response(
        content=buf.getvalue(),
        media_type="image/png",
        # The wifi password is in here; make sure no proxy caches it.
        headers={"Cache-Control": "private, max-age=300"},
    )


# --------------------------------------------------------------------------
#  Templates
# --------------------------------------------------------------------------

TEMPLATE_DIR = Path(
    os.environ.get("LIFEBOARD_TEMPLATES", Path(__file__).resolve().parents[2] / "templates")
)


def _load_templates() -> list[dict]:
    out = []
    if not TEMPLATE_DIR.is_dir():
        return out
    for path in sorted(TEMPLATE_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            data["id"] = path.stem
            out.append(data)
        except Exception:  # noqa: BLE001 - one bad template must not hide the rest
            log.exception("bad template %s", path)
    return out


@app.get("/api/templates")
def api_templates(_: bool = Depends(require_admin)):
    """Catalogue for the template picker. Widgets stripped - just the metadata."""
    return [
        {k: v for k, v in t.items() if k != "widgets"}
        for t in _load_templates()
    ]


@app.get("/api/templates/{template_id}")
def api_template(template_id: str, _: bool = Depends(require_admin)):
    for t in _load_templates():
        if t["id"] == template_id:
            return t
    raise HTTPException(status_code=404, detail="no such template")


@app.post("/api/templates/{template_id}/apply")
def api_apply_template(template_id: str, payload: dict, _: bool = Depends(require_admin)):
    """Create a new layout from a template and optionally assign it to a screen.

    Always creates a NEW layout rather than overwriting the current one, so
    trying a template is never destructive - the old board is one dropdown
    change away.
    """
    template = None
    for t in _load_templates():
        if t["id"] == template_id:
            template = t
            break
    if not template:
        raise HTTPException(status_code=404, detail="no such template")

    name = payload.get("name") or template.get("name") or template_id
    # Applying a template always creates a NEW layout, which is what makes
    # trying one non-destructive - but applying the same one three times left
    # three layouts all called "Kitchen" and no way to tell them apart in
    # the picker. Number the repeats.
    taken = {row["name"] for row in db.query("SELECT name FROM layouts")}
    if name in taken:
        n = 2
        while f"{name} {n}" in taken:
            n += 1
        name = f"{name} {n}"

    with db.tx() as conn:
        cur = conn.execute(
            "INSERT INTO layouts (name, background, background_image, background_kind, "
            "background_dim, background_blur) VALUES (?, ?, ?, ?, ?, ?)",
            (
                name,
                template.get("background", "#101014"),
                template.get("background_image", ""),
                template.get("background_kind", "none"),
                int(template.get("background_dim", 35)),
                int(template.get("background_blur", 0)),
            ),
        )
        layout_id = cur.lastrowid
        for index, widget in enumerate(template.get("widgets", [])):
            _insert_widget(conn, layout_id, widget, index)

    screen_id = payload.get("screen_id")
    if screen_id:
        db.execute(
            "UPDATE screens SET active_layout_id = ? WHERE id = ?", (layout_id, int(screen_id))
        )
        if template.get("orientation"):
            db.execute(
                "UPDATE screens SET orientation = ? WHERE id = ?",
                (template["orientation"], int(screen_id)),
            )
            control.set_orientation(template["orientation"])

    return {"ok": True, "layout_id": layout_id}


@app.get("/api/widget-catalogue")
def api_widget_catalogue(_: bool = Depends(require_admin)):
    """The admin UI builds its palette and settings forms from the renderer's
    registry, so there is exactly one definition of what a widget accepts."""
    return FileResponse(WEB_ROOT / "render" / "widgets" / "registry.js",
                        media_type="text/javascript")


# --------------------------------------------------------------------------
#  Native video
# --------------------------------------------------------------------------

@app.get("/api/video/status")
def api_video_status(_: bool = Depends(require_admin)):
    return {"capabilities": video_agent.available(), "slots": video_agent.AGENT.status()}


@app.post("/api/video/sync")
def api_video_sync(_: bool = Depends(require_admin)):
    return video_agent.AGENT.sync()


# --------------------------------------------------------------------------
#  First boot and networking
#
#  The device has no keyboard and no local login, so it cannot be told a Wi-Fi
#  password directly. If it has no network it raises its own open access point
#  and puts the instructions on the screen - see system/network.py.
# --------------------------------------------------------------------------

def _onboarding(screen: dict | None = None) -> dict | None:
    """What the screen should say when the box is not ready to be a board yet.

    The decision itself is in system/onboarding.py - pure logic with no web
    framework in it, so it can be tested directly. This half is the part that
    has to talk to nmcli and the database.
    """
    try:
        net = network.status()
    except Exception:  # noqa: BLE001 - no nmcli, or it fell over
        # Treated as offline on purpose. The wrong answer here is to decide
        # everything is fine and show an empty board.
        net = {"ok": False, "online": False, "hotspot_active": False, "addresses": []}

    state = onboarding.decide(net, setup_needed(), screen)
    if state is not None:
        state["hotspot_ssid"] = network.HOTSPOT_SSID
        # A failed join puts the hotspot back up; the TV is the one place the
        # person is guaranteed to look, so it says what went wrong.
        attempt = network.last_attempt()
        if attempt and not attempt.get("ok") and not net.get("online"):
            state["wifi_error"] = {"ssid": attempt.get("ssid", ""), "error": attempt.get("error", "")}
    return state


@app.get("/api/system/network")
def api_network_status():
    # Unauthenticated on purpose: before setup there is no password to check,
    # and this returns nothing sensitive - device names and IPs only.
    return network.status()


@app.get("/api/system/network/scan")
def api_network_scan(rescan: bool = True):
    return network.scan(rescan=rescan)


@app.post("/api/system/network/connect")
def api_network_connect(
    payload: dict,
    lifeboard_session: str | None = Cookie(default=None),
):
    """Join a Wi-Fi network.

    Deliberately allowed before a password exists, because this is how the
    device gets online in the first place: the only client that can reach it
    then is one attached to its own setup hotspot. Once setup is complete this
    requires a session like anything else.
    """
    if not setup_needed() and not (lifeboard_session and _unsign(lifeboard_session)):
        raise HTTPException(status_code=401, detail="not authenticated")
    result = network.connect(
        (payload.get("ssid") or "").strip(),
        payload.get("password") or "",
        bool(payload.get("hidden")),
    )
    if result.get("ok") and payload.get("reboot"):
        # Scheduled rather than immediate, so this reply actually reaches the
        # phone that asked for it - the caller is holding the answer open over
        # the very hotspot that is being torn down.
        #
        # Worth doing on first setup even though the connection is already
        # live: the box comes up on the new network from a cold start, with
        # the kiosk and the video agent started against it rather than against
        # a hotspot that no longer exists, which is the state everything else
        # here assumes.
        _reboot_soon(6)
        result["rebooting"] = True
    return result


def _reboot_soon(delay: float) -> None:
    """Reboot in `delay` seconds, without blocking the reply."""
    def go():
        time.sleep(delay)
        for cmd in (["systemctl", "reboot"], ["reboot"], ["shutdown", "-r", "now"]):
            try:
                subprocess.run(cmd, timeout=20, check=False)
                return
            except Exception:  # noqa: BLE001 - try the next one
                continue
        log.error("could not reboot: none of systemctl/reboot/shutdown worked")
    threading.Thread(target=go, daemon=True, name="lifeboard-reboot").start()


@app.post("/api/system/hotspot")
def api_hotspot(payload: dict, _: bool = Depends(require_admin)):
    return network.start_hotspot() if payload.get("on") else network.stop_hotspot()


@app.get("/api/system/info")
def api_system_info(_: bool = Depends(require_admin)):
    import platform
    caps = video_agent.available()
    return {
        "hostname": platform.node(),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "video": caps,
        "display": control.status(db.get_setting("display_backend", "auto")),
        "network": network.status(),
    }


# --------------------------------------------------------------------------
#  The generic widget envelope
#
#  Every widget carries the same fields regardless of kind. Writing that once
#  here is the whole reason scheduling, styling and refresh do not have to be
#  reimplemented per widget.
# --------------------------------------------------------------------------

def _tz():
    """The board's timezone. Nothing here may take the whole board down.

    The fallback is `timezone.utc`, NOT `ZoneInfo("UTC")`, and that distinction
    is the entire point of this function.

    The original guarded against a bad timezone NAME and fell back to
    ZoneInfo("UTC") - which needs the same IANA database the first call needed.
    On a platform without one, both raise, the exception escapes, and every
    request that asks the board what time it is returns 500. That is what
    happened on Android: /api/board died while /api/system/network was fine,
    so it looked like a renderer bug for two rounds of diagnosis.

    `datetime.timezone.utc` is a fixed offset built into the language. It needs
    no database and cannot fail, which is what a last resort has to mean.
    """
    try:
        return ZoneInfo(db.get_setting("timezone", "UTC"))
    except Exception:  # noqa: BLE001 - bad name, or no tz database at all
        try:
            return ZoneInfo("UTC")
        except Exception:  # noqa: BLE001
            log.warning("no timezone database on this platform; using fixed UTC")
            return timezone.utc


# Both of these live in db.py now, beside the column list they are built
# from, because the bundle restore needs the same two and a second copy of
# either is a column waiting to be forgotten.
_insert_widget = db.insert_widget
_hydrate_widget = db.hydrate_widget


def _widget_due(schedule: dict, now: datetime) -> bool:
    """Is this widget allowed on screen right now?

    Evaluated on the SERVER so the renderer never receives a widget it must not
    show. Doing it in the browser would mean the data for a hidden widget is
    still fetched and still sits in the page.
    """
    if not schedule or not schedule.get("enabled"):
        return True

    start = schedule.get("start_date")
    end = schedule.get("end_date")
    today = now.strftime("%Y-%m-%d")
    if start and today < start:
        return False
    if end and today > end:
        return False

    days = schedule.get("days")
    if days and now.weekday() not in [int(d) for d in days]:
        return False

    frm, to = schedule.get("from"), schedule.get("to")
    if frm and to:
        current = now.strftime("%H:%M")
        # An overnight window (22:00 to 06:00) means "across midnight", which
        # a naive comparison reads as "never".
        if frm <= to:
            if not (frm <= current < to):
                return False
        elif not (current >= frm or current < to):
            return False
    return True


# --------------------------------------------------------------------------
#  Generic data endpoints
# --------------------------------------------------------------------------

@app.get("/api/data/rest")
def api_rest(source_id: int, path: str = ""):
    src = db.one("SELECT * FROM sources WHERE id = ? AND kind = 'rest'", (source_id,))
    if not src:
        raise HTTPException(status_code=404, detail="data source not found")
    config = dict(json.loads(src["config"] or "{}"))
    if path:
        config["path"] = path

    result = restdata.fetch(config, ttl=float(src["refresh_seconds"] or 300))
    if result.error:
        db.execute("UPDATE sources SET last_error = ? WHERE id = ?",
                   (result.error[:500], source_id))
        return JSONResponse({"error": result.error}, status_code=502)

    db.execute("UPDATE sources SET last_ok = datetime('now'), last_error = '' WHERE id = ?",
               (source_id,))
    payload = dict(result.payload)
    if config.get("path"):
        try:
            payload["value"] = restdata.select(payload["data"], config["path"])
        except restdata.PathError as exc:
            return JSONResponse({"error": str(exc)}, status_code=422)
    return payload


@app.post("/api/data/rest/preview")
def api_rest_preview(payload: dict, _: bool = Depends(require_admin)):
    """The admin UI's Test button. Shows the response shape, not just the value -
    the usual failure is a path that does not match, and you cannot fix that
    without seeing what came back."""
    return restdata.preview(payload)


@app.get("/api/data/finance")
def api_finance(market: str = "stocks", symbols: str = "", base: str = "USD", vs: str = "usd"):
    items = [s.strip() for s in symbols.split(",") if s.strip()]
    if market == "crypto":
        result = finance_provider.crypto(items, vs=vs)
    elif market == "currency":
        result = finance_provider.currency(base, items)
    else:
        result = finance_provider.stocks(items)
    if result.error:
        return JSONResponse({"error": result.error}, status_code=502)
    return result.payload


# --------------------------------------------------------------------------
#  Todo lists
# --------------------------------------------------------------------------

@app.get("/api/todo/lists")
def api_todo_lists(_: bool = Depends(require_admin)):
    lists = db.query("SELECT * FROM todo_lists ORDER BY id")
    for item in lists:
        row = db.one(
            "SELECT COUNT(*) AS total, SUM(done) AS done FROM todo_items WHERE list_id = ?",
            (item["id"],),
        )
        item["total"] = row["total"] or 0
        item["done"] = row["done"] or 0
    return lists


@app.post("/api/todo/lists")
def api_create_todo_list(payload: dict, _: bool = Depends(require_admin)):
    return {"id": db.execute(
        "INSERT INTO todo_lists (name, colour) VALUES (?, ?)",
        (payload.get("name") or "List", payload.get("colour") or "#5b9dd9"),
    )}


@app.delete("/api/todo/lists/{list_id}")
def api_delete_todo_list(list_id: int, _: bool = Depends(require_admin)):
    db.execute("DELETE FROM todo_lists WHERE id = ?", (list_id,))
    return {"ok": True}


@app.get("/api/todo/lists/{list_id}")
def api_todo_list(list_id: int):
    """Read is unauthenticated: the wall renders this and cannot log in."""
    lst = db.one("SELECT * FROM todo_lists WHERE id = ?", (list_id,))
    if not lst:
        raise HTTPException(status_code=404, detail="no such list")
    lst["items"] = [
        dict(row, done=bool(row["done"]))
        for row in db.query(
            "SELECT * FROM todo_items WHERE list_id = ? ORDER BY done, position, id",
            (list_id,),
        )
    ]
    return lst


@app.post("/api/todo/lists/{list_id}/items")
def api_add_todo(list_id: int, payload: dict, _: bool = Depends(require_admin)):
    return {"id": db.execute(
        "INSERT INTO todo_items (list_id, text, due, priority, assignee, position) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (
            list_id,
            (payload.get("text") or "").strip(),
            payload.get("due") or "",
            int(payload.get("priority", 0)),
            payload.get("assignee") or "",
            int(payload.get("position", 0)),
        ),
    )}


@app.patch("/api/todo/items/{item_id}")
def api_update_todo(item_id: int, payload: dict):
    """Ticking a box is deliberately unauthenticated.

    This is what touch-to-complete on the wall calls, and that display has no
    session. The blast radius is one checkbox on a LAN-only appliance, which is
    a fair trade for the feature working at all. Editing the TEXT of an item
    still requires admin.
    """
    if set(payload) - {"done"}:
        raise HTTPException(status_code=403, detail="only 'done' may be set without a session")
    done = 1 if payload.get("done") else 0
    db.execute(
        "UPDATE todo_items SET done = ?, done_at = CASE WHEN ? = 1 THEN datetime('now') "
        "ELSE NULL END WHERE id = ?",
        (done, done, item_id),
    )
    # The same completion notice the tasks widget triggers. Both routes tick
    # the same rows, so a task sent from Teams gets its reply whichever widget
    # somebody happened to touch.
    if done:
        devices.notify_completed(item_id)
    return {"ok": True}


@app.delete("/api/todo/items/{item_id}")
def api_delete_todo(item_id: int, _: bool = Depends(require_admin)):
    db.execute("DELETE FROM todo_items WHERE id = ?", (item_id,))
    return {"ok": True}


# --------------------------------------------------------------------------
#  Media library
# --------------------------------------------------------------------------

MEDIA_DIR = Path(os.environ.get("LIFEBOARD_MEDIA", "/var/lib/lifeboard/media"))
ALLOWED_MEDIA = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
    "image/gif": ".gif", "video/mp4": ".mp4", "video/webm": ".webm",
}


@app.get("/api/media")
def api_media_list(folder: str = "", _: bool = Depends(require_admin)):
    if folder:
        return db.query("SELECT * FROM media WHERE folder = ? ORDER BY id DESC", (folder,))
    return db.query("SELECT * FROM media ORDER BY id DESC")


@app.post("/api/media")
async def api_media_upload(request: Request, _: bool = Depends(require_admin)):
    """Upload one file.

    The stored filename is generated, never taken from the upload - a name is
    attacker-controlled input and path traversal through it is the classic way
    an upload endpoint becomes a file-write primitive.
    """
    form = await request.form()
    upload = form.get("file")
    if upload is None or not hasattr(upload, "filename"):
        raise HTTPException(status_code=400, detail="no file uploaded")

    mime = (upload.content_type or "").split(";")[0].strip()
    if mime not in ALLOWED_MEDIA:
        raise HTTPException(
            status_code=415,
            detail=f"unsupported type {mime!r}; allowed: {', '.join(sorted(ALLOWED_MEDIA))}",
        )

    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    stored = f"{secrets.token_hex(12)}{ALLOWED_MEDIA[mime]}"
    target = MEDIA_DIR / stored

    size = 0
    limit = int(db.get_setting("media_max_bytes", str(64 * 1024 * 1024)))
    with target.open("wb") as handle:
        while chunk := await upload.read(1024 * 256):
            size += len(chunk)
            if size > limit:
                handle.close()
                target.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail="file is too large")
            handle.write(chunk)

    media_id = db.execute(
        "INSERT INTO media (filename, original, folder, mime, bytes) VALUES (?, ?, ?, ?, ?)",
        (stored, getattr(upload, "filename", stored), form.get("folder") or "", mime, size),
    )
    return {"id": media_id, "url": f"/api/media/{media_id}/file", "bytes": size}


@app.get("/api/media/{media_id}/file")
def api_media_file(media_id: int):
    """Unauthenticated so the renderer can display it; addressed by id only."""
    row = db.one("SELECT * FROM media WHERE id = ?", (media_id,))
    if not row:
        raise HTTPException(status_code=404, detail="not found")
    path = MEDIA_DIR / row["filename"]
    if not path.is_file():
        raise HTTPException(status_code=404, detail="file missing from disk")
    return FileResponse(path, media_type=row["mime"])


@app.patch("/api/media/{media_id}")
def api_media_rename(media_id: int, payload: dict, _: bool = Depends(require_admin)):
    fields = {k: v for k, v in payload.items() if k in {"original", "folder"}}
    if not fields:
        raise HTTPException(status_code=400, detail="nothing to update")
    sets = ", ".join(f"{k} = ?" for k in fields)
    db.execute(f"UPDATE media SET {sets} WHERE id = ?", (*fields.values(), media_id))
    return {"ok": True}


@app.delete("/api/media/{media_id}")
def api_media_delete(media_id: int, _: bool = Depends(require_admin)):
    row = db.one("SELECT * FROM media WHERE id = ?", (media_id,))
    if row:
        (MEDIA_DIR / row["filename"]).unlink(missing_ok=True)
        db.execute("DELETE FROM media WHERE id = ?", (media_id,))
    return {"ok": True}


# --------------------------------------------------------------------------
#  Screens: duplication, loops, switching
# --------------------------------------------------------------------------

@app.post("/api/screens")
def api_create_screen(payload: dict, _: bool = Depends(require_admin)):
    return {"id": db.execute(
        "INSERT INTO screens (name, orientation, width, height, output) VALUES (?, ?, ?, ?, ?)",
        (
            payload.get("name") or "Screen",
            payload.get("orientation") or "normal",
            int(payload.get("width", 1920)),
            int(payload.get("height", 1080)),
            payload.get("output"),
        ),
    )}


@app.delete("/api/screens/{screen_id}")
def api_delete_screen(screen_id: int, _: bool = Depends(require_admin)):
    if len(db.query("SELECT id FROM screens")) <= 1:
        raise HTTPException(status_code=409, detail="cannot delete the only screen")
    db.execute("DELETE FROM screens WHERE id = ?", (screen_id,))
    return {"ok": True}


@app.post("/api/layouts/{layout_id}/duplicate")
def api_duplicate_layout(layout_id: int, payload: dict, _: bool = Depends(require_admin)):
    src = db.one("SELECT * FROM layouts WHERE id = ?", (layout_id,))
    if not src:
        raise HTTPException(status_code=404, detail="no such layout")
    with db.tx() as conn:
        cur = conn.execute(
            "INSERT INTO layouts (name, background, background_image, background_kind, "
            "background_source_id, background_dim, background_blur) "
            "SELECT ?, background, background_image, background_kind, "
            "background_source_id, background_dim, background_blur FROM layouts WHERE id = ?",
            (payload.get("name") or f"{src['name']} copy", layout_id),
        )
        new_id = cur.lastrowid
        for index, row in enumerate(db.query(
            "SELECT * FROM widgets WHERE layout_id = ? ORDER BY z, id", (layout_id,)
        )):
            _insert_widget(conn, new_id, _hydrate_widget(row), index)
    return {"id": new_id}


@app.post("/api/board/switch")
def api_board_switch(payload: dict):
    """Change which layout a screen shows.

    Unauthenticated for the same reason ticking a task is: a button on the wall
    calls it, and that display has no session. It can only select a layout that
    already exists on this appliance.
    """
    screen_id = int(payload.get("screen_id", 1))
    layout_id = int(payload.get("layout_id", 0))
    if not db.one("SELECT id FROM layouts WHERE id = ?", (layout_id,)):
        raise HTTPException(status_code=404, detail="no such layout")
    db.execute("UPDATE screens SET active_layout_id = ? WHERE id = ?", (layout_id, screen_id))
    try:
        video_agent.AGENT.sync(screen_id)
    except Exception:  # noqa: BLE001
        log.exception("video resync after board switch failed")
    return {"ok": True}


@app.put("/api/screens/{screen_id}/loop")
def api_set_loop(screen_id: int, payload: dict, _: bool = Depends(require_admin)):
    """Rotate a screen through several layouts on a timer."""
    items = []
    for item in payload.get("items", []):
        items.append({
            "layout_id": int(item.get("layout_id")),
            "seconds": max(5, int(item.get("seconds", 30))),
        })
    db.execute(
        "UPDATE screens SET loop_enabled = ?, loop_items = ? WHERE id = ?",
        (1 if payload.get("enabled") and items else 0, json.dumps(items), screen_id),
    )
    return {"ok": True, "items": items}


# --------------------------------------------------------------------------
#  Layout revisions
# --------------------------------------------------------------------------

REVISION_LIMIT = 25


def _snapshot(layout_id: int, note: str = "") -> None:
    layout = db.one("SELECT * FROM layouts WHERE id = ?", (layout_id,))
    if not layout:
        return
    widgets = [_hydrate_widget(r) for r in db.query(
        "SELECT * FROM widgets WHERE layout_id = ? ORDER BY z, id", (layout_id,)
    )]
    db.execute(
        "INSERT INTO layout_revisions (layout_id, snapshot, note) VALUES (?, ?, ?)",
        (layout_id, json.dumps({"layout": layout, "widgets": widgets}, default=str), note),
    )
    # Bounded history: a 7GB appliance disk must not fill with old boards.
    old = db.query(
        "SELECT id FROM layout_revisions WHERE layout_id = ? ORDER BY id DESC LIMIT -1 OFFSET ?",
        (layout_id, REVISION_LIMIT),
    )
    for row in old:
        db.execute("DELETE FROM layout_revisions WHERE id = ?", (row["id"],))


@app.get("/api/layouts/{layout_id}/revisions")
def api_revisions(layout_id: int, _: bool = Depends(require_admin)):
    return db.query(
        "SELECT id, note, created_at FROM layout_revisions WHERE layout_id = ? "
        "ORDER BY id DESC", (layout_id,)
    )


@app.post("/api/layouts/{layout_id}/revisions/{revision_id}/restore")
def api_restore(layout_id: int, revision_id: int, _: bool = Depends(require_admin)):
    row = db.one(
        "SELECT * FROM layout_revisions WHERE id = ? AND layout_id = ?",
        (revision_id, layout_id),
    )
    if not row:
        raise HTTPException(status_code=404, detail="no such revision")
    snapshot = json.loads(row["snapshot"])
    # Snapshot the CURRENT state first, so a restore is itself undoable.
    _snapshot(layout_id, note="before restore")
    with db.tx() as conn:
        conn.execute("DELETE FROM widgets WHERE layout_id = ?", (layout_id,))
        for index, widget in enumerate(snapshot.get("widgets", [])):
            _insert_widget(conn, layout_id, widget, index)
    return {"ok": True}


# --------------------------------------------------------------------------
#  OAuth: Google Calendar and Microsoft 365
#
#  Two flows, because the providers genuinely differ - see providers/oauth.py.
#  Microsoft uses the device code flow, which needs no redirect URI and is the
#  right shape for an appliance. Google requires the redirect flow, and will
#  only accept an HTTPS or loopback redirect URI; docs/oauth.md explains the
#  three ways to satisfy that.
# --------------------------------------------------------------------------

# Pending authorisations, in memory only. These live for minutes and losing
# them on a restart is correct - a half-finished OAuth handshake should not
# survive the service bouncing.
_PENDING: dict[str, dict] = {}


def _oauth_config(source_id: int) -> tuple[dict, dict]:
    src = db.one("SELECT * FROM sources WHERE id = ?", (source_id,))
    if not src or src["kind"] not in ("google", "graph"):
        raise HTTPException(status_code=404, detail="not an OAuth calendar source")
    return json.loads(src["config"] or "{}"), dict(src)


@app.get("/api/oauth/status")
def api_oauth_status(_: bool = Depends(require_admin)):
    """Which accounts are connected, and whether secrets are actually encrypted."""
    out = []
    for src in db.query("SELECT * FROM sources WHERE kind IN ('google','graph') ORDER BY id"):
        tokens = secrets_store.open_(src["secret"]) or {}
        out.append({
            "id": src["id"],
            "kind": src["kind"],
            "name": src["name"],
            "connected": bool(tokens.get("refresh_token") or tokens.get("access_token")),
            "expires_in": max(0, int(tokens.get("expires_at", 0) - time.time())) if tokens else 0,
            "last_error": src["last_error"],
        })
    return {"accounts": out, "secrets": secrets_store.status()}



def _scopes_for(provider, config: dict) -> list[str]:
    """What to ask for, given what this source has been told to do.

    SharePoint is opt-in rather than part of the standard set, and the reason
    is consent: `Sites.Read.All` normally has to be granted by a TENANT
    ADMIN, while `Tasks.ReadWrite` is something a user can usually approve for
    themselves. Requesting it on every Microsoft connection would therefore
    turn a working To Do and Planner setup into one that needs a ticket raised
    with IT.

    So an account that has not asked for SharePoint keeps the scopes that
    always worked, and one that has asks for exactly one more.
    """
    scopes = list(provider.scopes)
    if provider.name == "graph" and config.get("include_sharepoint"):
        scopes.append(sharepoint.SCOPE_WRITE if config.get("allow_complete")
                      else sharepoint.SCOPE_READ)
    return scopes


@app.post("/api/oauth/{source_id}/start")
def api_oauth_start(source_id: int, payload: dict, _: bool = Depends(require_admin)):
    """Begin authorisation. Returns either a URL to open, or a device code."""
    config, src = _oauth_config(source_id)
    provider = oauth.PROVIDERS[src["kind"]]
    client_id = (config.get("client_id") or "").strip()
    if not client_id:
        raise HTTPException(status_code=400, detail="set the client id on this source first")

    # Microsoft: device flow. Nothing to register, nothing to proxy.
    if provider.supports_device_flow and payload.get("flow", "device") == "device":
        started = oauth.start_device_flow(provider, client_id,
                                          scopes=_scopes_for(provider, config))
        if "error" in started:
            raise HTTPException(status_code=502, detail=started["error"])
        _PENDING[f"device:{source_id}"] = {
            "device_code": started["device_code"],
            "expires_at": time.time() + started["expires_in"],
        }
        return {
            "flow": "device",
            "user_code": started["user_code"],
            "verification_uri": started["verification_uri"],
            "interval": started["interval"],
            "expires_in": started["expires_in"],
        }

    # Google: redirect flow with PKCE.
    redirect_uri = (payload.get("redirect_uri") or config.get("redirect_uri") or "").strip()
    if not redirect_uri:
        raise HTTPException(
            status_code=400,
            detail="a redirect URI is required; see docs/oauth.md for what Google accepts",
        )
    verifier, challenge = oauth.make_pkce()
    state = secrets.token_urlsafe(24)
    _PENDING[state] = {
        "source_id": source_id,
        "verifier": verifier,
        "redirect_uri": redirect_uri,
        "expires_at": time.time() + 900,
    }
    return {
        "flow": "redirect",
        "authorize_url": oauth.authorize_url(
            provider, client_id, redirect_uri, state, challenge,
            scopes=config.get("scopes") or None,
        ),
        "state": state,
    }


@app.post("/api/oauth/{source_id}/poll")
def api_oauth_poll(source_id: int, _: bool = Depends(require_admin)):
    """Poll a device-code authorisation. Called on the interval the start returned."""
    config, src = _oauth_config(source_id)
    pending = _PENDING.get(f"device:{source_id}")
    if not pending:
        raise HTTPException(status_code=409, detail="no device authorisation in progress")
    if pending["expires_at"] < time.time():
        _PENDING.pop(f"device:{source_id}", None)
        return {"error": "The code expired. Start again."}

    provider = oauth.PROVIDERS[src["kind"]]
    result = oauth.poll_device_flow(provider, config.get("client_id", ""), pending["device_code"])
    if result.get("pending"):
        return {"pending": True, "slow_down": bool(result.get("slow_down"))}
    if "error" in result:
        _PENDING.pop(f"device:{source_id}", None)
        return {"error": result["error"]}

    _store_tokens(source_id, result["tokens"])
    _PENDING.pop(f"device:{source_id}", None)
    return {"ok": True}


@app.get("/api/oauth/callback")
def api_oauth_callback(code: str = "", state: str = "", error: str = ""):
    """Where the provider redirects back to.

    Unauthenticated by necessity - the provider redirects a browser here and
    carries no session. Safety comes from `state`: a single-use, unguessable
    value this server generated minutes ago, which is exactly what it is for.
    """
    if error:
        return HTMLResponse(f"<h2>Authorisation failed</h2><p>{error}</p>", status_code=400)
    pending = _PENDING.pop(state, None)
    if not pending or pending["expires_at"] < time.time():
        return HTMLResponse(
            "<h2>That authorisation expired</h2><p>Start again from the Sources tab.</p>",
            status_code=400,
        )

    source_id = pending["source_id"]
    config, src = _oauth_config(source_id)
    provider = oauth.PROVIDERS[src["kind"]]
    tokens = oauth.exchange_code(
        provider,
        config.get("client_id", ""),
        config.get("client_secret", ""),
        code,
        pending["redirect_uri"],
        pending["verifier"],
    )
    if "error" in tokens:
        return HTMLResponse(f"<h2>Could not complete</h2><p>{tokens['error']}</p>", status_code=400)

    _store_tokens(source_id, tokens)
    return HTMLResponse(
        "<h2>Connected</h2><p>You can close this tab and go back to LifeBoard.</p>"
    )


def _store_tokens(source_id: int, tokens: dict) -> None:
    db.execute(
        "UPDATE sources SET secret = ?, last_error = '', last_ok = datetime('now') WHERE id = ?",
        (secrets_store.seal(tokens), source_id),
    )


def _oauth_token(source_id: int) -> str:
    """A live access token for any OAuth source, refreshing if needed.

    Not Google-specific despite its old name - it dispatches on the source's
    own kind, so it serves Microsoft To Do and Planner too. Shared by every
    task route so a refresh is persisted in exactly one place: a refreshed
    token that is not saved means paying for a refresh on every request.
    """
    config, src = _oauth_config(source_id)
    tokens = secrets_store.open_(src["secret"]) or {}
    provider = oauth.PROVIDERS[src["kind"]]
    try:
        token, updated = oauth.valid_access_token(provider, config, tokens)
    except oauth.ReauthNeeded as exc:
        raise HTTPException(status_code=409, detail=f"reconnect needed: {exc}") from None
    if updated:
        _store_tokens(source_id, updated)
    return token


@app.get("/api/oauth/{source_id}/tasklists")
def api_google_tasklists(source_id: int, _: bool = Depends(require_admin)):
    """The account's task lists, so the user picks rather than types an id."""
    result = gtasks.list_task_lists(_oauth_token(source_id))
    if result.error:
        raise HTTPException(status_code=502, detail=result.error)
    return result.payload


@app.get("/api/data/gtasks")
def api_gtasks(source_id: int, list_id: str = "", limit: int = 20,
               show_completed: bool = False):
    """One task list, for a sticky note on the wall."""
    if not list_id:
        return {"items": [], "error": "no task list chosen"}
    result = gtasks.tasks(_oauth_token(source_id), list_id,
                          show_completed=show_completed, limit=limit)
    _record_source(source_id, result.error or result.degraded)
    if result.error and not result.payload:
        return JSONResponse({"error": result.error}, status_code=502)
    return result.payload



# --------------------------------------------------------------------------
#  Tasks and Kanban, across three back ends
#
#  Reading is ordinary. WRITING is the interesting part: these are the routes
#  a finger on the wall calls, and that display has no session, so they are
#  unauthenticated like every other touch route here. The permission that
#  matters is on the SOURCE (`allow_complete`, off by default) and is checked
#  server-side in providers/tasks.py - a client-side flag would be no check at
#  all, since anything on the LAN can post to these.
# --------------------------------------------------------------------------

def _task_token(source_id: int | None, backend: str) -> str:
    """Token for a task back end, or "" for LifeBoard's own lists."""
    if backend == "local" or not source_id:
        return ""
    return _oauth_token(int(source_id))


@app.get("/api/tasks/lists")
def api_task_lists(backend: str = "local", source_id: int = 0,
                   _: bool = Depends(require_admin)):
    """Pickable lists for the admin, from whichever back end."""
    result = taskhub.lists(backend, _task_token(source_id or None, backend))
    if result.error:
        raise HTTPException(status_code=502, detail=result.error)
    return result.payload


@app.get("/api/tasks/items")
def api_task_items(backend: str = "local", list_id: str = "", source_id: int = 0,
                   show_completed: bool = False, limit: int = 50):
    """One list, for a widget on the wall. Unauthenticated: the TV reads it."""
    if not list_id:
        return {"items": [], "error": "no list chosen"}
    try:
        token = _task_token(source_id or None, backend)
    except HTTPException as exc:
        return JSONResponse({"error": str(exc.detail)}, status_code=exc.status_code)
    result = taskhub.items(backend, list_id, token,
                           show_completed=show_completed, limit=limit)
    if source_id:
        _record_source(source_id, result.error or result.degraded)
    if result.error and not result.payload:
        return JSONResponse({"error": result.error}, status_code=502)
    return result.payload


@app.post("/api/tasks/complete")
def api_task_complete(payload: dict):
    """Tick one task off, from the wall.

    Unauthenticated by necessity and gated by `allow_complete` on the source.
    The error text is returned rather than swallowed, because the widget puts
    it on screen: a checkbox that silently does nothing is worse than one that
    says why it will not.
    """
    backend = str(payload.get("backend") or "local")
    list_id = str(payload.get("list_id") or "")
    task_id = str(payload.get("task_id") or "")
    source_id = payload.get("source_id") or None
    done = bool(payload.get("done", True))
    if not task_id:
        raise HTTPException(status_code=400, detail="no task given")

    # PERMISSION BEFORE AUTHENTICATION, and the order is the whole point.
    #
    # Resolving the token first meant a locked source answered "reconnect
    # needed" - which sends somebody off to re-authorise an account that was
    # never the problem, while the actual fix is one switch on the Sources tab.
    # It also did OAuth work, up to and including a network token refresh, for
    # a request that was always going to be refused: anyone on the LAN could
    # make a read-only source burn refreshes by posting at it.
    if backend != "local":
        if not source_id:
            return JSONResponse({"error": "no account for that list"}, status_code=403)
        allowed, why = taskhub.may_write(int(source_id))
        if not allowed:
            return JSONResponse({"error": why}, status_code=403)

    try:
        token = _task_token(source_id, backend)
    except HTTPException as exc:
        return JSONResponse({"error": str(exc.detail)}, status_code=exc.status_code)

    result = taskhub.complete(backend, list_id, task_id,
                              source_id=source_id, token=token, done=done)
    if result.error:
        return JSONResponse({"error": result.error}, status_code=403)
    return result.payload


# ---- Kanban -------------------------------------------------------------

@app.get("/api/tasks/plans")
def api_planner_plans(source_id: int, _: bool = Depends(require_admin)):
    """Planner plans this account can see, for the admin's picker."""
    result = planner.list_plans(_oauth_token(source_id))
    if result.error:
        raise HTTPException(status_code=502, detail=result.error)
    return result.payload


@app.get("/api/tasks/board")
def api_kanban_board(source_id: int = 0, plan_id: str = "", backend: str = "planner",
                     show_completed: bool = False):
    """A Kanban board: columns of cards. Unauthenticated - the TV reads it."""
    if backend == "planner":
        if not plan_id:
            return {"columns": [], "error": "no plan chosen"}
        try:
            token = _oauth_token(int(source_id))
        except HTTPException as exc:
            return JSONResponse({"error": str(exc.detail)}, status_code=exc.status_code)
        result = planner.board(token, plan_id, show_completed=show_completed)
        _record_source(source_id, result.error or result.degraded)
        if result.error and not result.payload:
            return JSONResponse({"error": result.error}, status_code=502)
        return result.payload

    # LifeBoard's own lists as columns: one list per column, which makes a
    # Kanban out of the board's offline task storage with no account at all.
    ids = [int(v) for v in str(plan_id).split(",") if v.strip().isdigit()]
    columns = []
    for list_id in ids:
        row = db.one("SELECT * FROM todo_lists WHERE id = ?", (list_id,))
        if not row:
            continue
        items = taskhub.items("local", str(list_id), show_completed=show_completed)
        columns.append({
            "id": str(list_id), "title": row["name"],
            "colour": row["colour"],
            "cards": [
                {"id": c["id"], "title": c["title"], "done": c["done"],
                 "due": c["due"], "etag": ""}
                for c in (items.payload or {}).get("items", [])
            ],
        })
    return {"plan_id": plan_id, "columns": columns}


@app.post("/api/tasks/card")
def api_kanban_card(payload: dict):
    """What a tap on a Kanban card does - move it, complete it, or both.

    The action is decided by the WIDGET's configuration and passed in, rather
    than being fixed here, because "what should checking this column's cards
    do" is genuinely per-board: on one wall the left column means started, on
    another it means done.
    """
    backend = str(payload.get("backend") or "planner")
    card_id = str(payload.get("card_id") or "")
    if not card_id:
        raise HTTPException(status_code=400, detail="no card given")

    to_column = str(payload.get("to_column") or "")
    complete = payload.get("complete")

    if backend == "local":
        if not card_id.isdigit():
            raise HTTPException(status_code=400, detail="not a valid item")
        if to_column.isdigit():
            db.execute("UPDATE todo_items SET list_id = ? WHERE id = ?",
                       (int(to_column), int(card_id)))
        if complete is not None:
            taskhub.complete("local", "", card_id, done=bool(complete))
        return {"ok": True, "id": card_id}

    source_id = payload.get("source_id")
    if not source_id:
        raise HTTPException(status_code=400, detail="no account given")
    # Gate first, then the token - see api_task_complete for why the other
    # order is wrong.
    allowed, why = taskhub.may_write(int(source_id))
    if not allowed:
        return JSONResponse({"error": why}, status_code=403)

    try:
        token = _oauth_token(int(source_id))
    except HTTPException as exc:
        return JSONResponse({"error": str(exc.detail)}, status_code=exc.status_code)

    result = planner.update_task(
        token, card_id, str(payload.get("etag") or ""),
        bucket_id=to_column,
        percent=(100 if complete else 0) if complete is not None else None,
    )
    if result.error:
        return JSONResponse({"error": result.error}, status_code=409)
    return result.payload



# --------------------------------------------------------------------------
#  SharePoint / Microsoft Lists
#
#  The three picker routes are admin-only and each needs a live token, so they
#  are fetched on demand rather than with the rest of the admin state - nobody
#  should have their Microsoft token refreshed just for opening a tab.
#
#  The read and write routes are unauthenticated like every other board route,
#  and the write goes through the same `allow_complete` gate as the task ones.
# --------------------------------------------------------------------------

@app.get("/api/sharepoint/sites")
def api_sp_sites(source_id: int, search: str = "", _: bool = Depends(require_admin)):
    result = sharepoint.sites(_oauth_token(source_id), search)
    if result.error:
        raise HTTPException(status_code=502, detail=result.error)
    return result.payload


@app.get("/api/sharepoint/lists")
def api_sp_lists(source_id: int, site_id: str, _: bool = Depends(require_admin)):
    result = sharepoint.lists(_oauth_token(source_id), site_id)
    if result.error:
        raise HTTPException(status_code=502, detail=result.error)
    return result.payload


@app.get("/api/sharepoint/columns")
def api_sp_columns(source_id: int, site_id: str, list_id: str,
                   _: bool = Depends(require_admin)):
    result = sharepoint.columns(_oauth_token(source_id), site_id, list_id)
    if result.error:
        raise HTTPException(status_code=502, detail=result.error)
    return result.payload


@app.get("/api/sharepoint/items")
def api_sp_items(source_id: int, site_id: str, list_id: str, fields: str = "",
                 limit: int = 50, order_by: str = "", filter_query: str = ""):
    """Rows for a widget on the wall. Unauthenticated - the TV reads it."""
    if not site_id or not list_id:
        return {"items": [], "error": "no list chosen"}
    try:
        token = _oauth_token(source_id)
    except HTTPException as exc:
        return JSONResponse({"error": str(exc.detail)}, status_code=exc.status_code)
    result = sharepoint.items(
        token, site_id, list_id,
        fields=[f.strip() for f in fields.split(",") if f.strip()],
        limit=limit, order_by=order_by, filter_query=filter_query)
    _record_source(source_id, result.error or result.degraded)
    if result.error and not result.payload:
        return JSONResponse({"error": result.error}, status_code=502)
    return result.payload


@app.post("/api/sharepoint/update")
def api_sp_update(payload: dict):
    """Set a column on a row, which is what a tick on the wall becomes.

    Permission before authentication, for the same reason as the task routes:
    a locked source must be told it is read-only rather than sent off to
    reconnect an account that was never the problem.
    """
    source_id = payload.get("source_id")
    if not source_id:
        raise HTTPException(status_code=400, detail="no account given")
    allowed, why = taskhub.may_write(int(source_id))
    if not allowed:
        return JSONResponse({"error": why}, status_code=403)

    values = payload.get("values")
    if not isinstance(values, dict) or not values:
        raise HTTPException(status_code=400, detail="nothing to change")

    try:
        token = _oauth_token(int(source_id))
    except HTTPException as exc:
        return JSONResponse({"error": str(exc.detail)}, status_code=exc.status_code)

    result = sharepoint.update_item(
        token, str(payload.get("site_id") or ""), str(payload.get("list_id") or ""),
        str(payload.get("item_id") or ""), values)
    if result.error:
        return JSONResponse({"error": result.error}, status_code=502)
    return result.payload


@app.get("/api/oauth/{source_id}/calendars")
def api_oauth_calendars(source_id: int, _: bool = Depends(require_admin)):
    """The account's calendars, so the user picks rather than types an id."""
    config, src = _oauth_config(source_id)
    tokens = secrets_store.open_(src["secret"]) or {}
    provider = oauth.PROVIDERS[src["kind"]]
    try:
        token, updated = oauth.valid_access_token(provider, config, tokens)
    except oauth.ReauthNeeded as exc:
        raise HTTPException(status_code=409, detail=f"reconnect needed: {exc}") from None
    if updated:
        _store_tokens(source_id, updated)
    try:
        listing = (oauth_calendars.google_calendars(token) if src["kind"] == "google"
                   else oauth_calendars.graph_calendars(token))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from None
    return {"calendars": listing}


@app.post("/api/oauth/{source_id}/disconnect")
def api_oauth_disconnect(source_id: int, _: bool = Depends(require_admin)):
    db.execute("UPDATE sources SET secret = NULL WHERE id = ?", (source_id,))
    return {"ok": True}


# --------------------------------------------------------------------------
#  Weather extras
#
#  Separate endpoints so a board showing only today's high does not pay for an
#  air-quality lookup it never displays.
# --------------------------------------------------------------------------

def _weather_point(source_id: int) -> tuple[float, float, dict]:
    src = db.one("SELECT * FROM sources WHERE id = ? AND kind = 'weather'", (source_id,))
    if not src:
        raise HTTPException(status_code=404, detail="weather source not found")
    cfg = json.loads(src["config"] or "{}")
    return float(cfg.get("latitude", 0)), float(cfg.get("longitude", 0)), cfg


@app.get("/api/data/weather/hourly")
def api_weather_hourly(source_id: int, hours: int = 24):
    lat, lon, cfg = _weather_point(source_id)
    result = weather_extra.hourly(
        lat, lon,
        units=cfg.get("units", "imperial"),
        timezone_name=db.get_setting("timezone", "auto"),
        hours=max(1, min(hours, 48)),
    )
    if result.error:
        return JSONResponse({"error": result.error}, status_code=502)
    return result.payload


@app.get("/api/data/weather/air")
def api_weather_air(source_id: int):
    lat, lon, _cfg = _weather_point(source_id)
    result = weather_extra.air_quality(lat, lon)
    if result.error:
        return JSONResponse({"error": result.error}, status_code=502)
    return result.payload


@app.get("/api/data/weather/alerts")
def api_weather_alerts(source_id: int):
    lat, lon, _cfg = _weather_point(source_id)
    result = weather_extra.alerts(lat, lon)
    if result.error:
        return JSONResponse({"error": result.error}, status_code=502)
    return result.payload


@app.get("/api/data/tides")
def api_tides(source_id: int, days: int = 2, station: str = ""):
    """High and low tides. Reuses the WEATHER source purely for its
    coordinates - asking someone to configure a location twice, or to look up
    a NOAA station id, is the kind of setup step that stops a block being
    used."""
    lat, lon, cfg = _weather_point(source_id)
    result = local_info.tides(
        lat, lon,
        station=station or cfg.get("tide_station", ""),
        days=days,
        units=cfg.get("units", "imperial"),
    )
    if result.error and not result.payload:
        return JSONResponse({"error": result.error}, status_code=502)
    return result.payload


@app.get("/api/data/airports")
def api_airports(codes: str = ""):
    """FAA delays. No source row: it takes airport codes and nothing else."""
    result = local_info.airport_delays(codes)
    if result.error and not result.payload:
        return JSONResponse({"error": result.error}, status_code=502)
    return result.payload


@app.get("/api/data/weather/sunmoon")
def api_weather_sunmoon(source_id: int):
    """Sunrise/sunset for the next few days, plus the moon.

    The sun times come from the same daily forecast the weather widget already
    caches, so this is usually free. The moon is computed locally and works
    with the internet down.
    """
    lat, lon, cfg = _weather_point(source_id)
    src = db.one("SELECT * FROM sources WHERE id = ?", (source_id,))
    forecast = weather.fetch(
        lat, lon,
        units=cfg.get("units", "imperial"),
        timezone_name=db.get_setting("timezone", "auto"),
        days=int(cfg.get("days", 5)),
        ttl=float(src["refresh_seconds"] or 900),
    )
    days = []
    if forecast.payload:
        for day in forecast.payload.get("daily", []):
            days.append({
                "date": day.get("date"),
                "weekday": day.get("weekday"),
                "sunrise": day.get("sunrise"),
                "sunset": day.get("sunset"),
            })
    return {"days": days, "moon": weather_extra.moon()}


# --------------------------------------------------------------------------
#  Devices
#
#  A display registers itself on first load and heartbeats from then on. That
#  makes remote refresh possible without a push channel to keep alive: the
#  server bumps a counter and the device reloads when it notices.
# --------------------------------------------------------------------------

@app.post("/api/device/hello")
def api_device_hello(payload: dict, request: Request):
    """Unauthenticated: it is the wall display checking in, and it has no session.

    ONLY the local kiosk is registered. Every browser that opens /render/ has
    its own localStorage token, so before this, glancing at the board from a
    laptop created a permanent "Display" row - six of them had accumulated on
    the author's board, of which exactly one was the TV. A device list that fills
    up with whoever looked at the page is worse than no device list.

    Anyone else still gets a valid answer so the board renders normally for
    them; they simply are not recorded as a display.
    """
    token = (payload.get("token") or "").strip()
    if not token or len(token) < 16:
        raise HTTPException(status_code=400, detail="a device token is required")
    if not _is_local_request(request):
        # refresh_seq is echoed back so a remote viewer's heartbeat loop stays
        # happy and never thinks it has been asked to reload.
        return {"ok": True, "registered": False, "refresh_seq": 0}
    client_host = request.client.host if request.client else ""
    return devices.register(token, {
        "screen_id": payload.get("screen_id"),
        "user_agent": request.headers.get("user-agent", ""),
        "address": client_host,
        "resolution": payload.get("resolution", ""),
        "name": payload.get("name", ""),
    })


@app.get("/api/devices")
def api_devices(_: bool = Depends(require_admin)):
    return devices.listing()


@app.patch("/api/devices/{device_id}")
def api_update_device(device_id: int, payload: dict, _: bool = Depends(require_admin)):
    fields = {k: v for k, v in payload.items() if k in {"name", "screen_id", "notes"}}
    if not fields:
        raise HTTPException(status_code=400, detail="nothing to update")
    sets = ", ".join(f"{k} = ?" for k in fields)
    db.execute(f"UPDATE devices SET {sets} WHERE id = ?", (*fields.values(), device_id))
    return {"ok": True}


@app.delete("/api/devices/{device_id}")
def api_delete_device(device_id: int, _: bool = Depends(require_admin)):
    db.execute("DELETE FROM devices WHERE id = ?", (device_id,))
    return {"ok": True}


@app.post("/api/devices/refresh")
def api_refresh_devices(payload: dict, _: bool = Depends(require_admin)):
    """Remote refresh. No device id means every display."""
    count = devices.request_refresh(payload.get("device_id"))
    return {"ok": True, "devices": count}


# --------------------------------------------------------------------------
#  API keys
# --------------------------------------------------------------------------

@app.get("/api/keys")
def api_list_keys(_: bool = Depends(require_admin)):
    devices.ensure_schema()
    # Never the hash, and never anything that could reconstruct the key.
    return db.query(
        "SELECT id, name, prefix, read_only, last_used, created_at FROM api_keys ORDER BY id"
    )


@app.post("/api/keys")
def api_create_key(payload: dict, _: bool = Depends(require_admin)):
    """The plaintext key is returned exactly once and cannot be recovered."""
    return devices.create_key(payload.get("name") or "API key",
                              bool(payload.get("read_only")))


@app.delete("/api/keys/{key_id}")
def api_delete_key(key_id: int, _: bool = Depends(require_admin)):
    devices.ensure_schema()
    db.execute("DELETE FROM api_keys WHERE id = ?", (key_id,))
    return {"ok": True}


# --------------------------------------------------------------------------
#  Webhooks and variables
#
#  A webhook can write exactly one named variable and read nothing. That is
#  deliberately far less than an API key: most integrations only need to push
#  a number in, and handing them full access to do it would be careless.
# --------------------------------------------------------------------------

@app.get("/api/webhooks")
def api_list_webhooks(_: bool = Depends(require_admin)):
    devices.ensure_schema()
    rows = db.query("SELECT * FROM webhooks ORDER BY id")
    for row in rows:
        row["url"] = f"/api/hook/{row['token']}"
        if row.get("kind") == "task":
            # The page a phone opens, which is the one that goes in a QR code.
            row["add_url"] = f"/add/{row['token']}"
            listed = db.one("SELECT name FROM todo_lists WHERE id = ?",
                            (row.get("target"),))
            row["target_name"] = listed["name"] if listed else "(list deleted)"
    return rows


@app.post("/api/webhooks")
def api_create_webhook(payload: dict, _: bool = Depends(require_admin)):
    """Create a push link.

    Two shapes over one token mechanism: `variable` pushes a value a widget can
    read, `task` adds to one to-do list. A second token concept would only mean
    a second place to leak one from.
    """
    kind = "task" if payload.get("kind") == "task" else "variable"
    target = payload.get("target")
    if kind == "task":
        if not target:
            raise HTTPException(status_code=400, detail="pick a list to add to")
        if not db.one("SELECT id FROM todo_lists WHERE id = ?", (int(target),)):
            raise HTTPException(status_code=400, detail="no such list")
    return devices.create_webhook(
        payload.get("name") or ("Send tasks" if kind == "task" else "Webhook"),
        payload.get("variable") or "",
        kind=kind,
        target=int(target) if target else None,
        notify_url=(payload.get("notify_url") or "").strip(),
    )


@app.patch("/api/webhooks/{hook_id}")
def api_update_webhook(hook_id: int, payload: dict, _: bool = Depends(require_admin)):
    """Change where completions are announced.

    Separate from creation because the order people actually do this in is
    backwards from the order it is set up: you make the board link first, then
    go to Teams to make an Incoming Webhook, then come back with the URL.
    """
    devices.ensure_schema()
    if "notify_url" not in payload:
        raise HTTPException(status_code=400, detail="nothing to update")
    url = (payload.get("notify_url") or "").strip()
    if url and not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="that is not an http(s) URL")
    db.execute("UPDATE webhooks SET notify_url = ? WHERE id = ?", (url, hook_id))
    return {"ok": True}


@app.delete("/api/webhooks/{hook_id}")
def api_delete_webhook(hook_id: int, _: bool = Depends(require_admin)):
    devices.ensure_schema()
    db.execute("DELETE FROM webhooks WHERE id = ?", (hook_id,))
    return {"ok": True}


@app.post("/api/hook/{token}")
async def api_receive_hook(token: str, request: Request):
    """Inbound push. The token IS the authentication, so it is long and random.

    Accepts JSON, form data or raw text, because the things that call a webhook
    (a Grafana alert, a shell one-liner, a Home Assistant automation) all send
    something different and none of them should have to care.
    """
    body = await request.body()
    if len(body) > 256 * 1024:
        raise HTTPException(status_code=413, detail="payload too large")

    content_type = (request.headers.get("content-type") or "").lower()
    if "json" in content_type:
        try:
            payload = json.loads(body or b"null")
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="body was not valid JSON") from None
    elif "form" in content_type:
        payload = dict(await request.form())
    else:
        payload = body.decode("utf-8", errors="replace").strip()

    result = devices.receive(token, payload)
    if "error" in result:
        # 404 rather than 403: a wrong token should not confirm that some other
        # token would have worked.
        raise HTTPException(status_code=404, detail="unknown webhook")
    return result


@app.get("/api/hook/{token}")
async def api_receive_hook_get(token: str, request: Request):
    """Same thing over GET, for things that can only fire a URL."""
    params = dict(request.query_params)
    payload = params.get("value", params) if params else None
    result = devices.receive(token, payload)
    if "error" in result:
        raise HTTPException(status_code=404, detail="unknown webhook")
    return result



@app.get("/add/{token}")
def api_add_page(token: str):
    """The page a phone opens after scanning the QR on the wall.

    Unauthenticated on purpose, and the token in the path is the whole
    authorisation. Somebody in the kitchen who wants to add "milk" should not
    meet a login - handing the family the admin password so they can add a task
    is how the admin password ends up written on the fridge.

    The page is served for ANY token, valid or not; the POST it makes is what
    checks. Refusing here would turn this into an oracle for guessing tokens,
    and a wrong one gets a clear message from the endpoint anyway.
    """
    page = WEB_ROOT / "add" / "index.html"
    if not page.is_file():
        raise HTTPException(status_code=404, detail="not installed")
    return FileResponse(page, media_type="text/html", headers={
        # The token is in the URL, so keep it out of anything shared.
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
    })


@app.get("/api/variables")
def api_list_variables(_: bool = Depends(require_admin)):
    devices.ensure_schema()
    return db.query("SELECT name, value, updated_at, source FROM variables ORDER BY name")


@app.get("/api/data/variable")
def api_get_variable(name: str):
    """Read a pushed value. Unauthenticated - a widget on the wall reads it."""
    found = devices.get_variable(name)
    if not found:
        return JSONResponse({"error": f"no variable named {name!r} yet"}, status_code=404)
    return found


@app.put("/api/variables/{name}")
def api_set_variable(name: str, payload: dict, _: bool = Depends(require_admin)):
    return devices.set_variable(name, payload.get("value"), source="api")


@app.delete("/api/variables/{name}")
def api_delete_variable(name: str, _: bool = Depends(require_admin)):
    devices.ensure_schema()
    db.execute("DELETE FROM variables WHERE name = ?", (name,))
    return {"ok": True}


# --------------------------------------------------------------------------
#  Layout export / import
#
#  The exported file is the same shape as a built-in template, deliberately.
#  That means a board you export can be dropped into `templates/` and becomes
#  a template, and a template can be imported as a working layout - one format
#  instead of two that drift.
# --------------------------------------------------------------------------

LAYOUT_EXPORT_VERSION = 1


@app.get("/api/layouts/{layout_id}/export")
def api_export_layout(layout_id: int, _: bool = Depends(require_admin)):
    layout = db.one("SELECT * FROM layouts WHERE id = ?", (layout_id,))
    if not layout:
        raise HTTPException(status_code=404, detail="no such layout")

    widgets = []
    for row in db.query(
        "SELECT * FROM widgets WHERE layout_id = ? ORDER BY z, id", (layout_id,)
    ):
        w = _hydrate_widget(row)
        # Database ids are meaningless on another appliance, and a source id
        # that happens to exist there would silently point a widget at the
        # wrong calendar. Strip them and let the importer re-bind.
        for drop in ("id", "layout_id", "created_at", "source_id"):
            w.pop(drop, None)
        widgets.append(w)

    return {
        "lifeboard_export": LAYOUT_EXPORT_VERSION,
        "name": layout["name"],
        "aspect": "portrait" if _screen_is_portrait() else "landscape",
        "background": layout["background"],
        "background_kind": layout["background_kind"],
        "background_image": layout["background_image"],
        "background_dim": layout["background_dim"],
        "background_blur": layout["background_blur"],
        "widgets": widgets,
        # Named so a human opening the file can tell what a widget pointed at,
        # even though the ids are gone.
        "source_hints": _source_hints(layout_id),
    }


def _screen_is_portrait() -> bool:
    screen = db.one("SELECT orientation FROM screens ORDER BY id LIMIT 1")
    return bool(screen and screen["orientation"] in ("left", "right"))


def _source_hints(layout_id: int) -> dict:
    """Which sources this layout referenced, by name and kind."""
    hints: dict[str, dict] = {}
    for row in db.query("SELECT config FROM widgets WHERE layout_id = ?", (layout_id,)):
        try:
            config = json.loads(row["config"] or "{}")
        except (TypeError, ValueError):
            continue
        ids = []
        if config.get("source_id"):
            ids.append(config["source_id"])
        ids.extend(config.get("source_ids") or [])
        for source_id in ids:
            src = db.one("SELECT name, kind FROM sources WHERE id = ?", (source_id,))
            if src:
                hints[str(source_id)] = {"name": src["name"], "kind": src["kind"]}
    return hints


@app.post("/api/layouts/import")
def api_import_layout(payload: dict, _: bool = Depends(require_admin)):
    """Create a layout from an exported file (or a template file).

    Source references are re-bound BY NAME against this appliance's own
    sources. A reference that cannot be matched is cleared rather than left
    pointing at an arbitrary id - a widget that says "no source selected" is
    honest, whereas one silently showing the wrong calendar is not.
    """
    widgets = payload.get("widgets")
    if not isinstance(widgets, list):
        raise HTTPException(status_code=400, detail="that file has no widgets array")

    hints = payload.get("source_hints") or {}
    by_name = {
        (s["name"].strip().lower(), s["kind"]): s["id"]
        for s in db.query("SELECT id, name, kind FROM sources")
    }

    def rebind(old_id):
        hint = hints.get(str(old_id))
        if not hint:
            return None
        return by_name.get((str(hint.get("name", "")).strip().lower(), hint.get("kind")))

    unmatched: list[str] = []
    for widget in widgets:
        config = widget.get("config") or {}
        if config.get("source_id"):
            new_id = rebind(config["source_id"])
            if new_id is None:
                unmatched.append(str(hints.get(str(config["source_id"]), {}).get("name", "?")))
            config["source_id"] = new_id
        if config.get("source_ids"):
            mapped = [rebind(i) for i in config["source_ids"]]
            config["source_ids"] = [i for i in mapped if i is not None]
        widget["config"] = config

    with db.tx() as conn:
        cur = conn.execute(
            "INSERT INTO layouts (name, background, background_image, background_kind, "
            "background_dim, background_blur) VALUES (?, ?, ?, ?, ?, ?)",
            (
                payload.get("name") or "Imported layout",
                payload.get("background") or "#101014",
                payload.get("background_image") or "",
                payload.get("background_kind") or "none",
                int(payload.get("background_dim", 35)),
                int(payload.get("background_blur", 0)),
            ),
        )
        layout_id = cur.lastrowid
        for index, widget in enumerate(widgets):
            _insert_widget(conn, layout_id, widget, index)

    return {
        "id": layout_id,
        "widgets": len(widgets),
        # Named explicitly so the UI can tell the user what needs re-pointing
        # rather than leaving them to find the blank widgets themselves.
        "unmatched_sources": sorted(set(n for n in unmatched if n and n != "?")),
    }


# --------------------------------------------------------------------------
#  Test a source
#
#  "Implemented" is not the same as "working on your network with your
#  credentials". Every source kind can be exercised from the admin UI and
#  reports what it actually got back - a count, a sample, and the real error
#  when there is one. Without this, a mistyped album URL or a revoked token
#  shows up as a silently empty widget on the wall.
# --------------------------------------------------------------------------


# --------------------------------------------------------------------------
#  Whole-board bundles
#
#  The layout export above moves a DESIGN between appliances and strips source
#  ids on purpose. This moves a BOARD: layouts, the screens that show them,
#  the sources they read, the to-do lists, the power schedule and the settings
#  - so replacing dead hardware is a restore rather than an afternoon of
#  re-entering feed URLs. See backup.py for why credentials are opt-in.
# --------------------------------------------------------------------------

def _bundle_filename(name: str, credentials: bool) -> str:
    stem = "".join(c if c.isalnum() else "-" for c in (name or "lifeboard")).strip("-")
    stamp = datetime.now().strftime("%Y-%m-%d")
    # The filename says it, because the flag inside the file is not visible in
    # a download list or an email attachment - and this is the one file here
    # that should never be forwarded casually.
    tail = "-with-credentials" if credentials else ""
    return f"{(stem or 'lifeboard').lower()}-{stamp}{tail}.lifeboard.json"


@app.get("/api/backup")
def api_backup(
    layouts: str = "",
    screens: str = "",
    sources: bool = True,
    credentials: bool = False,
    todo: bool = True,
    settings: bool = True,
    media: bool = False,
    _: bool = Depends(require_admin),
):
    """Everything needed to rebuild this board, or the part of it named."""
    layout_ids = [int(v) for v in layouts.split(",") if v.strip().isdigit()]
    screen_ids = [int(v) for v in screens.split(",") if v.strip().isdigit()]
    bundle = backup.build(
        layout_ids=layout_ids or None,
        screen_ids=screen_ids or None,
        include_sources=sources,
        include_credentials=credentials,
        include_todo=todo,
        include_settings=settings,
        include_media=media,
        media_dir=MEDIA_DIR,
    )
    name = ""
    if screen_ids and bundle["screens"]:
        name = bundle["screens"][0]["name"]
    elif layout_ids and bundle["layouts"]:
        name = bundle["layouts"][0]["name"]
    return JSONResponse(bundle, headers={
        "Content-Disposition":
            f'attachment; filename="{_bundle_filename(name, credentials)}"',
    })


@app.get("/api/backup/preview")
def api_backup_preview(
    screens: str = "", layouts: str = "", _: bool = Depends(require_admin),
):
    """What a bundle would contain, so the UI can say so before downloading.

    Specifically it names the sources that carry a credential, because "this
    file will contain your Google tokens" is a thing to be told BEFORE
    clicking, not discovered afterwards in a downloads folder.
    """
    layout_ids = [int(v) for v in layouts.split(",") if v.strip().isdigit()]
    screen_ids = [int(v) for v in screens.split(",") if v.strip().isdigit()]
    plain = backup.build(layout_ids=layout_ids or None, screen_ids=screen_ids or None,
                         include_credentials=False, include_media=False,
                         media_dir=MEDIA_DIR)
    with_creds = [
        s["name"] for s in plain["sources"] if s.get("secret_redacted")
    ]
    referenced = 0
    for row in db.query("SELECT filename FROM media"):
        if f'"{row["filename"]}"' in json.dumps(plain):
            referenced += 1
    return {
        "layouts": len(plain["layouts"]),
        "screens": len(plain["screens"]),
        "widgets": sum(len(l["widgets"]) for l in plain["layouts"]),
        "sources": len(plain["sources"]),
        "todo_lists": len(plain.get("todo_lists") or []),
        "media_files": referenced,
        "credentialled_sources": sorted(set(with_creds)),
    }


@app.get("/api/bible/nlt")
def api_nlt_status(_: bool = Depends(require_admin)):
    """Is a local NLT installed on THIS board?"""
    from .providers import bible as bible_provider
    return bible_provider.nlt_status()


@app.post("/api/bible/nlt")
async def api_nlt_upload(request: Request, _: bool = Depends(require_admin)):
    """Install an NLT JSON on this board.

    Admin-only and stored under a fixed name: the upload's own filename is
    never used, because a name is attacker-controlled input and path traversal
    through it turns an upload into a write-anywhere primitive.
    """
    from .providers import bible as bible_provider

    # A legible failure instead of a severed connection.
    #
    # request.form() raises if python-multipart is not installed, and it raises
    # while the client is still sending - so the socket closes mid-body and the
    # browser says "Failed to fetch": no status, no message, nothing to act on.
    # Catching it turns an unexplained network error into a sentence naming the
    # package.
    try:
        form = await request.form()
    except (RuntimeError, AssertionError) as exc:
        raise HTTPException(
            status_code=500,
            detail=f"this board cannot accept uploads: {exc}") from exc

    upload = form.get("file")
    if upload is None or not hasattr(upload, "read"):
        raise HTTPException(status_code=400, detail="no file uploaded")

    # A complete Bible is a few megabytes of JSON; the cap is generous enough
    # for any real one and small enough that a wrong file cannot fill the disk
    # of a board with an 8GB card.
    limit = 64 * 1024 * 1024
    chunks, size = [], 0
    while chunk := await upload.read(1024 * 256):
        size += len(chunk)
        if size > limit:
            raise HTTPException(status_code=413, detail="that file is too large")
        chunks.append(chunk)

    try:
        return bible_provider.install_nlt(b"".join(chunks))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/backup/contents")
def api_backup_contents(payload: dict, _: bool = Depends(require_admin)):
    """List what is inside an uploaded bundle, WITHOUT importing any of it.

    The bundle is sent again with the restore rather than held on the server
    between the two calls: a picker somebody opens and then abandons leaves
    nothing behind, and there is never a window where a bundle full of
    credentials is sitting on the appliance un-chosen.
    """
    try:
        return backup.contents(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/backup/restore")
def api_restore(payload: dict, replace: bool = False,
                _: bool = Depends(require_admin)):
    """Load a bundle, or part of one, into this appliance.

    `replace` is for fresh hardware and wipes what is here first. It is off by
    default because the same button on a working board would otherwise be one
    misclick away from deleting it.

    `_select` inside the payload narrows what is taken: whole layouts, or
    individual blocks onto a layout that already exists here. See
    backup._selected - the selection is applied by rewriting the bundle, so
    partial and full imports go down exactly the same insertion path.
    """
    # Popped before anything else looks at the payload, because everything
    # else in it IS the bundle and restore() validates that shape.
    select = payload.pop("_select", None) if isinstance(payload, dict) else None
    try:
        report = backup.restore(payload, replace=replace, media_dir=MEDIA_DIR,
                                select=select)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # A restored board is a different board, so the native video windows have
    # to be re-placed now rather than at the next layout save. The power
    # scheduler needs nothing - it reads its rules from the database on every
    # tick, so it picks the restored ones up on its own.
    try:
        video_agent.AGENT.sync()
    except Exception:  # noqa: BLE001 - a restore must not fail because of mpv
        log.exception("video resync after restore failed")
    return report


@app.post("/api/sources/{source_id}/test")
def api_test_source(source_id: int, _: bool = Depends(require_admin)):
    """Test a source, and RECORD what happened.

    The recording is the point of this wrapper. Without it the Status column
    sat on "not fetched" however many times a test succeeded, because Status
    reflects last_ok and nothing on this path wrote it - a status that cannot
    change reads as "broken" for a source that is working perfectly.
    """
    outcome = _run_source_test(source_id)
    if outcome.get("ok"):
        db.execute(
            "UPDATE sources SET last_ok = datetime('now'), last_error = '' "
            "WHERE id = ?", (source_id,))
    elif outcome.get("error"):
        db.execute("UPDATE sources SET last_error = ? WHERE id = ?",
                   (str(outcome["error"])[:500], source_id))
    return outcome


def _run_source_test(source_id: int) -> dict:
    src = db.one("SELECT * FROM sources WHERE id = ?", (source_id,))
    if not src:
        raise HTTPException(status_code=404, detail="no such source")
    kind = src["kind"]
    config = json.loads(src["config"] or "{}")

    try:
        if kind == "photos":
            config["_source_id"] = source_id
            result = photos_provider.fetch(dict(src, config=json.dumps(config)), ttl=0)
            if result.error:
                return {"ok": False, "error": result.error, "hint": _photo_hint(config)}
            payload = result.payload or {}
            shots = payload.get("photos") or []
            items = payload.get("items") or []
            videos = int(payload.get("video_count") or 0)
            # Videos are counted separately, because "40 photos found" on an
            # album of clips is how you spend an evening wondering why the
            # slideshow shows nothing but stills.
            summary = f"{len(shots)} photo(s) found"
            if videos:
                summary += f", {videos} video(s)"
            return {
                "ok": bool(items),
                "summary": summary,
                "sample": [i.get("url") for i in items[:3]],
                "error": "" if items else "the album resolved but is empty",
                "hint": "" if items else _photo_hint(config),
            }

        if kind == "ical":
            start, end = datetime.now(timezone.utc), datetime.now(timezone.utc) + timedelta(days=30)
            from .providers import ical as ical_provider

            result = ical_provider.fetch(config.get("url", ""), start, end, ttl=0)
            if result.error:
                return {"ok": False, "error": result.error}
            return {
                "ok": True,
                "summary": f"{len(result.events)} event(s) in the next 30 days",
                "sample": [e.title for e in result.events[:3]],
            }

        if kind in ("google", "graph"):
            tokens = secrets_store.open_(src["secret"]) or {}
            if not tokens:
                return {"ok": False, "error": "not connected yet - use Connect on the System tab"}
            start, end = datetime.now(timezone.utc), datetime.now(timezone.utc) + timedelta(days=30)
            result, updated = oauth_calendars.fetch(
                kind, config, tokens, start, end,
                source_id=source_id, source_name=src["name"], colour=src["colour"], ttl=0,
            )
            if updated:
                _store_tokens(source_id, updated)
            if result.error:
                return {"ok": False, "error": result.error}
            return {
                "ok": True,
                "summary": f"{len(result.events)} event(s) in the next 30 days",
                "sample": [e.title for e in result.events[:3]],
            }

        if kind == "weather":
            result = weather.fetch(
                float(config.get("latitude", 0)), float(config.get("longitude", 0)),
                units=config.get("units", "imperial"), ttl=0,
            )
            if result.error:
                return {"ok": False, "error": result.error}
            current = (result.payload or {}).get("current", {})
            return {"ok": True,
                    "summary": f"{current.get('temp')}° and {current.get('label', '').lower()}"}

        if kind == "rss":
            # THE SAME CALL THE BOARD MAKES.
            #
            # This used to be `rss.fetch(config.get("url", ""))`, reading the
            # legacy single-feed key while the board read the current one via
            # fetch_many. A source created by today's editor has `urls` and no
            # `url`, so Test fetched the empty string and httpx reported
            # "Request URL is missing an 'http://' or 'https://' protocol" -
            # an error about a URL the user never typed, which reads as "your
            # address is malformed" and sends them off adding prefixes to a
            # perfectly good feed. A test that exercises a different code path
            # from the thing it is testing can only mislead.
            result = rss.fetch_many(config, ttl=0)
            if result.error and not result.payload:
                return {"ok": False, "error": result.error}
            items = (result.payload or {}).get("items", [])
            return {"ok": bool(items),
                    "summary": f"{len(items)} headline(s)",
                    "sample": [i["title"] for i in items[:3]],
                    "error": result.error}

        if kind == "homeassistant":
            result = ha.list_entities(config, ttl=0)
            if result.error:
                return {"ok": False, "error": result.error}
            entities = result.payload["entities"]
            return {"ok": True, "summary": f"{len(entities)} entities",
                    "sample": [e["entity_id"] for e in entities[:3]]}

        if kind == "rest":
            preview = restdata.preview(config)
            return {
                "ok": bool(preview.get("ok")),
                "error": preview.get("error", ""),
                "summary": f"HTTP {preview.get('status')}" if preview.get("ok") else "",
                "shape": preview.get("shape"),
                "value": preview.get("value"),
            }

        return {"ok": False, "error": f"no test available for {kind!r}"}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def _photo_hint(config: dict) -> str:
    """Say what to check, per backend - a bare failure is not actionable."""
    backend = config.get("backend", "local")
    if backend == "google_shared":
        return ("Check the album is shared with 'anyone with the link'. This reads a "
                "public page rather than an API, because Google withdrew album access "
                "for apps in March 2025 - see docs/google-photos.md.")
    if backend == "immich":
        return "Check the Immich URL, the album id from its web UI, and the API key."
    if backend == "local":
        return ("Check the path exists on the APPLIANCE (not on your laptop) and "
                "contains image files.")
    return ""


# --------------------------------------------------------------------------
#  Home Assistant: interactive control
#
#  AUTHORISATION, because this one actually changes things in the house.
#
#  The wall display has no session and cannot get one. So instead of trusting
#  the caller, the server checks what the BOARD is allowed to touch: the
#  request names a widget, and the entity must be one that widget was
#  configured with. Anything else is refused.
#
#  The practical effect is that a person standing at the display can do exactly
#  what the display already shows them a button for, and nothing more - not
#  every entity in Home Assistant.
# --------------------------------------------------------------------------

@app.post("/api/ha/control")
def api_ha_control(payload: dict):
    widget_id = payload.get("widget_id")
    entity_id = (payload.get("entity_id") or "").strip()
    action = (payload.get("action") or "toggle").strip()

    if not widget_id or not entity_id:
        raise HTTPException(status_code=400, detail="widget_id and entity_id are required")

    widget = db.one("SELECT * FROM widgets WHERE id = ?", (int(widget_id),))
    if not widget:
        raise HTTPException(status_code=404, detail="no such widget")

    config = json.loads(widget["config"] or "{}")
    allowed = set(config.get("entity_ids") or [])
    if entity_id not in allowed:
        # Deliberately explicit: this is the security boundary, and a vague
        # error here would send someone debugging the wrong thing.
        raise HTTPException(
            status_code=403,
            detail=f"{entity_id} is not one of the entities this widget controls",
        )
    if not config.get("interactive", True):
        raise HTTPException(status_code=403, detail="this widget is display-only")

    source_id = config.get("source_id")
    if not source_id:
        raise HTTPException(status_code=400, detail="the widget has no Home Assistant source")
    ha_config = _ha_config(int(source_id))

    result = ha.act(ha_config, entity_id, action, payload.get("value"))
    if result.error:
        return JSONResponse({"error": result.error}, status_code=502)

    # Return the entity's new state so the widget can settle on the truth
    # rather than keeping its optimistic guess.
    fresh = ha.states(ha_config, [entity_id], ttl=0)
    entity = (fresh.payload or {}).get("entities", [None])[0] if not fresh.error else None
    return {"ok": True, "entity": entity}


@app.get("/api/data/ha/controls")
def api_ha_controls(source_id: int, entities: str = ""):
    """States plus what each entity can actually be told to do.

    Unauthenticated like the other renderer feeds - it is read-only, and the
    control endpoint above is where the real check happens.
    """
    ids = [e.strip() for e in entities.split(",") if e.strip()]
    if not ids:
        return {"entities": [], "missing": []}
    result = ha.states(_ha_config(source_id), ids)
    if result.error:
        return JSONResponse({"error": result.error}, status_code=502)

    out = []
    for entity in result.payload["entities"]:
        out.append({
            **entity,
            "control": ha.controllable(entity["entity_id"]),
            "is_on": ha.is_on(entity),
            "domain": ha.domain_of(entity["entity_id"]),
        })
    return {"entities": out, "missing": result.payload["missing"]}


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/")
def root():
    return RedirectResponse("/admin/")


# Static mounts last so they never shadow an API route.
if (WEB_ROOT / "render").is_dir():
    class FreshStatic(StaticFiles):
        """StaticFiles that always revalidates.

        The appliance updates by replacing these files underneath a browser
        that may run for months without a reload. Without this the board can
        go on executing code that was deleted from disk two deploys ago, and
        nothing about the symptom points at caching.

        Revalidation is nearly free: the ETag is unchanged for an unchanged
        file, so the answer is a bodyless 304 over loopback.
        """

        def file_response(self, *args, **kwargs):  # noqa: D102
            response = super().file_response(*args, **kwargs)
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
            return response

    app.mount("/render", FreshStatic(directory=WEB_ROOT / "render", html=True), name="render")
if (WEB_ROOT / "admin").is_dir():
    app.mount("/admin", FreshStatic(directory=WEB_ROOT / "admin", html=True), name="admin")


@app.on_event("startup")
def _startup() -> None:
    db.connect()
    devices.ensure_schema()
    try:
        sweep_dangling_sources()
    except Exception:  # noqa: BLE001
        # Tidying is never worth refusing to boot over.
        log.exception("could not sweep dangling source references")
    scheduler.SCHEDULER.start()
    try:
        video_agent.AGENT.start()
        video_agent.AGENT.sync()
    except Exception:  # noqa: BLE001
        log.exception("video agent failed to start")
    log.info("lifeboard up; web root %s", WEB_ROOT)


@app.on_event("shutdown")
def _shutdown() -> None:
    scheduler.SCHEDULER.stop()
    video_agent.AGENT.stop()
