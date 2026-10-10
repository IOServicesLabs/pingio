# Pingio Federation

How multiple relay servers operate as one network under a single central auth
authority — with version policy enforcement and signed auto-update.

## Architecture

```
                ┌─────────────────────────────┐
                │        auth server          │
                │  (identity + control plane) │
                │                             │
                │  relay_nodes registry       │
                │  network_version_policy     │
                │  JWKS (RS256)               │
                └───────┬───────────┬─────────┘
              register/ │ heartbeat │ register/heartbeat
              heartbeat │           │
        ┌───────────────┴──┐     ┌──┴───────────────┐
        │   relay node A   │     │   relay node B   │   … any operator
        │  (your hardware) │     │ (their hardware) │
        └────────▲─────────┘     └────────▲─────────┘
                 │  same trust domain     │
        ┌────────┴────────────────────────┴────────┐
        │              MCP clients                 │
        │  discover pool via /.well-known/pingio   │
        │  one identity, any relay, auto failover  │
        └──────────────────────────────────────────┘
```

- **One trust domain.** The auth server anchors identity (RS256 access tokens,
  JWKS). Every relay runs `AUTH_MODE=central` and verifies tokens against the
  same JWKS, so a user's token works on *any* relay in the pool — the relay
  shadow-provisions the user on first sight (`CentralAuthStrategy`).
- **The auth server is the source of truth** for network membership (which
  relays may serve traffic) and for the version policy (what software those
  relays must run).
- **Clients fail over.** The MCP server learns the relay pool from
  `GET <auth>/.well-known/pingio` and rotates to the next pool member on
  connection failure, or immediately when a relay closes with WS code `1013`
  (decommissioned).

## Trust model — read this before admitting third-party operators

Trust is rooted in the **auth server and sender-held keys, never in relay
operators**. Today (Phase 0) the network is suitable for **multiple relays run
by operators you trust** (e.g. your own fleet, or partners under agreement):

- **E2E payload is safe.** DM and channel message content is encrypted
  end-to-end between clients; a rogue relay cannot read it.
- **A rogue relay CAN still:** substitute unpublished identity keys for *new*
  key lookups (mitigated by safety-number verification out of band), forge
  *plaintext* channel messages with a false `sender_id` (relays stamp sender
  server-side; sender-signed envelopes are the Phase 1 fix), and selectively
  withhold messages (mitigated by client failover and operator accountability).
- **Metadata is visible to relays** (who talks to whom, when). This is a
  stated non-goal for now.

Phase 1 (sender-signed envelopes) and Phase 2 (auth-countersigned identity
keys) are the planned data-plane hardening before openly federating with
untrusted operators. The control plane in this document is operator-facing
infrastructure and is safe to deploy today.

## Node lifecycle

```
 register ──► active ──► grace ──► decommissioned
    │            ▲          │            │
    │            └──────────┘            │ (reactivate, admin)
    │         heartbeat shows compliance ▼
    └── initial status computed from current policy (banned versions
        start decommissioned immediately)
```

Status is recomputed on every heartbeat **and** immediately when the policy
changes:

| condition                                            | status           |
|------------------------------------------------------|------------------|
| `version >= min_supported_version`                   | `active`         |
| below minimum, `now < grace_ends_at`                 | `grace` (pooled) |
| below minimum, grace expired                         | `decommissioned` |
| no policy published, or node didn't report a version | `active`         |

Only `active` and `grace` nodes are listed to clients. `decommissioned` nodes
are dropped from the pool and **refuse new WebSocket connections** with close
code `1013` (existing sessions drain naturally).

## Version policy + auto update

The `network_version_policy` table pins, per component (`relay-server`):

- `current_version` — what the network runs
- `min_supported_version` — floor for staying in the pool
- `grace_ends_at` — deadline after which non-compliant nodes are decommissioned
- `artifact_url` + `artifact_sha256` — the signed update payload
- `manifest` — an **RS256 JWT** (audience `pingio-federation-manifest`,
  verifiable against the auth server's JWKS) binding component, version,
  artifact URL and SHA-256. Re-minted on every policy change.

When a node's reported version differs from `current_version`, its heartbeat
response carries an **update directive** — same mechanism for upgrade and
rollback (downgrade is how the network recovers from a bad release):

```json
{
  "update": {
    "targetVersion": "1.2.0",
    "direction": "upgrade",
    "manifest": "<signed JWT>",
    "artifactUrl": "https://releases.example.com/relay-1.2.0.tgz",
    "artifactSha256": "<64 hex>"
  }
}
```

A node with `FEDERATION_AUTO_UPDATE=true`:

1. Verifies the manifest signature against the auth JWKS, and checks the
   directive fields match the signed claims (fail closed on any mismatch).
2. Downloads the artifact and verifies its SHA-256.
3. Stages it to a temp dir and exits with code **75** — the supervisor
   (Docker `restart: always`, systemd, wrapper script) restarts the process
   into the staged artifact.

A rejected update (bad signature, bad hash, failed download) **never stops a
healthy node** — it logs and keeps running the current version.

## Running a relay node

```bash
# Relay environment
AUTH_MODE=central
CENTRAL_AUTH_ISSUER=https://auth.pingio.io

FEDERATION_ENABLED=true
FEDERATION_NODE_NAME=relay-eu-1            # default: hostname
FEDERATION_OPERATOR=you@example.com        # contact, optional
FEDERATION_BOOTSTRAP_TOKEN=<token>         # required if the network sets one
FEDERATION_HEARTBEAT_SECONDS=300           # default 300
FEDERATION_AUTO_UPDATE=true                # opt-in
PUBLIC_BASE_URL=https://relay-eu.example.com
PUBLIC_WS_URL=wss://relay-eu.example.com/ws
RELAY_VERSION=1.2.0                        # override, default: package.json
```

On boot the relay registers (credential persisted in its local
`relay_node_state` table — delete that row to force re-registration), then
heartbeats its version. `/health` reports `federation: {status, nodeId, …}`.

## Operating the network (auth server admin)

```bash
# Auth server environment
FEDERATION_BOOTSTRAP_TOKEN=<shared secret>   # unset = OPEN registration (loud warning)
FEDERATION_ADMIN_TOKEN=<admin secret>        # unset = admin API disabled (503)

# Publish a new version (starts the grace clock, default 72h, max 2160h):
curl -X PUT https://auth.example.com/api/federation/policy/relay-server \
  -H "authorization: Bearer $FEDERATION_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "currentVersion": "1.2.0",
    "minSupportedVersion": "1.1.0",
    "graceHours": 72,
    "artifactUrl": "https://releases.example.com/relay-server-1.2.0.tgz",
    "artifactSha256": "<sha256 of the tarball>"
  }'

# Inspect the fleet:
curl https://auth.example.com/api/federation/nodes \
  -H "authorization: Bearer $FEDERATION_ADMIN_TOKEN"

# Remove a hostile/broken node now (clients stop seeing it immediately):
curl -X POST https://auth.example.com/api/federation/nodes/<id>/decommission \
  -H "authorization: Bearer $FEDERATION_ADMIN_TOKEN" \
  -H "content-type: application/json" -d '{"reason": "compromised"}'

# Restore it (status re-derived from policy compliance):
curl -X POST https://auth.example.com/api/federation/nodes/<id>/reactivate \
  -H "authorization: Bearer $FEDERATION_ADMIN_TOKEN"
```

## API reference

| endpoint | auth | purpose |
|---|---|---|
| `POST /api/federation/register` | bootstrap token (if set) | join the network; returns node credential |
| `POST /api/federation/heartbeat` | node credential (Bearer) | report version; receive status + update directive |
| `GET /api/federation/relays` | none | public pool (`active` + `grace` only) |
| `GET /api/federation/manifest/:component` | none | current policy + signed manifest |
| `PUT /api/federation/policy/:component` | admin token | publish policy; recomputes every node's status |
| `GET /api/federation/nodes` | admin token | full fleet inventory (credential hashes stripped) |
| `POST /api/federation/nodes/:id/decommission` | admin token | drop a node from the pool |
| `POST /api/federation/nodes/:id/reactivate` | admin token | restore a node per policy |
| `GET /.well-known/pingio` | none | client discovery: primary relay + `relays` pool |

## Security notes

- Node credentials are random 256-bit values, stored **SHA-256 hashed** on the
  auth server and never logged; the relay keeps its own copy in its local DB
  (DB access already implies full relay compromise).
- Bootstrap and admin token comparisons are constant-time
  (`crypto.timingSafeEqual`).
- Artifact URLs must be HTTPS; the SHA-256 is pinned inside the signed
  manifest, so neither the artifact host nor a MITM can swap the payload.
- Version comparison is numeric `x.y.z`; pre-release suffixes compare equal to
  their release (`1.2.0-rc.1` == `1.2.0`).
- A decommissioned node's credential stays valid for heartbeats (so it can
  come back after upgrading); the admin decommission endpoint is the hard
  kill-switch for hostile nodes.
- The auth server is a single point of failure for *new registrations and
  policy changes*; existing user sessions on healthy relays are unaffected if
  it goes down briefly.
