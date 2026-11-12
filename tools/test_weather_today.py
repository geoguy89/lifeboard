"""Today's forecast row must be about the rest of today.

The board showed, at half past one on a clear afternoon:

    now:   80F, Clear
    Thu:   80F, 92% rain, with a rain animation

Both are true statements about the same Open-Meteo response, which is what made
it so confusing to look at. `current` is this moment; the daily row uses
`precipitation_probability_max` and the daily `weather_code`, and both cover the
whole CALENDAR day - including the hours that have already happened. Measured
against live data at the time: peak chance earlier in the day 92%, peak chance
for the rest of the day 0%. It had rained that morning. The board was reporting
the morning as though it were the forecast.

A wall display is read for what is coming. Today's row is now recomputed from
the hourly series, from the current hour onwards.

    python tools/test_weather_today.py
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

_tmp = tempfile.mkdtemp()
os.environ.setdefault("LIFEBOARD_DB", os.path.join(_tmp, "t.db"))
os.environ.setdefault("LIFEBOARD_KEY", os.path.join(_tmp, "key"))
os.environ.setdefault("LIFEBOARD_MEDIA", os.path.join(_tmp, "media"))
os.environ.setdefault("LIFEBOARD_NETWORK", "managed")

from lifeboard.providers import weather  # noqa: E402

problems = []

# The shape of the real response, with the real numbers from the day it was
# reported: a wet morning, a clear afternoon, and rain again on Friday.
RESPONSE = {
    "current": {
        "time": "2026-09-10T13:30",
        "temperature_2m": 80.0,
        "apparent_temperature": 79.0,
        "relative_humidity_2m": 50,
        "weather_code": 0,          # clear
        "wind_speed_10m": 5,
        "is_day": 1,
    },
    "daily": {
        "time": ["2026-09-10", "2026-09-11"],
        "weather_code": [63, 61],   # moderate rain, slight rain
        "temperature_2m_max": [80.1, 69.0],
        "temperature_2m_min": [59.0, 49.0],
        "precipitation_probability_max": [92, 70],
        "sunrise": ["2026-09-10T06:15", "2026-09-11T06:16"],
        "sunset": ["2026-09-10T19:02", "2026-09-11T19:00"],
    },
    "hourly": {
        "time": [
            "2026-09-10T05:00", "2026-09-10T06:00", "2026-09-10T07:00",
            "2026-09-10T13:00", "2026-09-10T14:00", "2026-09-10T15:00",
            "2026-09-10T20:00",
            "2026-09-11T09:00", "2026-09-11T15:00",
        ],
        # 92% at 6am - already over. Nothing at all for the rest of today.
        "precipitation_probability": [80, 92, 60, 0, 0, 0, 0, 70, 40],
        "weather_code": [61, 63, 61, 0, 0, 1, 3, 61, 61],
    },
}

shaped = weather._shape(RESPONSE, imperial=True)
today = shaped["daily"][0]
tomorrow = shaped["daily"][1]

# --- today ---------------------------------------------------------------
if today["precip_chance"] != 0:
    problems.append(
        f"today still reports {today['precip_chance']}% rain, which is this "
        "morning's peak, not what is left of the day")
else:
    print("  ok   today's rain chance is what is still to come (0%), not 92%")

if today["icon"] in ("rain", "showers", "storm"):
    problems.append(f"today still shows a {today['icon']!r} animation under a clear sky")
else:
    print(f"  ok   today's icon is {today['icon']!r}, not a rain animation")

if not today.get("rest_of_day"):
    problems.append("today is not marked as covering only the rest of the day, "
                    "so a widget cannot say so")
else:
    print("  ok   today is flagged so a widget can label it")

# The temperatures are the day's, deliberately: a high already reached is still
# the high, and every weather app in the world shows it that way.
if today["high"] != 80 or today["low"] != 59:
    problems.append(f"today's high/low changed: {today['high']}/{today['low']}")
else:
    print("  ok   today's high and low are still the day's")

# --- tomorrow, which must be untouched ------------------------------------
if tomorrow["precip_chance"] != 70:
    problems.append(f"tomorrow was rewritten too: {tomorrow['precip_chance']}%")
elif tomorrow.get("rest_of_day"):
    problems.append("tomorrow is flagged as a partial day")
else:
    print("  ok   tomorrow still uses the whole-day figures")

# --- and the fallbacks ----------------------------------------------------
no_hourly = {k: v for k, v in RESPONSE.items() if k != "hourly"}
shaped = weather._shape(no_hourly, imperial=True)
if shaped["daily"][0]["precip_chance"] != 92:
    problems.append("with no hourly data the daily figure should be kept, "
                    f"got {shaped['daily'][0]['precip_chance']}")
else:
    print("  ok   with no hourly series the daily figures are kept")

spent = {**RESPONSE, "current": {**RESPONSE["current"], "time": "2026-09-10T23:59"}}
shaped = weather._shape(spent, imperial=True)
if shaped["daily"][0]["precip_chance"] != 92:
    problems.append("at the end of the day, with no hours left, the daily "
                    "figure should be kept rather than invented as 0")
else:
    print("  ok   a spent day falls back rather than inventing a clear night")

if problems:
    print("\nFAILED:")
    for p in problems:
        print("  - " + p)
    sys.exit(1)
print("\nToday's row describes today's remainder.")
