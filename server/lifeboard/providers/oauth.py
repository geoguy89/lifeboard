"""OAuth 2.0 for Google and Microsoft, shaped for an appliance.

TWO FLOWS, BECAUSE THE PROVIDERS DIFFER
---------------------------------------
**Microsoft: device code flow.** This is the right answer for a device with no
keyboard. LifeBoard asks Microsoft for a code, you type it into
microsoft.com/devicelogin on your phone, and the appliance polls until you have
approved it. No redirect URI, no reverse proxy, nothing to register beyond the
app itself. Microsoft supports Graph calendar scopes this way.

**Google: authorization code flow with PKCE.** Google's device flow does *not*
cover Calendar scopes, so the redirect flow is the only option — and Google
will only accept a redirect URI that is HTTPS or loopback. A private LAN
address like `http://198.51.100.50:8080/...` is rejected. That is a Google
policy, not something this code can work around, so `docs/oauth.md` explains
the three ways to satisfy it. The redirect URI is configurable precisely
because which one applies depends on how you reach the box.

TOKEN HANDLING
--------------
Refresh tokens are the long-lived credential and are stored encrypted (see
secrets_store). Access tokens are refreshed on demand with a safety margin, and
a refresh that fails with `invalid_grant` means the user revoked access — that
is reported as "reconnect needed" rather than retried forever.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import secrets as pysecrets
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

log = logging.getLogger("lifeboard.oauth")

# Refresh this long before expiry, so a slow request never lands on a token
# that expired between the check and the call.
EXPIRY_MARGIN = 120


@dataclass
class Provider:
    name: str
    auth_url: str
    token_url: str
    scopes: list[str]
    device_url: str = ""
    supports_device_flow: bool = False
    extra_auth: dict[str, str] = field(default_factory=dict)


GOOGLE = Provider(
    name="google",
    auth_url="https://accounts.google.com/o/oauth2/v2/auth",
    token_url="https://oauth2.googleapis.com/token",
    scopes=[
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar.events.readonly",
        # Tasks rides the same connection so the awkward consent flow is done
        # once rather than twice.
        #
        # This was `tasks.readonly` until touch-to-complete was asked for, on
        # the reasoning that a wall display which could silently tick somebody's
        # tasks off is not one to hang in a kitchen. That reasoning still holds
        # - what changed is that crossing a task off the wall IS the feature,
        # and it cannot be done with a read-only token.
        #
        # So the guard moved rather than disappeared: the scope allows writing,
        # and the board still refuses to write unless the SOURCE has
        # `allow_complete` turned on, which is off by default. The token can;
        # the appliance will not. See providers/tasks.py.
        #
        # An account authorised before this changed holds the old read-only
        # grant and must be reconnected; gtasks._friendly says exactly that
        # when Google answers 403.
        "https://www.googleapis.com/auth/tasks",
    ],
    # access_type=offline is what makes Google issue a refresh token at all;
    # prompt=consent forces one to be re-issued if the user has authorised
    # before, otherwise a re-auth silently returns no refresh token and the
    # integration dies in an hour.
    extra_auth={"access_type": "offline", "prompt": "consent", "include_granted_scopes": "true"},
)

MICROSOFT = Provider(
    name="graph",
    auth_url="https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token_url="https://login.microsoftonline.com/common/oauth2/v2.0/token",
    device_url="https://login.microsoftonline.com/common/oauth2/v2.0/devicecode",
    supports_device_flow=True,
    # offline_access is Microsoft's equivalent of access_type=offline.
    #
    # Tasks.ReadWrite is one scope covering BOTH Microsoft To Do and Planner -
    # they share Graph's task permissions - so a single consent gets the task
    # list widget and the Kanban board. Same rule as Google: the scope permits
    # writing, `allow_complete` on the source decides whether the board does.
    scopes=["offline_access", "Calendars.Read", "User.Read", "Tasks.ReadWrite"],
)

PROVIDERS = {"google": GOOGLE, "graph": MICROSOFT}


# --------------------------------------------------------------------------
#  Authorization code flow (Google)
# --------------------------------------------------------------------------

def make_pkce() -> tuple[str, str]:
    """Verifier and challenge. PKCE is used even with a client secret, because
    the redirect passes through a browser we do not control."""
    verifier = base64.urlsafe_b64encode(pysecrets.token_bytes(48)).decode().rstrip("=")
    digest = hashlib.sha256(verifier.encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    return verifier, challenge


def authorize_url(
    provider: Provider, client_id: str, redirect_uri: str,
    state: str, challenge: str, scopes: list[str] | None = None,
) -> str:
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(scopes or provider.scopes),
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        **provider.extra_auth,
    }
    return str(httpx.URL(provider.auth_url, params=params))


def exchange_code(
    provider: Provider, client_id: str, client_secret: str,
    code: str, redirect_uri: str, verifier: str, timeout: float = 30.0,
) -> dict:
    data = {
        "client_id": client_id,
        "code": code,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
        "code_verifier": verifier,
    }
    if client_secret:
        data["client_secret"] = client_secret
    return _token_request(provider, data, timeout)


# --------------------------------------------------------------------------
#  Device code flow (Microsoft)
# --------------------------------------------------------------------------

def start_device_flow(
    provider: Provider, client_id: str, scopes: list[str] | None = None,
    timeout: float = 30.0,
) -> dict:
    if not provider.supports_device_flow:
        return {"error": f"{provider.name} does not support the device flow"}
    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(provider.device_url, data={
                "client_id": client_id,
                "scope": " ".join(scopes or provider.scopes),
            })
            resp.raise_for_status()
            data = resp.json()
        return {
            "ok": True,
            "device_code": data["device_code"],
            "user_code": data["user_code"],
            "verification_uri": data.get("verification_uri") or data.get("verification_url"),
            "expires_in": data.get("expires_in", 900),
            "interval": max(5, int(data.get("interval", 5))),
        }
    except httpx.HTTPStatusError as exc:
        return {"error": _describe(exc)}
    except Exception as exc:  # noqa: BLE001
        return {"error": f"{type(exc).__name__}: {exc}"}


def poll_device_flow(
    provider: Provider, client_id: str, device_code: str, timeout: float = 30.0,
) -> dict:
    """One poll. The caller drives the interval.

    `authorization_pending` is the normal answer while the user is still typing
    the code in, and must not be treated as an error.
    """
    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(provider.token_url, data={
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "client_id": client_id,
                "device_code": device_code,
            })
        payload = resp.json()
        if resp.status_code == 200:
            return {"ok": True, "tokens": _shape_tokens(payload)}

        error = payload.get("error", "")
        if error == "authorization_pending":
            return {"pending": True}
        if error == "slow_down":
            return {"pending": True, "slow_down": True}
        if error == "expired_token":
            return {"error": "The code expired. Start again."}
        if error == "authorization_declined":
            return {"error": "Access was declined."}
        return {"error": payload.get("error_description") or error or "device flow failed"}
    except Exception as exc:  # noqa: BLE001
        return {"error": f"{type(exc).__name__}: {exc}"}


# --------------------------------------------------------------------------
#  Refresh
# --------------------------------------------------------------------------

class ReauthNeeded(Exception):
    """The refresh token is no longer valid; the user must reconnect."""


def refresh(
    provider: Provider, client_id: str, client_secret: str,
    refresh_token: str, timeout: float = 30.0,
) -> dict:
    data = {
        "client_id": client_id,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }
    if client_secret:
        data["client_secret"] = client_secret
    return _token_request(provider, data, timeout)


def valid_access_token(provider: Provider, config: dict, tokens: dict) -> tuple[str, dict | None]:
    """Return a usable access token, refreshing if needed.

    The second element is a new token dict to persist, or None if nothing
    changed - so callers only write to the database when they must.
    """
    if not tokens:
        raise ReauthNeeded("not connected")

    if tokens.get("expires_at", 0) > time.time() + EXPIRY_MARGIN:
        return tokens["access_token"], None

    if not tokens.get("refresh_token"):
        raise ReauthNeeded("no refresh token stored; reconnect the account")

    fresh = refresh(
        provider,
        config.get("client_id", ""),
        config.get("client_secret", ""),
        tokens["refresh_token"],
    )
    if "error" in fresh:
        raise ReauthNeeded(fresh["error"])

    # Google does not re-issue the refresh token on every refresh; losing the
    # old one here would break the account on the next expiry.
    merged = dict(tokens, **fresh)
    if not fresh.get("refresh_token"):
        merged["refresh_token"] = tokens["refresh_token"]
    return merged["access_token"], merged


# --------------------------------------------------------------------------

def _token_request(provider: Provider, data: dict, timeout: float) -> dict:
    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(provider.token_url, data=data)
        payload = resp.json()
        if resp.status_code != 200:
            error = payload.get("error", "")
            description = payload.get("error_description") or error
            if error == "invalid_grant":
                # Revoked, expired, or the account password changed. Retrying
                # will never help, so say what to do instead.
                return {"error": "Access was revoked or expired. Reconnect the account."}
            return {"error": description or f"token request failed ({resp.status_code})"}
        return _shape_tokens(payload)
    except Exception as exc:  # noqa: BLE001
        return {"error": f"{type(exc).__name__}: {exc}"}


def _shape_tokens(payload: dict) -> dict:
    out = {
        "access_token": payload.get("access_token", ""),
        "token_type": payload.get("token_type", "Bearer"),
        "scope": payload.get("scope", ""),
        "expires_at": time.time() + int(payload.get("expires_in", 3600)),
    }
    if payload.get("refresh_token"):
        out["refresh_token"] = payload["refresh_token"]
    return out


def _describe(exc: httpx.HTTPStatusError) -> str:
    try:
        body = exc.response.json()
        return body.get("error_description") or body.get("error") or exc.response.text[:200]
    except Exception:  # noqa: BLE001
        return f"HTTP {exc.response.status_code}"
