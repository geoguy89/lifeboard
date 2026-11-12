"""Whether the screen shows the board, or explains itself.

Split out of main.py because it is pure logic with three inputs and no web
framework anywhere in it - which means it can be tested directly, and this is
a decision worth testing. It decides what a wall-mounted TV with no keyboard
displays, and the failure mode is a black screen: from across the room a board
that has not been configured and a board that is broken look exactly alike.

Three conditions, all required:

  * a network, or nobody can reach the admin page to configure anything;
  * an admin password, or the box is open to whoever finds it;
  * a layout on THIS screen, or there is nothing to draw.

The third was missing. Network and password satisfied the old check, so a new
board went from "join this Wi-Fi" straight to black at the exact moment the
user needed telling where to go next.
"""

from __future__ import annotations

import json


def decide(net: dict, needs_password: bool, screen: dict | None) -> dict | None:
    """None when the board is ready. Otherwise what the screen should say."""
    online = bool(net.get("online"))

    # A screen on a rotation has plenty to show without a single active
    # layout, so both count as configured.
    needs_layout = True
    if screen:
        if screen.get("active_layout_id"):
            needs_layout = False
        elif screen.get("loop_enabled"):
            try:
                needs_layout = not json.loads(screen.get("loop_items") or "[]")
            except (TypeError, ValueError):
                # A corrupt loop is not a configured screen. Better to ask for
                # a layout than to draw nothing and say nothing.
                needs_layout = True

    if online and not needs_password and not needs_layout:
        return None

    return {
        "online": online,
        "needs_password": needs_password,
        "needs_layout": needs_layout,
        "hotspot_active": bool(net.get("hotspot_active")),
        "addresses": list(net.get("addresses") or []),
        "has_wifi": bool(net.get("has_wifi")),
        "screen_name": (screen or {}).get("name", ""),
    }
