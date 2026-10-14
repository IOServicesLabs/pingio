"""Exception hierarchy for the Pingio SDK."""


class PingioError(Exception):
    """Base class for all Pingio SDK errors."""


class AuthError(PingioError):
    """Authentication or registration failed (HTTP 4xx from the auth server)."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class ProtocolError(PingioError):
    """The relay sent an error frame or violated the protocol contract."""


class NotConnectedError(PingioError):
    """An operation requiring a live WebSocket was attempted while disconnected."""
