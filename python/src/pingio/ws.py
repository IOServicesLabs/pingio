"""Synchronous WebSocket connection to the Pingio relay.

Wraps `websocket-client <https://websocket-client.readthedocs.io/>`_ and
speaks the relay's JSON envelope protocol::

    {"id": "<uuid4>", "type": "<type>", "timestamp": <epoch-ms>, "payload": {...}}
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any

from .errors import ProtocolError

# Message types that signal a server-side error for the current request.
ERROR_TYPES = {"error", "message_error", "auth_error", "validation_error"}


def make_envelope(msg_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Build a protocol frame the way the relay expects it."""
    return {
        "id": str(uuid.uuid4()),
        "type": msg_type,
        "timestamp": int(time.time() * 1000),
        "payload": payload,
    }


def _is_timeout(exc: BaseException) -> bool:
    """True for websocket-client's timeout exception without a hard import."""
    try:
        import websocket

        return isinstance(exc, websocket.WebSocketTimeoutException) or isinstance(exc, TimeoutError)
    except ImportError:
        return isinstance(exc, TimeoutError)


class RelayConnection:
    """One authenticated WebSocket session with a Pingio relay."""

    def __init__(self, ws_url: str, timeout: float = 30.0):
        self.ws_url = ws_url
        self.timeout = timeout
        self._ws: Any = None  # websocket.WebSocket
        self.authenticated_user: dict[str, Any] | None = None

    # -- lifecycle ---------------------------------------------------------

    def open(self) -> None:
        """Open the TCP/TLS + WS handshake (does not authenticate)."""
        if self._ws is not None:
            return
        try:
            import websocket
        except ImportError as exc:  # pragma: no cover - dependency guard
            raise ProtocolError(
                "websocket-client is required: pip install websocket-client"
            ) from exc
        self._ws = websocket.create_connection(self.ws_url, timeout=self.timeout)
        self._ws.settimeout(self.timeout)

    def close(self) -> None:
        """Close the socket if open; safe to call repeatedly."""
        ws, self._ws = self._ws, None
        self.authenticated_user = None
        if ws is not None:
            try:
                ws.close()
            except Exception:
                pass

    @property
    def is_open(self) -> bool:
        return self._ws is not None

    # -- framed IO ---------------------------------------------------------

    def send_frame(self, msg_type: str, payload: dict[str, Any]) -> str:
        """Send one protocol frame; returns its envelope id."""
        self._require_open()
        envelope = make_envelope(msg_type, payload)
        self._ws.send(json.dumps(envelope))
        return envelope["id"]

    def recv_frame(self, timeout: float | None = None) -> dict[str, Any] | None:
        """Receive the next frame.

        Returns ``None`` when ``timeout`` elapses with nothing received.
        Raises :class:`ProtocolError` on malformed JSON or an empty socket.
        """
        self._require_open()
        old_timeout = self._ws.gettimeout()
        if timeout is not None:
            self._ws.settimeout(timeout)
        try:
            raw = self._ws.recv()
        except Exception as exc:
            if _is_timeout(exc):
                return None
            raise
        finally:
            if timeout is not None and self._ws is not None:
                self._ws.settimeout(old_timeout)
        if raw is None or raw == "":
            raise ProtocolError("relay closed the WebSocket connection")
        try:
            frame = json.loads(raw)
        except ValueError as exc:
            raise ProtocolError(f"invalid frame from relay: {raw[:200]!r}") from exc
        if not isinstance(frame, dict) or "type" not in frame:
            raise ProtocolError(f"malformed frame from relay: {frame!r}")
        return frame

    # -- handshake ---------------------------------------------------------

    def authenticate(self, token: str, device_fingerprint: str | None, timeout: float = 15.0) -> dict[str, Any]:
        """Perform the ``auth`` handshake and return the authenticated user."""
        payload: dict[str, Any] = {"token": token}
        if device_fingerprint:
            payload["deviceFingerprint"] = device_fingerprint
        self.send_frame("auth", payload)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            frame = self.recv_frame(timeout=max(0.1, deadline - time.monotonic()))
            if frame["type"] != "auth_response":
                continue
            resp = frame.get("payload") or {}
            if not resp.get("success"):
                raise ProtocolError(
                    resp.get("error") or "authentication rejected by relay",
                )
            self.authenticated_user = resp.get("user") or {}
            return self.authenticated_user
        raise ProtocolError("timed out waiting for auth_response")

    # -- helpers -----------------------------------------------------------

    def _require_open(self) -> None:
        if self._ws is None:
            from .errors import NotConnectedError

            raise NotConnectedError("not connected — call connect() first")
