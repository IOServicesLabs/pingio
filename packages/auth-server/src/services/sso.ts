import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { createLocalJWKSet, jwtVerify } from 'jose';
import type { JSONWebKeySet, JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { ERROR_MESSAGES, MAX_DEVICES_PER_USER } from '@pingio/shared';
import type { PostgresStore, SsoLoginState } from '../stores/postgres.js';
import type { AuthService } from './auth.js';

const SSO_STATE_TTL_MINUTES = 10;
const SSO_CODE_TTL_MINUTES = 5;
const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const JWKS_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

// Unambiguous alphabet for the one-time login code (no 0/O/1/I)
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class SsoError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = 'SsoError';
  }
}

const SsoProviderSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9-]{2,64}$/, 'slug must be 2-64 chars of a-z, 0-9, hyphen'),
  name: z.string().min(1).max(128),
  issuerUrl: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  allowedDomains: z.array(z.string().min(1).max(255)).optional(),
});

export type SsoProvider = z.infer<typeof SsoProviderSchema>;

const DiscoveryDocSchema = z.object({
  issuer: z.string().min(1),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
});

type DiscoveryDoc = z.infer<typeof DiscoveryDocSchema>;

interface TokenEndpointResponse {
  id_token?: string;
  access_token?: string;
  error?: string;
  error_description?: string;
}

function sha256hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeIssuer(url: string): string {
  return url.replace(/\/+$/, '');
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

/**
 * Enterprise SSO: the auth server acts as a confidential OIDC client to
 * upstream corporate identity providers (Okta, Entra ID, Google Workspace...).
 *
 * Terminal-friendly flow:
 *   1. MCP `login_sso` → POST /oauth/sso/start → authorize URL
 *   2. User completes SSO in the browser → GET /oauth/sso/:slug/callback
 *   3. Callback verifies the id_token (signature, iss, aud, exp, nonce,
 *      allowed domains), JIT-provisions or links the user, then renders a
 *      short-lived one-time code
 *   4. MCP `complete_sso_login` → POST /oauth/sso/complete → token pair
 *
 * All login-flow secrets (state, nonce, PKCE verifier, one-time code) live
 * server-side and are stored as SHA-256 hashes; state and codes are consumed
 * atomically (DELETE/UPDATE ... RETURNING) so they cannot be replayed.
 */
export class SsoService {
  private providers = new Map<string, SsoProvider>();
  private discoveryCache = new Map<string, { doc: DiscoveryDoc; fetchedAt: number }>();
  private jwksCache = new Map<string, { jwks: JWTVerifyGetKey; fetchedAt: number }>();

  constructor(
    private postgres: PostgresStore,
    private authService: AuthService,
    private baseUrl: string,
    providers: SsoProvider[] = []
  ) {
    for (const provider of providers) {
      this.providers.set(provider.slug, provider);
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  static parseProviders(envValue: string | undefined): SsoProvider[] {
    if (!envValue || !envValue.trim()) return [];

    let raw: unknown;
    try {
      raw = JSON.parse(envValue);
    } catch {
      throw new Error('SSO_PROVIDERS is not valid JSON');
    }

    const parsed = z.array(SsoProviderSchema).safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.errors
        .map(e => `${e.path.join('.')}: ${e.message}`)
        .join('; ');
      throw new Error(`SSO_PROVIDERS failed validation: ${issues}`);
    }

    const providers = parsed.data.map(p => ({
      ...p,
      issuerUrl: normalizeIssuer(p.issuerUrl),
      allowedDomains: p.allowedDomains?.map(d => d.toLowerCase()),
    }));

    const slugs = new Set<string>();
    for (const p of providers) {
      if (slugs.has(p.slug)) {
        throw new Error(`SSO_PROVIDERS has duplicate slug: ${p.slug}`);
      }
      slugs.add(p.slug);
    }

    return providers;
  }

  listProviders(): Array<{ slug: string; name: string }> {
    return [...this.providers.values()].map(p => ({ slug: p.slug, name: p.name }));
  }

  hasProvider(slug: string): boolean {
    return this.providers.has(slug);
  }

  private redirectUri(slug: string): string {
    return `${this.baseUrl}/oauth/sso/${slug}/callback`;
  }

  private async getDiscovery(provider: SsoProvider): Promise<DiscoveryDoc> {
    const cached = this.discoveryCache.get(provider.slug);
    if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) {
      return cached.doc;
    }

    const res = await fetch(
      `${provider.issuerUrl}/.well-known/openid-configuration`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } }
    );
    if (!res.ok) {
      throw new SsoError('discovery_failed', `Could not fetch OIDC discovery for "${provider.name}"`);
    }

    let doc: DiscoveryDoc;
    try {
      doc = DiscoveryDocSchema.parse(await res.json());
    } catch {
      throw new SsoError('discovery_failed', `Invalid OIDC discovery document from "${provider.name}"`);
    }

    // OIDC Discovery §4.3: the discovered issuer must match the configured
    // issuer URL, otherwise a compromised/misconfigured host could redirect
    // tokens to a different issuer's keys.
    if (normalizeIssuer(doc.issuer) !== normalizeIssuer(provider.issuerUrl)) {
      throw new SsoError('issuer_mismatch', `Issuer mismatch for SSO provider "${provider.slug}"`);
    }

    this.discoveryCache.set(provider.slug, { doc, fetchedAt: Date.now() });
    return doc;
  }

  // JWKS is fetched explicitly (not via createRemoteJWKSet, whose Node runtime
  // bypasses global fetch and offers no timeout) and cached per provider.
  private async getJwks(
    provider: SsoProvider,
    discovery: DiscoveryDoc,
    forceRefresh = false
  ): Promise<JWTVerifyGetKey> {
    const cached = this.jwksCache.get(provider.slug);
    if (!forceRefresh && cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) {
      return cached.jwks;
    }

    const res = await fetch(discovery.jwks_uri, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      throw new SsoError('jwks_failed', `Could not fetch signing keys for "${provider.name}"`);
    }

    const parsed = z
      .object({ keys: z.array(z.record(z.string(), z.unknown())).min(1) })
      .safeParse(await res.json().catch(() => null));
    if (!parsed.success) {
      throw new SsoError('jwks_failed', `Invalid signing key set from "${provider.name}"`);
    }

    const jwks = createLocalJWKSet(parsed.data as unknown as JSONWebKeySet);
    this.jwksCache.set(provider.slug, { jwks, fetchedAt: Date.now() });
    return jwks;
  }

  async startLogin(slug: string): Promise<{ authorizeUrl: string; expiresAt: Date }> {
    const provider = this.providers.get(slug);
    if (!provider) {
      throw new SsoError('unknown_provider', `Unknown SSO provider: ${slug}`);
    }

    await this.postgres.deleteExpiredSsoArtifacts();
    const discovery = await this.getDiscovery(provider);

    const state = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(32).toString('base64url');
    const pkceVerifier = crypto.randomBytes(48).toString('base64url');
    const pkceChallenge = crypto.createHash('sha256').update(pkceVerifier).digest('base64url');

    const expiresAt = new Date(Date.now() + SSO_STATE_TTL_MINUTES * 60_000);
    await this.postgres.createSsoLoginState(sha256hex(state), nonce, pkceVerifier, slug, expiresAt);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: provider.clientId,
      redirect_uri: this.redirectUri(slug),
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: pkceChallenge,
      code_challenge_method: 'S256',
    });

    return {
      authorizeUrl: `${discovery.authorization_endpoint}?${params.toString()}`,
      expiresAt,
    };
  }

  async handleCallback(
    slug: string,
    query: { code?: string; state?: string; error?: string; error_description?: string }
  ): Promise<{ code: string; username: string; expiresAt: Date }> {
    const provider = this.providers.get(slug);
    if (!provider) {
      throw new SsoError('unknown_provider', `Unknown SSO provider: ${slug}`);
    }

    if (query.error) {
      throw new SsoError(
        'upstream_error',
        query.error_description || `Identity provider returned an error: ${query.error}`
      );
    }
    if (!query.code || !query.state) {
      throw new SsoError('invalid_callback', 'Missing code or state parameter');
    }

    const stored = await this.postgres.consumeSsoLoginState(sha256hex(query.state));
    if (!stored || stored.providerSlug !== slug) {
      throw new SsoError('invalid_state', 'Login session is unknown or expired — start the SSO login again');
    }

    const discovery = await this.getDiscovery(provider);
    const idToken = await this.exchangeCode(provider, discovery, stored, query.code);
    const claims = await this.verifyIdToken(provider, discovery, idToken, stored.nonce);

    const user = await this.resolveUser(discovery.issuer, claims);

    const code = this.generateLoginCode();
    const expiresAt = new Date(Date.now() + SSO_CODE_TTL_MINUTES * 60_000);
    await this.postgres.createSsoLoginCode(sha256hex(code), user.id, expiresAt);

    return { code, username: user.username, expiresAt };
  }

  private async exchangeCode(
    provider: SsoProvider,
    discovery: DiscoveryDoc,
    stored: SsoLoginState,
    code: string
  ): Promise<string> {
    let res: Response;
    try {
      res = await fetch(discovery.token_endpoint, {
        method: 'POST',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: this.redirectUri(provider.slug),
          client_id: provider.clientId,
          client_secret: provider.clientSecret,
          code_verifier: stored.pkceVerifier,
        }).toString(),
      });
    } catch {
      throw new SsoError('token_exchange_failed', 'Could not reach the identity provider');
    }

    let tokens: TokenEndpointResponse;
    try {
      tokens = (await res.json()) as TokenEndpointResponse;
    } catch {
      throw new SsoError('token_exchange_failed', 'Identity provider returned an invalid response');
    }

    if (!res.ok || !tokens.id_token) {
      // Never surface upstream error bodies to the browser — they may contain
      // internal details. Log for operators instead.
      console.error(
        `SSO token exchange failed for provider ${provider.slug}: HTTP ${res.status}`,
        tokens.error || ''
      );
      throw new SsoError('token_exchange_failed', 'Identity provider rejected the code exchange');
    }

    return tokens.id_token;
  }

  private async verifyIdToken(
    provider: SsoProvider,
    discovery: DiscoveryDoc,
    idToken: string,
    expectedNonce: string
  ): Promise<{
    sub: string;
    email?: string;
    emailVerified: boolean;
    displayName?: string;
    preferredUsername?: string;
  }> {
    let payload;
    try {
      const verified = await jwtVerify(idToken, await this.getJwks(provider, discovery), {
        issuer: discovery.issuer,
        audience: provider.clientId,
      });
      payload = verified.payload;
    } catch {
      // Upstream keys rotate — retry once with a freshly fetched key set
      try {
        const verified = await jwtVerify(
          idToken,
          await this.getJwks(provider, discovery, true),
          { issuer: discovery.issuer, audience: provider.clientId }
        );
        payload = verified.payload;
      } catch {
        throw new SsoError('invalid_token', 'Identity provider token failed verification');
      }
    }

    if (payload.nonce !== expectedNonce) {
      throw new SsoError('invalid_nonce', 'Identity provider token nonce mismatch');
    }
    if (!payload.sub) {
      throw new SsoError('invalid_token', 'Identity provider token is missing a subject');
    }

    const email = typeof payload.email === 'string' ? payload.email : undefined;
    const emailVerified = payload.email_verified === true;

    if (provider.allowedDomains && provider.allowedDomains.length > 0) {
      if (!email) {
        throw new SsoError('domain_not_allowed', 'Your identity provider did not return an email address');
      }
      const domain = email.split('@')[1]?.toLowerCase();
      if (!domain || !provider.allowedDomains.includes(domain)) {
        throw new SsoError(
          'domain_not_allowed',
          `Only accounts from ${provider.allowedDomains.join(', ')} may use this login`
        );
      }
    }

    const displayName = typeof payload.name === 'string' ? payload.name : undefined;
    const preferredUsername =
      typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined;

    return { sub: payload.sub, email, emailVerified, displayName, preferredUsername };
  }

  private async resolveUser(
    issuer: string,
    claims: {
      sub: string;
      email?: string;
      emailVerified: boolean;
      displayName?: string;
      preferredUsername?: string;
    }
  ): Promise<{ id: string; username: string }> {
    const existing = await this.postgres.getSsoIdentity(issuer, claims.sub);
    if (existing) {
      const user = await this.postgres.getUserById(existing.userId);
      if (!user) {
        throw new SsoError('user_not_found', 'The account linked to this SSO identity no longer exists');
      }
      await this.postgres.touchSsoIdentity(existing.id);
      return user;
    }

    // Cross-provider linking: an already-linked, IdP-verified email lets a new
    // identity from another provider land on the same account. Unverified
    // emails are never used for linking (they can be attacker-controlled).
    if (claims.email && claims.emailVerified) {
      const linked = await this.postgres.findVerifiedSsoIdentityByEmail(claims.email);
      if (linked) {
        const user = await this.postgres.getUserById(linked.userId);
        if (user) {
          await this.postgres.createSsoIdentity(
            user.id,
            issuer,
            claims.sub,
            claims.email,
            claims.emailVerified,
            claims.displayName
          );
          return user;
        }
      }
    }

    return this.provisionUser(issuer, claims);
  }

  private async provisionUser(
    issuer: string,
    claims: {
      sub: string;
      email?: string;
      emailVerified: boolean;
      displayName?: string;
      preferredUsername?: string;
    }
  ): Promise<{ id: string; username: string }> {
    const base = this.deriveUsername(claims);

    for (let attempt = 0; attempt < 5; attempt++) {
      const username =
        attempt === 0
          ? base
          : `${base.slice(0, 27)}_${crypto.randomBytes(3).toString('hex')}`;

      // Random unexposed password: SSO-only users cannot log in by password.
      const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('base64url'), 10);
      const user = await this.postgres.createUser(username, passwordHash, claims.displayName);
      if (!user) continue; // username taken — retry with a suffix

      await this.postgres.createSsoIdentity(
        user.id,
        issuer,
        claims.sub,
        claims.email,
        claims.emailVerified,
        claims.displayName
      );
      return user;
    }

    throw new SsoError('provisioning_failed', 'Could not allocate a username for the new account');
  }

  private deriveUsername(claims: {
    email?: string;
    displayName?: string;
    preferredUsername?: string;
  }): string {
    const source =
      claims.preferredUsername ||
      (claims.email ? claims.email.split('@')[0] : '') ||
      claims.displayName ||
      'user';
    let username = source
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^[_-]+|[_-]+$/g, '')
      .slice(0, 32);
    if (username.length < 3) {
      username = `u_${username || 'user'}`.slice(0, 32);
    }
    return username;
  }

  private generateLoginCode(): string {
    const bytes = crypto.randomBytes(12);
    const chars = [...bytes].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]);
    return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`;
  }

  async completeLogin(
    code: string,
    deviceFingerprint?: string,
    deviceName?: string,
    ipAddress?: string
  ): Promise<{
    success: boolean;
    user?: { id: string; username: string; displayName?: string };
    token?: string;
    refreshToken?: string;
    deviceId?: string;
    error?: string;
  }> {
    await this.postgres.deleteExpiredSsoArtifacts();

    const normalized = code.trim().toUpperCase();
    if (!normalized) {
      return { success: false, error: 'Login code is required' };
    }

    const consumed = await this.postgres.consumeSsoLoginCode(sha256hex(normalized));
    if (!consumed) {
      return { success: false, error: 'Login code is invalid, expired, or already used' };
    }

    const user = await this.postgres.getUserById(consumed.userId);
    if (!user) {
      return { success: false, error: ERROR_MESSAGES.USER_NOT_FOUND };
    }

    // Devices created through SSO are verified immediately: the upstream IdP
    // already strongly authenticated this login, and a first-time SSO user has
    // no trusted device that could approve a new one.
    let deviceId: string | undefined;
    if (deviceFingerprint) {
      const existing = await this.postgres.getDeviceByFingerprint(user.id, deviceFingerprint);
      if (existing) {
        deviceId = existing.id;
        await this.postgres.updateDeviceLastSeen(deviceId, ipAddress);
        if (!existing.isVerified) {
          await this.postgres.verifyDevice(deviceId);
        }
      } else {
        const deviceCount = await this.postgres.getDeviceCount(user.id);
        if (deviceCount >= MAX_DEVICES_PER_USER) {
          return { success: false, error: ERROR_MESSAGES.MAX_DEVICES_REACHED };
        }
        const device = await this.postgres.createDevice(
          user.id,
          deviceFingerprint,
          deviceName,
          ipAddress,
          true
        );
        deviceId = device?.id;
      }
    }

    const tokens = await this.authService.issueTokens(user.id, user.username, deviceId);
    await this.postgres.updateLastSeen(user.id);

    return {
      success: true,
      user: { id: user.id, username: user.username, displayName: user.displayName },
      token: tokens.token,
      refreshToken: tokens.refreshToken,
      deviceId,
    };
  }
}

const PAGE_STYLE = `
  body { font-family: system-ui, sans-serif; background: #0f1115; color: #e6e6e6;
         display: flex; justify-content: center; padding: 48px 16px; margin: 0; }
  main { max-width: 480px; width: 100%; background: #1a1d24; border: 1px solid #2a2e38;
         border-radius: 12px; padding: 32px; }
  h1 { font-size: 20px; margin: 0 0 16px; }
  p { line-height: 1.5; color: #b8bcc4; }
  code.code { display: block; font-size: 28px; letter-spacing: 2px; text-align: center;
              background: #0f1115; border: 1px solid #3a3f4b; border-radius: 8px;
              padding: 16px; margin: 24px 0; color: #7ee787; user-select: all; }
  code.cmd { background: #0f1115; border-radius: 4px; padding: 2px 6px; color: #a5d6ff; }
  .warn { color: #d29922; font-size: 13px; }
  .err h1 { color: #f85149; }
`;

export function renderLoginCodePage(code: string, username: string, expiresAt: Date): string {
  const minutes = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 60_000));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Pingio SSO Login</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
  <h1>Signed in as ${escapeHtml(username)}</h1>
  <p>Back in your terminal, complete the login with:</p>
  <code class="code">${escapeHtml(code)}</code>
  <p><code class="cmd">complete_sso_login(code="${escapeHtml(code)}")</code></p>
  <p class="warn">This code expires in ${minutes} minute${minutes === 1 ? '' : 's'} and can be used only once. Never share it.</p>
</main>
</body>
</html>`;
}

export function renderLoginErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Pingio SSO Login Failed</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main class="err">
  <h1>SSO login failed</h1>
  <p>${escapeHtml(message)}</p>
  <p>Return to your terminal and start the login again.</p>
</main>
</body>
</html>`;
}
