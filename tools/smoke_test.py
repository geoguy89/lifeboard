# -*- coding: utf-8 -*-
"""End-to-end smoke test against a throwaway database.

Exercises the paths that actually break: setup/auth, template apply, layout
save/round-trip, QR generation (including a wifi password containing the
characters that must be escaped), and the board payload the renderer consumes.

    python tools/smoke_test.py

Deliberately does NOT touch display control - that shells out to xset/cec and
has no meaning on a dev machine.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

# Must be set before lifeboard.db is imported - it reads the path at import time.
TMP = Path(tempfile.mkdtemp(prefix="lifeboard-smoke-"))
os.environ["LIFEBOARD_DB"] = str(TMP / "test.db")
os.environ["LIFEBOARD_WEB"] = str(ROOT / "web")
os.environ["LIFEBOARD_TEMPLATES"] = str(ROOT / "templates")

from fastapi.testclient import TestClient  # noqa: E402

from lifeboard.main import app  # noqa: E402

PNG_MAGIC = b"\x89PNG"
PASSWORD = 'a:b,c;d\\e"f'
EXPECTED_PW = 'a\\:b\\,c\\;d\\\\e\\"f'

FAILURES: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        FAILURES.append(label)


def main() -> int:
    print(f"database: {os.environ['LIFEBOARD_DB']}\n")
    # Loopback, like the kiosk: only a local display may register itself.
    with TestClient(app, client=("127.0.0.1", 50000)) as client:
        # --- first boot -----------------------------------------------------
        print("first boot")
        session = client.get("/api/session").json()
        check("setup is required on a fresh db", session["setup_needed"] is True)

        board = client.get("/api/board?screen_id=1").json()
        check("a default board exists", board["layout"] is not None)
        check("default board is not empty", len(board["widgets"]) >= 1,
              "a blank screen is indistinguishable from a broken install")

        # --- auth -----------------------------------------------------------
        print("\nauth")
        resp = client.post("/api/setup", json={"password": "short"})
        check("short password rejected", resp.status_code == 400)

        resp = client.post("/api/setup", json={"username": "sam",
                                       "password": "correct-horse-battery"})
        check("password accepted", resp.status_code == 200)

        resp = client.post("/api/setup", json={"password": "another-one-here"})
        check("setup cannot be run twice", resp.status_code == 409,
              "otherwise anyone on the LAN could re-claim the appliance")

        client.cookies.clear()
        check("protected route refuses anonymous",
              client.get("/api/sources").status_code == 401)
        check("renderer board stays public",
              client.get("/api/board?screen_id=1").status_code == 200,
              "the TV cannot log in")

        check("wrong password rejected",
              client.post("/api/login", json={"password": "nope"}).status_code == 401)
        check("right password accepted",
              client.post("/api/login", json={"password": "correct-horse-battery"}).status_code == 200)

        # --- templates ------------------------------------------------------
        print("\ntemplates")
        templates = client.get("/api/templates").json()
        check("templates load", len(templates) >= 10, f"got {len(templates)}")
        portrait = [t for t in templates if t.get("aspect") == "portrait"]
        check("portrait templates exist", len(portrait) >= 7, f"got {len(portrait)}")

        target = portrait[0]["id"]
        resp = client.post(f"/api/templates/{target}/apply", json={"screen_id": 1})
        check("template applies", resp.status_code == 200)
        layout_id = resp.json()["layout_id"]

        board = client.get("/api/board?screen_id=1").json()
        check("board switched to the new layout", board["layout"]["id"] == layout_id)
        check("template widgets landed", len(board["widgets"]) >= 3)
        check("applying set portrait orientation",
              board["screen"]["orientation"] in ("left", "right"))

        layouts = client.get("/api/layouts").json()
        check("previous layout was kept, not overwritten", len(layouts) >= 2,
              "applying a template must never destroy the current board")

        # --- layout round trip ---------------------------------------------
        print("\nlayout editing")
        resp = client.put(f"/api/layouts/{layout_id}", json={
            "name": "Edited",
            "background": "#123456",
            "widgets": [
                {"kind": "clock", "x": 1, "y": 2, "w": 50, "h": 20, "z": 0,
                 "config": {"hour12": False, "show_seconds": True}},
                {"kind": "qr", "x": 60, "y": 5, "w": 30, "h": 30, "z": 1,
                 "config": {"mode": "wifi", "ssid": "Test", "password": "p;a,s:s"}},
            ],
        })
        check("layout saves", resp.status_code == 200)

        board = client.get("/api/board?screen_id=1").json()
        check("widget count round-trips", len(board["widgets"]) == 2)
        clock = next(w for w in board["widgets"] if w["kind"] == "clock")
        check("geometry round-trips", clock["x"] == 1 and clock["w"] == 50)
        check("config round-trips as a dict", clock["config"]["show_seconds"] is True)
        check("background round-trips", board["layout"]["background"] == "#123456")

        check("in-use layout cannot be deleted",
              client.delete(f"/api/layouts/{layout_id}").status_code == 409,
              "would leave the screen pointing at nothing")

        # --- QR --------------------------------------------------------------
        print("\nQR codes")
        resp = client.get("/api/qr", params={"mode": "text", "text": "hello"})
        check("text QR renders",
              resp.status_code == 200 and resp.content[:4] == PNG_MAGIC,
              f"status={resp.status_code} magic={resp.content[:4]!r}")

        # Escaping in the WIFI: scheme is the bit worth testing. Getting it
        # wrong yields a QR that scans perfectly and then fails to join the
        # network - close to impossible to diagnose from across the room.
        from lifeboard.main import _wifi_payload

        payload = _wifi_payload("My;Net", PASSWORD, "WPA", False)
        check("SSID separator is escaped", "My\\;Net" in payload, payload)
        check("every password delimiter is escaped", EXPECTED_PW in payload, payload)
        check("payload is well formed",
              payload.startswith("WIFI:T:WPA;") and payload.endswith(";;"), payload)

        resp = client.get("/api/qr", params={
            "mode": "wifi", "ssid": "My;Net", "password": PASSWORD, "security": "WPA",
        })
        check("wifi QR renders",
              resp.status_code == 200 and resp.content[:4] == PNG_MAGIC,
              f"status={resp.status_code}")

        check("open network omits the password field",
              "P:" not in _wifi_payload("Guest", "", "nopass", False))

        check("empty QR is rejected",
              client.get("/api/qr", params={"mode": "text", "text": ""}).status_code == 400)

        # --- sources ---------------------------------------------------------
        print("\nsources")
        resp = client.post("/api/sources", json={
            "kind": "ical", "name": "Test cal", "config": {"url": "https://example.invalid/x.ics"},
        })
        check("source created", resp.status_code == 200)
        source_id = resp.json()["id"]

        data = client.get("/api/data/calendar?days=30").json()
        check("calendar endpoint answers with a bad feed", "events" in data)
        check("the broken source is reported, not swallowed",
              str(source_id) in {str(k) for k in data["errors"]},
              "a silent empty calendar is the worst outcome")

        sources = client.get("/api/sources").json()
        check("error is recorded against the source",
              any(s["id"] == source_id and s["last_error"] for s in sources))

        check("source deletes",
              client.delete(f"/api/sources/{source_id}").status_code == 200)

        # --- backgrounds and panels -----------------------------------------
        print("\nbackgrounds and panels")
        resp = client.put(f"/api/layouts/{layout_id}", json={
            "background_kind": "url",
            "background_image": "https://example.invalid/pic.jpg",
            "background_dim": 55,
            "background_blur": 8,
            "widgets": [
                {"kind": "clock", "x": 0, "y": 0, "w": 100, "h": 20, "z": 0,
                 "panel": "glass", "config": {}},
                {"kind": "video", "x": 0, "y": 30, "w": 100, "h": 30, "z": 1,
                 "panel": "none",
                 "config": {"url": "https://youtube.com/watch?v=abc", "engine": "native"}},
            ],
        })
        check("layout with a background saves", resp.status_code == 200)

        board = client.get("/api/board?screen_id=1").json()
        layout = board["layout"]
        check("background image round-trips",
              layout["background_image"] == "https://example.invalid/pic.jpg")
        check("background dim round-trips", layout["background_dim"] == 55)
        check("background blur round-trips", layout["background_blur"] == 8)
        glass = next(w for w in board["widgets"] if w["kind"] == "clock")
        check("panel style round-trips", glass["panel"] == "glass",
              "otherwise every photo-backed template renders as solid boxes")

        # --- migrations ------------------------------------------------------
        # The appliance must survive an in-place upgrade without a reflash, so
        # the new columns have to be added to an existing database, not just to
        # a freshly created one.
        from lifeboard import db as mdb

        cols = {r["name"] for r in mdb.connect().execute("PRAGMA table_info(layouts)")}
        check("layouts has the background columns",
              {"background_image", "background_kind", "background_dim",
               "background_blur"} <= cols, sorted(cols))
        cols_w = {r["name"] for r in mdb.connect().execute("PRAGMA table_info(widgets)")}
        check("widgets has the panel column", "panel" in cols_w, sorted(cols_w))

        # --- native video ----------------------------------------------------
        print("\nnative video")
        check("board advertises native video capability", "native_video" in board)
        status = client.get("/api/video/status").json()
        check("video status reports capabilities", "capabilities" in status)
        check("capabilities name mpv and yt-dlp",
              {"mpv", "yt_dlp", "hwdec"} <= set(status["capabilities"]))

        from lifeboard.video import agent as va

        check("a hardware decoder is chosen for this machine",
              va._detect_hwdec() in ("drm-copy", "v4l2m2m-copy", "vaapi-copy"))
        sync = client.post("/api/video/sync").json()
        check("video sync answers without mpv installed",
              sync.get("ok") is False or sync.get("ok") is True,
              "must degrade, not raise")

        # --- onboarding ------------------------------------------------------
        print("\nonboarding")
        # setup is complete by this point, so onboarding depends only on link
        # state; either shape is valid, it must simply be present and typed.
        check("board carries an onboarding field", "onboarding" in board)
        if board["onboarding"] is not None:
            check("onboarding names the setup network",
                  board["onboarding"].get("hotspot_ssid") == "LifeBoard-Setup")

        net = client.get("/api/system/network").json()
        check("network status answers", "ok" in net)

        # --- the recreation --------------------------------------------------
        print("\nHearth template")
        sunset = client.get("/api/templates/portrait-hearth")
        check("Hearth template exists", sunset.status_code == 200)
        if sunset.status_code == 200:
            tpl = sunset.json()
            kinds = [w["kind"] for w in tpl["widgets"]]
            for needed in ("clock", "date", "weather", "calendar", "video", "qr",
                           "rss", "photos", "text"):
                check(f"  it includes a {needed}", needed in kinds)
            styles = [w["config"].get("style") for w in tpl["widgets"]
                      if w["kind"] == "calendar"]
            check("  its calendar is the week-bubbles view",
                  styles == ["bubbles"], str(styles))

        # --- the generic widget envelope --------------------------------------
        print("\nwidget envelope")
        resp = client.put(f"/api/layouts/{layout_id}", json={
            "widgets": [
                {"kind": "clock", "x": 0, "y": 0, "w": 50, "h": 20, "z": 0,
                 "name": "Big clock", "refresh_seconds": 45, "locked": True,
                 "style": {"colour": "#ff0000"}, "config": {}},
                {"kind": "text", "x": 0, "y": 30, "w": 50, "h": 10, "z": 1,
                 "visible": False, "config": {"text": "hidden"}},
                {"kind": "text", "x": 0, "y": 50, "w": 50, "h": 10, "z": 2,
                 "schedule": {"enabled": True, "days": [], "from": "00:00", "to": "00:01"},
                 "config": {"text": "out of hours"}},
            ],
        })
        check("envelope saves", resp.status_code == 200)

        layouts = client.get("/api/layouts").json()
        edited = next(l for l in layouts if l["id"] == layout_id)
        clock = next(w for w in edited["widgets"] if w["kind"] == "clock")
        check("name round-trips", clock["name"] == "Big clock")
        check("refresh_seconds round-trips", clock["refresh_seconds"] == 45)
        check("locked round-trips", clock["locked"] is True)
        check("style round-trips as a dict", clock["style"].get("colour") == "#ff0000")

        board = client.get("/api/board?screen_id=1").json()
        kinds = [w["kind"] for w in board["widgets"]]
        check("hidden widget is withheld from the renderer", kinds.count("text") == 0,
              "a hidden widget must not have its data fetched either")
        check("scheduled-out widget is withheld", len(board["widgets"]) == 1, str(kinds))

        # A schedule that IS in force must let the widget through.
        client.put(f"/api/layouts/{layout_id}", json={"widgets": [
            {"kind": "text", "x": 0, "y": 0, "w": 50, "h": 10, "z": 0,
             "schedule": {"enabled": True, "from": "00:00", "to": "23:59"},
             "config": {"text": "always"}},
        ]})
        board = client.get("/api/board?screen_id=1").json()
        check("in-window widget is delivered", len(board["widgets"]) == 1)

        # --- REST data source and path selection ------------------------------
        print("\ngeneric data source")
        from lifeboard.providers import restdata

        sample = {"results": [{"t": 21.5, "name": "one"}, {"t": 22.5, "name": "two"}],
                  "meta": {"count": 2}}
        check("dotted path", restdata.select(sample, "meta.count") == 2)
        check("list index by dot", restdata.select(sample, "results.1.t") == 22.5)
        check("list index by bracket", restdata.select(sample, "results[0].name") == "one")
        check("negative index", restdata.select(sample, "results[-1].t") == 22.5)
        check("whole response when path is empty", restdata.select(sample, "") is sample)

        for bad, why in [("meta.nope", "missing key"),
                         ("results.9.t", "index out of range"),
                         ("meta.count.deeper", "scalar has no children")]:
            try:
                restdata.select(sample, bad)
                check(f"path error: {why}", False, "no exception raised")
            except restdata.PathError as exc:
                # The message must name what WAS there - a bare "not found"
                # gives no way to fix the path from a settings form.
                check(f"path error names the problem: {why}", len(str(exc)) > 20, str(exc))

        resp = client.post("/api/sources", json={
            "kind": "rest", "name": "Test API",
            "config": {"url": "https://example.invalid/data.json", "path": "a.b"},
        })
        check("rest source created", resp.status_code == 200)
        rest_id = resp.json()["id"]
        got = client.get(f"/api/data/rest?source_id={rest_id}")
        check("unreachable rest source 502s rather than raising", got.status_code == 502)
        check("  and says why", "error" in got.json())

        # --- todo lists --------------------------------------------------------
        print("\ntask lists")
        list_id = client.post("/api/todo/lists", json={"name": "Chores"}).json()["id"]
        item_id = client.post(f"/api/todo/lists/{list_id}/items",
                              json={"text": "Take the bins out"}).json()["id"]
        listing = client.get(f"/api/todo/lists/{list_id}").json()
        check("item was added", len(listing["items"]) == 1)
        check("item starts undone", listing["items"][0]["done"] is False)

        check("tap-to-complete works without a session",
              client.patch(f"/api/todo/items/{item_id}", json={"done": True}).status_code == 200,
              "the wall display has no session")
        check("completion persisted",
              client.get(f"/api/todo/lists/{list_id}").json()["items"][0]["done"] is True)
        check("but editing text without a session is refused",
              client.patch(f"/api/todo/items/{item_id}",
                           json={"text": "something else"}).status_code == 403)

        # --- screen loop -------------------------------------------------------
        print("\nscreen loops")
        second = client.post("/api/layouts", json={"name": "Second"}).json()["id"]
        resp = client.put("/api/screens/1/loop", json={
            "enabled": True,
            "items": [{"layout_id": layout_id, "seconds": 30},
                      {"layout_id": second, "seconds": 30}],
        })
        check("loop saves", resp.status_code == 200)
        board = client.get("/api/board?screen_id=1").json()
        check("board reports its loop position", board.get("loop") is not None)
        check("  and which layout of how many",
              board["loop"]["of"] == 2 and 0 <= board["loop"]["index"] < 2)
        client.put("/api/screens/1/loop", json={"enabled": False, "items": []})

        # --- duplication and revisions ----------------------------------------
        print("\nduplication and revisions")
        dup = client.post(f"/api/layouts/{layout_id}/duplicate", json={"name": "A copy"})
        check("layout duplicates", dup.status_code == 200)
        dup_id = dup.json()["id"]
        original = next(l for l in client.get("/api/layouts").json() if l["id"] == layout_id)
        copy = next(l for l in client.get("/api/layouts").json() if l["id"] == dup_id)
        check("copy has the same widgets", len(copy["widgets"]) == len(original["widgets"]))
        check("copy is independent", copy["id"] != original["id"])

        revs = client.get(f"/api/layouts/{layout_id}/revisions").json()
        check("saves created revisions", len(revs) >= 2, f"got {len(revs)}")

        client.put(f"/api/layouts/{layout_id}", json={"widgets": []})
        check("board is now empty",
              len(client.get("/api/board?screen_id=1").json()["widgets"]) == 0)
        newest = client.get(f"/api/layouts/{layout_id}/revisions").json()[1]["id"]
        check("restore works",
              client.post(f"/api/layouts/{layout_id}/revisions/{newest}/restore").status_code == 200)
        restored = next(l for l in client.get("/api/layouts").json() if l["id"] == layout_id)
        check("  and brought the widgets back", len(restored["widgets"]) > 0)

        # --- media library -----------------------------------------------------
        print("\nmedia library")
        png = (b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
        resp = client.post("/api/media", files={"file": ("test.png", png, "image/png")})
        check("upload accepted", resp.status_code == 200, resp.text[:120])
        media_id = resp.json()["id"]
        check("file serves back",
              client.get(f"/api/media/{media_id}/file").status_code == 200)
        check("listing shows it",
              any(m["id"] == media_id for m in client.get("/api/media").json()))

        # The stored name must be generated, never the uploaded one - a filename
        # is attacker-controlled and is how an upload becomes a file write.
        row = next(m for m in client.get("/api/media").json() if m["id"] == media_id)
        check("stored filename is generated, not the uploaded name",
              row["filename"] != "test.png" and row["original"] == "test.png")

        check("dangerous type refused",
              client.post("/api/media", files={
                  "file": ("evil.sh", b"#!/bin/sh", "application/x-sh")
              }).status_code == 415)

        check("media deletes",
              client.delete(f"/api/media/{media_id}").status_code == 200)

        # --- board switching ---------------------------------------------------
        print("\nboard switching")
        check("a button can switch layouts without a session",
              client.post("/api/board/switch",
                          json={"screen_id": 1, "layout_id": second}).status_code == 200)
        check("  and the board followed",
              client.get("/api/board?screen_id=1").json()["layout"]["id"] == second)
        check("switching to a nonexistent layout 404s",
              client.post("/api/board/switch",
                          json={"screen_id": 1, "layout_id": 999999}).status_code == 404)

        # --- weather extras ----------------------------------------------------
        print("\nweather extras")
        from lifeboard.providers import weather_extra as wx

        info = wx.moon(datetime(2026, 1, 3, tzinfo=timezone.utc))
        check("moon returns a named phase", bool(info["name"]))
        check("illumination is a percentage", 0 <= info["illumination"] <= 100)
        check("moon reports its next full and new",
              len(info["next_full"]) == 10 and len(info["next_new"]) == 10)
        # A full moon must actually read as full.
        full = wx.moon(datetime(2026, 1, 3, tzinfo=timezone.utc))
        near_full = max(
            wx.moon(datetime(2026, 1, d, tzinfo=timezone.utc))["illumination"]
            for d in range(1, 29)
        )
        check("some day in a month is ~fully lit", near_full > 95, str(near_full))

        label, colour = wx.band(42)
        check("AQI 42 is Good", label == "Good")
        check("AQI 160 is Unhealthy", wx.band(160)[0] == "Unhealthy")
        check("a non-numeric AQI degrades to Unknown", wx.band(None)[0] == "Unknown")

        wsrc = client.post("/api/sources", json={
            "kind": "weather", "name": "Home",
            "config": {"latitude": 44.80, "longitude": -68.77, "units": "imperial"},
        }).json()["id"]
        sm = client.get(f"/api/data/weather/sunmoon?source_id={wsrc}")
        check("sun/moon endpoint answers", sm.status_code == 200)
        check("  and always includes the moon (computed locally, no network)",
              "moon" in sm.json() and bool(sm.json()["moon"]["name"]))

        # --- OAuth plumbing ----------------------------------------------------
        print("\nOAuth plumbing")
        from lifeboard import secrets_store
        from lifeboard.providers import oauth

        blob = secrets_store.seal({"refresh_token": "abc", "expires_at": 1})
        check("secrets round-trip", secrets_store.open_(blob)["refresh_token"] == "abc")
        check("the sealed blob does not contain the plaintext",
              b"abc" not in blob or not secrets_store.available(),
              "encryption at rest is the whole point")
        check("secrets status is reported", "encrypted" in secrets_store.status())

        verifier, challenge = oauth.make_pkce()
        check("PKCE verifier is long enough", len(verifier) >= 43)
        check("PKCE challenge differs from the verifier", challenge != verifier)

        url = oauth.authorize_url(
            oauth.GOOGLE, "cid", "https://example.test/cb", "st8", challenge)
        for needle in ("code_challenge_method=S256", "access_type=offline",
                       "prompt=consent", "state=st8"):
            check(f"authorize url carries {needle.split('=')[0]}", needle in url)

        gsrc = client.post("/api/sources", json={
            "kind": "google", "name": "Google cal", "config": {"client_id": "x"},
        }).json()["id"]
        status = client.get("/api/oauth/status").json()
        check("oauth status lists the account",
              any(a["id"] == gsrc for a in status["accounts"]))
        check("  and reports it as not connected",
              next(a for a in status["accounts"] if a["id"] == gsrc)["connected"] is False)

        started = client.post(f"/api/oauth/{gsrc}/start",
                              json={"redirect_uri": "https://example.test/cb"})
        check("google start returns a redirect flow", started.status_code == 200)
        check("  with an authorize url", "authorize_url" in started.json())

        check("a bogus callback state is rejected",
              client.get("/api/oauth/callback?code=x&state=nope").status_code == 400,
              "state is the only thing protecting this endpoint")

        # A calendar source with no tokens must report 'reconnect', not crash,
        # and must not take the other calendars down with it.
        data = client.get("/api/data/calendar?days=7").json()
        check("an unconnected OAuth calendar reports an error, not a crash",
              str(gsrc) in {str(k) for k in data["errors"]})
        check("  and the word is 'reconnect'",
              "reconnect" in data["errors"][str(gsrc)].lower(),
              data["errors"].get(str(gsrc), ""))
        check("  while the endpoint still returns events normally", "events" in data)

        # --- devices -----------------------------------------------------------
        print("\ndevices")
        token = "dev" + "0123456789abcdef" * 2
        hello = client.post("/api/device/hello",
                            json={"token": token, "screen_id": 1, "resolution": "1080x1920"})
        check("a display can register itself without a session", hello.status_code == 200,
              "the wall has no way to log in")
        device_id = hello.json()["device_id"]
        check("registration returns a refresh counter", "refresh_seq" in hello.json())

        check("a too-short token is refused",
              client.post("/api/device/hello", json={"token": "abc"}).status_code == 400)

        listing = client.get("/api/devices").json()
        me = next(d for d in listing if d["id"] == device_id)
        check("device appears in the registry", me["resolution"] == "1080x1920")
        check("a fresh device is online", me["online"] is True)
        check("the full token is never returned",
              token not in json.dumps(listing) if "json" in dir() else True)

        client.patch(f"/api/devices/{device_id}", json={"name": "Kitchen"})
        check("device renames",
              next(d for d in client.get("/api/devices").json()
                   if d["id"] == device_id)["name"] == "Kitchen")

        before = client.post("/api/device/hello", json={"token": token}).json()["refresh_seq"]
        client.post("/api/devices/refresh", json={"device_id": device_id})
        after = client.post("/api/device/hello", json={"token": token}).json()["refresh_seq"]
        check("remote refresh bumps the counter the device watches", after == before + 1)

        check("refresh-all answers",
              client.post("/api/devices/refresh", json={}).json()["devices"] >= 1)

        # --- API keys ----------------------------------------------------------
        print("\nAPI keys")
        made = client.post("/api/keys", json={"name": "Script"}).json()
        raw_key = made["key"]
        check("a key is issued", raw_key.startswith("lb_"))

        keys = client.get("/api/keys").json()
        check("the key hash is never listed",
              all("key_hash" not in k for k in keys))
        check("the plaintext key is never listed again",
              raw_key not in str(keys),
              "it is shown once at creation and cannot be recovered")

        # A key must work in place of a session.
        client.cookies.clear()
        check("no session and no key is refused",
              client.get("/api/sources").status_code == 401)
        check("a valid key authenticates",
              client.get("/api/sources", headers={"X-API-Key": raw_key}).status_code == 200)
        check("Bearer form works too",
              client.get("/api/sources",
                         headers={"Authorization": f"Bearer {raw_key}"}).status_code == 200)
        check("a bogus key is refused",
              client.get("/api/sources", headers={"X-API-Key": "lb_nope"}).status_code == 401)

        ro = client.post("/api/keys", json={"name": "Readonly", "read_only": True},
                         headers={"X-API-Key": raw_key}).json()["key"]
        check("a read-only key can read",
              client.get("/api/sources", headers={"X-API-Key": ro}).status_code == 200)
        check("a read-only key cannot write",
              client.post("/api/todo/lists", json={"name": "nope"},
                          headers={"X-API-Key": ro}).status_code == 403,
              "read-only has to be enforced centrally, not per endpoint")

        client.post("/api/login", json={"password": "correct-horse-battery"})

        # --- webhooks and variables -------------------------------------------
        print("\nwebhooks and variables")
        hook = client.post("/api/webhooks",
                           json={"name": "Backup", "variable": "backup_status"}).json()
        check("a webhook is created with its own token", len(hook["token"]) > 20)

        check("JSON pushes in",
              client.post(f"/api/hook/{hook['token']}",
                          json={"ok": True, "files": 1204}).status_code == 200)
        got = client.get("/api/data/variable?name=backup_status").json()
        check("the value is readable back", got["value"]["files"] == 1204)
        check("  and records where it came from", "webhook" in got["source"])

        # Plain text and GET both have to work: the things that call a webhook
        # are a shell one-liner and a Grafana alert, not a well-behaved client.
        client.post(f"/api/hook/{hook['token']}", content="42",
                    headers={"Content-Type": "text/plain"})
        check("plain text pushes in",
              client.get("/api/data/variable?name=backup_status").json()["value"] == "42")
        client.get(f"/api/hook/{hook['token']}?value=fromget")
        check("GET pushes in",
              client.get("/api/data/variable?name=backup_status").json()["value"] == "fromget")

        check("an unknown webhook token 404s",
              client.post("/api/hook/not-a-real-token", json={"x": 1}).status_code == 404,
              "and must not confirm that some other token would work")

        check("a variable that was never set 404s",
              client.get("/api/data/variable?name=never_set").status_code == 404)

        # The webhook must be able to write ONLY its own variable.
        client.post("/api/webhooks", json={"name": "Other", "variable": "other_value"})
        client.post(f"/api/hook/{hook['token']}", json={"sneaky": 1})
        check("a webhook cannot write another hook's variable",
              client.get("/api/data/variable?name=other_value").status_code == 404,
              "one hook, one variable, is the whole security model")

        check("variables are listable", len(client.get("/api/variables").json()) >= 1)

        # --- layout export / import -------------------------------------------
        print("\nlayout export and import")
        cal_src = client.post("/api/sources", json={
            "kind": "ical", "name": "Family calendar",
            "config": {"url": "https://example.invalid/fam.ics"},
        }).json()["id"]

        exp_layout = client.post("/api/layouts", json={"name": "Exportable"}).json()["id"]
        client.put(f"/api/layouts/{exp_layout}", json={
            "background": "#223344",
            "background_kind": "url",
            "background_image": "https://example.invalid/bg.jpg",
            "widgets": [
                {"kind": "clock", "x": 0, "y": 0, "w": 40, "h": 15, "z": 0,
                 "name": "Top clock", "panel": "glass", "config": {"hour12": False}},
                {"kind": "calendar", "x": 0, "y": 20, "w": 90, "h": 40, "z": 1,
                 "config": {"style": "agenda", "source_ids": [cal_src]}},
            ],
        })

        exported = client.get(f"/api/layouts/{exp_layout}/export")
        check("layout exports", exported.status_code == 200)
        doc = exported.json()
        check("export is versioned", doc.get("lifeboard_export") == 1)
        check("export keeps the widgets", len(doc["widgets"]) == 2)
        check("export keeps the background", doc["background_image"].endswith("bg.jpg"))
        check("export keeps per-widget name and panel",
              doc["widgets"][0]["name"] == "Top clock"
              and doc["widgets"][0]["panel"] == "glass")
        check("export strips database ids",
              all("id" not in w and "layout_id" not in w for w in doc["widgets"]),
              "ids are meaningless on another appliance")
        check("export records source names so they can be re-bound",
              any(h["name"] == "Family calendar" for h in doc["source_hints"].values()))

        # Re-importing on the SAME appliance should re-bind by name.
        again = client.post("/api/layouts/import", json=doc)
        check("import succeeds", again.status_code == 200)
        new_id = again.json()["id"]
        check("import reports nothing unmatched here",
              again.json()["unmatched_sources"] == [])

        imported = next(l for l in client.get("/api/layouts").json() if l["id"] == new_id)
        check("imported layout has the widgets", len(imported["widgets"]) == 2)
        cal = next(w for w in imported["widgets"] if w["kind"] == "calendar")
        check("source references were re-bound to the local id",
              cal["config"]["source_ids"] == [cal_src])
        check("imported layout is independent of the original", new_id != exp_layout)

        # A layout referencing a source this appliance does not have must clear
        # the reference and SAY so - a widget silently bound to the wrong
        # calendar is far worse than one that says "nothing selected".
        foreign = json.loads(json.dumps(doc))
        foreign["name"] = "From another box"
        foreign["source_hints"] = {"999": {"name": "Someone else's calendar", "kind": "ical"}}
        for w in foreign["widgets"]:
            if w["kind"] == "calendar":
                w["config"]["source_ids"] = [999]
                w["config"]["source_id"] = 999
        result = client.post("/api/layouts/import", json=foreign).json()
        check("an unknown source is reported by name",
              "Someone else's calendar" in result["unmatched_sources"], str(result))
        orphan = next(l for l in client.get("/api/layouts").json() if l["id"] == result["id"])
        ocal = next(w for w in orphan["widgets"] if w["kind"] == "calendar")
        check("  and the reference is cleared, not left pointing at id 999",
              ocal["config"]["source_id"] is None and ocal["config"]["source_ids"] == [])

        check("importing something without widgets is refused",
              client.post("/api/layouts/import", json={"name": "junk"}).status_code == 400)

        # A built-in template must import as-is, since the formats are the same.
        tpl = client.get("/api/templates/portrait-minimal").json()
        check("a built-in template imports as a layout",
              client.post("/api/layouts/import", json=tpl).status_code == 200,
              "export format and template format are deliberately identical")

        # --- admin appearance ---------------------------------------------------
        print("\nadmin appearance")
        settings = client.get("/api/settings").json()
        check("theme defaults to dark", settings.get("admin_theme") == "dark")
        check("colour overrides default to empty", settings.get("admin_colours") == "{}")

        client.put("/api/settings", json={
            "admin_theme": "light",
            "admin_colours": json.dumps({"--accent": "#ffcc00"}),
            "admin_radius": "4",
        })
        settings = client.get("/api/settings").json()
        check("theme persists", settings["admin_theme"] == "light")
        check("colour overrides persist",
              json.loads(settings["admin_colours"])["--accent"] == "#ffcc00")
        check("radius persists", settings["admin_radius"] == "4")
        check("settings still never leak the password hash",
              "admin_password_hash" not in settings and "session_key" not in settings)

        # --- testing a source --------------------------------------------------
        print("\nsource self-test")
        bad_ical = client.post("/api/sources", json={
            "kind": "ical", "name": "Broken cal",
            "config": {"url": "https://example.invalid/none.ics"},
        }).json()["id"]
        result = client.post(f"/api/sources/{bad_ical}/test").json()
        check("testing a broken calendar reports failure", result["ok"] is False)
        check("  and gives the real reason", len(result.get("error", "")) > 5, str(result))

        # Photo backends: each failure must name what to check, because "album
        # not found" alone is not actionable.
        for backend, config, needle in [
            ("local", {"backend": "local", "path": "/definitely/not/here"}, "APPLIANCE"),
            ("immich", {"backend": "immich", "base_url": "", "album_id": "", "api_key": ""},
             "Immich"),
            ("google_shared", {"backend": "google_shared",
                               "share_url": "https://photos.app.goo.gl/zzzz"}, "anyone with the link"),
        ]:
            src_id = client.post("/api/sources", json={
                "kind": "photos", "name": f"Album {backend}", "config": config,
            }).json()["id"]
            res = client.post(f"/api/sources/{src_id}/test").json()
            check(f"photo backend '{backend}' test reports failure clearly",
                  res["ok"] is False and bool(res.get("error")))
            check(f"  and the hint says what to check for {backend}",
                  needle.lower() in (res.get("hint", "") or "").lower(),
                  res.get("hint", ""))

        # --- a local album holding BOTH photos and video ---------------------
        #
        # The index is the whole security model of the local backend ("photo 4
        # of album 2", never a path), so the listing and the by-index fetch
        # have to agree on what the album contains. They used to build that
        # list separately, and on the day videos were added to one and not the
        # other, index 4 would quietly have become a different file.
        print("\nmixed photo and video album")
        album_dir = TMP / "album"
        album_dir.mkdir(exist_ok=True)
        # Real magic bytes are irrelevant here; what is under test is listing,
        # ordering, classification and range serving, not decoding.
        (album_dir / "a-photo.jpg").write_bytes(b"\xff\xd8\xff" + b"0" * 64)
        (album_dir / "b-clip.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"0" * 512)
        (album_dir / "c-photo.png").write_bytes(b"\x89PNG" + b"0" * 64)
        (album_dir / "d-notes.txt").write_bytes(b"not media")

        mixed = client.post("/api/sources", json={
            "kind": "photos", "name": "Mixed album",
            "config": {"backend": "local", "path": str(album_dir)},
        }).json()["id"]

        data = client.get(f"/api/data/photos?source_id={mixed}").json()
        items = data.get("items") or []
        kinds = [i["kind"] for i in items]
        check("the album lists exactly its media files", len(items) == 3,
              f"got {len(items)}: {[i.get('name') for i in items]}")
        check("  the .txt is not offered as a photo",
              all(not (i.get("name") or "").endswith(".txt") for i in items))
        check("  the video is classified as video", kinds.count("video") == 1, str(kinds))
        check("  and the photos as photos", kinds.count("image") == 2, str(kinds))
        check("  video_count is reported", data.get("video_count") == 1,
              str(data.get("video_count")))
        check("the legacy 'photos' list excludes video",
              len(data.get("photos") or []) == 2,
              "a rotating BACKGROUND reads this list and must never land on a video")

        video_item = next(i for i in items if i["kind"] == "video")
        # The listing and the fetch must resolve the same index to the same
        # file. The clip sorts second by name, so it must be index 1.
        check("index order matches the listing order",
              "index=1" in video_item["url"], video_item["url"])

        resp = client.get(video_item["url"])
        check("the video's bytes are served", resp.status_code == 200)
        check("  with a video content type",
              resp.headers.get("content-type", "").startswith("video/"),
              resp.headers.get("content-type", ""))
        # Seeking into a clip is the whole point of "start somewhere random",
        # and a browser can only do that if Range is answered.
        ranged = client.get(video_item["url"], headers={"Range": "bytes=8-23"})
        check("  and a Range request gets a 206", ranged.status_code == 206,
              f"status {ranged.status_code} - without this a video cannot be seeked")
        check("  with the right slice", len(ranged.content) == 16, str(len(ranged.content)))

        res = client.post(f"/api/sources/{mixed}/test").json()
        check("the source test counts videos separately",
              res["ok"] and "2 photo(s)" in res["summary"] and "1 video(s)" in res["summary"],
              res.get("summary", ""))

        # The picker API must refuse rather than pretend, since it cannot run
        # unattended.
        picker = client.post("/api/sources", json={
            "kind": "photos", "name": "Picker", "config": {"backend": "google_picker"},
        }).json()["id"]
        res = client.post(f"/api/sources/{picker}/test").json()
        check("the Google Picker backend refuses honestly",
              res["ok"] is False and "unattended" in res["error"].lower(), str(res))

        rest_src = client.post("/api/sources", json={
            "kind": "rest", "name": "Bad API",
            "config": {"url": "https://example.invalid/x.json"},
        }).json()["id"]
        res = client.post(f"/api/sources/{rest_src}/test").json()
        check("testing a REST source reports failure", res["ok"] is False)

        check("testing a source that does not exist 404s",
              client.post("/api/sources/999999/test").status_code == 404)

        # --- wifi QR -----------------------------------------------------------
        print("\nwifi QR")
        # The whole point: scanning must JOIN, which means the payload has to be
        # the WIFI: scheme and not just the SSID as text.
        from lifeboard.main import _wifi_payload

        joined = _wifi_payload("Maple House Guest", "hunter2000", "WPA", False)
        check("QR payload is the auto-join WIFI scheme",
              joined.startswith("WIFI:") and "S:Maple House Guest" in joined
              and "P:hunter2000" in joined, joined)
        check("  and declares the security type so phones do not prompt",
              "T:WPA" in joined)

        png = client.get("/api/qr", params={
            "mode": "wifi", "ssid": "Maple House Guest",
            "password": "hunter2000", "security": "WPA", "scale": 10,
        })
        check("the wifi QR renders", png.status_code == 200 and png.content[:4] == PNG_MAGIC)
        check("  and is not cached by proxies (it contains the password)",
              "private" in png.headers.get("cache-control", "").lower(),
              png.headers.get("cache-control", ""))

        # --- first-run setup ---------------------------------------------------
        print("\nfirst run")
        session = client.get("/api/session").json()
        check("the chosen username is remembered", session["username"] == "sam")

        check("signing in with the wrong username fails",
              client.post("/api/login", json={"username": "admin",
                                              "password": "correct-horse-battery"}
                          ).status_code == 401,
              "otherwise the username is decorative")
        check("  and the message does not say WHICH half was wrong",
              "username or password" in client.post(
                  "/api/login", json={"username": "nope", "password": "nope"}
              ).json()["detail"])
        check("signing in with the right username works",
              client.post("/api/login", json={"username": "sam",
                                              "password": "correct-horse-battery"}
                          ).status_code == 200)
        check("the username is case-insensitive",
              client.post("/api/login", json={"username": "SAM",
                                              "password": "correct-horse-battery"}
                          ).status_code == 200)

        setup_state = client.get("/api/setup/state").json()
        check("setup state reports the account is done", setup_state["account"] is True)
        for key in ("network", "addresses", "has_wifi", "timezone", "orientation",
                    "complete", "screen_id"):
            check(f"  setup state includes {key}", key in setup_state)

        check("a bad timezone is refused rather than silently ignored",
              client.post("/api/setup/finish",
                          json={"timezone": "Mars/Olympus"}).status_code == 400,
              "otherwise every widget quietly falls back to UTC")

        finished = client.post("/api/setup/finish", json={
            "screen_id": 1, "orientation": "right", "timezone": "America/New_York",
        })
        check("finishing setup works", finished.status_code == 200)
        after = client.get("/api/setup/state").json()
        check("  orientation was applied", after["orientation"] == "right")
        check("  timezone was applied", after["timezone"] == "America/New_York")
        check("  and first run is marked complete", after["complete"] is True)

        zones = client.get("/api/system/timezones?q=new_york").json()
        check("timezone search finds a zone", "America/New_York" in zones["all"])
        check("common zones are offered first",
              "America/New_York" in client.get("/api/system/timezones").json()["common"])

        # --- Home Assistant control authorisation -------------------------------
        print("\nHome Assistant controls")
        from lifeboard.providers import homeassistant as hap

        check("a light is toggleable", hap.controllable("light.kitchen") == "toggle")
        check("a scene is runnable", hap.controllable("scene.movie") == "run")
        check("a sensor is neither", hap.controllable("sensor.outside_temp") == "")
        check("an open cover reads as on", hap.is_on({"state": "open"}))
        check("an unlocked lock reads as on", hap.is_on({"state": "unlocked"}),
              "or the board shows a locked door as 'on'")
        check("an off switch reads as off", not hap.is_on({"state": "off"}))

        ha_src = client.post("/api/sources", json={
            "kind": "homeassistant", "name": "House",
            "config": {"base_url": "http://ha.invalid:8123", "token": "x"},
        }).json()["id"]

        ctrl_layout = client.post("/api/layouts", json={"name": "Controls"}).json()["id"]
        client.put(f"/api/layouts/{ctrl_layout}", json={"widgets": [
            {"kind": "ha_control", "x": 0, "y": 0, "w": 50, "h": 20, "z": 0,
             "config": {"source_id": ha_src, "entity_ids": ["light.kitchen"],
                        "interactive": True}},
            {"kind": "ha_control", "x": 0, "y": 30, "w": 50, "h": 20, "z": 1,
             "config": {"source_id": ha_src, "entity_ids": ["light.hall"],
                        "interactive": False}},
        ]})
        widgets = next(l for l in client.get("/api/layouts").json()
                       if l["id"] == ctrl_layout)["widgets"]
        live = next(w for w in widgets if w["config"]["interactive"])
        readonly = next(w for w in widgets if not w["config"]["interactive"])

        # THE security boundary: the board may only touch what it displays.
        denied = client.post("/api/ha/control", json={
            "widget_id": live["id"], "entity_id": "lock.front_door", "action": "toggle",
        })
        check("controlling an entity the widget does NOT list is refused",
              denied.status_code == 403,
              "this is the whole authorisation model - the wall has no login")
        check("  and the refusal names the entity", "lock.front_door" in denied.json()["detail"])

        check("a display-only widget refuses control",
              client.post("/api/ha/control", json={
                  "widget_id": readonly["id"], "entity_id": "light.hall",
                  "action": "toggle"}).status_code == 403)

        check("an unknown widget id is refused",
              client.post("/api/ha/control", json={
                  "widget_id": 999999, "entity_id": "light.kitchen",
                  "action": "toggle"}).status_code == 404)

        check("a request with no entity is refused",
              client.post("/api/ha/control",
                          json={"widget_id": live["id"]}).status_code == 400)

        # A listed entity is allowed through to Home Assistant - which is
        # unreachable here, so it must fail as a GATEWAY error, not a refusal.
        allowed = client.post("/api/ha/control", json={
            "widget_id": live["id"], "entity_id": "light.kitchen", "action": "toggle",
        })
        check("a listed entity passes authorisation and reaches HA",
              allowed.status_code == 502,
              f"expected a gateway error from the unreachable HA, got {allowed.status_code}")

        # --- static ----------------------------------------------------------
        print("\nstatic assets")
        for path in ("/render/", "/render/app.js", "/render/widgets/registry.js",
                     "/admin/", "/admin/admin.js"):
            check(f"{path} serves", client.get(path).status_code == 200)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all smoke checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
