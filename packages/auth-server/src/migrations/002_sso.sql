-- Enterprise SSO: upstream OIDC identities and terminal login-flow artifacts.
-- The auth server acts as an OIDC *client* to corporate identity providers
-- (Okta, Entra ID, Google Workspace, ...). SSO-provisioned users get a random
-- unexposed password hash, so password login is impossible for SSO-only users.

CREATE TABLE IF NOT EXISTS sso_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email VARCHAR(255),
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  display_name VARCHAR(64),
  created_at TIMESTAMP DEFAULT NOW(),
  last_login_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(issuer, subject)
);

CREATE INDEX IF NOT EXISTS idx_sso_identities_user ON sso_identities(user_id);
-- Case-insensitive email lookups for cross-provider account linking
CREATE INDEX IF NOT EXISTS idx_sso_identities_email ON sso_identities(lower(email)) WHERE email IS NOT NULL;

-- In-flight OIDC authorization requests (state/nonce/PKCE verifier kept server-side).
-- state is stored as SHA-256 hex so a database leak cannot hijack in-flight logins.
CREATE TABLE IF NOT EXISTS sso_login_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash VARCHAR(64) UNIQUE NOT NULL,
  nonce VARCHAR(128) NOT NULL,
  pkce_verifier VARCHAR(128) NOT NULL,
  provider_slug VARCHAR(64) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL
);

-- One-time codes shown in the browser after successful IdP authentication;
-- exchanged via complete_sso_login for a Pingio token pair.
-- Stored as SHA-256 hex; single-use; short TTL.
CREATE TABLE IF NOT EXISTS sso_login_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash VARCHAR(64) UNIQUE NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sso_login_codes_user ON sso_login_codes(user_id);
