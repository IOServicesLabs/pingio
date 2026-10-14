# pingio — Python client SDK

Python client for the [Pingio](https://github.com/IOServicesLabs/pingio) secure
messaging relay: register/login against the central auth server, connect over
WebSocket, and send/receive direct messages with presence.

The hosted endpoint is `https://pingio.ioservices.io` (auth at `/oauth/*`,
relay WebSocket at `wss://pingio.ioservices.io/ws`) — the defaults, so the
client works out of the box against the hosted service, or point it at your
own deployment.

## Install

```bash
pip install pingio
```

Only dependency: [`websocket-client`](https://websocket-client.readthedocs.io/).
Python 3.9+.

## CLI

```bash
pingio register --username alice --display-name "Alice A"
pingio login --username alice          # password prompted if omitted
pingio whoami                          # introspect the stored token
pingio send --to 9f1c... --message "hello from python"
pingio receive                         # stream incoming DMs until Ctrl+C
pingio logout
```

The same works via `python -m pingio ...`. Tokens are stored in
`~/.pingio/python-config.json` (mode 0600) between runs. Use `--auth-url` /
`--relay-url` to target a self-hosted relay.

## Library

```python
from pingio import PingioClient

client = PingioClient()                       # hosted defaults
client.register("alice", "s3cret-password")   # or client.login(...)
print(client.whoami())

with client:                                  # connect() + auth handshake
    client.set_presence("online")
    message = client.send_dm("9f1c2e...", "hello from python")
    print("stored as", message["id"])

    frame = client.receive(timeout=30)        # next incoming protocol frame
    if frame and frame["type"] == "message":
        print("DM:", frame["payload"]["message"]["content"])
```

## Protocol notes

WebSocket frames are JSON envelopes
`{"id": <uuid4>, "type": <type>, "timestamp": <epoch-ms>, "payload": {...}}`:

- auth: `type="auth"`, `payload={token, deviceFingerprint}` → `auth_response`
- DM send: `type="message"`,
  `payload={recipientId, content, isEphemeral, clientMessageId}` →
  `message_sent` for the sender; the recipient receives `type="message"`
  with `payload.message`
- presence: `type="presence_update"`, `payload={status, message}` with
  status `online | away | busy | offline`
- liveness: `type="ping"` → `type="pong"`

The device fingerprint mirrors the TypeScript client
(`packages/mcp-server`) so the auth server's device verification treats this
client the same way.

## Development

```bash
pip install -e .
python -m unittest discover -s tests -v
```

## License

MIT — see [LICENSE](LICENSE).
