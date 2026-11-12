"""Encryption at rest for OAuth tokens and API credentials.

WHAT THIS DOES AND DOES NOT PROTECT AGAINST
-------------------------------------------
The key lives in a 0600 file next to the database, owned by the service user.
So this does **not** stop someone who already has root on the appliance — if
they can read the database they can read the key.

What it does stop is the realistic failure: the database getting copied
somewhere it should not be. A LifeBoard `.db` is the natural thing to back up,
paste into a support thread, or sync to a NAS — and a refresh token for
somebody's Google Calendar sitting in it as plain text would be genuinely bad.
Separating the key from the data means a stray copy of the database is inert.

If the key file is lost the tokens are unrecoverable, which is the correct
behaviour: re-authorising is a two-minute job, whereas a silent fallback to
plaintext would quietly undo the whole point.
"""

from __future__ import annotations

import base64
import json
import logging
import os
from pathlib import Path
from typing import Any

log = logging.getLogger("lifeboard.secrets")

KEY_PATH = Path(os.environ.get(
    "LIFEBOARD_KEY", str(Path(os.environ.get("LIFEBOARD_DB", "/var/lib/lifeboard/lifeboard.db")).parent / "secret.key")
))

_fernet = None
_unavailable_reason = ""


def _load():
    """Get (or create) the Fernet instance. None if cryptography is missing."""
    global _fernet, _unavailable_reason
    if _fernet is not None or _unavailable_reason:
        return _fernet

    try:
        from cryptography.fernet import Fernet
    except ImportError:
        _unavailable_reason = (
            "the 'cryptography' package is not installed, so credentials are "
            "stored unencrypted"
        )
        log.warning("SECRETS NOT ENCRYPTED: %s", _unavailable_reason)
        return None

    try:
        KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
        if KEY_PATH.exists():
            key = KEY_PATH.read_bytes().strip()
        else:
            key = Fernet.generate_key()
            # Write with restrictive permissions from the start rather than
            # chmod-ing afterwards, or the key is briefly world-readable.
            fd = os.open(KEY_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(key)
            log.info("generated a new secret key at %s", KEY_PATH)
        _fernet = Fernet(key)
    except Exception as exc:  # noqa: BLE001
        _unavailable_reason = f"could not load the key file: {exc}"
        log.error("SECRETS NOT ENCRYPTED: %s", _unavailable_reason)
        return None
    return _fernet


def available() -> bool:
    return _load() is not None


def status() -> dict:
    """Surfaced in the admin UI so unencrypted storage is never silent."""
    return {
        "encrypted": available(),
        "reason": _unavailable_reason,
        "key_path": str(KEY_PATH),
    }


def seal(value: Any) -> bytes:
    """Encrypt a JSON-serialisable value for storage in a BLOB column."""
    raw = json.dumps(value).encode("utf-8")
    box = _load()
    if box is None:
        # Prefixed so `open` can tell the two apart, and so a database written
        # before cryptography was installed still reads correctly afterwards.
        return b"plain:" + base64.b64encode(raw)
    return b"fernet:" + box.encrypt(raw)


def open_(blob: bytes | None) -> Any:
    """Decrypt a stored value. Returns None if it cannot be read."""
    if not blob:
        return None
    try:
        if blob.startswith(b"plain:"):
            return json.loads(base64.b64decode(blob[6:]))
        if blob.startswith(b"fernet:"):
            box = _load()
            if box is None:
                log.error("cannot decrypt: cryptography is unavailable")
                return None
            return json.loads(box.decrypt(blob[7:]))
        # Written before this module existed.
        return json.loads(blob)
    except Exception as exc:  # noqa: BLE001
        # A key change makes every token undecryptable. Say so loudly - the
        # symptom otherwise is every calendar silently going empty.
        log.error("could not decrypt a stored secret (%s); re-authorisation needed", exc)
        return None
