# -*- coding: utf-8 -*-
"""Wi-Fi setup from the setup hotspot, against a fake nmcli.

    python tools/test_wifi_setup.py

Covers:
  * the setup hotspot is created OPEN (no `wifi hotspot` shortcut, which
    always sets a random WPA password nobody is shown);
  * the network list survives the hotspot: scanned before it goes up, served
    from the cache while it is up;
  * a failed join is recorded, the stale profile removed, and the hotspot put
    back so the board is not stranded;
  * captive portal: requests for foreign hosts are redirected to the setup
    page only while the hotspot is up, never for the board's own address.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

TMP = Path(tempfile.mkdtemp(prefix="lifeboard-wifi-"))
os.environ["LIFEBOARD_DB"] = str(TMP / "test.db")
os.environ["LIFEBOARD_WEB"] = str(ROOT / "web")
os.environ["LIFEBOARD_TEMPLATES"] = str(ROOT / "templates")
os.environ["LIFEBOARD_WIFI_SCAN"] = str(TMP / "wifi-scan.txt")
os.environ["LIFEBOARD_WIFI_LAST"] = str(TMP / "wifi-last.json")
os.environ.pop("LIFEBOARD_NETWORK", None)

from fastapi.testclient import TestClient  # noqa: E402

from lifeboard import main  # noqa: E402
from lifeboard.system import network  # noqa: E402

FAILURES: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if condition else 'FAIL'} {label}" + ("" if condition else f"  {detail}"))
    if not condition:
        FAILURES.append(label)


class FakeNM:
    """Just enough nmcli to drive network.py."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self.hotspot = False
        self.visible = "Home Net:80:WPA2:\nCoffee Shop:40::\nHome Net:55:WPA2:\n"
        self.join_ok = True

    def __call__(self, args: list[str], timeout: float = 45.0):
        self.calls.append(list(args))
        if args[:4] == ["-t", "-f", "NAME", "connection"]:
            return 0, network.HOTSPOT_NAME if self.hotspot else "Home Net"
        if args[:4] == ["-t", "-f", "DEVICE,TYPE", "device"]:
            return 0, "wlan0:wifi\neth0:ethernet"
        if args[:3] == ["device", "wifi", "rescan"]:
            return (1, "Scanning not allowed while in AP mode") if self.hotspot else (0, "")
        if args[-3:] == ["device", "wifi", "list"]:
            return 0, ("LifeBoard-Setup:100:--:*\n" if self.hotspot else self.visible)
        if args[:2] == ["connection", "up"] and args[2] == network.HOTSPOT_NAME:
            self.hotspot = True
            return 0, "activated"
        if args[:2] == ["connection", "down"]:
            self.hotspot = False
            return 0, ""
        if args[:3] == ["device", "wifi", "connect"]:
            return (0, "Device 'wlan0' successfully activated") if self.join_ok else \
                (4, "Error: Connection activation failed: Secrets were required, but not provided.")
        return 0, ""


network.available = lambda: True
fake = FakeNM()
network._run = fake

print("Setup hotspot")
fake.calls.clear()
result = network.start_hotspot()
flat = [" ".join(c) for c in fake.calls]
check("comes up", result.get("ok") and fake.hotspot, str(result))
check("never uses the `wifi hotspot` shortcut (random WPA password)",
      not any("wifi hotspot" in c for c in flat), str(flat))
add = next((c for c in fake.calls if c[:2] == ["connection", "add"]), [])
check("is an access-point profile", "802-11-wireless.mode" in add and "ap" in add, str(add))
check("has no security section, so it is open",
      not any(a.startswith("802-11-wireless-security") or a in ("password", "wifi-sec.key-mgmt") for a in add),
      str(add))
check("scanned before going up", Path(os.environ["LIFEBOARD_WIFI_SCAN"]).exists())

print("Network list while the hotspot is up")
data = network.scan()
names = [n["ssid"] for n in data["networks"]]
check("comes from the pre-hotspot scan", data.get("cached") is True, str(data))
check("one entry per network, strongest first", names == ["Home Net", "Coffee Shop"], str(names))
check("the board's own hotspot is not offered", "LifeBoard-Setup" not in names, str(names))
check("Home Net keeps its strongest signal", data["networks"][0]["signal"] == 80)

print("A failed join")
fake.join_ok = False
fake.calls.clear()
out = network.connect("Home Net", "wrong-password")
check("reports a readable error", out == {"ok": False, "error": "Wrong Wi-Fi password."}, str(out))
check("puts the hotspot back", fake.hotspot)
check("removes the profile with the bad password",
      sum(c[:3] == ["connection", "delete", "Home Net"] for c in fake.calls) >= 2, str(fake.calls))
attempt = network.last_attempt() or {}
check("is recorded for the setup page and the TV",
      attempt.get("ssid") == "Home Net" and attempt.get("ok") is False, str(attempt))

print("A good join")
fake.join_ok = True
out = network.connect("Home Net", "right-password")
check("succeeds and drops the hotspot", out.get("ok") and not fake.hotspot, str(out))
check("is recorded as a success", (network.last_attempt() or {}).get("ok") is True)

print("Captive portal")
client = TestClient(main.app, follow_redirects=False)
fake.hotspot = True
main._captive["t"] = 0.0
r = client.get("/generate_204", headers={"host": "connectivitycheck.gstatic.com"})
check("Android's check is sent to the setup page",
      r.status_code == 302 and r.headers.get("location") == main.SETUP_URL, f"{r.status_code} {r.headers}")
r = client.get("/hotspot-detect.html", headers={"host": "captive.apple.com"})
check("Apple's check is sent to the setup page", r.status_code == 302)
r = client.get("/api/system/network", headers={"host": "10.42.0.1:8080"})
check("the board's own address is never redirected", r.status_code == 200, str(r.status_code))
r = client.get("/api/system/network", headers={"host": "lifeboard.local:8080"})
check("nor its .local name", r.status_code == 200, str(r.status_code))
fake.hotspot = False
main._captive["t"] = 0.0
r = client.get("/api/system/network", headers={"host": "board.example.com"})
check("with the hotspot down, other names pass through", r.status_code == 200, str(r.status_code))

print()
if FAILURES:
    print(f"{len(FAILURES)} failure(s)")
    sys.exit(1)
print("wifi setup: open hotspot, cached list, recorded failures and captive portal all behave")
