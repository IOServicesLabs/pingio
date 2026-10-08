import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SignJWT, generateKeyPair, createLocalJWKSet, exportJWK } from 'jose';
import { LocalAuthStrategy, CentralAuthStrategy } from './auth-strategy.js';
import { AuthService } from './auth.js';
import type { PostgresStore } from '../stores/postgres.js';
import type { User } from '@pingio/shared';

type CryptoKey = any;

const makePostgres = () => ({
  getUserById: vi.fn(),
  createUser: vi.fn(),
});

describe('LocalAuthStrategy', () => {
  const secret = 'test-secret';
  let strategy: LocalAuthStrategy;

  beforeEach(() => {
    strategy = new LocalAuthStrategy(secret);
  });

  it('verifies a valid HS256 access token', async () => {
    const token = await new SignJWT({ userId: 'user-1', username: 'alice', type: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(secret));

    const result = await strategy.verifyToken(token);
    expect(result).not.toBeNull();
    expect(result?.userId).toBe('user-1');
    expect(result?.username).toBe('alice');
  });

  it('returns null for an invalid token (wrong secret)', async () => {
    const token = await new SignJWT({ userId: 'user-1', username: 'alice', type: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('wrong-secret'));

    const result = await strategy.verifyToken(token);
    expect(result).toBeNull();
  });

  it('returns null for a malformed token', async () => {
    const result = await strategy.verifyToken('not-a-token');
    expect(result).toBeNull();
  });

  it('rejects a non-access token', async () => {
    const token = await new SignJWT({ userId: 'user-1', username: 'alice', type: 'refresh' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(secret));

    const result = await strategy.verifyToken(token);
    expect(result).toBeNull();
  });

  it('verifies a token with no type field (defaults to access)', async () => {
    const token = await new SignJWT({ userId: 'user-1', username: 'alice' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(secret));

    const result = await strategy.verifyToken(token);
    expect(result).not.toBeNull();
    expect(result?.userId).toBe('user-1');
  });
});

describe('CentralAuthStrategy', () => {
  let postgres: ReturnType<typeof makePostgres>;
  let strategy: CentralAuthStrategy;
  let keyPair: { publicKey: CryptoKey; privateKey: CryptoKey };
  let jwks: { keys: any[] };
  const issuer = 'https://auth.example.com';
  const audience = 'pingio-relay';

  beforeEach(async () => {
    postgres = makePostgres();
    strategy = new CentralAuthStrategy(issuer, audience, postgres as unknown as PostgresStore);
    keyPair = await generateKeyPair('RS256');
    const jwk = await exportJWK(keyPair.publicKey);
    jwk.kid = 'key-1';
    jwk.use = 'sig';
    jwks = { keys: [jwk] };
  });

  async function makeToken(payload: Record<string, unknown>, overrides?: { issuer?: string; audience?: string; exp?: string }) {
    const sign = new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .setSubject(payload.sub as string || 'user-1')
      .setIssuer(overrides?.issuer || issuer)
      .setAudience(overrides?.audience || audience)
      .setExpirationTime(overrides?.exp || '1h');
    return await sign.sign(keyPair.privateKey);
  }

  it('verifies a valid RS256 access token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      Response.json(jwks)
    ));

    const token = await makeToken({
      sub: 'user-1',
      preferred_username: 'alice',
      type: 'access',
      device_id: 'device-1',
    });

    postgres.getUserById.mockResolvedValue({
      id: 'user-1',
      username: 'alice',
      createdAt: new Date(),
    } as User);

    const result = await strategy.verifyToken(token);
    expect(result).not.toBeNull();
    expect(result?.userId).toBe('user-1');
    expect(result?.username).toBe('alice');
    expect(result?.deviceId).toBe('device-1');
  });

  it('returns null for an invalid token (wrong signature)', async () => {
    const otherKeyPair = await generateKeyPair('RS256');
    const token = await new SignJWT({ sub: 'user-1', preferred_username: 'alice', type: 'access' })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime('1h')
      .sign(otherKeyPair.privateKey);

    vi.stubGlobal('fetch', vi.fn(async () => Response.json(jwks)));

    const result = await strategy.verifyToken(token);
    expect(result).toBeNull();
  });

  it('returns null for wrong issuer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(jwks)));

    const token = await makeToken(
      { sub: 'user-1', preferred_username: 'alice', type: 'access' },
      { issuer: 'https://evil.com' }
    );

    const result = await strategy.verifyToken(token);
    expect(result).toBeNull();
  });

  it('returns null for wrong audience', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(jwks)));

    const token = await makeToken(
      { sub: 'user-1', preferred_username: 'alice', type: 'access' },
      { audience: 'wrong-audience' }
    );

    const result = await strategy.verifyToken(token);
    expect(result).toBeNull();
  });

  it('returns null for an expired token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(jwks)));

    const token = await makeToken(
      { sub: 'user-1', preferred_username: 'alice', type: 'access' },
      { exp: '-1h' }
    );

    const result = await strategy.verifyToken(token);
    expect(result).toBeNull();
  });

  it('returns null for a non-access token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(jwks)));

    const token = await makeToken({ sub: 'user-1', preferred_username: 'alice', type: 'refresh' });

    const result = await strategy.verifyToken(token);
    expect(result).toBeNull();
  });

  it('returns null when sub or preferred_username is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(jwks)));

    const tokenNoSub = await new SignJWT({ preferred_username: 'alice', type: 'access' })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime('1h')
      .sign(keyPair.privateKey);
    expect(await strategy.verifyToken(tokenNoSub)).toBeNull();

    const tokenNoUsername = await makeToken({ sub: 'user-1', type: 'access' });
    expect(await strategy.verifyToken(tokenNoUsername)).toBeNull();
  });

  it('caches JWKS and reuses it without refetching', async () => {
    const fetchMock = vi.fn(async () => Response.json(jwks));
    vi.stubGlobal('fetch', fetchMock);

    const token = await makeToken({ sub: 'user-1', preferred_username: 'alice', type: 'access' });
    postgres.getUserById.mockResolvedValue({ id: 'user-1', username: 'alice', createdAt: new Date() } as User);

    await strategy.verifyToken(token);
    await strategy.verifyToken(token);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${issuer}/.well-known/jwks.json`);
  });

  it('refetches JWKS after cache expires', async () => {
    const fetchMock = vi.fn(async () => Response.json(jwks));
    vi.stubGlobal('fetch', fetchMock);

    const token = await makeToken({ sub: 'user-1', preferred_username: 'alice', type: 'access' });
    postgres.getUserById.mockResolvedValue({ id: 'user-1', username: 'alice', createdAt: new Date() } as User);

    // First call fetches JWKS
    await strategy.verifyToken(token);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Simulate cache expiry by overriding internal state
    (strategy as any).jwksLastFetched = 0;
    // Ensure the token cache does not skip the second verification
    (strategy as any).tokenCache.clear();

    await strategy.verifyToken(token);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('creates a shadow user when user is missing in Postgres', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(jwks)));

    const token = await makeToken({ sub: 'user-1', preferred_username: 'alice', type: 'access' });

    postgres.getUserById.mockResolvedValue(null);
    postgres.createUser.mockResolvedValue({
      id: 'user-1',
      username: 'alice',
      createdAt: new Date(),
    } as User);

    const result = await strategy.verifyToken(token);
    expect(result).not.toBeNull();
    expect(result?.userId).toBe('user-1');
    expect(result?.username).toBe('alice');
    expect(postgres.createUser).toHaveBeenCalledWith('alice', '', undefined, 'user-1');
  });

  it('returns existing user without creating shadow when user is present', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(jwks)));

    const token = await makeToken({ sub: 'user-1', preferred_username: 'alice', type: 'access' });

    postgres.getUserById.mockResolvedValue({
      id: 'user-1',
      username: 'alice',
      createdAt: new Date(),
    } as User);

    const result = await strategy.verifyToken(token);
    expect(result).not.toBeNull();
    expect(result?.userId).toBe('user-1');
    expect(postgres.createUser).not.toHaveBeenCalled();
  });

  it('caches verified tokens and returns cached result without DB lookup', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(jwks)));

    const token = await makeToken({ sub: 'user-1', preferred_username: 'alice', type: 'access' });

    postgres.getUserById.mockResolvedValue({
      id: 'user-1',
      username: 'alice',
      createdAt: new Date(),
    } as User);

    const result1 = await strategy.verifyToken(token);
    const result2 = await strategy.verifyToken(token);

    expect(result1).toEqual(result2);
    // DB lookup should only happen once because token is cached
    expect(postgres.getUserById).toHaveBeenCalledTimes(1);
  });

  it('does not use stale token cache when token is near expiry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(jwks)));

    const token = await makeToken({ sub: 'user-1', preferred_username: 'alice', type: 'access' }, { exp: '30s' });

    postgres.getUserById.mockResolvedValue({
      id: 'user-1',
      username: 'alice',
      createdAt: new Date(),
    } as User);

    await strategy.verifyToken(token);
    // Token exp is 2 minutes out; cache requires >60s buffer, so it should NOT be cached
    expect(postgres.getUserById).toHaveBeenCalledTimes(1);

    // Because the token is not cached, a second call will hit the DB again
    await strategy.verifyToken(token);
    expect(postgres.getUserById).toHaveBeenCalledTimes(2);
  });
});

describe('AuthService production JWT_SECRET guard', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses to start in production with the default JWT_SECRET', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('JWT_SECRET', '');

    expect(() => new AuthService(makePostgres() as unknown as PostgresStore)).toThrow(
      /JWT_SECRET/
    );
  });

  it('starts in production when JWT_SECRET is set to a real value', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('JWT_SECRET', 'a-real-strong-secret');

    expect(() => new AuthService(makePostgres() as unknown as PostgresStore)).not.toThrow();
  });

  it('allows the default secret outside production', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('JWT_SECRET', '');

    expect(() => new AuthService(makePostgres() as unknown as PostgresStore)).not.toThrow();
  });
});
