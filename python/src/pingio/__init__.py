"""Pingio Python SDK — client for the Pingio secure messaging relay.

Protocol-compatible with the Pingio relay server (`packages/relay-server`)
and central auth server (`packages/auth-server`):

* REST auth:  POST {auth_url}/oauth/register | /oauth/login | /oauth/refresh
* Token check: POST {auth_url}/oauth/token/introspect
* WebSocket:  {relay_ws_url} (hosted default wss://pingio.ioservices.io/ws)

Every WebSocket frame is a JSON envelope::

    {"id": "<uuid4>", "type": "<type>", "timestamp": <epoch-ms>, "payload": {...}}

DM flow: authenticate with ``type: "auth"`` + ``payload {token,
deviceFingerprint}``, send with ``type: "message"`` + ``payload
{recipientId, content, isEphemeral, clientMessageId}``; the sender gets
``message_sent`` and the recipient gets ``message`` with
``payload.message``.
"""

from .client import PingioClient
from .constants import DEFAULT_AUTH_URL, DEFAULT_RELAY_WS_URL
from .device import get_device_fingerprint, get_device_name
from .errors import AuthError, NotConnectedError, PingioError, ProtocolError

__version__ = "0.1.0"
__all__ = [
    "PingioClient",
    "PingioError",
    "AuthError",
    "ProtocolError",
    "NotConnectedError",
    "get_device_fingerprint",
    "get_device_name",
    "DEFAULT_AUTH_URL",
    "DEFAULT_RELAY_WS_URL",
    "__version__",
]
