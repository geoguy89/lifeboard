"""Weather via Open-Meteo.

Deliberately not OpenWeatherMap or similar: Open-Meteo needs **no API key**,
which matters for an appliance you hand to someone else. Nothing to sign up
for, nothing to expire, nothing to leak. Geocoding is also keyless, so a user
types "Springfield, Illinois" in the admin UI and never sees a coordinate.
"""

from __future__ import annotations

from datetime import datetime

import httpx

from .base import CACHE, FetchResult

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

# WMO weather codes -> (label, icon key). The icon key is resolved to an SVG in
# the renderer, so no image files are fetched at runtime.
WMO = {
    0: ("Clear", "clear"),
    1: ("Mainly clear", "clear"),
    2: ("Partly cloudy", "partly"),
    3: ("Overcast", "cloudy"),
    45: ("Fog", "fog"),
    48: ("Rime fog", "fog"),
    51: ("Light drizzle", "drizzle"),
    53: ("Drizzle", "drizzle"),
    55: ("Heavy drizzle", "drizzle"),
    56: ("Freezing drizzle", "sleet"),
    57: ("Freezing drizzle", "sleet"),
    61: ("Light rain", "rain"),
    63: ("Rain", "rain"),
    65: ("Heavy rain", "rain"),
    66: ("Freezing rain", "sleet"),
    67: ("Freezing rain", "sleet"),
    71: ("Light snow", "snow"),
    73: ("Snow", "snow"),
    75: ("Heavy snow", "snow"),
    77: ("Snow grains", "snow"),
    80: ("Rain showers", "rain"),
    81: ("Rain showers", "rain"),
    82: ("Violent showers", "rain"),
    85: ("Snow showers", "snow"),
    86: ("Snow showers", "snow"),
    95: ("Thunderstorm", "storm"),
    96: ("Thunderstorm, hail", "storm"),
    99: ("Thunderstorm, hail", "storm"),
}


def geocode(place: str, timeout: float = 15.0) -> dict | None:
    """Turn a typed place name into coordinates. Used by the admin UI only."""
    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.get(GEOCODE_URL, params={"name": place, "count": 5})
            resp.raise_for_status()
            hits = resp.json().get("results") or []
    except Exception:  # noqa: BLE001
        return None
    if not hits:
        return None
    return [
        {
            "name": h.get("name"),
            "admin1": h.get("admin1"),
            "country": h.get("country_code"),
            "latitude": h.get("latitude"),
            "longitude": h.get("longitude"),
            "timezone": h.get("timezone"),
        }
        for h in hits
    ]


def fetch(
    latitude: float,
    longitude: float,
    *,
    units: str = "imperial",
    timezone_name: str = "auto",
    days: int = 5,
    ttl: float = 900.0,
    timeout: float = 20.0,
) -> FetchResult:
    """Current conditions plus a daily forecast, in one call."""
    cache_key = ("weather", round(latitude, 3), round(longitude, 3), units, days)
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached

    imperial = units == "imperial"
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "timezone": timezone_name,
        "current": "temperature_2m,apparent_temperature,relative_humidity_2m,"
                   "weather_code,wind_speed_10m,is_day",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,"
                 "precipitation_probability_max,sunrise,sunset",
        # TODAY'S ROW HAS TO BE ABOUT WHAT IS LEFT OF TODAY.
        #
        # `precipitation_probability_max` is the maximum across the whole
        # CALENDAR day, and the daily weather code describes the day as a
        # whole - both including hours that have already happened. On a wall at
        # half past one, after a wet morning and under a clear sky, the board
        # said "80 degrees, 92% rain" with a rain animation, beside a current
        # reading of "80 and Clear". Measured at the time: peak chance earlier
        # in the day 92%, peak chance for the rest of the day 0%. The board was
        # reporting the morning as though it were the forecast.
        #
        # The hourly series is what makes the row answerable: today is
        # recomputed from now onwards in _shape().
        "hourly": "precipitation_probability,weather_code",
        "forecast_days": max(1, min(days, 14)),
        "temperature_unit": "fahrenheit" if imperial else "celsius",
        "wind_speed_unit": "mph" if imperial else "kmh",
        "precipitation_unit": "inch" if imperial else "mm",
    }

    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.get(FORECAST_URL, params=params)
            resp.raise_for_status()
            data = resp.json()
        result = FetchResult(payload=_shape(data, imperial))
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=f"{type(exc).__name__}: {exc}")

    return CACHE.put(cache_key, result)


def _rest_of_today(data: dict) -> tuple[int, int] | None:
    """The peak rain chance and the worst weather code STILL TO COME today.

    Returns None when the hourly series is missing or the day is spent, so the
    caller keeps the daily figures rather than inventing a clear evening out of
    no data.

    On "worst": WMO codes rise roughly with severity, so the maximum is a fair
    proxy for "what this afternoon is mostly going to be". It is not perfect -
    showers (80-82) sort above snow (71-77) - but it is honest in the direction
    that matters, and the alternative is a severity table that has to be
    maintained against a standard nobody here controls.
    """
    hourly = data.get("hourly") or {}
    times = hourly.get("time") or []
    if not times:
        return None
    now = ((data.get("current") or {}).get("time") or "")
    if not now:
        return None
    today = now[:10]

    chances, codes = [], []
    probabilities = hourly.get("precipitation_probability") or []
    hour_codes = hourly.get("weather_code") or []
    for i, stamp in enumerate(times):
        if stamp[:10] != today or stamp < now:
            continue
        if i < len(probabilities) and probabilities[i] is not None:
            chances.append(int(probabilities[i]))
        if i < len(hour_codes) and hour_codes[i] is not None:
            codes.append(int(hour_codes[i]))

    if not chances and not codes:
        return None
    return (max(chances) if chances else 0), (max(codes) if codes else 0)


def _shape(data: dict, imperial: bool) -> dict:
    cur = data.get("current", {}) or {}
    daily = data.get("daily", {}) or {}
    code = int(cur.get("weather_code", 0) or 0)
    label, icon = WMO.get(code, ("Unknown", "cloudy"))

    ahead = _rest_of_today(data)
    today_date = (cur.get("time") or "")[:10]

    days = []
    dates = daily.get("time", []) or []
    for i, day in enumerate(dates):
        dcode = int((daily.get("weather_code") or [0])[i] or 0)
        chance = (daily.get("precipitation_probability_max") or [None])[i]
        rest_of_day = False

        # Today only: what is left of it, not what has already happened.
        if ahead is not None and day == today_date:
            chance, dcode = ahead
            rest_of_day = True

        dlabel, dicon = WMO.get(dcode, ("Unknown", "cloudy"))
        days.append(
            {
                "date": day,
                "weekday": datetime.fromisoformat(day).strftime("%a"),
                "high": _round(daily.get("temperature_2m_max", [None])[i]),
                "low": _round(daily.get("temperature_2m_min", [None])[i]),
                "precip_chance": chance,
                "label": dlabel,
                "icon": dicon,
                # So a widget can say "rest of today" rather than leaving the
                # reader to wonder why today's row disagrees with this morning.
                "rest_of_day": rest_of_day,
                "sunrise": (daily.get("sunrise") or [None])[i],
                "sunset": (daily.get("sunset") or [None])[i],
            }
        )

    return {
        "units": "F" if imperial else "C",
        "wind_units": "mph" if imperial else "km/h",
        "current": {
            "temp": _round(cur.get("temperature_2m")),
            "feels_like": _round(cur.get("apparent_temperature")),
            "humidity": cur.get("relative_humidity_2m"),
            "wind": _round(cur.get("wind_speed_10m")),
            "label": label,
            "icon": icon,
            "is_day": bool(cur.get("is_day", 1)),
        },
        "daily": days,
    }


def _round(value) -> int | None:
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return None
