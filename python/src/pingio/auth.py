"""REST client for the Pingio central auth server (OAuth2-style endpoints)."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

from .errors import AuthError


class AuthClient:
    """Thin JSON-over-HTTP client for ``{auth_url}/oauth/*``.

    Uses only the standard library so the SDK stays lean. Raises
    :class:`AuthError` with the server's ``error`` message on any
    non-2xx response.
    """

    def __init__(self, auth_url: str, timeout: float = 15.0):
        self.auth_url = auth_url.rstrip("/")
        self.timeout = timeout

    def register(
        self,
        username: str,
        password: str,
        display_name: str | None = None,
        device_fingerprint: str | None = None,
        device_name: str | None = None,
    ) -> dict[str, Any]:
        """Create an account. Returns ``{success, userId, token, refreshToken, deviceId}``."""
        payload: dict[str, Any] = {"username": username, "password": password}
        if display_name:
            payload["displayName"] = display_name
        if device_fingerprint:
            payload["deviceFingerprint"] = device_fingerprint
        if device_name:
            payload["deviceName"] = device_name
        return self._post("/oauth/register", payload)

    def login(
        self,
        username: str,
        password: str,
        device_fingerprint: str | None = None,
        device_name: str | None = None,
    ) -> dict[str, Any]:
        """Exchange credentials for tokens. Returns ``{success, userId, token, refreshToken, deviceId}``."""
        payload: dict[str, Any] = {"username": username, "password": password}
        if device_fingerprint:
            payload["deviceFingerprint"] = device_fingerprint
        if device_name:
            payload["deviceName"] = device_name
        return self._post("/oauth/login", payload)

    def refresh(self, refresh_token: str, device_fingerprint: str) -> dict[str, Any]:
        """Rotate an access token. Returns ``{success, token, refreshToken, deviceId}``."""
        return self._post(
            "/oauth/refresh",
            {"refreshToken": refresh_token, "deviceFingerprint": device_fingerprint},
        )

    def introspect(self, token: str) -> dict[str, Any]:
        """Check a token. Returns ``{active, sub?, username?, device_id?, exp?, ...}``."""
        return self._post("/oauth/token/introspect", {"token": token})

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.auth_url}{path}"
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            message = exc.reason or f"HTTP {exc.code}"
            try:
                data = json.loads(exc.read().decode("utf-8"))
                if isinstance(data, dict) and data.get("error"):
                    message = str(data["error"])
            except Exception:
                pass
            raise AuthError(message, status=exc.code) from exc
        except urllib.error.URLError as exc:
            raise AuthError(f"Cannot reach auth server: {exc.reason}") from exc


def join_ws_url(base: str) -> str:
    """Normalize a relay URL to a ws:// or wss:// WebSocket URL ending in /ws."""
    url = base.strip()
    if not url:
        raise ValueError("relay URL must not be empty")
    if url.startswith("https://"):
        url = "wss://" + url[len("https://") :]
    elif url.startswith("http://"):
        url = "ws://" + url[len("http://") :]
    if not url.startswith(("ws://", "wss://")):
        url = "wss://" + url
    return url.rstrip("/")
