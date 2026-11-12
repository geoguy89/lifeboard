"""Stocks, crypto and currency — all from keyless endpoints.

Same principle as the weather provider: no API key means nothing to sign up
for, nothing to expire, and nothing to leak from an appliance that might get
handed to somebody else.

  * **Stocks**   - Stooq CSV. Free, no key, no registration, covers US and
                   most major exchanges. Delayed rather than real-time, which
                   is entirely adequate for a wall display.
  * **Crypto**   - CoinGecko's public API. No key for reasonable volumes.
  * **Currency** - Frankfurter, which serves European Central Bank reference
                   rates. No key, no rate limit worth worrying about.

Every one of these can fail or rate-limit, so a failure returns the previous
value with a stale marker rather than blanking the widget.
"""

from __future__ import annotations

import csv
import io

import httpx

from .base import CACHE, FetchResult

STOOQ = "https://stooq.com/q/l/"
COINGECKO = "https://api.coingecko.com/api/v3/simple/price"
FRANKFURTER = "https://api.frankfurter.app/latest"

USER_AGENT = "LifeBoard/0.2"


def stocks(symbols: list[str], ttl: float = 900.0, timeout: float = 20.0) -> FetchResult:
    """Delayed quotes for a list of tickers."""
    clean = [s.strip().upper() for s in symbols if s.strip()]
    if not clean:
        return FetchResult(error="no symbols configured")

    cache_key = ("stocks", tuple(clean))
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached

    # Stooq wants lowercase and, for US tickers, a .us suffix. Anything already
    # carrying an exchange suffix is passed through untouched.
    query = ",".join(s.lower() if "." in s else f"{s.lower()}.us" for s in clean)

    try:
        with httpx.Client(timeout=timeout, headers={"User-Agent": USER_AGENT}) as client:
            resp = client.get(STOOQ, params={"s": query, "f": "sd2t2ohlcv", "h": "", "e": "csv"})
            resp.raise_for_status()
            rows = list(csv.DictReader(io.StringIO(resp.text)))

        quotes = []
        for row, original in zip(rows, clean):
            close = _num(row.get("Close"))
            open_ = _num(row.get("Open"))
            change = None
            percent = None
            if close is not None and open_:
                change = round(close - open_, 2)
                percent = round((close - open_) / open_ * 100, 2)
            quotes.append({
                "symbol": original,
                "price": close,
                "open": open_,
                "high": _num(row.get("High")),
                "low": _num(row.get("Low")),
                "change": change,
                "percent": percent,
                "date": row.get("Date") or "",
                # Stooq returns "N/D" for an unknown ticker rather than an
                # error, which would otherwise render as a silent blank row.
                "ok": close is not None,
            })
        result = FetchResult(payload={"quotes": quotes})
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=f"{type(exc).__name__}: {exc}")

    return CACHE.put(cache_key, result)


def crypto(
    coins: list[str], vs: str = "usd", ttl: float = 300.0, timeout: float = 20.0
) -> FetchResult:
    """Spot prices and 24h change. Coins are CoinGecko ids: bitcoin, ethereum."""
    clean = [c.strip().lower() for c in coins if c.strip()]
    if not clean:
        return FetchResult(error="no coins configured")

    cache_key = ("crypto", tuple(clean), vs)
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached

    try:
        with httpx.Client(timeout=timeout, headers={"User-Agent": USER_AGENT}) as client:
            resp = client.get(COINGECKO, params={
                "ids": ",".join(clean),
                "vs_currencies": vs,
                "include_24hr_change": "true",
            })
            resp.raise_for_status()
            data = resp.json()

        quotes = []
        for coin in clean:
            entry = data.get(coin) or {}
            price = entry.get(vs)
            quotes.append({
                "symbol": coin,
                "price": price,
                "percent": _round(entry.get(f"{vs}_24h_change"), 2),
                "currency": vs.upper(),
                "ok": price is not None,
            })
        result = FetchResult(payload={"quotes": quotes})
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=f"{type(exc).__name__}: {exc}")

    return CACHE.put(cache_key, result)


def currency(
    base: str = "USD", targets: list[str] | None = None,
    ttl: float = 3600.0, timeout: float = 20.0,
) -> FetchResult:
    """ECB reference rates. Updated once a working day, so a long TTL is right."""
    targets = [t.strip().upper() for t in (targets or ["EUR", "GBP", "CAD"]) if t.strip()]
    base = base.strip().upper() or "USD"

    cache_key = ("fx", base, tuple(targets))
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached

    try:
        with httpx.Client(timeout=timeout, headers={"User-Agent": USER_AGENT}) as client:
            resp = client.get(FRANKFURTER, params={"from": base, "to": ",".join(targets)})
            resp.raise_for_status()
            data = resp.json()

        rates = [
            {"symbol": code, "price": value, "base": base, "ok": value is not None}
            for code, value in (data.get("rates") or {}).items()
        ]
        result = FetchResult(payload={"quotes": rates, "date": data.get("date", "")})
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=f"{type(exc).__name__}: {exc}")

    return CACHE.put(cache_key, result)


def _num(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _round(value, places: int) -> float | None:
    number = _num(value)
    return None if number is None else round(number, places)
