"""Hourly forecast, air quality, sun and moon, and severe-weather alerts.

Kept separate from `weather.py` so the common case — current conditions plus a
daily strip — stays one HTTP call. A board that only shows today's high should
not pay for an air-quality lookup it never displays.

Providers, all keyless:

  * **Hourly / UV / pressure / visibility** - Open-Meteo, same as the daily
    forecast.
  * **Air quality** - Open-Meteo's air-quality API. Reports both the European
    and US AQI; which one is "right" depends where you are, so both are
    returned and the widget picks.
  * **Alerts** - the US National Weather Service. Free, no key, and
    authoritative for the US. There is no equivalent global free feed, so this
    is explicitly US-only and says so rather than silently returning nothing.
  * **Moon** - computed locally. It is pure astronomy, needs no network, and
    works with the internet down.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import httpx

from .base import CACHE, FetchResult

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
AIR_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
NWS_ALERTS = "https://api.weather.gov/alerts/active"

USER_AGENT = "LifeBoard/0.2 (self-hosted dashboard)"


# --------------------------------------------------------------------------
#  Hourly
# --------------------------------------------------------------------------

def hourly(
    latitude: float, longitude: float, *,
    units: str = "imperial", timezone_name: str = "auto",
    hours: int = 24, ttl: float = 900.0, timeout: float = 20.0,
) -> FetchResult:
    imperial = units == "imperial"
    cache_key = ("hourly", round(latitude, 3), round(longitude, 3), units, hours)
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached

    try:
        with httpx.Client(timeout=timeout, headers={"User-Agent": USER_AGENT}) as client:
            resp = client.get(FORECAST_URL, params={
                "latitude": latitude, "longitude": longitude, "timezone": timezone_name,
                "hourly": "temperature_2m,precipitation_probability,weather_code,"
                          "wind_speed_10m,uv_index,relative_humidity_2m,"
                          "apparent_temperature,pressure_msl,visibility",
                "forecast_days": 3,
                "temperature_unit": "fahrenheit" if imperial else "celsius",
                "wind_speed_unit": "mph" if imperial else "kmh",
                "precipitation_unit": "inch" if imperial else "mm",
            })
            resp.raise_for_status()
            data = resp.json()

        from .weather import WMO

        block = data.get("hourly", {}) or {}
        times = block.get("time", []) or []

        # Start from the current hour, not the start of today - a wall display
        # showing "8am: 40 degrees" at 6pm is worse than showing nothing.
        now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
        start = 0
        for index, stamp in enumerate(times):
            try:
                if datetime.fromisoformat(stamp).replace(tzinfo=timezone.utc) >= now:
                    start = index
                    break
            except ValueError:
                continue

        out = []
        for i in range(start, min(start + max(1, hours), len(times))):
            code = int((block.get("weather_code") or [0])[i] or 0)
            label, icon = WMO.get(code, ("Unknown", "cloudy"))
            out.append({
                "time": times[i],
                "hour": _hour_label(times[i]),
                "temp": _round(_at(block, "temperature_2m", i)),
                "feels_like": _round(_at(block, "apparent_temperature", i)),
                "precip_chance": _at(block, "precipitation_probability", i),
                "wind": _round(_at(block, "wind_speed_10m", i)),
                "humidity": _at(block, "relative_humidity_2m", i),
                "uv": _round(_at(block, "uv_index", i)),
                "pressure": _round(_at(block, "pressure_msl", i)),
                "visibility": _round(_at(block, "visibility", i)),
                "label": label,
                "icon": icon,
            })
        result = FetchResult(payload={
            "hours": out,
            "units": "F" if imperial else "C",
            "wind_units": "mph" if imperial else "km/h",
        })
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=f"{type(exc).__name__}: {exc}")

    return CACHE.put(cache_key, result)


def _at(block: dict, key: str, index: int):
    values = block.get(key) or []
    return values[index] if index < len(values) else None


def _hour_label(stamp: str) -> str:
    try:
        dt = datetime.fromisoformat(stamp)
        return dt.strftime("%-I%p").lower() if hasattr(dt, "strftime") else stamp
    except (ValueError, TypeError):
        return stamp


# --------------------------------------------------------------------------
#  Air quality
# --------------------------------------------------------------------------

# US AQI bands. The number alone means nothing to most people; the label and
# the colour are what make it readable across a room.
AQI_BANDS = [
    (50, "Good", "#7fb069"),
    (100, "Moderate", "#d9d06b"),
    (150, "Unhealthy for sensitive groups", "#d9a06b"),
    (200, "Unhealthy", "#d98b8b"),
    (300, "Very unhealthy", "#a98bd9"),
    (10_000, "Hazardous", "#8b5a5a"),
]


def band(value) -> tuple[str, str]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "Unknown", "#9aa0a8"
    for limit, label, colour in AQI_BANDS:
        if number <= limit:
            return label, colour
    return "Hazardous", "#8b5a5a"


def air_quality(
    latitude: float, longitude: float, *,
    ttl: float = 1800.0, timeout: float = 20.0,
) -> FetchResult:
    cache_key = ("aqi", round(latitude, 3), round(longitude, 3))
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached

    try:
        with httpx.Client(timeout=timeout, headers={"User-Agent": USER_AGENT}) as client:
            resp = client.get(AIR_URL, params={
                "latitude": latitude, "longitude": longitude,
                "current": "us_aqi,european_aqi,pm2_5,pm10,ozone,"
                           "nitrogen_dioxide,sulphur_dioxide,carbon_monoxide",
                "timezone": "auto",
            })
            resp.raise_for_status()
            current = (resp.json().get("current") or {})

        us = current.get("us_aqi")
        label, colour = band(us)
        result = FetchResult(payload={
            "us_aqi": _round(us),
            "european_aqi": _round(current.get("european_aqi")),
            "label": label,
            "colour": colour,
            "pm2_5": _round(current.get("pm2_5"), 1),
            "pm10": _round(current.get("pm10"), 1),
            "ozone": _round(current.get("ozone")),
            "no2": _round(current.get("nitrogen_dioxide")),
            "so2": _round(current.get("sulphur_dioxide")),
            "co": _round(current.get("carbon_monoxide")),
        })
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=f"{type(exc).__name__}: {exc}")

    return CACHE.put(cache_key, result)


# --------------------------------------------------------------------------
#  Alerts (US only)
# --------------------------------------------------------------------------

SEVERITY_COLOUR = {
    "Extreme": "#d95b5b", "Severe": "#d9825b", "Moderate": "#d9a06b",
    "Minor": "#d9d06b", "Unknown": "#9aa0a8",
}


def alerts(
    latitude: float, longitude: float, *,
    ttl: float = 600.0, timeout: float = 20.0,
) -> FetchResult:
    """Active NWS alerts for a point. US only - stated, not silently empty."""
    cache_key = ("alerts", round(latitude, 3), round(longitude, 3))
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached

    try:
        with httpx.Client(
            timeout=timeout,
            # NWS requires a User-Agent identifying the caller and will refuse
            # requests without one.
            headers={"User-Agent": USER_AGENT, "Accept": "application/geo+json"},
        ) as client:
            resp = client.get(NWS_ALERTS, params={"point": f"{latitude},{longitude}"})
            resp.raise_for_status()
            features = resp.json().get("features", [])

        items = []
        for feature in features:
            props = feature.get("properties", {}) or {}
            severity = props.get("severity", "Unknown")
            items.append({
                "id": props.get("id", ""),
                "event": props.get("event", "Alert"),
                "headline": props.get("headline", ""),
                "description": (props.get("description") or "")[:800],
                "severity": severity,
                "urgency": props.get("urgency", ""),
                "certainty": props.get("certainty", ""),
                "colour": SEVERITY_COLOUR.get(severity, "#9aa0a8"),
                "onset": props.get("onset") or props.get("effective") or "",
                "expires": props.get("expires", ""),
                "sender": props.get("senderName", ""),
            })
        # Most severe first: on a board that only has room for one, it must be
        # the tornado warning and not the frost advisory.
        order = {"Extreme": 0, "Severe": 1, "Moderate": 2, "Minor": 3, "Unknown": 4}
        items.sort(key=lambda a: order.get(a["severity"], 5))
        result = FetchResult(payload={"alerts": items, "region": "us"})
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            # Outside NWS coverage. Not an error worth showing in red.
            result = FetchResult(payload={"alerts": [], "region": "unsupported"})
        else:
            result = FetchResult(error=f"HTTP {exc.response.status_code} from weather.gov")
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=f"{type(exc).__name__}: {exc}")

    return CACHE.put(cache_key, result)


# --------------------------------------------------------------------------
#  Sun and moon
# --------------------------------------------------------------------------

MOON_PHASES = [
    (0.033, "New moon", "🌑"),
    (0.216, "Waxing crescent", "🌒"),
    (0.283, "First quarter", "🌓"),
    (0.466, "Waxing gibbous", "🌔"),
    (0.533, "Full moon", "🌕"),
    (0.716, "Waning gibbous", "🌖"),
    (0.783, "Last quarter", "🌗"),
    (0.966, "Waning crescent", "🌘"),
    (1.001, "New moon", "🌑"),
]

# A known new moon, and the synodic month. Accurate to well under a day over
# any timeframe a dashboard cares about, and needs no network.
KNOWN_NEW_MOON = datetime(2000, 1, 6, 18, 14, tzinfo=timezone.utc)
SYNODIC_MONTH = 29.530588853


def moon(at: datetime | None = None) -> dict:
    at = at or datetime.now(timezone.utc)
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)

    days = (at - KNOWN_NEW_MOON).total_seconds() / 86400.0
    fraction = (days % SYNODIC_MONTH) / SYNODIC_MONTH
    name, glyph = next((n, g) for limit, n, g in MOON_PHASES if fraction < limit)

    # Illuminated fraction: 0 at new, 1 at full, following a cosine.
    illumination = (1 - math.cos(2 * math.pi * fraction)) / 2

    return {
        "phase": round(fraction, 3),
        "name": name,
        "glyph": glyph,
        "illumination": round(illumination * 100),
        "age_days": round(fraction * SYNODIC_MONTH, 1),
        "next_full": _next_phase(at, 0.5),
        "next_new": _next_phase(at, 0.0),
    }


def _next_phase(at: datetime, target: float) -> str:
    days = (at - KNOWN_NEW_MOON).total_seconds() / 86400.0
    current = (days % SYNODIC_MONTH) / SYNODIC_MONTH
    ahead = (target - current) % 1.0
    return (at + timedelta(days=ahead * SYNODIC_MONTH)).strftime("%Y-%m-%d")


def _round(value, places: int = 0):
    try:
        number = round(float(value), places)
        return int(number) if places == 0 else number
    except (TypeError, ValueError):
        return None
