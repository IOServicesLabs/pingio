"""High-level Pingio client: auth, config persistence, DM messaging, presence."""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Iterator

from .auth import AuthClient, join_ws_url
from .constants import DEFAULT_AUTH_URL, DEFAULT_RELAY_WS_URL
from .device import get_device_fingerprint, get_device_name
from .errors import AuthError, NotConnectedError, PingioError, ProtocolError
from .ws import RelayConnection

DEFAULT_CONFIG_PATH = Path.home() / ".pingio" / "python-config.json"
_CONFIG_ENV_VAR = "PINGIO_CONFIG"

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

_UNSET: Any = object()

PRESENCE_STATUSES = ("online", "away", "busy", "offline")


class PingioClient:
    """Client for the Pingio messaging relay.

    Parameters
    ----------
    auth_url:
        Base URL of the auth server. Auth calls hit ``{auth_url}/oauth/*``.
        Defaults to the hosted endpoint https://pingio.ioservices.io.
    relay_ws_url:
        WebSocket URL of the relay. Defaults to
        ``wss://pingio.ioservices.io/ws``.
    config_path:
        Where to persist tokens between runs. Defaults to
        ``~/.pingio/python-config.json`` (override with the
        ``PINGIO_CONFIG`` environment variable). Pass ``None`` to disable
        persistence.
    """

    def __init__(
        self,
        auth_url: str = DEFAULT_AUTH_URL,
        relay_ws_url: str = DEFAULT_RELAY_WS_URL,
        config_path: "Path | str | None | Any" = _UNSET,
        timeout: float = 30.0,
    ):
        self.auth_url = auth_url.rstrip("/")
        self.relay_ws_url = join_ws_url(relay_ws_url)
        # The relay REST API (/api/*) is served from the same origin as the
        # auth endpoints in the standard single-domain deployment.
        self.rest_url = self.auth_url + "/api"
        if config_path is _UNSET:
            override = os.environ.get(_CONFIG_ENV_VAR)
            config_path = Path(override) if override else DEFAULT_CONFIG_PATH
        self.config_path = Path(config_path) if config_path is not None else None
        self.timeout = timeout
        self._auth = AuthClient(self.auth_url, timeout=timeout)
        self._ws: RelayConnection | None = None
        self._incoming: list[dict[str, Any]] = []
        self._config: dict[str, Any] = self._load_config()

    # -- config persistence -------------------------------------------------

    def _load_config(self) -> dict[str, Any]:
        if self.config_path is None or not self.config_path.exists():
            return {}
        try:
            return json.loads(self.config_path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def _save_config(self) -> None:
        if self.config_path is None:
            return
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        self.config_path.write_text(json.dumps(self._config, indent=2), encoding="utf-8")
        try:
            os.chmod(self.config_path, 0o600)
        except OSError:
            pass

    # -- auth ----------------------------------------------------------------

    @property
    def token(self) -> str | None:
        return self._config.get("token")

    @property
    def user_id(self) -> str | None:
        return self._config.get("user_id")

    def register(
        self,
        username: str,
        password: str,
        display_name: str | None = None,
    ) -> dict[str, Any]:
        """Register a new account and persist the resulting tokens."""
        result = self._auth.register(
            username,
            password,
            display_name=display_name,
            device_fingerprint=get_device_fingerprint(),
            device_name=get_device_name(),
        )
        if not result.get("success"):
            raise AuthError(str(result.get("error", "registration failed")))
        self._store_session(result)
        return result

    def login(self, username: str, password: str) -> dict[str, Any]:
        """Log in and persist the resulting tokens."""
        result = self._auth.login(
            username,
            password,
            device_fingerprint=get_device_fingerprint(),
            device_name=get_device_name(),
        )
        if not result.get("success"):
            if result.get("verificationRequired"):
                raise AuthError(
                    f"device verification required (deviceId={result.get('deviceId')}): "
                    f"{result.get('error', 'approve this device')}"
                )
            raise AuthError(str(result.get("error", "login failed")))
        self._store_session(result)
        return result

    def whoami(self) -> dict[str, Any]:
        """Introspect the current access token.

        Returns the token claims (``active``, ``sub``, ``username``,
        ``device_id``, ``exp``). Raises :class:`AuthError` if inactive.
        """
        token = self.token
        if not token:
            raise AuthError("not logged in — call login() or register() first")
        info = self._auth.introspect(token)
        if not info.get("active"):
            raise AuthError(info.get("error") or "token is not active")
        return info

    def refresh(self) -> dict[str, Any]:
        """Rotate the access token using the stored refresh token."""
        refresh_token = self._config.get("refresh_token")
        if not refresh_token:
            raise AuthError("no refresh token stored — log in again")
        result = self._auth.refresh(refresh_token, get_device_fingerprint())
        if not result.get("success"):
            raise AuthError(str(result.get("error", "refresh failed")))
        self._store_session(result)
        return result

    def logout(self) -> None:
        """Drop stored tokens and close any open connection."""
        self.disconnect()
        self._config = {}
        if self.config_path and self.config_path.exists():
            try:
                self.config_path.unlink()
            except OSError:
                pass

    def _store_session(self, result: dict[str, Any]) -> None:
        self._config.update(
            {
                "auth_url": self.auth_url,
                "relay_ws_url": self.relay_ws_url,
                "token": result.get("token"),
                "refresh_token": result.get("refreshToken"),
                "user_id": result.get("userId"),
                "device_id": result.get("deviceId"),
            }
        )
        self._save_config()

    # -- contacts (relay REST) ----------------------------------------------

    def _require_token(self) -> str:
        token = self.token
        if not token:
            raise AuthError("Not logged in — run register() or login() first")
        return token

    def _rest(
        self,
        path: str,
        method: str = "GET",
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        url = f"{self.rest_url}{path}"
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Authorization": f"Bearer {self._require_token()}",
            },
            method=method,
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
            raise ProtocolError(message) from exc
        except urllib.error.URLError as exc:
            raise ProtocolError(f"Cannot reach relay: {exc.reason}") from exc

    def add_contact(self, username: str, custom_name: str | None = None) -> dict[str, Any]:
        """Add a user to your contacts (required before you can DM them).

        Returns the stored contact, including ``contactId`` — the id to use
        as ``recipientId`` when messaging them.
        """
        payload: dict[str, Any] = {"username": username}
        if custom_name:
            payload["customName"] = custom_name
        result = self._rest("/contacts", method="POST", payload=payload)
        return result.get("contact") or {}

    def list_contacts(self) -> list[dict[str, Any]]:
        """Return your contacts (each with ``contactId``, ``username``, presence)."""
        result = self._rest("/contacts")
        return list(result.get("contacts") or [])

    def resolve_contact(self, username: str) -> str | None:
        """Return the ``contactId`` for a contact username, or ``None``."""
        for contact in self.list_contacts():
            if contact.get("username") == username:
                cid = contact.get("contactId")
                return str(cid) if cid else None
        return None

    def resolve_recipient(self, recipient: str) -> str:
        """Resolve a ``--to`` value to a user id.

        Bare UUIDs pass through unchanged; otherwise the value is looked up
        among your contacts by username.
        """
        if _UUID_RE.match(recipient):
            return recipient
        contact_id = self.resolve_contact(recipient)
        if not contact_id:
            raise ProtocolError(
                f"@{recipient} is not in your contacts — run `pingio add-contact --username {recipient}` first"
            )
        return contact_id

    # -- websocket -----------------------------------------------------------

    @property
    def is_connected(self) -> bool:
        return self._ws is not None and self._ws.is_open

    def connect(self) -> dict[str, Any]:
        """Open the WebSocket and run the auth handshake. Returns the user."""
        token = self.token
        if not token:
            raise NotConnectedError("not logged in — call login() first")
        if self.is_connected:
            assert self._ws is not None
            return self._ws.authenticated_user or {}
        conn = RelayConnection(self.relay_ws_url, timeout=self.timeout)
        conn.open()
        try:
            user = conn.authenticate(token, get_device_fingerprint())
        except Exception:
            conn.close()
            raise
        self._ws = conn
        return user

    def disconnect(self) -> None:
        """Close the WebSocket connection if open."""
        if self._ws is not None:
            self._ws.close()
            self._ws = None

    def __enter__(self) -> "PingioClient":
        self.connect()
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.disconnect()

    # -- messaging ------------------------------------------------------------

    def send_dm(
        self,
        recipient_id: str,
        content: str,
        is_ephemeral: bool = False,
        timeout: float = 15.0,
    ) -> dict[str, Any]:
        """Send a direct message and return the stored message on success.

        The relay confirms with a ``message_sent`` frame; anything else
        (``message_error``, ``blocked``, ``not_mutual_contact`` ...) raises
        :class:`ProtocolError`.
        """
        conn = self._require_connection()
        client_message_id = str(uuid.uuid4())
        conn.send_frame(
            "message",
            {
                "recipientId": recipient_id,
                "content": content,
                "isEphemeral": is_ephemeral,
                "clientMessageId": client_message_id,
            },
        )
        import time

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            frame = conn.recv_frame(timeout=max(0.1, deadline - time.monotonic()))
            if frame is None:
                break
            ftype = frame["type"]
            payload = frame.get("payload") or {}
            if ftype == "message_sent" and payload.get("clientMessageId") == client_message_id:
                return payload.get("message") or {}
            if ftype == "message":
                self._buffer_incoming(frame)
                continue
            if ftype.endswith("error") or ftype == "error":
                raise ProtocolError(str(payload.get("error") or ftype))
        raise ProtocolError("timed out waiting for message_sent confirmation")

    def _buffer_incoming(self, frame: dict[str, Any]) -> None:
        self._incoming.append(frame)

    def receive(self, timeout: float | None = None) -> dict[str, Any] | None:
        """Return the next incoming frame ( buffered first ).

        Incoming DMs are ``type == "message"`` frames whose
        ``payload.message`` has ``sender_id``/``recipient_id``/``content``.
        Returns ``None`` on timeout.
        """
        conn = self._require_connection()
        if self._incoming:
            return self._incoming.pop(0)
        return conn.recv_frame(timeout=timeout)

    def iter_messages(self) -> Iterator[dict[str, Any]]:
        """Yield incoming frames forever (or until the connection drops)."""
        while True:
            frame = self.receive()
            if frame is None:
                continue
            yield frame

    def set_presence(self, status: str, message: str | None = None) -> None:
        """Publish presence: one of online / away / busy / offline."""
        if status not in PRESENCE_STATUSES:
            raise ValueError(f"status must be one of {PRESENCE_STATUSES}")
        conn = self._require_connection()
        payload: dict[str, Any] = {"status": status}
        if message:
            payload["message"] = message
        conn.send_frame("presence_update", payload)

    def ping(self) -> bool:
        """Liveness check: send ``ping`` and wait for ``pong``."""
        conn = self._require_connection()
        conn.send_frame("ping", {})
        import time

        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            frame = conn.recv_frame(timeout=max(0.1, deadline - time.monotonic()))
            if frame is None:
                continue
            if frame["type"] == "pong":
                return True
            self._buffer_incoming(frame)
        return False

    def _require_connection(self) -> RelayConnection:
        if not self.is_connected:
            raise NotConnectedError("not connected — call connect() first")
        assert self._ws is not None
        return self._ws
