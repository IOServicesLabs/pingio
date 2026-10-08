import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import {
  SsoService,
  SsoError,
  escapeHtml,
  renderLoginCodePage,
  renderLoginErrorPage,
} from './sso.js';

// Avoid slow bcrypt rounds for the random SSO-only password hash
vi.mock('bcrypt', () => ({
  default: {
    hash: vi.fn(async (pw: string) => `hashed:${pw}`),
    compare: vi.fn(async () => false),
  },
}));

const ISSUER_URL = 'https://idp.acme.example';
const BASE_URL = 'https://auth.pingio.example';
const CLIENT_ID = 'pingio-client-123';

const PROVIDER = {
  slug: 'acme',
  name: 'Acme Corp SSO',
  issuerUrl: ISSUER_URL,
  clientId: CLIENT_ID,
  clientSecret: 'super-secret',
  allowedDomains: ['acme.com'],
};

function makePostgres() {
  return {
    deleteExpiredSsoArtifacts: vi.fn(),
    createSsoLoginState: vi.fn(),
    consumeSsoLoginState: vi.fn(),
    getSsoIdentity: vi.fn(),
    getUserById: vi.fn(),
    touchSsoIdentity: vi.fn(),
    findVerifiedSsoIdentityByEmail: vi.fn(),
    createUser: vi.fn(),
    createSsoIdentity: vi.fn(),
    createSsoLoginCode: vi.fn(),
    consumeSsoLoginCode: vi.fn(),
    getDeviceByFingerprint: vi.fn(),
    updateDeviceLastSeen: vi.fn(),
    verifyDevice: vi.fn(),
    getDeviceCount: vi.fn(),
    createDevice: vi.fn(),
    updateLastSeen: vi.fn(),
  };
}

function makeAuthService() {
  return {
    issueTokens: vi.fn(async () => ({ token: 'access-token', refreshToken: 'refresh-token' })),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Response;
}

function discoveryDoc(issuer = ISSUER_URL) {
  return {
    issuer,
    authorization_endpoint: `${ISSUER_URL}/authorize`,
    token_endpoint: `${ISSUER_URL}/token`,
    jwks_uri: `${ISSUER_URL}/jwks`,
  };
}

interface Upstream {
  privateKey: crypto.KeyObject | Uint8Array;
  jwk: Record<string, unknown>;
  kid: string;
}

async function makeUpstream(kid = 'upstream-key-1'): Promise<Upstream> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = (await exportJWK(publicKey)) as unknown as Record<string, unknown>;
  jwk.kid = kid;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  return { privateKey: privateKey as Upstream['privateKey'], jwk, kid };
}

async function signIdToken(
  upstream: Upstream,
  claims: Record<string, unknown>,
  key?: Upstream['privateKey']
) {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    iss: ISSUER_URL,
    aud: CLIENT_ID,
    iat: now,
    exp: now + 300,
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: upstream.kid, typ: 'JWT' })
    .sign(key ?? upstream.privateKey);
}

interface FetchOpts {
  idToken?: string;
  tokenStatus?: number;
  tokenBody?: unknown;
  jwksKeys?: Array<Record<string, unknown>>;
  discovery?: ReturnType<typeof discoveryDoc>;
}

function makeFetch(upstream: Upstream, opts: FetchOpts = {}) {
  return vi.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (url === `${ISSUER_URL}/.well-known/openid-configuration`) {
      return jsonResponse(opts.discovery ?? discoveryDoc());
    }
    if (url === `${ISSUER_URL}/token`) {
      const status = opts.tokenStatus ?? 200;
      const body =
        opts.tokenBody ?? { id_token: opts.idToken, access_token: 'at-1', token_type: 'Bearer' };
      return jsonResponse(body, status);
    }
    if (url === `${ISSUER_URL}/jwks`) {
      return jsonResponse({ keys: opts.jwksKeys ?? [upstream.jwk] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function sha256hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

describe('SsoService', () => {
  let postgres: ReturnType<typeof makePostgres>;
  let authService: ReturnType<typeof makeAuthService>;
  let sso: SsoService;
  let upstream: Upstream;

  beforeEach(async () => {
    vi.clearAllMocks();
    postgres = makePostgres();
    authService = makeAuthService();
    sso = new SsoService(postgres as any, authService as any, BASE_URL, [PROVIDER]);
    upstream = await makeUpstream();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('parseProviders', () => {
    it('returns empty list when env is unset', () => {
      expect(SsoService.parseProviders(undefined)).toEqual([]);
      expect(SsoService.parseProviders('  ')).toEqual([]);
    });

    it('parses a valid config and lowercases allowed domains', () => {
      const providers = SsoService.parseProviders(
        JSON.stringify([
          { ...PROVIDER, issuerUrl: `${ISSUER_URL}/`, allowedDomains: ['Acme.COM'] },
        ])
      );
      expect(providers).toHaveLength(1);
      expect(providers[0].issuerUrl).toBe(ISSUER_URL);
      expect(providers[0].allowedDomains).toEqual(['acme.com']);
    });

    it('throws on invalid JSON', () => {
      expect(() => SsoService.parseProviders('{not json')).toThrow('not valid JSON');
    });

    it('throws on invalid slug', () => {
      expect(() =>
        SsoService.parseProviders(JSON.stringify([{ ...PROVIDER, slug: 'Bad Slug!' }]))
      ).toThrow('failed validation');
    });

    it('throws on duplicate slugs', () => {
      expect(() => SsoService.parseProviders(JSON.stringify([PROVIDER, PROVIDER]))).toThrow(
        'duplicate slug'
      );
    });
  });

  describe('startLogin', () => {
    it('builds an authorize URL with PKCE and stores only the state hash', async () => {
      vi.stubGlobal('fetch', makeFetch(upstream));

      const { authorizeUrl, expiresAt } = await sso.startLogin('acme');

      const url = new URL(authorizeUrl);
      expect(url.origin + url.pathname).toBe(`${ISSUER_URL}/authorize`);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
      expect(url.searchParams.get('redirect_uri')).toBe(
        `${BASE_URL}/oauth/sso/acme/callback`
      );
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('code_challenge')).toBeTruthy();
      expect(url.searchParams.get('state')).toBeTruthy();
      expect(url.searchParams.get('nonce')).toBeTruthy();
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

      const state = url.searchParams.get('state')!;
      const [stateHash, nonce, pkceVerifier, slug] = postgres.createSsoLoginState.mock.calls[0];
      expect(stateHash).toBe(sha256hex(state));
      expect(stateHash).not.toBe(state);
      expect(nonce).toBe(url.searchParams.get('nonce'));
      expect(pkceVerifier).toBeTruthy();
      expect(slug).toBe('acme');
    });

    it('throws unknown_provider for an unconfigured slug', async () => {
      await expect(sso.startLogin('nope')).rejects.toMatchObject({
        name: 'SsoError',
        code: 'unknown_provider',
      });
    });

    it('throws issuer_mismatch when discovery issuer differs from config', async () => {
      vi.stubGlobal(
        'fetch',
        makeFetch(upstream, { discovery: discoveryDoc('https://evil.example') })
      );

      await expect(sso.startLogin('acme')).rejects.toMatchObject({
        name: 'SsoError',
        code: 'issuer_mismatch',
      });
    });
  });

  // Runs startLogin and rewires the mock store so the callback finds the state
  async function startAndCaptureState(): Promise<{ state: string; nonce: string }> {
    vi.stubGlobal('fetch', makeFetch(upstream));
    const { authorizeUrl } = await sso.startLogin('acme');
    const state = new URL(authorizeUrl).searchParams.get('state')!;
    const [, nonce, pkceVerifier, slug] = postgres.createSsoLoginState.mock.calls[0];
    postgres.consumeSsoLoginState.mockResolvedValue({
      id: 'state-row-1',
      nonce,
      pkceVerifier,
      providerSlug: slug,
      expiresAt: new Date(Date.now() + 60_000),
    });
    return { state, nonce };
  }

  // Explicit claims override the captured nonce (used by the nonce-mismatch test)
  async function runCallback(idTokenClaims: Record<string, unknown>) {
    const { state, nonce } = await startAndCaptureState();
    const idToken = await signIdToken(upstream, { nonce, ...idTokenClaims });
    vi.stubGlobal('fetch', makeFetch(upstream, { idToken }));
    return sso.handleCallback('acme', { code: 'auth-code-1', state });
  }

  describe('handleCallback', () => {
    it('happy path: JIT-provisions a user and returns a one-time code', async () => {
      postgres.getSsoIdentity.mockResolvedValue(null);
      postgres.findVerifiedSsoIdentityByEmail.mockResolvedValue(null);
      postgres.createUser.mockResolvedValue({ id: 'user-1', username: 'alice' });
      postgres.createSsoIdentity.mockResolvedValue({ id: 'ident-1' });

      const result = await runCallback({
        sub: 'sub-123',
        email: 'alice@acme.com',
        email_verified: true,
        preferred_username: 'alice',
        name: 'Alice A',
      });

      expect(result.username).toBe('alice');
      expect(result.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(postgres.createUser).toHaveBeenCalledWith(
        'alice',
        expect.stringMatching(/^hashed:/),
        'Alice A'
      );
      expect(postgres.createSsoIdentity).toHaveBeenCalledWith(
        'user-1',
        ISSUER_URL,
        'sub-123',
        'alice@acme.com',
        true,
        'Alice A'
      );
      // Only the code hash is persisted
      const [codeHash] = postgres.createSsoLoginCode.mock.calls[0];
      expect(codeHash).toBe(sha256hex(result.code));
    });

    it('logs an existing identity back into the same account', async () => {
      postgres.getSsoIdentity.mockResolvedValue({
        id: 'ident-1',
        userId: 'user-1',
        issuer: ISSUER_URL,
        subject: 'sub-123',
      });
      postgres.getUserById.mockResolvedValue({ id: 'user-1', username: 'alice' });

      const result = await runCallback({ sub: 'sub-123', email: 'alice@acme.com' });

      expect(result.username).toBe('alice');
      expect(postgres.touchSsoIdentity).toHaveBeenCalledWith('ident-1');
      expect(postgres.createUser).not.toHaveBeenCalled();
    });

    it('links a new provider identity by verified email', async () => {
      postgres.getSsoIdentity.mockResolvedValue(null);
      postgres.findVerifiedSsoIdentityByEmail.mockResolvedValue({
        id: 'ident-other',
        userId: 'user-existing',
      });
      postgres.getUserById.mockResolvedValue({ id: 'user-existing', username: 'alice' });
      postgres.createSsoIdentity.mockResolvedValue({ id: 'ident-new' });

      const result = await runCallback({
        sub: 'sub-999',
        email: 'alice@acme.com',
        email_verified: true,
      });

      expect(result.username).toBe('alice');
      expect(postgres.createUser).not.toHaveBeenCalled();
      expect(postgres.createSsoIdentity).toHaveBeenCalledWith(
        'user-existing',
        ISSUER_URL,
        'sub-999',
        'alice@acme.com',
        true,
        undefined
      );
    });

    it('does not link by unverified email', async () => {
      postgres.getSsoIdentity.mockResolvedValue(null);
      postgres.createUser.mockResolvedValue({ id: 'user-new', username: 'bob' });
      postgres.createSsoIdentity.mockResolvedValue({ id: 'ident-1' });

      await runCallback({ sub: 'sub-555', email: 'bob@acme.com', email_verified: false });

      expect(postgres.findVerifiedSsoIdentityByEmail).not.toHaveBeenCalled();
      expect(postgres.createUser).toHaveBeenCalled();
    });

    it('rejects an unknown or expired state', async () => {
      vi.stubGlobal('fetch', makeFetch(upstream));
      postgres.consumeSsoLoginState.mockResolvedValue(null);

      await expect(
        sso.handleCallback('acme', { code: 'c', state: 'unknown-state' })
      ).rejects.toMatchObject({ name: 'SsoError', code: 'invalid_state' });
    });

    it('rejects a state issued for a different provider', async () => {
      vi.stubGlobal('fetch', makeFetch(upstream));
      postgres.consumeSsoLoginState.mockResolvedValue({
        id: 's1',
        nonce: 'n',
        pkceVerifier: 'v',
        providerSlug: 'other-provider',
        expiresAt: new Date(Date.now() + 60_000),
      });

      await expect(
        sso.handleCallback('acme', { code: 'c', state: 'some-state' })
      ).rejects.toMatchObject({ name: 'SsoError', code: 'invalid_state' });
    });

    it('surfaces an upstream provider error', async () => {
      await expect(
        sso.handleCallback('acme', {
          error: 'access_denied',
          error_description: 'User cancelled',
        })
      ).rejects.toMatchObject({ name: 'SsoError', code: 'upstream_error' });
    });

    it('rejects when the token exchange fails', async () => {
      const { state } = await startAndCaptureState();
      vi.stubGlobal(
        'fetch',
        makeFetch(upstream, { tokenStatus: 400, tokenBody: { error: 'invalid_grant' } })
      );

      await expect(
        sso.handleCallback('acme', { code: 'bad-code', state })
      ).rejects.toMatchObject({ name: 'SsoError', code: 'token_exchange_failed' });
    });

    it('rejects an id_token signed by an unknown key', async () => {
      const attacker = await makeUpstream('attacker-key');
      const { state, nonce } = await startAndCaptureState();
      // Sign with the attacker's key but claim the legitimate kid — JWKS only
      // serves the real key, so verification must fail.
      const idToken = await signIdToken(
        { ...attacker, kid: upstream.kid },
        { sub: 'sub-1', nonce },
        attacker.privateKey
      );
      vi.stubGlobal('fetch', makeFetch(upstream, { idToken }));

      await expect(sso.handleCallback('acme', { code: 'c', state })).rejects.toMatchObject({
        name: 'SsoError',
        code: 'invalid_token',
      });
    });

    it('rejects an id_token with the wrong issuer', async () => {
      await expect(
        runCallback({ sub: 'sub-1', iss: 'https://evil.example' })
      ).rejects.toMatchObject({ name: 'SsoError', code: 'invalid_token' });
    });

    it('rejects an id_token with the wrong audience', async () => {
      await expect(
        runCallback({ sub: 'sub-1', aud: 'some-other-client' })
      ).rejects.toMatchObject({ name: 'SsoError', code: 'invalid_token' });
    });

    it('rejects an expired id_token', async () => {
      const now = Math.floor(Date.now() / 1000);
      await expect(
        runCallback({ sub: 'sub-1', iat: now - 600, exp: now - 60 })
      ).rejects.toMatchObject({ name: 'SsoError', code: 'invalid_token' });
    });

    it('rejects a nonce mismatch', async () => {
      await expect(
        runCallback({ sub: 'sub-1', nonce: 'not-the-stored-nonce' })
      ).rejects.toMatchObject({ name: 'SsoError', code: 'invalid_nonce' });
    });

    it('rejects an email from a disallowed domain', async () => {
      await expect(
        runCallback({ sub: 'sub-1', email: 'mallory@evil.com', email_verified: true })
      ).rejects.toMatchObject({ name: 'SsoError', code: 'domain_not_allowed' });
    });

    it('rejects when allowedDomains is set but no email is returned', async () => {
      await expect(runCallback({ sub: 'sub-1' })).rejects.toMatchObject({
        name: 'SsoError',
        code: 'domain_not_allowed',
      });
    });

    it('allows any domain when allowedDomains is not configured', async () => {
      const openSso = new SsoService(
        postgres as any,
        authService as any,
        BASE_URL,
        [{ ...PROVIDER, allowedDomains: undefined }]
      );
      vi.stubGlobal('fetch', makeFetch(upstream));
      const { authorizeUrl } = await openSso.startLogin('acme');
      const state = new URL(authorizeUrl).searchParams.get('state')!;
      const [, nonce, pkceVerifier] = postgres.createSsoLoginState.mock.calls[0];
      postgres.consumeSsoLoginState.mockResolvedValue({
        id: 's1',
        nonce,
        pkceVerifier,
        providerSlug: 'acme',
        expiresAt: new Date(Date.now() + 60_000),
      });

      const idToken = await signIdToken(upstream, {
        sub: 'sub-7',
        nonce,
        email: 'carol@anything.example',
        email_verified: true,
      });
      vi.stubGlobal('fetch', makeFetch(upstream, { idToken }));

      postgres.getSsoIdentity.mockResolvedValue(null);
      postgres.findVerifiedSsoIdentityByEmail.mockResolvedValue(null);
      postgres.createUser.mockResolvedValue({ id: 'user-7', username: 'carol' });
      postgres.createSsoIdentity.mockResolvedValue({ id: 'ident-7' });

      const result = await openSso.handleCallback('acme', { code: 'c', state });
      expect(result.username).toBe('carol');
    });
  });

  describe('completeLogin', () => {
    it('issues tokens and creates a verified device', async () => {
      postgres.consumeSsoLoginCode.mockResolvedValue({ userId: 'user-1' });
      postgres.getUserById.mockResolvedValue({ id: 'user-1', username: 'alice' });
      postgres.getDeviceByFingerprint.mockResolvedValue(null);
      postgres.getDeviceCount.mockResolvedValue(0);
      postgres.createDevice.mockResolvedValue({ id: 'device-1', isNew: true });

      const result = await sso.completeLogin('abcd-efgh-jkmn', 'fp-1', 'Laptop', '1.2.3.4');

      expect(result.success).toBe(true);
      expect(result.token).toBe('access-token');
      expect(result.refreshToken).toBe('refresh-token');
      expect(result.deviceId).toBe('device-1');
      expect(postgres.consumeSsoLoginCode).toHaveBeenCalledWith(sha256hex('ABCD-EFGH-JKMN'));
      expect(postgres.createDevice).toHaveBeenCalledWith('user-1', 'fp-1', 'Laptop', '1.2.3.4', true);
      expect(authService.issueTokens).toHaveBeenCalledWith('user-1', 'alice', 'device-1');
      expect(postgres.updateLastSeen).toHaveBeenCalledWith('user-1');
    });

    it('verifies a pre-existing unverified device instead of duplicating it', async () => {
      postgres.consumeSsoLoginCode.mockResolvedValue({ userId: 'user-1' });
      postgres.getUserById.mockResolvedValue({ id: 'user-1', username: 'alice' });
      postgres.getDeviceByFingerprint.mockResolvedValue({
        id: 'device-1',
        userId: 'user-1',
        deviceFingerprint: 'fp-1',
        isVerified: false,
      });

      const result = await sso.completeLogin('ABCD-EFGH-JKMN', 'fp-1');

      expect(result.success).toBe(true);
      expect(postgres.verifyDevice).toHaveBeenCalledWith('device-1');
      expect(postgres.createDevice).not.toHaveBeenCalled();
      expect(postgres.updateDeviceLastSeen).toHaveBeenCalledWith('device-1', undefined);
    });

    it('rejects an invalid, expired, or already-used code', async () => {
      postgres.consumeSsoLoginCode.mockResolvedValue(null);

      const result = await sso.completeLogin('XXXX-XXXX-XXXX');

      expect(result.success).toBe(false);
      expect(result.error).toContain('invalid, expired, or already used');
      expect(authService.issueTokens).not.toHaveBeenCalled();
    });

    it('rejects an empty code without hitting the store', async () => {
      const result = await sso.completeLogin('   ');

      expect(result.success).toBe(false);
      expect(postgres.consumeSsoLoginCode).not.toHaveBeenCalled();
    });

    it('fails when the user behind the code no longer exists', async () => {
      postgres.consumeSsoLoginCode.mockResolvedValue({ userId: 'ghost' });
      postgres.getUserById.mockResolvedValue(null);

      const result = await sso.completeLogin('ABCD-EFGH-JKMN');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('enforces the max device count', async () => {
      postgres.consumeSsoLoginCode.mockResolvedValue({ userId: 'user-1' });
      postgres.getUserById.mockResolvedValue({ id: 'user-1', username: 'alice' });
      postgres.getDeviceByFingerprint.mockResolvedValue(null);
      postgres.getDeviceCount.mockResolvedValue(99);

      const result = await sso.completeLogin('ABCD-EFGH-JKMN', 'fp-new');

      expect(result.success).toBe(false);
      expect(postgres.createDevice).not.toHaveBeenCalled();
    });
  });

  describe('HTML rendering', () => {
    it('escapes HTML in usernames and codes', () => {
      const page = renderLoginCodePage('ABCD-EFGH-JKMN', '<script>alert(1)</script>', new Date(Date.now() + 300_000));
      expect(page).not.toContain('<script>alert(1)</script>');
      expect(page).toContain('&lt;script&gt;');
      expect(page).toContain('ABCD-EFGH-JKMN');
    });

    it('escapes HTML in error messages', () => {
      const page = renderLoginErrorPage('<img src=x onerror=alert(1)>');
      expect(page).not.toContain('<img src=x');
      expect(page).toContain('&lt;img');
    });

    it('escapeHtml covers the five dangerous characters', () => {
      expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
    });
  });
});
