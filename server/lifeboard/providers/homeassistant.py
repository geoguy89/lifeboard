"""Home Assistant.

Talks to HA's REST API with a long-lived access token. Everything goes through
the server, never the browser, for two reasons: the token is a full-privilege
credential that must not sit in a kiosk's page source, and HA's CORS setup
would otherwise have to be widened to allow the board's origin.

WHY THIS ALSO SOLVES LIFE360
----------------------------
Don't integrate Life360 directly. Home Assistant already has a Life360
integration, and once it is set up there, each member arrives as a normal
``device_tracker.*`` entity (plus a ``person.*`` that combines their sources)
carrying latitude, longitude, battery and the zone they are in. Pulling those
through HA means one credential, one integration to maintain, and it works
identically for Life360, iCloud, the HA companion app, or anything else HA can
track. If Life360 changes their API, that becomes HA's problem, not ours.

A long-lived token is created in HA under Profile -> Security -> Long-lived
access tokens.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

import time

import httpx

from .base import CACHE, FetchResult

# Attributes worth surfacing on a dashboard, in the order a person would read
# them. HA entities carry a lot of noise; showing everything is unreadable.
INTERESTING = (
    "friendly_name", "unit_of_measurement", "device_class", "icon",
    "latitude", "longitude", "gps_accuracy", "battery_level", "source_type",
    # A person's `source` is the device_tracker entity behind them, which is
    # the only link to their phone's battery and charging sensors.
    "source", "battery_state", "is_charging",
    "current_temperature", "temperature", "humidity", "media_title",
    "media_artist", "entity_picture",
    # Needed to render a control rather than just a reading: a light's
    # brightness, a thermostat's setpoint and range, what the HVAC is
    # currently doing.
    "brightness", "hvac_action", "hvac_modes", "min_temp", "max_temp",
    "target_temp_high", "target_temp_low", "supported_features",
)


def _client(config: dict) -> httpx.Client:
    base = (config.get("base_url") or "").rstrip("/")
    token = config.get("token") or ""
    if not base or not token:
        raise ValueError("Home Assistant needs base_url and token")
    return httpx.Client(
        base_url=base,
        timeout=float(config.get("timeout", 15)),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        # A self-signed cert on a LAN HA install is extremely common. Allow it
        # to be opted into explicitly rather than silently disabling verify.
        verify=not config.get("insecure", False),
    )


def _shape(state: dict) -> dict:
    attrs = state.get("attributes", {}) or {}
    return {
        "entity_id": state.get("entity_id"),
        "state": state.get("state"),
        "last_changed": state.get("last_changed"),
        "name": attrs.get("friendly_name") or state.get("entity_id"),
        "unit": attrs.get("unit_of_measurement", ""),
        "device_class": attrs.get("device_class", ""),
        "icon": attrs.get("icon", ""),
        "attributes": {k: attrs[k] for k in INTERESTING if k in attrs},
    }


def list_entities(config: dict, ttl: float = 60.0) -> FetchResult:
    """Every entity, trimmed. Used by the admin UI's entity picker."""
    cache_key = ("ha-list", config.get("base_url"))
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached
    try:
        with _client(config) as client:
            resp = client.get("/api/states")
            resp.raise_for_status()
            states = resp.json()
        entities = sorted(
            (_shape(s) for s in states),
            key=lambda e: (e["entity_id"].split(".")[0], e["name"].lower()),
        )
        result = FetchResult(payload={"entities": entities})
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=_friendly(exc))
    return CACHE.put(cache_key, result)


def states(config: dict, entity_ids: list[str], ttl: float = 15.0) -> FetchResult:
    """Current state of specific entities.

    Fetches /api/states once and filters locally rather than making one request
    per entity: a board with a dozen entity tiles would otherwise hammer HA
    twelve times per refresh, and HA's per-entity endpoint is no cheaper.
    """
    cache_key = ("ha-states", config.get("base_url"))
    cached = CACHE.get(cache_key, ttl)
    if cached is None:
        try:
            with _client(config) as client:
                resp = client.get("/api/states")
                resp.raise_for_status()
                cached = FetchResult(payload={"all": resp.json()})
        except Exception as exc:  # noqa: BLE001
            cached = FetchResult(error=_friendly(exc))
        cached = CACHE.put(cache_key, cached)

    if cached.error:
        return cached

    wanted = set(entity_ids)
    found = {
        s["entity_id"]: _shape(s)
        for s in cached.payload["all"]
        if s.get("entity_id") in wanted
    }
    # Report entities that were asked for but do not exist, rather than
    # silently rendering a gap - a renamed entity is the most common way one of
    # these tiles goes quietly blank.
    missing = sorted(wanted - set(found))
    return FetchResult(
        payload={
            "entities": [found[e] for e in entity_ids if e in found],
            "missing": missing,
        }
    )


def trackers(
    config: dict,
    entity_ids: list[str] | None = None,
    ttl: float = 30.0,
    resolve_town: bool = True,
) -> FetchResult:
    """People and device trackers, with location where HA exposes it.

    With no explicit list, returns every ``person.*`` entity - which is what
    the Life360 / companion-app setup produces and almost always what you want
    on a family board.
    """
    result = list_entities(config, ttl=ttl)
    if result.error:
        return result

    entities = result.payload["entities"]
    if entity_ids:
        chosen = [e for e in entities if e["entity_id"] in set(entity_ids)]
    else:
        chosen = [e for e in entities if e["entity_id"].startswith("person.")]

    by_id = {e["entity_id"]: e for e in entities}

    # Per-person entity overrides, so a sensor that does not follow the
    # companion app's naming can still be named outright:
    #   {"person.alex_morgan": {"battery": "sensor.x", "phone": "sensor.y"}}
    overrides = config.get("person_entities") or {}

    people = []
    for entity in chosen:
        attrs = entity["attributes"]
        phone = _phone_for(attrs.get("source", ""), by_id)

        named = overrides.get(entity["entity_id"]) or {}
        if named.get("battery") and named["battery"] in by_id:
            value = _as_int(by_id[named["battery"]].get("state"))
            if value is not None:
                phone["battery"] = value

        phone_entity = named.get("phone") or (
            f"sensor.{phone.get('device')}_phone_state" if phone.get("device") else "")
        if phone_entity and phone_entity in by_id:
            phone["phone_state"] = _phone_state(by_id[phone_entity].get("state"))
        people.append(
            {
                "entity_id": entity["entity_id"],
                "name": entity["name"],
                # HA reports 'home', 'not_home', or a zone name like 'Work'.
                "zone": _zone_label(entity["state"]),
                "raw_state": entity["state"],
                "home": entity["state"] == "home",
                # Home -> named zone -> town -> Traveling. `kind` drives the
                # colour of the status dot, matching the vault's chips.
                **_locate(entity["state"], attrs, resolve_town),
                "phone_state": phone.get("phone_state", ""),
                "latitude": attrs.get("latitude"),
                "longitude": attrs.get("longitude"),
                # The person's own battery if HA has one, else the phone's.
                "battery": attrs.get("battery_level", phone.get("battery")),
                "charging": phone.get("charging"),
                "battery_state": phone.get("battery_state", ""),
                "device": phone.get("device", ""),
                "picture": attrs.get("entity_picture"),
                "source_type": attrs.get("source_type", ""),
                "last_changed": entity["last_changed"],
            }
        )
    return FetchResult(payload={"people": people})


# Town names for coordinates. Six hours, keyed on coordinates rounded to
# ~100m: a phone sitting on a kitchen counter is looked up once, not every
# thirty seconds. Nominatim is free and asks only that it not be hammered.
_TOWNS: dict[str, tuple[float, str]] = {}
_TOWN_TTL = 6 * 60 * 60


def town_for(lat: float, lon: float) -> str:
    """Reverse-geocode to a town name.

    "not_home" is accurate and useless on a wall display; "Newport" is what
    somebody actually wants to read. Failure returns "Traveling" rather than
    raising - a chip with a vaguer label still works.
    """
    key = f"{lat:.3f},{lon:.3f}"
    hit = _TOWNS.get(key)
    if hit and time.time() - hit[0] < _TOWN_TTL:
        return hit[1]

    try:
        with httpx.Client(timeout=10, headers={"User-Agent": USER_AGENT}) as client:
            resp = client.get(
                "https://nominatim.openstreetmap.org/reverse",
                params={"format": "jsonv2", "lat": lat, "lon": lon, "zoom": 10},
            )
            resp.raise_for_status()
            address = (resp.json() or {}).get("address", {}) or {}
    except Exception:  # noqa: BLE001 - a vaguer label beats an error
        return "Traveling"

    town = (address.get("town") or address.get("city") or address.get("village")
            or address.get("hamlet") or address.get("municipality") or "Traveling")
    _TOWNS[key] = (time.time(), town)
    return town


def _phone_state(raw: str) -> str:
    """HA's phone_state sensor, reduced to what a board shows."""
    value = (raw or "").strip().lower()
    if value == "offhook":
        return "call"
    if value == "ringing":
        return "ring"
    if value and value not in ("unavailable", "unknown", "idle_unknown"):
        return "idle"
    return ""


def _phone_for(tracker_id: str, by_id: dict) -> dict:
    """Battery and charging state for the device behind a person.

    The companion app names its sensors after the device -
    sensor.<device>_battery_level, sensor.<device>_battery_state - and a
    person's `source` names the tracker: device_tracker.<device>. That shared
    slug is the whole trick.

    A convention, not an API. Every step is optional and a miss simply leaves
    the field out: a chip showing a name and a zone is still worth having.
    """
    if not tracker_id or "." not in tracker_id:
        return {}

    slug = tracker_id.split(".", 1)[1]
    out: dict = {"device": slug}

    tracker = by_id.get(tracker_id)
    if tracker:
        level = (tracker.get("attributes") or {}).get("battery_level")
        if level is not None:
            out["battery"] = _as_int(level)

    level_sensor = by_id.get(f"sensor.{slug}_battery_level")
    if level_sensor is not None:
        value = _as_int(level_sensor.get("state"))
        if value is not None:
            out["battery"] = value

    state_sensor = by_id.get(f"sensor.{slug}_battery_state")
    if state_sensor is not None:
        text = str(state_sensor.get("state") or "")
        if text and text.lower() not in ("unknown", "unavailable"):
            out["battery_state"] = text
            out["charging"] = text.lower() in ("charging", "full")

    charging_sensor = by_id.get(f"binary_sensor.{slug}_is_charging")
    if charging_sensor is not None:
        out["charging"] = str(charging_sensor.get("state")).lower() == "on"

    return out


def _as_int(value) -> int | None:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _locate(state: str, attrs: dict, resolve_town: bool) -> dict:
    """Where someone is, in the words a board should use.

    The ladder matters more than any single step: a named zone beats
    coordinates, a town beats "not_home", and "Traveling" beats nothing.
    """
    lowered = (state or "").lower()
    lat, lon = attrs.get("latitude"), attrs.get("longitude")

    if lowered == "home":
        return {"location": "Home", "kind": "home"}

    if lowered and lowered not in ("not_home", "unknown", "unavailable"):
        return {"location": _pretty(state), "kind": "zone"}

    if lowered == "not_home" and lat is not None and lon is not None and resolve_town:
        return {"location": town_for(float(lat), float(lon)), "kind": "away"}

    return {"location": "Traveling", "kind": "away"}


def _pretty(text: str) -> str:
    return " ".join(word.capitalize() for word in str(text).replace("_", " ").split())


def _zone_label(state: str) -> str:
    if state == "home":
        return "Home"
    if state == "not_home":
        return "Away"
    if state in ("unknown", "unavailable", ""):
        return "Unknown"
    return state           # a named zone comes through as-is


def _friendly(exc: Exception) -> str:
    """HA's failure modes are distinctive enough to be worth naming."""
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        if code == 401:
            return "401: Home Assistant rejected the token (expired or revoked?)"
        if code == 404:
            return "404: check base_url points at Home Assistant's root, not /lovelace"
        return f"{code}: {exc.response.reason_phrase}"
    if isinstance(exc, httpx.ConnectError):
        return f"cannot reach Home Assistant: {exc}"
    return f"{type(exc).__name__}: {exc}"


# --------------------------------------------------------------------------
#  Interactive control
#
#  Displaying an entity is read-only and safe. *Changing* one is not, and the
#  wall has no session to authenticate with - so the authorisation model is
#  deliberately narrow: a board may only act on entities a widget on that board
#  was explicitly configured with. The caller passes a widget id, the server
#  looks up what that widget is allowed to touch, and anything else is refused.
#
#  That means the worst a person standing at the display can do is exactly what
#  the display already shows them a button for.
# --------------------------------------------------------------------------

# What "toggle" means per domain. Anything not listed here is not toggleable
# and the UI will not offer a switch for it.
TOGGLE_SERVICES = {
    "light": ("turn_on", "turn_off"),
    "switch": ("turn_on", "turn_off"),
    "fan": ("turn_on", "turn_off"),
    "input_boolean": ("turn_on", "turn_off"),
    "media_player": ("turn_on", "turn_off"),
    "climate": ("turn_on", "turn_off"),
    "cover": ("open_cover", "close_cover"),
    "lock": ("unlock", "lock"),
    "humidifier": ("turn_on", "turn_off"),
    "siren": ("turn_on", "turn_off"),
}

# Domains that are fire-and-forget rather than on/off.
RUN_SERVICES = {
    "scene": "turn_on",
    "script": "turn_on",
    "button": "press",
    "input_button": "press",
    "automation": "trigger",
}

# States that mean "on" for the purposes of drawing a toggle. `cover` and
# `lock` invert the usual sense, which is exactly the sort of thing that makes
# a dashboard show a locked door as "off".
ON_STATES = {"on", "open", "unlocked", "playing", "home", "heat", "cool", "heat_cool", "auto"}


def domain_of(entity_id: str) -> str:
    return (entity_id or "").split(".", 1)[0]


def is_on(entity: dict) -> bool:
    return str(entity.get("state", "")).lower() in ON_STATES


def controllable(entity_id: str) -> str:
    """'toggle' | 'run' | '' - what kind of control this entity supports."""
    domain = domain_of(entity_id)
    if domain in TOGGLE_SERVICES:
        return "toggle"
    if domain in RUN_SERVICES:
        return "run"
    return ""


def call_service(
    config: dict, domain: str, service: str,
    entity_id: str, data: dict | None = None, timeout: float = 20.0,
) -> FetchResult:
    """POST /api/services/<domain>/<service>."""
    payload = {"entity_id": entity_id, **(data or {})}
    try:
        with _client(config) as client:
            resp = client.post(f"/api/services/{domain}/{service}", json=payload)
            resp.raise_for_status()
        # HA returns the states it changed. Empty is normal for a script.
        return FetchResult(payload={"ok": True, "changed": resp.json()})
    except Exception as exc:  # noqa: BLE001
        return FetchResult(error=_friendly(exc))


def act(config: dict, entity_id: str, action: str, value=None) -> FetchResult:
    """One entry point for every kind of control the widget offers."""
    domain = domain_of(entity_id)
    kind = controllable(entity_id)

    if action in ("on", "off", "toggle"):
        if kind != "toggle":
            return FetchResult(error=f"{domain} entities cannot be switched on and off")
        on_service, off_service = TOGGLE_SERVICES[domain]
        if action == "toggle":
            # Ask HA for the current state rather than trusting what the board
            # last rendered, which may be a minute stale.
            current = states(config, [entity_id], ttl=0)
            if current.error:
                return current
            found = current.payload["entities"]
            if not found:
                return FetchResult(error=f"{entity_id} not found")
            action = "off" if is_on(found[0]) else "on"
        return call_service(config, domain, on_service if action == "on" else off_service,
                            entity_id)

    if action == "run":
        if kind != "run":
            return FetchResult(error=f"{domain} entities cannot be run")
        return call_service(config, domain, RUN_SERVICES[domain], entity_id)

    if action == "set_temperature":
        if domain != "climate":
            return FetchResult(error="only climate entities have a target temperature")
        try:
            target = float(value)
        except (TypeError, ValueError):
            return FetchResult(error="a numeric temperature is required")
        return call_service(config, "climate", "set_temperature", entity_id,
                            {"temperature": target})

    if action == "set_brightness":
        if domain != "light":
            return FetchResult(error="only lights have brightness")
        try:
            pct = max(0, min(100, int(float(value))))
        except (TypeError, ValueError):
            return FetchResult(error="brightness must be 0-100")
        if pct == 0:
            return call_service(config, "light", "turn_off", entity_id)
        return call_service(config, "light", "turn_on", entity_id,
                            {"brightness_pct": pct})

    return FetchResult(error=f"unknown action {action!r}")


# --------------------------------------------------------------------------
#  History, cameras and media players
#
#  Everything below reuses _client, so it inherits the same token, timeout and
#  self-signed-cert handling. That is the whole reason these live here rather
#  than in a module of their own.
# --------------------------------------------------------------------------

def history(
    config: dict,
    entity_id: str,
    *,
    hours: int = 24,
    points: int = 60,
    ttl: float = 300.0,
) -> FetchResult:
    """A numeric entity's recent values, downsampled for a sparkline.

    HA returns EVERY state change in the window, which for a busy sensor is
    thousands of points - far more than a 200px sparkline can show and enough
    to make a Pi 3 work for no visible benefit. So it is bucketed here, on the
    server, where the data already is.

    Non-numeric states ('unavailable', 'unknown', 'on') are dropped rather
    than coerced to zero: a gap in the line is honest, a floor of zeros is a
    lie about what the sensor read.
    """
    hours = max(1, min(int(hours), 168))
    cache_key = ("ha-history", config.get("base_url"), entity_id, hours, points)
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached

    try:
        start = datetime.now(timezone.utc) - timedelta(hours=hours)
        with _client(config) as client:
            resp = client.get(
                f"/api/history/period/{start.isoformat()}",
                params={
                    "filter_entity_id": entity_id,
                    "minimal_response": "true",
                    "no_attributes": "true",
                },
            )
            resp.raise_for_status()
            series = resp.json()

        raw = []
        for row in (series[0] if series else []):
            try:
                value = float(row.get("state"))
            except (TypeError, ValueError):
                continue          # 'unavailable', 'on', '' - not a number
            stamp = row.get("last_changed") or row.get("last_updated") or ""
            raw.append((stamp, value))

        if not raw:
            raise ValueError(f"{entity_id} has no numeric history in {hours}h")

        # Bucket into at most `points` averages, keeping the first and last
        # stamps so the widget can label the ends of the axis.
        points = max(2, min(int(points), 300))
        step = max(1, len(raw) // points)
        buckets = []
        for i in range(0, len(raw), step):
            chunk = raw[i:i + step]
            values = [v for _, v in chunk]
            buckets.append({
                "t": chunk[0][0],
                "v": round(sum(values) / len(values), 3),
                "min": round(min(values), 3),
                "max": round(max(values), 3),
            })

        values = [b["v"] for b in buckets]
        result = FetchResult(payload={
            "entity_id": entity_id,
            "points": buckets,
            "min": round(min(values), 3),
            "max": round(max(values), 3),
            "first": buckets[0]["v"],
            "last": buckets[-1]["v"],
            "hours": hours,
            "count": len(raw),
        })
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=_friendly(exc))
    return CACHE.put(cache_key, result)


def camera_image(config: dict, entity_id: str) -> tuple[bytes, str]:
    """One JPEG frame from a camera entity.

    Returned as BYTES for the server to proxy rather than a URL for the board
    to fetch, because the HA token must never reach the renderer - the wall
    page has no login and anyone on the LAN can read it.
    """
    with _client(config) as client:
        resp = client.get(f"/api/camera_proxy/{entity_id}")
        resp.raise_for_status()
        return resp.content, resp.headers.get("content-type", "image/jpeg")


# Attributes worth showing for a media player, and nothing else - a media
# player entity carries a lot of noise.
_MEDIA_KEYS = (
    "media_title", "media_artist", "media_album_name", "media_series_title",
    "media_season", "media_episode", "media_duration", "media_position",
    "app_name", "source", "volume_level", "entity_picture", "friendly_name",
)


def media_players(config: dict, entity_ids: list[str], ttl: float = 10.0) -> FetchResult:
    """Now playing, for one or more media players.

    A short TTL on purpose: a track change the board shows a minute late is
    the one case where staleness is obvious to anyone standing in the room.
    """
    cache_key = ("ha-media", config.get("base_url"), tuple(sorted(entity_ids)))
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached

    try:
        with _client(config) as client:
            resp = client.get("/api/states")
            resp.raise_for_status()
            everything = resp.json()

        wanted = set(entity_ids)
        players = []
        for state in everything:
            if state.get("entity_id") not in wanted:
                continue
            attrs = state.get("attributes", {}) or {}
            raw = state.get("state", "")
            picture = attrs.get("entity_picture") or ""
            players.append({
                "entity_id": state.get("entity_id"),
                "name": attrs.get("friendly_name") or state.get("entity_id"),
                "state": raw,
                "playing": raw == "playing",
                "idle": raw in ("off", "idle", "standby", "unavailable"),
                # Proxied through the server for the same token reason as the
                # camera; a bare HA path would 401 from the board.
                "art": f"/api/data/ha/art?entity={state.get('entity_id')}" if picture else "",
                **{k: attrs.get(k) for k in _MEDIA_KEYS if k in attrs},
            })

        missing = sorted(wanted - {p["entity_id"] for p in players})
        result = FetchResult(payload={"players": players, "missing": missing})
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=_friendly(exc))
    return CACHE.put(cache_key, result)


def entity_picture(config: dict, entity_id: str) -> tuple[bytes, str]:
    """Album art / entity picture, proxied. Same token reasoning as above."""
    with _client(config) as client:
        resp = client.get("/api/states")
        resp.raise_for_status()
        for state in resp.json():
            if state.get("entity_id") == entity_id:
                path = (state.get("attributes") or {}).get("entity_picture")
                if not path:
                    raise ValueError(f"{entity_id} has no picture")
                img = client.get(path)
                img.raise_for_status()
                return img.content, img.headers.get("content-type", "image/jpeg")
    raise ValueError(f"{entity_id} not found")
