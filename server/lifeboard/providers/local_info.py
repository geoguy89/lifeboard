"""Tides and airport delays. Both free, both US government, neither needs a key.

Kept apart from weather.py because neither is weather: tides come from NOAA
CO-OPS and delays from the FAA's national airspace status. What they share is
being *local* facts a wall display is a good place for, and being free of the
API-key ceremony that rules out most of the equivalents.
"""

from __future__ import annotations

import math
import re
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta

import httpx

from .base import CACHE, FetchResult

USER_AGENT = "LifeBoard/0.1 (+local dashboard)"
TIMEOUT = 20.0

TIDES_API = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
STATIONS_API = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json"
FAA_API = "https://nasstatus.faa.gov/api/airport-status-information"


def _get(url: str, **kwargs):
    with httpx.Client(timeout=TIMEOUT, follow_redirects=True,
                      headers={"User-Agent": USER_AGENT}) as client:
        resp = client.get(url, **kwargs)
        resp.raise_for_status()
        return resp


# --------------------------------------------------------------------------
#  Tides
# --------------------------------------------------------------------------

def nearest_station(latitude: float, longitude: float, ttl: float = 7 * 86400.0):
    """The closest NOAA tide-prediction station to a point.

    There are ~3,500 of them and the list changes about never, so it is cached
    for a week. Asking a person to look up a station id is exactly the kind of
    setup step that stops a block being used at all.
    """
    cache_key = ("tide-stations",)
    cached = CACHE.get(cache_key, ttl)
    if cached is None:
        try:
            data = _get(STATIONS_API, params={"type": "tidepredictions"}).json()
            stations = [
                {"id": s.get("id"), "name": s.get("name"),
                 "state": s.get("state", ""),
                 "lat": float(s.get("lat")), "lon": float(s.get("lng"))}
                for s in data.get("stations", [])
                if s.get("lat") is not None and s.get("lng") is not None
            ]
            cached = FetchResult(payload={"stations": stations})
        except Exception as exc:  # noqa: BLE001
            cached = FetchResult(error=f"{type(exc).__name__}: {exc}")
        cached = CACHE.put(cache_key, cached)

    if cached.error or not cached.payload:
        return None
    stations = cached.payload["stations"]
    if not stations:
        return None

    # Equirectangular approximation. Over the few hundred km that separate a
    # house from its nearest tide station this is indistinguishable from a
    # great-circle distance, and it avoids the trig on every one of 3,500 rows.
    lat_r = math.radians(latitude)
    def dist(s):
        dx = (s["lon"] - longitude) * math.cos(lat_r)
        dy = s["lat"] - latitude
        return dx * dx + dy * dy
    return min(stations, key=dist)


def tides(
    latitude: float,
    longitude: float,
    *,
    station: str = "",
    days: int = 2,
    units: str = "imperial",
    ttl: float = 6 * 3600.0,
) -> FetchResult:
    """High and low tides for the next couple of days."""
    days = max(1, min(int(days), 5))
    cache_key = ("tides", station or (round(latitude, 2), round(longitude, 2)),
                 days, units, date.today().isoformat())
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached

    try:
        name = ""
        if not station:
            found = nearest_station(latitude, longitude)
            if not found:
                raise ValueError("could not find a nearby tide station")
            station = found["id"]
            name = f"{found['name']}, {found['state']}".strip(", ")

        begin = date.today()
        end = begin + timedelta(days=days)
        resp = _get(TIDES_API, params={
            "product": "predictions",
            "application": "LifeBoard",
            "begin_date": begin.strftime("%Y%m%d"),
            "end_date": end.strftime("%Y%m%d"),
            "datum": "MLLW",
            "station": station,
            "time_zone": "lst_ldt",
            "units": "english" if units == "imperial" else "metric",
            "interval": "hilo",
            "format": "json",
        })
        data = resp.json()
        if "error" in data:
            raise ValueError(str(data["error"].get("message", data["error"]))[:200])

        events = []
        for row in data.get("predictions", []):
            when = datetime.strptime(row["t"], "%Y-%m-%d %H:%M")
            events.append({
                "time": when.isoformat(),
                "hour": when.strftime("%I:%M %p").lstrip("0"),
                "day": when.strftime("%a"),
                "height": round(float(row["v"]), 2),
                "kind": "high" if row.get("type") == "H" else "low",
            })
        if not events:
            raise ValueError("no tide predictions returned")

        result = FetchResult(payload={
            "station": station,
            "station_name": name,
            "units": "ft" if units == "imperial" else "m",
            "events": events,
        })
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=f"{type(exc).__name__}: {exc}")
    return CACHE.put(cache_key, result)


# --------------------------------------------------------------------------
#  Airport delays
# --------------------------------------------------------------------------

def _text(node, *path) -> str:
    for step in path:
        if node is None:
            return ""
        node = node.find(step)
    return (node.text or "").strip() if node is not None else ""


def airport_delays(codes: str = "", *, ttl: float = 600.0) -> FetchResult:
    """FAA national airspace status: ground stops, delays and closures.

    XML, not JSON - the FAA has served this format for twenty years and it is
    not about to change. `codes` filters to the airports someone actually
    flies from; empty means everything currently delayed, which on a bad
    afternoon is a very long list.
    """
    wanted = {c.strip().upper() for c in codes.split(",") if c.strip()}
    cache_key = ("faa", tuple(sorted(wanted)))
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached

    try:
        root = ET.fromstring(_get(FAA_API).text)
        updated = _text(root, "Update_Time")

        items = []
        for delay_type in root.iter("Delay_type"):
            name = _text(delay_type, "Name")
            for airport in delay_type.iter("Airport"):
                code = _text(airport, "ARPT")
                if wanted and code not in wanted:
                    continue
                reason = _text(airport, "Reason")
                # The three flavours nest their detail differently, so the
                # readable line is assembled per flavour rather than guessed.
                detail = ""
                avg = airport.find(".//Avg")
                if avg is not None and avg.text:
                    detail = f"average {avg.text.strip()}"
                length = airport.find(".//Length")
                if length is not None and length.text:
                    detail = f"delays {length.text.strip()}"
                closed = airport.find(".//Reopen")
                if closed is not None and closed.text:
                    detail = f"reopens {closed.text.strip()}"
                items.append({
                    "airport": code,
                    "type": name,
                    "reason": reason,
                    "detail": detail,
                })

        result = FetchResult(payload={
            "updated": updated,
            "delays": items,
            # An explicit "asked about these, none are delayed" is a different
            # statement from "we have no data", and the widget says so.
            "watched": sorted(wanted),
        })
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=f"{type(exc).__name__}: {exc}")
    return CACHE.put(cache_key, result)
