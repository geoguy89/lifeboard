"""Wi-Fi and network configuration, driven entirely from the web UI.

THE CHICKEN AND EGG
-------------------
The appliance has no keyboard and no local login, so there is no way to type a
Wi-Fi password into it. But you cannot reach its web UI until it is on the
network. Something has to break the loop.

The answer is a **setup hotspot**. On first boot, if there is no connection
after a grace period, the device brings up its own open access point called
``LifeBoard-Setup``. The screen shows that name and a QR code that joins it. You
connect a phone, the phone opens the setup page by itself (the hotspot answers
every DNS name with its own address, and port 80 is forwarded to the server),
you pick your network from the list and type the password, and the device
switches over and drops the hotspot.

This is the same dance a smart plug does, and it is the only approach that
works when the device genuinely has no input hardware.

Everything here shells out to ``nmcli``. NetworkManager is the only thing on a
minimal Debian that handles WPA2/WPA3, hidden SSIDs, hotspot mode and Ethernet
failover without hand-writing supplicant config.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import socket
import subprocess
import time

log = logging.getLogger("lifeboard.network")

HOTSPOT_NAME = "lifeboard-setup"
HOTSPOT_SSID = "LifeBoard-Setup"

# nmcli -t escapes colons inside fields with a backslash. Splitting naively on
# ':' mangles any SSID containing one, which is rare but produces a network you
# can see and cannot ever join.
_FIELD = re.compile(r"(?<!\\):")


def _split(line: str) -> list[str]:
    return [f.replace("\\:", ":").replace("\\\\", "\\") for f in _FIELD.split(line)]


# WHEN SOMETHING ELSE OWNS THE NETWORK
# ------------------------------------
# On Android - and on any box where the interfaces are somebody else's job -
# there is no nmcli, nothing for the setup hotspot to do, and no way to raise
# one anyway. Left alone, `status()` would report offline, `_onboarding` would
# hold the board on the "join LifeBoard-Setup" screen forever, and the wall
# would never show a layout on a device that was on the network the whole time.
#
# So the platform says so once, at startup, and this module stops guessing.
def managed_elsewhere() -> bool:
    return os.environ.get("LIFEBOARD_NETWORK", "").strip().lower() == "managed"


def available() -> bool:
    return bool(shutil.which("nmcli"))


def _own_address() -> str:
    """This machine's address on the LAN, without asking nmcli.

    Opening a UDP socket towards a public address and reading back the local
    end is the portable way to find which interface would be used. Nothing is
    sent and nothing has to be reachable - the kernel picks the route, which is
    the part being asked about.

    It matters because the setup screen prints this address for somebody to
    type into a laptop. On a device managing its own network there is no nmcli
    to ask, and printing 127.0.0.1 would be worse than printing nothing.
    """
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.settimeout(0.5)
        probe.connect(("192.0.2.1", 9))   # TEST-NET-1: reserved, never routed
        return probe.getsockname()[0]
    except Exception:  # noqa: BLE001 - no route, no address to report
        return ""
    finally:
        probe.close()


def _run(args: list[str], timeout: float = 45.0) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            ["nmcli", *args], capture_output=True, text=True, timeout=timeout
        )
        return proc.returncode, ((proc.stdout or "") + (proc.stderr or "")).strip()
    except FileNotFoundError:
        return 127, "nmcli is not installed"
    except subprocess.TimeoutExpired:
        return 124, "nmcli timed out"
    except Exception as exc:  # noqa: BLE001
        return 1, f"{type(exc).__name__}: {exc}"


def status() -> dict:
    """Enough for the setup UI to say what is going on."""
    if managed_elsewhere():
        # Deliberately says online without probing. The alternative - pinging
        # something to check - would make the board's first paint wait on a
        # timeout every time the wifi happens to be slow, to answer a question
        # this platform does not actually need answered.
        address = _own_address()
        return {
            "ok": True,
            "online": True,
            "hotspot_active": False,
            "devices": [],
            "addresses": [address] if address else [],
            "has_wifi": False,      # nothing here can raise an access point
            "managed": True,
        }
    if not available():
        return {"ok": False, "error": "NetworkManager (nmcli) is not installed"}

    code, out = _run(["-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status"], 20)
    devices = []
    if code == 0:
        for line in out.splitlines():
            parts = _split(line)
            if len(parts) >= 4:
                devices.append({
                    "device": parts[0], "type": parts[1],
                    "state": parts[2], "connection": parts[3],
                })

    addresses: list[str] = []
    code, out = _run(["-t", "-f", "IP4.ADDRESS", "device", "show"], 20)
    if code == 0:
        for line in out.splitlines():
            if ":" in line:
                value = line.split(":", 1)[1].strip()
                if value and value != "--":
                    addresses.append(value.split("/")[0])

    online = any(
        d["state"].startswith("connected") and d["type"] in ("wifi", "ethernet")
        and d["connection"] not in ("--", HOTSPOT_NAME)
        for d in devices
    )

    return {
        "ok": True,
        "online": online,
        "hotspot_active": any(d["connection"] == HOTSPOT_NAME for d in devices),
        "devices": devices,
        "addresses": addresses,
        "has_wifi": any(d["type"] == "wifi" for d in devices),
    }


# Networks seen just before the setup hotspot went up. A Pi's radio cannot
# scan while it is an access point, so without this the setup page - the one
# place a list is needed - would always say "no networks found". Written by
# firstboot.sh and by start_hotspot(); same format as `nmcli -t` output.
SCAN_CACHE = os.environ.get("LIFEBOARD_WIFI_SCAN", "/var/lib/lifeboard/wifi-scan.txt")
LAST_ATTEMPT = os.environ.get("LIFEBOARD_WIFI_LAST", "/var/lib/lifeboard/wifi-last.json")
_LIST = ["-t", "-f", "SSID,SIGNAL,SECURITY,IN-USE", "device", "wifi", "list"]


def _parse_list(out: str) -> list[dict]:
    best: dict[str, dict] = {}
    for line in out.splitlines():
        parts = _split(line)
        if len(parts) < 3:
            continue
        ssid = parts[0].strip()
        if not ssid or ssid == "--" or ssid == HOTSPOT_SSID:
            continue          # hidden network (joined by name), or our own AP
        try:
            signal = int(parts[1] or 0)
        except ValueError:
            signal = 0
        entry = {
            "ssid": ssid,
            "signal": signal,
            "security": parts[2].strip() or "open",
            "in_use": len(parts) > 3 and parts[3].strip() == "*",
        }
        # A network shows up once per band and per AP; keep the strongest.
        if ssid not in best or signal > best[ssid]["signal"]:
            best[ssid] = entry
    return sorted(best.values(), key=lambda n: -n["signal"])


def _save_scan(out: str) -> None:
    try:
        tmp = SCAN_CACHE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(out)
        os.replace(tmp, SCAN_CACHE)
    except OSError as exc:
        log.debug("could not cache the wifi scan: %s", exc)


def _cached_scan() -> tuple[list[dict], float | None]:
    try:
        with open(SCAN_CACHE, encoding="utf-8") as fh:
            return _parse_list(fh.read()), os.path.getmtime(SCAN_CACHE)
    except OSError:
        return [], None


def hotspot_active() -> bool:
    if not available():
        return False
    code, out = _run(["-t", "-f", "NAME", "connection", "show", "--active"], 10)
    return code == 0 and HOTSPOT_NAME in out.splitlines()


def scan(rescan: bool = True) -> dict:
    """Visible networks, strongest first, one entry per SSID.

    While the setup hotspot is up the radio usually cannot scan, so the list
    from just before it went up is returned instead, marked `cached`.
    """
    if not available():
        return {"ok": False, "error": "nmcli is not installed", "networks": []}

    on_hotspot = hotspot_active()
    if rescan and not on_hotspot:
        _run(["device", "wifi", "rescan"], 30)
        time.sleep(2)      # nmcli returns before the scan results land

    code, out = _run(_LIST, 30)
    live = _parse_list(out) if code == 0 else []
    if live and not on_hotspot:
        _save_scan(out)
        return {"ok": True, "networks": live, "cached": False}

    cached, when = _cached_scan()
    if cached:
        return {"ok": True, "networks": cached, "cached": True,
                "scanned_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(when))}
    if code != 0:
        return {"ok": False, "error": out, "networks": []}
    return {"ok": True, "networks": live, "cached": False}


def last_attempt() -> dict | None:
    """The most recent join attempt made from the setup page, if any."""
    try:
        with open(LAST_ATTEMPT, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _record_attempt(ssid: str, ok: bool, error: str = "") -> None:
    try:
        with open(LAST_ATTEMPT, "w", encoding="utf-8") as fh:
            json.dump({"ssid": ssid, "ok": ok, "error": error,
                       "at": time.strftime("%Y-%m-%dT%H:%M:%S")}, fh)
    except OSError as exc:
        log.debug("could not record the wifi attempt: %s", exc)


def connect(ssid: str, password: str = "", hidden: bool = False) -> dict:
    """Join a network. Drops the setup hotspot first if it is up.

    Returns before confirming a lease on purpose: the client that called this
    is very likely connected *through the hotspot* being torn down, so it will
    lose the reply either way. The outcome is recorded (last_attempt) so the
    TV and the setup page can show it once the phone is back on the hotspot.
    """
    if not available():
        return {"ok": False, "error": "nmcli is not installed"}
    if not ssid:
        return {"ok": False, "error": "no network name given"}

    stop_hotspot()
    # A stale profile with an old password would be reused instead of the one
    # just typed.
    _run(["connection", "delete", ssid], 20)

    args = ["device", "wifi", "connect", ssid]
    if password:
        args += ["password", password]
    if hidden:
        args += ["hidden", "yes"]

    code, out = _run(args, 90)
    if code != 0:
        # Rescue: if joining failed the box may now have no network at all and
        # no way to be reached. Put the hotspot back so it is not stranded.
        log.warning("wifi connect failed: %s", out)
        _run(["connection", "delete", ssid], 20)
        error = _friendly(out)
        _record_attempt(ssid, False, error)
        start_hotspot(rescan=False)
        return {"ok": False, "error": error}

    _record_attempt(ssid, True)
    return {"ok": True, "message": out}


def forget(ssid: str) -> dict:
    code, out = _run(["connection", "delete", ssid], 30)
    return {"ok": code == 0, "message": out}


def _wifi_device() -> str:
    code, out = _run(["-t", "-f", "DEVICE,TYPE", "device", "status"], 20)
    for line in out.splitlines() if code == 0 else []:
        parts = _split(line)
        if len(parts) >= 2 and parts[1] == "wifi":
            return parts[0]
    return ""


def start_hotspot(rescan: bool = True) -> dict:
    """Bring up the OPEN setup access point.

    Built with `connection add` rather than `nmcli device wifi hotspot`: that
    shortcut always generates a WPA password, so a "hotspot with no password"
    is in fact protected by a random one nobody is shown - and the setup
    screen's join-without-password QR code cannot work.

    Open, not WPA, on purpose: the point is that somebody with no credentials
    can reach the setup page. It carries nothing but the setup form, is only
    up when the device has no network, and disappears the moment it joins one.
    """
    if not available():
        return {"ok": False, "error": "nmcli is not installed"}
    device = _wifi_device()
    if not device:
        return {"ok": False, "error": "no Wi-Fi adapter"}

    if rescan:
        # Last chance to see the neighbourhood before the radio becomes an AP.
        _run(["device", "wifi", "rescan"], 30)
        time.sleep(2)
        code, out = _run(_LIST, 30)
        if code == 0 and _parse_list(out):
            _save_scan(out)

    _run(["connection", "delete", HOTSPOT_NAME], 20)
    code, out = _run([
        "connection", "add", "type", "wifi", "ifname", device,
        "con-name", HOTSPOT_NAME, "autoconnect", "no", "ssid", HOTSPOT_SSID,
        "802-11-wireless.mode", "ap", "802-11-wireless.band", "bg",
        "ipv4.method", "shared", "ipv6.method", "disabled",
    ], 30)
    if code != 0:
        return {"ok": False, "error": out}
    code, out = _run(["connection", "up", HOTSPOT_NAME], 60)
    if code != 0:
        return {"ok": False, "error": out}
    return {"ok": True, "ssid": HOTSPOT_SSID}


def stop_hotspot() -> dict:
    code, out = _run(["connection", "down", HOTSPOT_NAME], 30)
    _run(["connection", "delete", HOTSPOT_NAME], 30)
    return {"ok": code == 0, "message": out}


def _friendly(message: str) -> str:
    low = message.lower()
    if "secrets were required" in low or "invalid" in low and "password" in low:
        return "Wrong Wi-Fi password."
    if "no network with ssid" in low:
        return "That network was not found. If it is hidden, tick 'hidden network'."
    if "timeout" in low:
        return "Timed out joining. Check the password and that the network is in range."
    return message.split("\n")[0][:200] or "Could not connect."
