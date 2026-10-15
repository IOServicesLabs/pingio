# Pingio

A messaging and communication system that operates inside LLM chat sessions and terminals using the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). Pingio can run as a managed cloud service, a private self-hosted relay, or a fully local development stack.

## Send your first message (2 minutes)

Everything defaults to the hosted server at `https://pingio.ioservices.io` — no config, no server to run. (Self-hosting options are [below](#deployment-modes).)

**From your terminal:**

```bash
pip install pingio

# create your account
python -m pingio register --username alice --password yourpassword

# both of you run this for each other, then you can message
python -m pingio add-contact --username bob

python -m pingio send --to bob --message "hey bob!"
python -m pingio receive   # wait for replies (Ctrl+C to quit)
```

**From Claude Code (or any MCP client):**

```bash
npm i -g pingio-mcp-server
claude mcp add pingio -- pingio
```

Then in the chat: `register_user` → `add_contact` → `send_message` → `get_history`.

> Both installs ship a `pingio` command. If you install both, use `python -m pingio ...` for the Python CLI. To use your own relay instead of the hosted one, set `PINGIO_CLOUD_ENDPOINT` (MCP server) or `--auth-url/--relay-url` (Python CLI).

## Architecture

```
┌─────────────────┐      ┌───────────────────┐      ┌─────────────────┐
│   MCP Client    │◄────►│    MCP Server     │◄────►│  Auth Server    │
│ (Claude/Cursor/ │      │pingio-mcp-server │      │ (OAuth2/OIDC    │
│  Windsurf/etc.) │      │                   │      │   authority)    │
└─────────────────┘      └───────────────────┘      └─────────────────┘
                                 │
                                 ▼
                      ┌──────────────────────┐
                      │     Relay Server     │
                      │ @pingio/relay-server │
                      └──────────────────────┘
                                 │
                      ┌──────────┴──────────┐
                      ▼                     ▼
                ┌──────────┐          ┌──────────┐
                │ Postgres │          │  Redis   │
                └──────────┘          └──────────┘
```

The monorepo contains four packages:

| Package | Path | Purpose |
|---|---|---|
| `pingio-mcp-server` | `packages/mcp-server` | User-installed MCP server that exposes `register_user`, `send_message`, `create_channel`, etc. |
| `@pingio/auth-server` | `packages/auth-server` | Central OAuth2/OIDC authority. Issues RS256 access tokens and publishes a JWKS endpoint. |
| `@pingio/relay-server` | `packages/relay-server` | Messaging relay with REST + WebSocket endpoints. Can run in `local` or `central` auth mode. |
| `@pingio/shared` | `packages/shared` | Common types, schemas, constants, and utilities. |

## Deployment Modes

1. **Local development** — everything on your laptop via Docker Compose; relay handles its own auth (`AUTH_MODE=local`).
2. **Fresh server / VPS** — full internet-ready stack with TLS using Docker Compose + Caddy; separate auth + relay (`AUTH_MODE=central`).
3. **Managed platforms** — Railway, Render, or Fly.io using the provided config files.
4. **Cloudflare in front** — put your self-hosted or VPS server behind Cloudflare DNS or a Cloudflare Tunnel (the stack itself cannot run on Cloudflare Workers as-is; see below).

## Requirements

- Node.js `>=20` (LTS recommended)
- npm `>=10`
- Docker + Docker Compose (for server deployments)
- A publicly reachable server with ports `80`/`443` open (for VPS installs)
- DNS records pointing at your server (for TLS):
  - `auth.yourdomain.com` → your server
  - `relay.yourdomain.com` → your server

## Option 1 — Fresh Server Install (VPS + Docker Compose + Caddy)

This is the recommended path if you want a public, TLS-secured Pingio deployment that you control.

### 1. Clone the repo

```bash
git clone https://github.com/IOServicesLabs/pingio.git
cd pingio
```

### 2. Configure the environment

```bash
cp infrastructure/docker/.env.example infrastructure/docker/.env
# edit infrastructure/docker/.env
```

At minimum set:

```ini
POSTGRES_PASSWORD=<strong-random-password>
JWT_SECRET=$(openssl rand -base64 32)

AUTH_DOMAIN=auth.yourdomain.com
RELAY_DOMAIN=relay.yourdomain.com

AUTH_ISSUER=https://auth.yourdomain.com
RELAY_URL=wss://relay.yourdomain.com/ws
```

Leave `AUTH_MODE` out of this file — `docker-compose.prod.yml` forces `central` for the relay.

### 3. Start the stack

```bash
cd infrastructure/docker
docker compose -f docker-compose.prod.yml up -d
```

This starts:

- Postgres (`postgres:16-alpine`)
- Redis (`redis:7-alpine`)
- Auth server on internal port `3001`
- Relay server on internal port `3000` in `AUTH_MODE=central`
- Caddy reverse proxy with automatic HTTPS on ports `80`/`443`

### 4. Verify

```bash
# Auth server health
curl https://auth.yourdomain.com/health

# JWKS endpoint
curl https://auth.yourdomain.com/.well-known/jwks.json

# Relay health (should report authMode: central)
curl https://relay.yourdomain.com/health

# Auto-discovery metadata
curl https://auth.yourdomain.com/.well-known/pingio
```

### 5. Configure your MCP client

Use the MCP server from the published npm package or from the local build. Add it to your client config:

```json
{
  "pingio": {
    "command": "npx",
    "args": ["-y", "pingio-mcp-server"],
    "env": {
      "PINGIO_MODE": "cloud",
      "PINGIO_CLOUD_ENDPOINT": "https://auth.yourdomain.com"
    }
  }
}
```

> The MCP server stores its persistent config in `~/.pingio/config.json` and will discover the relay URL automatically from `/.well-known/pingio`.

### Single-domain variant

If you'd rather run everything under one hostname (e.g. `pingio.ioservices.io` instead of `auth.` + `relay.` subdomains), a path-based Caddyfile and a compose override are included. Routing: `/ws` + `/api/*` → relay, `/oauth/*` + `/.well-known/*` + `/api/federation/*` → auth.

In `.env`, set one name for **all three** variables:

```ini
SINGLE_DOMAIN=pingio.ioservices.io
AUTH_ISSUER=https://pingio.ioservices.io
RELAY_URL=wss://pingio.ioservices.io/ws
```

Then start with the override file:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.single.yml up -d --build
```

Users point their MCP client at the same name (`PINGIO_CLOUD_ENDPOINT=https://pingio.ioservices.io`) — discovery works exactly as before. Notes for this mode:

- External `GET /health` answers from the **auth** server (the relay's health stays available inside the compose network and via `docker inspect` health status).
- The relay's own `/.well-known/pingio` self-description is not publicly reachable (all `/.well-known` goes to the auth server, whose document is the one clients actually fetch). Only relevant if you later join a multi-relay federation as an external node — pool nodes need their own hostname.

## Option 2 — Local Development Install

For hacking on the code or running a private LAN relay.

```bash
git clone https://github.com/IOServicesLabs/pingio.git
cd pingio
npm install
```

Build all packages from the root (turbo resolves the dependency order):

```bash
npm run build
```

### Run the local Docker stack (self-contained relay auth)

```bash
cd infrastructure/docker
cp .env.example .env
# set JWT_SECRET and POSTGRES_PASSWORD
docker compose up -d
```

The relay listens on `http://localhost:5000` (the compose file maps host 5000 → container 3000) and the WebSocket path is `ws://localhost:5000/ws`. The relay runs in `local` auth mode, so no separate auth container is started.

### Run tests

```bash
# Integration tests (requires Docker)
npm run test:integration

# Unit tests per package
npm run test --workspace=@pingio/auth-server
npm run test --workspace=@pingio/relay-server
npm run test --workspace=pingio-mcp-server
```

## Option 3 — Managed Cloud Platforms

### Railway

Two services are needed because Railway configs are per-service:

1. Create a Railway project from this repo.
2. Add a service using `railway.auth.json` as the config file.
3. Add a second service using `railway.json` as the config file.
4. Set the environment variables from `infrastructure/docker/.env.example` in Railway.
5. Point your DNS at Railway's generated domains or attach custom domains.

### Render

1. Create a new **Blueprint** in Render.
2. Paste your repo URL and select `render.yaml`.
3. Update the placeholder domains (`pingio-auth.onrender.com`, `pingio-relay.onrender.com`) to match your actual Render apps.
4. Deploy.

### Fly.io

```bash
# Auth app
fly deploy --config fly.auth.toml

# Relay app
fly deploy --config fly.toml
```

Then provision Postgres + Redis and attach them:

```bash
fly postgres create --name pingio-db
fly postgres attach --app pingio-auth pingio-db
fly postgres attach --app pingio-relay pingio-db
fly redis create --name pingio-redis
fly secrets set --app pingio-relay REDIS_URL=<redis-url>
```

## Option 4 — Cloudflare

### Can I run this on Cloudflare Workers?

**Not directly.** Pingio currently relies on:

- Long-lived WebSocket connections handled by `@fastify/websocket`
- Node.js libraries (`bcrypt`, `jsonwebtoken`, `pg`, `ioredis`, `uuid`)
- Persistent Postgres and Redis

These are not compatible with the Cloudflare Workers runtime as-is. A native Workers port would require rewriting the relay around Durable Objects + D1 and replacing the crypto/DB dependencies.

### Putting Pingio behind Cloudflare

You can still use Cloudflare as the public edge for a self-hosted or VPS deployment:

1. Point `auth.yourdomain.com` and `relay.yourdomain.com` DNS records at your origin server.
2. Enable the orange cloud (proxied) in Cloudflare DNS.
3. Set SSL/TLS mode to **Full (strict)** if your origin has its own certificate (Caddy/Let's Encrypt), or **Full** if not.
4. Make sure WebSockets are enabled (they are by default on all paid and free plans).

If your origin is behind CGNAT or a firewall, use a **Cloudflare Tunnel**:

```bash
# On the server running Pingio
cloudflared tunnel create pingio
cloudflared tunnel route dns pingio auth.yourdomain.com
cloudflared tunnel route dns pingio relay.yourdomain.com
cloudflared tunnel run pingio
```

Your `config.yml` for the tunnel should look like:

```yaml
tunnel: <tunnel-id>
credentials-file: /path/to/<tunnel-id>.json

ingress:
  - hostname: auth.yourdomain.com
    service: http://localhost:3001
  - hostname: relay.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
```

This keeps your origin machine private while still exposing auth + relay through Cloudflare.

## Federation (multi-relay network)

One auth server can anchor a whole pool of relays run by different operators: relays register with the auth server, heartbeat their running version, and clients discover the pool via `/.well-known/pingio` and fail over automatically. A network-wide version policy gives lagging nodes a grace period (default 72h) and then decommissions them, and nodes can opt into signed auto-updates (RS256 manifest + SHA-256-pinned artifact, applied via supervisor restart).

```bash
# On each relay node:
AUTH_MODE=central
CENTRAL_AUTH_ISSUER=https://auth.yourdomain.com
FEDERATION_ENABLED=true
FEDERATION_BOOTSTRAP_TOKEN=<network token>
FEDERATION_AUTO_UPDATE=true   # opt-in

# On the auth server:
FEDERATION_BOOTSTRAP_TOKEN=<network token>   # unset = open registration
FEDERATION_ADMIN_TOKEN=<admin token>         # enables the policy/fleet admin API
```

Full protocol, trust model, and operator runbook: [docs/FEDERATION.md](docs/FEDERATION.md).

## Claude Code / Codex Plugin

The easiest way to use Pingio from Claude Code or Codex is the bundled plugin — it packages the MCP server, a usage skill for the agent, and `/pingio:setup` + `/pingio:status` slash commands (Claude Code).

**Claude Code:**

```text
/plugin marketplace add IOServicesLabs/pingio
/plugin install pingio@pingio
```

**Codex:**

```text
codex plugin marketplace add IOServicesLabs/pingio
```

then enable it in `~/.codex/config.toml`:

```toml
[plugins."pingio@pingio"]
enabled = true
```

The plugin launcher runs the published `npx -y pingio-mcp-server`, or a local build automatically when used from a clone (`npm run build --workspace=@pingio/shared --workspace=pingio-mcp-server`, then `claude --plugin-dir ./plugins/pingio`). Details: [plugins/pingio/README.md](plugins/pingio/README.md). Validate the packaging with `npm run test:plugin`.

## MCP Client Configuration

The MCP server reads configuration from `~/.pingio/config.json`. You can also seed it with environment variables:

| Env var | Effect |
|---|---|
| `PINGIO_MODE` | `cloud`, `self-hosted`, or `auto` |
| `PINGIO_CLOUD_ENDPOINT` | Base URL of the auth service (e.g. `https://auth.yourdomain.com`) |
| `PINGIO_CLOUD_RELAY_URL` | Optional override for the relay WebSocket URL |
| `PINGIO_SELF_HOSTED_RELAY_URL` | Relay URL in self-hosted mode (e.g. `ws://localhost:5000/ws`) |
| `PINGIO_SELF_HOSTED_AUTH_URL` | Optional auth-server URL in self-hosted mode (when the relay doesn't serve auth) |
| `PINGIO_ENABLE_LOCAL_P2P` | `true`/`false` — try LAN P2P before using the relay |

Example Claude Desktop / Cursor / Windsurf config:

```json
{
  "mcpServers": {
    "pingio": {
      "command": "npx",
      "args": ["-y", "pingio-mcp-server"],
      "env": {
        "PINGIO_MODE": "cloud",
        "PINGIO_CLOUD_ENDPOINT": "https://auth.yourdomain.com"
      }
    }
  }
}
```

For self-hosted:

```json
{
  "mcpServers": {
    "pingio": {
      "command": "npx",
      "args": ["-y", "pingio-mcp-server"],
      "env": {
        "PINGIO_MODE": "self-hosted",
        "PINGIO_SELF_HOSTED_RELAY_URL": "ws://localhost:5000/ws"
      }
    }
  }
}
```

## Enterprise SSO

The auth server can act as a confidential OIDC **client** to upstream corporate
identity providers (Okta, Microsoft Entra ID, Google Workspace, Keycloak, ...),
so companies can use Pingio for internal chats with their existing accounts —
like Slack/Teams sign-in, but in the terminal.

### Configure a provider (operator)

Set `SSO_PROVIDERS` on the auth server to a JSON array:

```bash
SSO_PROVIDERS='[{"slug":"acme","name":"Acme Corp SSO","issuerUrl":"https://login.microsoftonline.com/<tenant-id>/v2.0","clientId":"<client-id>","clientSecret":"<client-secret>","allowedDomains":["acme.com"]}]'
```

| Field | Description |
|---|---|
| `slug` | URL-safe identifier (a-z, 0-9, hyphen), unique per provider |
| `name` | Display name shown to users |
| `issuerUrl` | OIDC issuer URL (no trailing slash); discovery is fetched from `<issuerUrl>/.well-known/openid-configuration` and the discovered `issuer` must match |
| `clientId` / `clientSecret` | App registration credentials |
| `allowedDomains` | Optional email-domain allowlist (case-insensitive) |

Register this redirect URI at the IdP for each provider:

```
https://<your-auth-domain>/oauth/sso/<slug>/callback
```

### Log in (user)

```
list_sso_providers()                  → see configured providers
login_sso(provider="acme")            → returns a browser URL
# ...complete SSO in the browser; the page shows a one-time code...
complete_sso_login(code="XXXX-XXXX-XXXX")  → logged in, token pair issued
```

### Security properties

- Authorization Code flow with **PKCE** and **nonce**; state, nonce, PKCE
  verifier, and the one-time code live only server-side and are stored as
  SHA-256 hashes. State (10 min) and codes (5 min) are consumed atomically —
  single-use, no replay.
- `id_token` signature is verified against the upstream JWKS (fetched with a
  10 s timeout, cached 10 min, one forced refetch on failure for key rotation);
  `iss`, `aud`, `exp`, and `nonce` are all enforced.
- First login **JIT-provisions** a Pingio account (username derived from the
  IdP profile). SSO-only users get a random unexposed password hash, so
  password login is impossible for them. A new identity is linked to an
  existing account only via an **IdP-verified** email that matches another
  verified SSO identity — unverified email claims are never used for linking.
- Devices created via SSO are marked verified (the IdP already strongly
  authenticated the session; a first-time SSO user has no trusted device that
  could approve a new one). The per-user device cap still applies.
- SSO endpoints exist only on the central auth server (cloud mode); self-hosted
  relays keep password auth.

## Channel End-to-End Encryption

Channels can be made **server-blind**: messages are encrypted on the sender's
device with a per-channel AES-256-GCM key and the relay stores and forwards
only ciphertext envelopes. Channel keys never touch the server — members share
them via wrapped key shares (ephemeral-static X25519 ECDH + HKDF-SHA256 +
AES-256-GCM), so neither the relay operator nor the database can read
encrypted channels.

### Usage

```
create_channel(name="vault", displayName="Vault", encrypted=true)
                                      → channel created encrypted, key generated + distributed
enable_channel_encryption(channelId)  → admin: turn on E2E for an existing channel;
                                        member: re-share the key to newly joined members
publish_encryption_key()              → publish your identity key (needed to receive shares)
sync_channel_keys(channelId?)         → fetch + unwrap your pending key shares
                                        (new device, or after joining an encrypted channel)
rotate_channel_key(channelId)         → distribute a fresh key (old messages stay readable)
```

Sending to an encrypted channel is transparent: `send_channel_message`
encrypts automatically when you hold the key (and refuses to send plaintext if
the channel is encrypted but you don't). Incoming messages and
`get_channel_history` decrypt automatically; envelopes you can't read show a
placeholder pointing at `sync_channel_keys`. `list_channels` marks encrypted
channels with 🔒.

### Security properties

- **Identity**: each device generates an X25519 keypair
  (`~/.pingio/e2e-identity.json`, mode 0600); only the public key is
  uploaded. Channel keys are cached locally in
  `~/.pingio/channel-keys.json` (mode 0600).
- **Message encryption**: AES-256-GCM with a random 256-bit channel key,
  random 96-bit nonce, and the channel ID as AAD (ciphertext can't be replayed
  into another channel). `keyId = sha256(key)[:16]` identifies which key
  decrypts a message, so rotation keeps history readable.
- **Key wrapping**: fresh ephemeral X25519 pair per share; the wrap key is
  HKDF-SHA256(ECDH shared secret, salt = ephemeral‖member public keys,
  info = `pingio-channel-key-wrap`); the share's AAD binds it to
  `(keyId, userId)` so shares can't be rebound to another member or key.
- **Relay-side checks**: publishing keys and posting shares require auth;
  share targets must be channel members; only the member who created a share
  can replace it (409 otherwise — use `rotate_channel_key`); enabling
  encryption is admin-only and one-way (no downgrade).
- **Limits**: encrypted plaintext is capped at 2800 chars so the envelope fits
  the 4096-char message wire limit. Members who never publish an identity key
  cannot receive shares — the enable/rotate output lists them.
- **Trust model**: members hold the channel key, so any member can read all
  history and re-share the key. A compromised member compromises the channel —
  rotate the key and remove them. The relay authenticates and authorizes but
  cannot read content.

## Direct Message Encryption

DMs are end-to-end encrypted **automatically** between users who have
published an encryption identity (`publish_encryption_key`) — nothing to
enable per conversation:

- **Pairwise keys**: static-static X25519 ECDH between the two parties'
  identity keys, then HKDF-SHA256 (salt `pingio-dm-v1`, info =
  `pingio-dm:<sorted user ids>`). Both sides derive the identical 256-bit
  key independently — no key ever crosses the wire, and the relay only ever
  sees the same ciphertext envelope format as encrypted channels.
- **Transparent send path**: `send_message` encrypts when the peer has a
  published key and appends 🔒 to the confirmation; when they don't, the
  message goes in plaintext (with no 🔒). If the peer's key can't be verified
  or encryption fails, the send **fails closed** — no silent plaintext
  downgrade. Local history always stores plaintext on your own device.
- **Automatic read path**: incoming messages and `get_history` decrypt
  envelopes inline (🔒 prefix). If the peer rotated their identity, the key is
  refetched once; old envelopes that no longer decrypt show a placeholder.
- **Pair binding**: the sorted user-ID pair is the envelope's AAD, so
  ciphertext can't be replayed into a different conversation.
- **Verification**: `dm_encryption_status(username)` shows both identity
  fingerprints plus the pairwise **safety number** (the derived keyId, equal on
  both sides). Compare it with your peer out-of-band to detect a relay
  substituting keys — the same ceremony as Signal's safety numbers.

```
dm_encryption_status(username)   → fingerprints + safety number for a DM peer
```

## Channel Roles, Member Management & Audit Log

Every channel member has a role: **owner** (the creator, exactly one per
channel), **admin**, or **member** (default). The relay enforces the hierarchy
server-side:

- **Admins** manage the membership: invite, enable encryption, and kick
  members (but not other admins). Granting or revoking admin is owner-only.
- **The owner** can do everything admins can, plus grant/revoke admin, kick
  admins, and transfer ownership (`role: 'owner'` on another member — the old
  owner becomes an admin). The owner can never be kicked or demoted by anyone
  else, and cannot leave while other members remain (transfer ownership first,
  or be the last one out).

```
kick_channel_member(channelId, username)        → remove a member (admin+)
set_channel_member_role(channelId, username, role)  → member/admin (owner manages admins);
                                                      role 'owner' transfers ownership
get_channel_audit_log(channelId, limit?)        → read the audit log (owner/admin only)
```

All security-relevant events — channel creation, joins, leaves, kicks, role
changes, invite creation/use, encryption enablement, key-share posts, and
retention changes — are
written to a per-channel **audit log** (`channel_audit_events` table) with
actor, target, and metadata. The log is readable only by the channel's owner
and admins via `GET /api/channels/:id/audit` (or the `get_channel_audit_log`
MCP tool), newest first. The log contains metadata only — never message
content or key material — and invite codes are recorded by suffix only, so an
active code in the log can't be reused.

## Message Retention

For compliance and data-minimization, the relay can purge old messages on a
schedule — a sweeper runs at startup and then hourly:

- **Server-wide default**: set `MESSAGE_RETENTION_MINUTES` on the relay (0 =
  keep forever, the default). It applies to all channels without an override
  *and* to direct messages.
- **Per-channel override**: channel owners/admins set their own TTL, which
  takes precedence over the server default:

```
set_channel_retention(channelId, retentionMinutes=10080)   → keep 7 days
set_channel_retention(channelId)                           → clear override, inherit default
```

Retention is a **hard delete** — purged messages are gone from the database,
not soft-deleted. Changes are written to the channel audit log
(`retention_changed`). Allowed range: 1 hour to ~1 year (60–527040 minutes).
For E2E-encrypted channels the relay only ever held ciphertext, but retention
still bounds how long that ciphertext (and its metadata) exists.

## Presence

Presence is live and session-based: you are `online` while your WebSocket is
connected and `offline` when your last session closes (multi-device safe).

```
set_status("busy", "in a meeting")     → online / away / busy / offline + optional message
get_user_status("bob")                 → a mutual contact's live status
list_contacts()                        → includes each contact's presence
typing("bob")                          → DM typing indicator
```

Presence is **contacts-scoped**: `GET /api/users/:id/presence` only answers for
yourself or a mutual contact, so nobody can stalk a stranger's online status.
Users with no live session and no stored record read as `offline`.

## Work-Context Sharing (Pair Programming)

Members of a conversation can share a live, self-expiring snapshot of what
they're working on — the MCP-native equivalent of "what are you on right now?"
for remote pair programming:

```
share_context(channelId=..., summary="Fixing the WS reconnect race",
              status="working", files=["src/relay.ts"], ttlMinutes=120)
share_context(channelId=..., summary="...", includeGit=true)      → attach git state
share_context(recipient="bob", summary="Reviewing the auth PR")   → DM scope
get_shared_context(channelId=... | contact="bob")                 → read live snapshots
request_context_share(channelId=..., targetUsername="alice")      → ask a member
stop_sharing_context(channelId=... | recipient="bob")             → revoke early
```

- **Ephemeral by design**: every share has a TTL (default 4h, max 24h) and one
  live share per user per scope — re-sharing replaces the previous snapshot.
  Revocation is instant.
- **Git auto-capture (opt-in)**: pass `includeGit: true` to attach the local
  working-tree state — branch, dirty flag, up to 20 changed file paths and a
  short diff stat — captured from the MCP server's current working directory.
  Handy for pair programming ("which branch are you on?"), and off by default
  since it exposes repo metadata to the conversation. If git is unavailable or
  the cwd is not a repo, the share goes through without it.
- **Live inbox**: incoming shares, share requests and revokes surface in your
  MCP client as log notifications, so you see teammates' snapshots without
  polling.
- **Agent auto-answer (opt-in)**: with agent mode on, set
  `autoShareContext: true` (`enable_agent_mode` / `configure_agent`) and the
  agent answers incoming `request_context_share` events by composing a fresh
  `share_context` snapshot itself. Off by default — it exposes your current
  work, so it is a per-chat explicit choice. Auto-answers are rate-limited to
  one per minute per chat, never fire for your own requests, and honor
  `targetUsername` addressing in channels. The agent still stays inside its
  `allowedTools` list, so remove `share_context` from it to make the agent
  answer requests with a plain message instead.

## Environment Variable Reference

### Auth server (`packages/auth-server`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATABASE_URL` | — | Postgres connection string |
| `ISSUER` | `http://localhost:3001` | OIDC issuer / `iss` claim |
| `AUDIENCE` | `pingio-relay` | OIDC audience / `aud` claim |
| `RELAY_ID` | — | Optional relay UUID for federation hooks |
| `RELAY_URL` | `ws://localhost:3000/ws` | Relay WebSocket URL returned by discovery |
| `DEVICE_VERIFICATION_REQUIRED` | `false` | Require approval for new devices |
| `MAX_DEVICES_PER_USER` | `5` | Per-user device cap |
| `ACCESS_TOKEN_EXPIRY_MINUTES` | `60` | Access token lifetime |
| `REFRESH_TOKEN_EXPIRY_DAYS` | `30` | Refresh token lifetime |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-*` headers |
| `CORS_ORIGIN` | `true` | CORS origin(s); set to `false` in production |
| `SSO_PROVIDERS` | — | JSON array of upstream OIDC providers (enterprise SSO) |

### Relay server (`packages/relay-server`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP/WebSocket port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATABASE_URL` | — | Postgres connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `AUTH_MODE` | `local` | `local` (symmetric JWT) or `central` (JWKS from auth server) |
| `JWT_SECRET` | — | Required when `AUTH_MODE=local` |
| `CENTRAL_AUTH_ISSUER` | — | Required when `AUTH_MODE=central` |
| `CENTRAL_AUTH_AUDIENCE` | `pingio-relay` | Audience for RS256 tokens |
| `RELAY_ID` | — | Optional relay UUID |
| `RELAY_HOST` | `localhost` | Host used in `/.well-known/pingio` |
| `DEVICE_VERIFICATION_REQUIRED` | `false` | In `local` mode, require device verification (in `central` mode the auth server enforces this) |
| `MAX_DEVICES_PER_USER` | `5` | Device cap in `local` mode (no-op in `central` mode) |
| `ACCESS_TOKEN_EXPIRY_MINUTES` | `60` | Token lifetime in `local` mode |
| `MESSAGE_RETENTION_MINUTES` | `0` | Server-wide message TTL (0 = keep forever); channels can override |
| `REFRESH_TOKEN_EXPIRY_DAYS` | `30` | Refresh lifetime in `local` mode |
| `TRUST_PROXY` | `false` | Trust proxy headers |
| `CORS_ORIGIN` | `true` in development, `false` when `NODE_ENV=production` | CORS origin(s) |

### MCP server (`packages/mcp-server`)

| Variable | Default | Description |
|---|---|---|
| `PINGIO_MODE` | `auto` | `cloud`, `self-hosted`, or `auto` |
| `PINGIO_CLOUD_ENDPOINT` | — | Base URL of the central auth service |
| `PINGIO_CLOUD_RELAY_URL` | — | Optional override for the relay WebSocket URL |
| `PINGIO_SELF_HOSTED_RELAY_URL` | `ws://localhost:5000/ws` | Relay URL in self-hosted mode |
| `PINGIO_ENABLE_LOCAL_P2P` | `true` | Try LAN P2P before using the relay |
| `LOCAL_ARTIFACT_DIR` | `~/.pingio/artifacts` | Build-group artifact storage path |
| `MAX_ARTIFACT_MESSAGE_SIZE` | `1048576` | Max artifact payload size in bytes (1 MB) |
| `ARTIFACT_CLEANUP_INTERVAL_HOURS` | `1` | How often to run artifact cleanup |
| `ARTIFACT_MAX_AGE_HOURS` | `24` | Remove artifact files older than this |

## Database Migrations

Both the auth server and relay server set up their schemas automatically on startup — the auth server runs the SQL files in its `migrations/` directory (in sorted order), and the relay applies its schema from inline DDL in `PostgresStore.init()`. For production, you may want to run them manually or pin schema versions.

Migration SQL files (auth server):

- `packages/auth-server/src/migrations/001_initial.sql`
- `packages/auth-server/src/migrations/002_sso.sql` (enterprise SSO identities + login flow state)

## Building (Turbo)

The repo uses npm workspaces orchestrated by `turbo` from the root:

```bash
npm run build       # all packages, dependency order
npm test            # all unit suites
npm run typecheck   # all packages
```

If the `turbo` binary fails to start, its platform package may be missing from
`node_modules` (npm occasionally skips optional dependencies). Reinstall it,
e.g. on Windows: `npm install turbo-windows-64 --no-save`. Every task also
remains runnable per package as a fallback:

```bash
npm run build --workspace=@pingio/shared
npm run build --workspace=@pingio/auth-server
npm run build --workspace=@pingio/relay-server
npm run build --workspace=pingio-mcp-server
```

## Running Tests

```bash
# Unit tests
npm run test --workspace=@pingio/auth-server     # 98 tests
npm run test --workspace=@pingio/relay-server    # 206 tests
npm run test --workspace=pingio-mcp-server      # 267 tests

# Integration tests (Docker required)
npm run test:integration                                # 29 tests
```

Smoke-test a running relay end to end (registration → mutual contacts → DM over
WebSocket): `./test-messaging.sh` (bash + curl + jq + node) or
`pwsh -File ./test-messaging.ps1` (Windows, REST surface only).

## Upgrading

1. Pull the latest code.
2. Review `.env.example` for new required variables.
3. Rebuild images:
   ```bash
   cd infrastructure/docker
   docker compose -f docker-compose.prod.yml down
   docker compose -f docker-compose.prod.yml up --build -d
   ```
4. Restart your MCP client so it picks up any new tool schema.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `authMode: local` when you expected `central` | `AUTH_MODE` not set to `central` or env file not loaded | Check `docker-compose.prod.yml` or platform env vars |
| `Invalid auth payload` on WebSocket connect | `deviceFingerprint: null` sent during auth | Update MCP server; it should send `undefined` instead of `null` |
| `Connection is closed` errors during tests | Redis closed before WS cleanup | Already handled; pull latest |
| Cannot register user — username taken | Global uniqueness on central auth | Try one of the suggested usernames returned by the auth server |
| Relay can't reach auth JWKS | `CENTRAL_AUTH_ISSUER` mismatch or network issue | Verify `ISSUER` on auth server equals `CENTRAL_AUTH_ISSUER` on relay |
| Caddy fails to get certificate | DNS not pointing at server or port 80 blocked | Check A/AAAA records and firewall |
| `Refusing to start: JWT_SECRET is unset or still the known default` | Production boot guard (`NODE_ENV=production`, `AUTH_MODE=local`) | Set a strong `JWT_SECRET`: `openssl rand -base64 32` |

## Agent Mode

Any DM or channel can be turned into an autonomous sub-agent. When agent mode is enabled for a chat, incoming messages in that chat are passed to the host LLM via MCP sampling (`sampling/createMessage`). The agent can call a configurable allow-list of Pingio tools and then reply back into the same chat.

**Important identity note:** The agent replies **as you** (the logged-in user), not as a separate bot. This keeps the feature entirely inside the MCP server and requires no relay or auth changes.

### Enabling an agent

```json
{
  "name": "enable_agent_mode",
  "arguments": {
    "chatId": "<contact-or-channel-uuid>",
    "chatType": "dm",
    "mode": "auto",
    "systemPrompt": "You are a helpful research assistant. Be concise.",
    "allowedTools": ["send_message", "get_history", "search_users"],
    "maxIterations": 10
  }
}
```

- `mode: auto` — the agent replies to every incoming message.
- `mode: mention` — in channels, the agent only replies when the configured `mentionKeyword` appears (defaults to `@<your-username>`).
- `allowedTools` defaults to a safe list: `send_message`, `send_channel_message`, `get_history`, `get_channel_history`, `add_contact`, `search_users`, `create_channel`, `invite_to_channel`, `list_contacts`, `list_channels`, `set_status`, `typing`.

### Managing agents

- `configure_agent` — update the system prompt, allowed tools, mode, keyword, or iteration limit.
- `get_agent_status` — inspect one chat's agent config or list all configured agents.
- `disable_agent_mode` — stop the agent from auto-replying.
- `trigger_agent` — manually run one agent turn with a custom task, useful for testing or background jobs.

### Requirements

Agent mode requires an MCP client that supports **host sampling** (the `sampling/createMessage` request). Clients known to support it:

- Claude Desktop
- Cursor (with MCP sampling enabled)
- Other clients that implement the MCP sampling capability

If your client does not support sampling, `enable_agent_mode` will still store the config, but turns will fail with a clear error when a message arrives.

### Security

- Only tools in the chat's `allowedTools` list are exposed to the host LLM.
- Sensitive tools (`register_user`, `login`, `logout`, `revoke_device`, `delete_message` with `forEveryone`, etc.) are excluded from the default allow-list.
- The agent skips messages it sent itself to prevent infinite loops. Use `mention` mode for busy channels.

## Social Groups

Social groups are channels where members can chat without requiring mutual contacts. They work like regular group chats.

- Create a social group with `create_channel` and `channelType: "social"`.
- Invite members with `invite_to_channel` or generate an invite code with the relay REST API.
- Members join with `join_channel` or `join_channel_by_invite`.
- Send messages with `send_channel_message` and read history with `get_channel_history`.

## Build Groups

Build groups let multiple users pool session capacity and collaborate on larger tasks. A build group is a channel with `channelType: "build"`. The owner defines a build prompt and can dispatch tasks to other members; members (workers) complete tasks and return artifacts.

### Concepts

- **Owner/orchestrator** — creates tasks, picks workers by checking member session status, assigns tasks, downloads completed artifacts, and can request context clears.
- **Workers** — receive assigned tasks, run an autonomous agent turn, write the result to a local artifact file, and report completion.
- **Credit pool** — workers self-report remaining requests and context-window usage so the orchestrator can spread work across the least-loaded sessions.
- **Artifacts** — completed work is transferred as files from the worker's machine to the owner's machine over the WebSocket; the relay only routes small control messages.
- **Context clearing** — after a task, the owner can ask workers to clear local chat history to free up context window. This is cooperative: the MCP server clears its own stored history and asks the host to run `/compact`.

### Setting up a build group

1. Create the group:
   ```json
   {
     "name": "create_channel",
     "arguments": {
       "name": "my-build-group",
       "displayName": "My Build Group",
       "channelType": "build",
       "buildPrompt": "Build small TypeScript utilities and write tests for them."
     }
   }
   ```

2. Enable agent mode for the owner and for each worker. Pass `channelType`, `ownerId`, and `role` so the agent knows whether to act as orchestrator or worker:
   ```json
   {
     "name": "enable_agent_mode",
     "arguments": {
       "chatId": "<channel-id>",
       "chatType": "channel",
       "mode": "auto",
       "channelType": "build",
       "ownerId": "<owner-user-id>",
       "role": "orchestrator"
     }
   }
   ```

3. Workers enable agent mode with `role: "worker"`.

4. Send a request in the channel. The orchestrator agent will create a task, pick a worker, and assign it automatically.

5. When the worker completes the task, it writes a file locally and calls `upload_artifact`. The owner agent downloads the artifact and can request the worker clear its copy.

### Build-group tools

Task lifecycle:

- `create_build_task`
- `assign_build_task`
- `get_build_tasks`
- `complete_build_task`

Session capacity:

- `report_session_status`
- `get_member_statuses`

Context management:

- `request_context_clear`
- `acknowledge_context_clear`

Artifact transfer:

- `upload_artifact`
- `send_artifact_payload`
- `download_artifact`
- `clear_worker_artifact`
- `clear_local_artifact`

### Artifact storage and cleanup

Artifacts are stored under `~/.pingio/artifacts/<channelId>/<taskId>/` by default. You can override this with `LOCAL_ARTIFACT_DIR`. The MCP server also runs a periodic cleanup job that removes artifact directories whose files are older than `ARTIFACT_MAX_AGE_HOURS` (default 24).

## License

MIT
