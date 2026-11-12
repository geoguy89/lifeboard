"""Generic REST / JSON / text data source.

This is the highest-leverage provider in the system. Rather than writing a
bespoke integration for every service, one configurable HTTP source plus a path
expression covers a very long tail: Grafana, Prometheus, Proxmox, pfSense,
Unraid, uptime monitors, package tracking, sports scores, a Pi-hole's stats, a
webhook that some script writes — anything with an HTTP endpoint.

Native providers still exist where the value is in *understanding* the data
(calendar recurrence, weather codes, HA entity shapes). This one exists for
everything else, so adding a service usually means filling in a form rather
than shipping new code.

SECURITY POSTURE
----------------
This deliberately lets an authenticated admin make the appliance issue HTTP
requests to arbitrary URLs, including on the local network. That is the entire
point of the feature - reaching Proxmox or a NAS on the LAN is the main use
case - so it is not treated as SSRF to be blocked. It IS gated behind admin
auth, never exposed to the unauthenticated renderer, and credentials are held
server-side and never sent to the browser.
"""

from __future__ import annotations

import base64
import json
import re
from typing import Any

import httpx

from .base import CACHE, FetchResult

USER_AGENT = "LifeBoard/0.2"

# Guard against a misconfigured endpoint streaming gigabytes into a wall
# display's memory. Generous enough for any sane API response.
MAX_BYTES = 4 * 1024 * 1024


def fetch(config: dict, ttl: float = 300.0, timeout: float = 20.0) -> FetchResult:
    """Call the endpoint and return the parsed body (plus the selected value)."""
    url = (config.get("url") or "").strip()
    if not url:
        return FetchResult(error="no URL configured")

    method = (config.get("method") or "GET").upper()
    cache_key = ("rest", url, method, json.dumps(config.get("body") or "", sort_keys=True))
    cached = CACHE.get(cache_key, ttl)
    if cached is not None:
        return cached

    headers = {"User-Agent": USER_AGENT}
    for line in (config.get("headers") or "").splitlines():
        if ":" in line:
            key, _, value = line.partition(":")
            headers[key.strip()] = value.strip()

    # Auth is a separate field from headers so the UI can mask it and so the
    # common cases do not require knowing the header syntax.
    auth_kind = config.get("auth", "none")
    if auth_kind == "bearer" and config.get("token"):
        headers["Authorization"] = f"Bearer {config['token']}"
    elif auth_kind == "basic" and config.get("username"):
        raw = f"{config.get('username','')}:{config.get('password','')}".encode()
        headers["Authorization"] = "Basic " + base64.b64encode(raw).decode()
    elif auth_kind == "header" and config.get("auth_header"):
        headers[config["auth_header"]] = config.get("token", "")

    try:
        with httpx.Client(
            timeout=timeout,
            follow_redirects=True,
            verify=not config.get("insecure", False),
        ) as client:
            request = client.build_request(
                method, url, headers=headers,
                json=config.get("body") if config.get("body") and method != "GET" else None,
            )
            resp = client.send(request)
            resp.raise_for_status()
            body = resp.content[:MAX_BYTES]

        content_type = resp.headers.get("content-type", "")
        if config.get("format") == "text" or (
            config.get("format", "auto") == "auto" and "json" not in content_type
        ):
            data: Any = body.decode(resp.encoding or "utf-8", errors="replace")
        else:
            data = json.loads(body)

        payload = {
            "data": data,
            "status": resp.status_code,
            "content_type": content_type,
        }
        # Pre-resolve the configured path so widgets do not each re-implement it.
        if config.get("path"):
            payload["value"] = select(data, config["path"])
        result = FetchResult(payload=payload)

    except httpx.HTTPStatusError as exc:
        result = FetchResult(
            error=f"HTTP {exc.response.status_code} from {_host(url)}"
        )
    except httpx.TimeoutException:
        result = FetchResult(error=f"timed out after {timeout:.0f}s")
    except httpx.ConnectError as exc:
        result = FetchResult(error=f"cannot reach {_host(url)}: {exc}")
    except json.JSONDecodeError as exc:
        result = FetchResult(error=f"response was not valid JSON: {exc}")
    except Exception as exc:  # noqa: BLE001
        result = FetchResult(error=f"{type(exc).__name__}: {exc}")

    return CACHE.put(cache_key, result)


def _host(url: str) -> str:
    try:
        return httpx.URL(url).host or url
    except Exception:  # noqa: BLE001
        return url


# --------------------------------------------------------------------------
#  Path selection
#
#  A deliberately small subset of JSONPath: dotted keys and [n] indexing, with
#  [-1] for "last". Full JSONPath would mean a dependency and a query language
#  nobody can debug from a settings form; this covers the shapes real APIs
#  actually return, and says clearly when it cannot find something.
#
#      results.0.temperature
#      data[-1].value
#      items[0].name
# --------------------------------------------------------------------------

_TOKEN = re.compile(r"[^.\[\]]+|\[-?\d+\]")


class PathError(Exception):
    pass


def select(data: Any, path: str) -> Any:
    """Pull one value out of a parsed response. Raises PathError with context."""
    if not path:
        return data
    current = data
    walked: list[str] = []
    for token in _TOKEN.findall(path):
        if token.startswith("["):
            index = int(token[1:-1])
            if not isinstance(current, list):
                raise PathError(
                    f"{'.'.join(walked) or 'response'} is "
                    f"{type(current).__name__}, not a list, so {token} does not apply"
                )
            try:
                current = current[index]
            except IndexError:
                raise PathError(
                    f"{'.'.join(walked) or 'response'} has {len(current)} items, "
                    f"so {token} is out of range"
                ) from None
        else:
            # A bare integer after a dot is list indexing too: "results.0.x" is
            # how most people write it, and rejecting that is just annoying.
            if isinstance(current, list) and token.lstrip("-").isdigit():
                try:
                    current = current[int(token)]
                except IndexError:
                    raise PathError(
                        f"{'.'.join(walked) or 'response'} has {len(current)} "
                        f"items, so index {token} is out of range"
                    ) from None
            elif isinstance(current, dict):
                if token not in current:
                    available = ", ".join(list(current)[:8]) or "(empty object)"
                    raise PathError(
                        f"no key {token!r} at {'.'.join(walked) or 'the top level'}; "
                        f"available: {available}"
                    )
                current = current[token]
            else:
                raise PathError(
                    f"cannot read {token!r} from a {type(current).__name__} "
                    f"at {'.'.join(walked) or 'the top level'}"
                )
        walked.append(token)
    return current


def preview(config: dict) -> dict:
    """Used by the admin UI's 'Test' button.

    Returns the selected value AND the shape of the response, because the most
    common failure is not a broken URL but a path that does not match - and the
    only way to fix that is to see what the response actually looks like.
    """
    result = fetch(config, ttl=0)
    if result.error:
        return {"ok": False, "error": result.error}

    data = result.payload["data"]
    out: dict[str, Any] = {
        "ok": True,
        "status": result.payload["status"],
        "shape": _shape(data),
        "sample": _truncate(data),
    }
    if config.get("path"):
        try:
            value = select(data, config["path"])
            out["value"] = _truncate(value)
            out["value_type"] = type(value).__name__
        except PathError as exc:
            out["ok"] = False
            out["error"] = str(exc)
    return out


def _shape(data: Any, depth: int = 0) -> Any:
    """A compact description of the response structure, for the test panel."""
    if depth > 3:
        return "..."
    if isinstance(data, dict):
        return {k: _shape(v, depth + 1) for k, v in list(data.items())[:12]}
    if isinstance(data, list):
        return [_shape(data[0], depth + 1), f"...{len(data)} items"] if data else []
    return type(data).__name__


def _truncate(value: Any, limit: int = 600) -> Any:
    text = json.dumps(value, default=str)
    if len(text) <= limit:
        return value
    return text[:limit] + " ..."
