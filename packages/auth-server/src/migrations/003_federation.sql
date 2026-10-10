-- Federation: relay node registry + network version policy.
--
-- relay_nodes: one row per operator-run relay that has registered with this
-- auth server. `status` lifecycle: active -> grace -> decommissioned, driven
-- by the version policy below. Credentials are opaque random tokens stored as
-- SHA-256 hashes (revocable via decommission).
--
-- network_version_policy: one row per component ('relay-server', ...). The
-- auth server is the single source of truth for what version the network
-- runs. Bumping min_supported_version with a grace window starts the clock;
-- nodes still below min after grace_ends_at are decommissioned from the pool.
-- `manifest` is an RS256-signed JWT (aud 'pingio-federation-manifest') minted
-- on every policy update — nodes verify it against the JWKS endpoint before
-- applying any auto update/downgrade.

CREATE TABLE IF NOT EXISTS relay_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(64) NOT NULL,
  base_url TEXT NOT NULL UNIQUE,
  ws_url TEXT NOT NULL,
  operator VARCHAR(128),
  credential_hash VARCHAR(64) NOT NULL UNIQUE,
  reported_version VARCHAR(32),
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  status_reason TEXT,
  registered_at TIMESTAMP DEFAULT NOW(),
  last_heartbeat_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_relay_nodes_status ON relay_nodes(status);

CREATE TABLE IF NOT EXISTS network_version_policy (
  component VARCHAR(32) PRIMARY KEY,
  current_version VARCHAR(32) NOT NULL,
  min_supported_version VARCHAR(32) NOT NULL,
  grace_ends_at TIMESTAMP,
  artifact_url TEXT,
  artifact_sha256 VARCHAR(64),
  manifest TEXT,
  updated_at TIMESTAMP DEFAULT NOW()
);
