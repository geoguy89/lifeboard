# -*- coding: utf-8 -*-
"""What the TV shows before the board is a board.

    python tools/test_onboarding.py

Three things have to be true before a layout is worth displaying: the box is
on a network, it has an admin password, and this screen has been given
something to show. Miss any one and the screen has to explain itself, because
a wall-mounted TV with no keyboard cannot be interrogated - from the kitchen,
a board nobody has configured and a board that is dead look identical.

The third condition is the one that was missing. Network and password both
done satisfied the old check, so a brand new board went from "join this Wi-Fi"
straight to black at exactly the moment the user needed telling where to go
next.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

from lifeboard.system.onboarding import decide  # noqa: E402

failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        return
    failures.append(f"{name}{f' - {detail}' if detail else ''}")


def net(online=True, hotspot=False, addresses=("192.168.1.50",)):
    """What network.status() hands over. nmcli is not on this machine, and
    would not be honest about a Pi's radio if it were."""
    return {"ok": True, "online": online, "hotspot_active": hotspot,
            "addresses": list(addresses), "has_wifi": True}


def screen(active_layout_id=None, loop_enabled=0, loop_items="[]", name="Wall"):
    return {"name": name, "active_layout_id": active_layout_id,
            "loop_enabled": loop_enabled, "loop_items": loop_items}


# ---------------------------------------------------------------------------
#  All three, or the screen explains itself
# ---------------------------------------------------------------------------
out = decide(net(), needs_password=False, screen=screen(active_layout_id=1))
check("online + password + layout shows the board itself", out is None, str(out))

out = decide(net(), needs_password=False, screen=screen(active_layout_id=None))
check("no layout keeps the setup screen up", out is not None)
check("and says that is what is missing", bool(out and out["needs_layout"]))
check("without claiming the password is missing",
      bool(out and not out["needs_password"]))
check("and hands over the address to type in",
      bool(out and out["addresses"] == ["192.168.1.50"]), str(out))
check("named, so it can say which screen is waiting",
      bool(out and out["screen_name"] == "Wall"))

# ---------------------------------------------------------------------------
#  A rotation counts as configured; an empty or broken one does not
# ---------------------------------------------------------------------------
out = decide(net(), False,
             screen(loop_enabled=1, loop_items='[{"layout_id":2,"seconds":30}]'))
check("a screen on a loop counts as configured", out is None, str(out))

out = decide(net(), False, screen(loop_enabled=1, loop_items='[]'))
check("but an EMPTY loop does not", out is not None)

out = decide(net(), False, screen(loop_enabled=1, loop_items='not json'))
check("and neither does a corrupt one", out is not None)

# A loop that is switched OFF is not a configured screen either, however many
# layouts are sitting in it.
out = decide(net(), False,
             screen(loop_enabled=0, loop_items='[{"layout_id":2,"seconds":30}]'))
check("a loop that is turned off does not count", out is not None, str(out))

# ---------------------------------------------------------------------------
#  Each condition on its own holds the setup screen up
# ---------------------------------------------------------------------------
out = decide(net(), needs_password=True, screen=screen(active_layout_id=1))
check("no password keeps the setup screen up even with a layout", out is not None)
check("and says so", bool(out and out["needs_password"]))

out = decide(net(online=False, hotspot=True, addresses=("10.42.0.1",)),
             needs_password=False, screen=screen(active_layout_id=1))
check("offline keeps the setup screen up even with a layout", out is not None)
check("and reports that the hotspot is up", bool(out and out["hotspot_active"]))
check("and carries the hotspot's own address",
      bool(out and out["addresses"] == ["10.42.0.1"]))

out = decide(net(online=False, hotspot=False, addresses=()),
             needs_password=True, screen=None)
check("nothing configured at all is still one coherent answer", out is not None)
check("and does not pretend the hotspot is up",
      bool(out and not out["hotspot_active"]))
check("and does not invent an address",
      bool(out and out["addresses"] == []))

# ---------------------------------------------------------------------------
#  Degrading safely
# ---------------------------------------------------------------------------
# When nmcli is missing or falls over, main.py hands over this shape. The
# wrong answer would be to decide everything is fine and show an empty board.
broken = {"ok": False, "online": False, "hotspot_active": False, "addresses": []}
out = decide(broken, needs_password=False, screen=screen(active_layout_id=1))
check("an unusable nmcli shows setup rather than a black screen",
      out is not None and out["online"] is False, str(out))

out = decide(net(), needs_password=False, screen=None)
check("with no screen row at all it asks for a layout rather than crashing",
      out is not None and out["needs_layout"] is True, str(out))

# Nothing here should ever raise: this runs on every /api/board poll, and an
# exception would take the board down rather than the setup screen.
for bad in ({}, {"online": None}, {"addresses": None},
            {"online": True, "addresses": "not a list"}):
    try:
        decide(bad, False, screen(active_layout_id=1))
        check(f"a malformed status {bad} is survivable", True)
    except Exception as exc:  # noqa: BLE001
        check(f"a malformed status {bad} is survivable", False, repr(exc))

if failures:
    print()
    for f in failures:
        print(f"  FAIL  {f}")
    print(f"\n{len(failures)} problem(s)")
    sys.exit(1)
print("onboarding: the screen explains itself until it has a network, a "
      "password AND a layout")
