import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthService } from './auth.js';
import { ERROR_MESSAGES } from '@pingio/shared';
import crypto from 'crypto';

// Mock bcrypt to avoid slow hashing in tests
vi.mock('bcrypt', () => ({
  default: {
    hash: vi.fn(async (pw: string) => `hashed:${pw}`),
    compare: vi.fn(async (pw: string, hash: string) => hash === `hashed:${pw}`),
  },
}));

vi.mock('./username.js', () => ({
  suggestUsernames: vi.fn((username: string) => [`${username}1`, `${username}2`, `${username}3`]),
}));

const makePostgres = () => ({
  getUserByUsername: vi.fn(),
  getUserById: vi.fn(),
  createUser: vi.fn(),
  createDevice: vi.fn(),
  getDeviceByFingerprint: vi.fn(),
  getDeviceById: vi.fn(),
  getDeviceCount: vi.fn(),
  updateDeviceLastSeen: vi.fn(),
  verifyDevice: vi.fn(),
  revokeDevice: vi.fn(),
  revokeAllRefreshTokensForDevice: vi.fn(),
  createRefreshToken: vi.fn(),
  getRefreshTokenByHash: vi.fn(),
  revokeRefreshToken: vi.fn(),
  getUserDevices: vi.fn(),
  getUserWithPassword: vi.fn(),
  updateLastSeen: vi.fn(),
  getActiveSigningKeys: vi.fn(),
  createSigningKey: vi.fn(),
});

function generateTestKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const kid = crypto.randomUUID();
  return {
    id: crypto.randomUUID(),
    kid,
    publicKey,
    privateKey,
    algorithm: 'RS256',
    createdAt: new Date(),
  };
}

describe('AuthService', () => {
  let postgres: ReturnType<typeof makePostgres>;
  let auth: AuthService;
  let testKey: ReturnType<typeof generateTestKeyPair>;

  beforeEach(() => {
    vi.clearAllMocks();
    postgres = makePostgres();
    testKey = generateTestKeyPair();
    auth = new AuthService(postgres as any, 'test-issuer', 'test-audience', 'relay-1');
  });

  describe('register', () => {
    it('returns user + tokens on valid input', async () => {
      postgres.getUserByUsername.mockResolvedValue(null);
      postgres.createUser.mockResolvedValue({ id: 'user-1', username: 'alice', displayName: undefined });
      postgres.createDevice.mockResolvedValue({ id: 'device-1', isNew: true });
      postgres.getActiveSigningKeys.mockResolvedValue([testKey]);

      const result = await auth.register('alice', 'password123', undefined, 'fp-1', 'Device A');

      expect(result.success).toBe(true);
      expect(result.user?.username).toBe('alice');
      expect(result.token).toBeDefined();
      expect(result.deviceId).toBe('device-1');
      expect(result.refreshToken).toBeDefined();
    });

    it('returns error and suggestions on duplicate username', async () => {
      postgres.getUserByUsername.mockResolvedValue({ id: 'existing', username: 'alice' });

      const result = await auth.register('alice', 'password123');

      expect(result.success).toBe(false);
      expect(result.error).toBe(ERROR_MESSAGES.USERNAME_TAKEN);
      expect(result.suggestions).toEqual(['alice1', 'alice2', 'alice3']);
    });

    it('returns error when createUser fails (e.g., race condition)', async () => {
      postgres.getUserByUsername.mockResolvedValue(null);
      postgres.createUser.mockResolvedValue(null);

      const result = await auth.register('alice', 'password123');

      expect(result.success).toBe(false);
      expect(result.error).toBe(ERROR_MESSAGES.USERNAME_TAKEN);
      expect(result.suggestions).toEqual(['alice1', 'alice2', 'alice3']);
    });
  });

  describe('login', () => {
    it('returns tokens on correct password with verified device', async () => {
      postgres.getUserWithPassword.mockResolvedValue({
        id: 'user-1',
        username: 'alice',
        displayName: null,
        passwordHash: 'hashed:password123',
      });
      postgres.getDeviceByFingerprint.mockResolvedValue({
        id: 'device-1',
        userId: 'user-1',
        deviceFingerprint: 'fp-1',
        isVerified: true,
      });
      postgres.updateDeviceLastSeen.mockResolvedValue(undefined);
      postgres.updateLastSeen.mockResolvedValue(undefined);
      postgres.getActiveSigningKeys.mockResolvedValue([testKey]);

      const result = await auth.login('alice', 'password123', 'fp-1', 'Device A');

      expect(result.success).toBe(true);
      expect(result.token).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.deviceId).toBe('device-1');
      expect(result.user?.username).toBe('alice');
    });

    it('returns error on wrong password', async () => {
      postgres.getUserWithPassword.mockResolvedValue({
        id: 'user-1',
        username: 'alice',
        displayName: null,
        passwordHash: 'hashed:correct',
      });

      const result = await auth.login('alice', 'wrongpassword');

      expect(result.success).toBe(false);
      expect(result.error).toBe(ERROR_MESSAGES.INVALID_CREDENTIALS);
    });

    it('returns error on unknown user', async () => {
      postgres.getUserWithPassword.mockResolvedValue(null);

      const result = await auth.login('nobody', 'password');

      expect(result.success).toBe(false);
      expect(result.error).toBe(ERROR_MESSAGES.INVALID_CREDENTIALS);
    });

    it('creates new device when no fingerprint match and no verification required', async () => {
      postgres.getUserWithPassword.mockResolvedValue({
        id: 'user-1',
        username: 'alice',
        displayName: null,
        passwordHash: 'hashed:password123',
      });
      postgres.getDeviceByFingerprint.mockResolvedValue(null);
      postgres.createDevice.mockResolvedValue({ id: 'device-new', isNew: true });
      postgres.updateLastSeen.mockResolvedValue(undefined);
      postgres.getActiveSigningKeys.mockResolvedValue([testKey]);

      const result = await auth.login('alice', 'password123', 'fp-new', 'Device B');

      expect(result.success).toBe(true);
      expect(result.deviceId).toBe('device-new');
      expect(postgres.createDevice).toHaveBeenCalledWith('user-1', 'fp-new', 'Device B', undefined, true);
    });

    it('requires device verification when DEVICE_VERIFICATION_REQUIRED=true and new device', async () => {
      vi.stubEnv('DEVICE_VERIFICATION_REQUIRED', 'true');

      postgres.getUserWithPassword.mockResolvedValue({
        id: 'user-1',
        username: 'alice',
        displayName: null,
        passwordHash: 'hashed:password123',
      });
      postgres.getDeviceByFingerprint.mockResolvedValue(null);
      postgres.getDeviceCount.mockResolvedValue(1);
      postgres.createDevice.mockResolvedValue({ id: 'device-new', isNew: true });

      const result = await auth.login('alice', 'password123', 'fp-new', 'Device B');

      expect(result.success).toBe(false);
      expect(result.verificationRequired).toBe(true);
      expect(result.deviceId).toBe('device-new');
      expect(result.error).toBe(ERROR_MESSAGES.DEVICE_VERIFICATION_REQUIRED);


    });

    it('requires device verification when DEVICE_VERIFICATION_REQUIRED=true and existing unverified device', async () => {
      vi.stubEnv('DEVICE_VERIFICATION_REQUIRED', 'true');

      postgres.getUserWithPassword.mockResolvedValue({
        id: 'user-1',
        username: 'alice',
        displayName: null,
        passwordHash: 'hashed:password123',
      });
      postgres.getDeviceByFingerprint.mockResolvedValue({
        id: 'device-1',
        userId: 'user-1',
        deviceFingerprint: 'fp-1',
        isVerified: false,
      });

      const result = await auth.login('alice', 'password123', 'fp-1', 'Device A');

      expect(result.success).toBe(false);
      expect(result.verificationRequired).toBe(true);
      expect(result.deviceId).toBe('device-1');
      expect(result.error).toBe(ERROR_MESSAGES.DEVICE_VERIFICATION_REQUIRED);


    });

    it('returns error when max devices reached and verification required', async () => {
      vi.stubEnv('DEVICE_VERIFICATION_REQUIRED', 'true');

      postgres.getUserWithPassword.mockResolvedValue({
        id: 'user-1',
        username: 'alice',
        displayName: null,
        passwordHash: 'hashed:password123',
      });
      postgres.getDeviceByFingerprint.mockResolvedValue(null);
      postgres.getDeviceCount.mockResolvedValue(5); // MAX_DEVICES_PER_USER

      const result = await auth.login('alice', 'password123', 'fp-new', 'Device B');

      expect(result.success).toBe(false);
      expect(result.error).toBe(ERROR_MESSAGES.MAX_DEVICES_REACHED);


    });
  });

  describe('refreshToken', () => {
    it('returns new access token on valid refresh token', async () => {
      const refreshToken = crypto.randomBytes(32).toString('base64url');
      const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

      postgres.getRefreshTokenByHash.mockResolvedValue({
        id: 'rt-id',
        userId: 'user-1',
        deviceId: 'device-1',
        expiresAt: new Date(Date.now() + 86400000),
      });
      postgres.getDeviceById.mockResolvedValue({
        id: 'device-1',
        userId: 'user-1',
        deviceFingerprint: 'fp-1',
        isVerified: true,
      });
      postgres.getUserById.mockResolvedValue({ id: 'user-1', username: 'alice' });
      postgres.revokeRefreshToken.mockResolvedValue(undefined);
      postgres.createRefreshToken.mockResolvedValue('new-rt-id');
      postgres.updateDeviceLastSeen.mockResolvedValue(undefined);
      postgres.getActiveSigningKeys.mockResolvedValue([testKey]);

      const result = await auth.refreshToken(refreshToken, 'fp-1');

      expect(result.success).toBe(true);
      expect(result.token).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.deviceId).toBe('device-1');
      expect(result.user?.username).toBe('alice');
      expect(postgres.revokeRefreshToken).toHaveBeenCalledWith(tokenHash);
    });

    it('returns error when refresh token not found', async () => {
      postgres.getRefreshTokenByHash.mockResolvedValue(null);

      const result = await auth.refreshToken('some-token', 'fp-1');

      expect(result.success).toBe(false);
      expect(result.error).toBe(ERROR_MESSAGES.UNAUTHORIZED);
    });

    it('returns error when device fingerprint mismatch and revokes token', async () => {
      const refreshToken = crypto.randomBytes(32).toString('base64url');
      const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

      postgres.getRefreshTokenByHash.mockResolvedValue({
        id: 'rt-id',
        userId: 'user-1',
        deviceId: 'device-1',
        expiresAt: new Date(Date.now() + 86400000),
      });
      postgres.getDeviceById.mockResolvedValue({
        id: 'device-1',
        userId: 'user-1',
        deviceFingerprint: 'fp-2',
        isVerified: true,
      });
      postgres.revokeRefreshToken.mockResolvedValue(undefined);

      const result = await auth.refreshToken(refreshToken, 'fp-1');

      expect(result.success).toBe(false);
      expect(result.error).toBe(ERROR_MESSAGES.DEVICE_REVOKED);
      expect(postgres.revokeRefreshToken).toHaveBeenCalledWith(tokenHash);
    });

    it('returns error when user not found', async () => {
      const refreshToken = crypto.randomBytes(32).toString('base64url');
      const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

      postgres.getRefreshTokenByHash.mockResolvedValue({
        id: 'rt-id',
        userId: 'user-1',
        deviceId: 'device-1',
        expiresAt: new Date(Date.now() + 86400000),
      });
      postgres.getDeviceById.mockResolvedValue({
        id: 'device-1',
        userId: 'user-1',
        deviceFingerprint: 'fp-1',
        isVerified: true,
      });
      postgres.getUserById.mockResolvedValue(null);
      postgres.revokeRefreshToken.mockResolvedValue(undefined);

      const result = await auth.refreshToken(refreshToken, 'fp-1');

      expect(result.success).toBe(false);
      expect(result.error).toBe(ERROR_MESSAGES.USER_NOT_FOUND);
      expect(postgres.revokeRefreshToken).toHaveBeenCalledWith(tokenHash);
    });
  });

  describe('verifyDevice', () => {
    it('returns success when device exists and belongs to user', async () => {
      postgres.getDeviceById.mockResolvedValue({
        id: 'device-1',
        userId: 'user-1',
        deviceFingerprint: 'fp-1',
        isVerified: false,
      });
      postgres.verifyDevice.mockResolvedValue(true);

      const result = await auth.verifyDevice('user-1', 'device-1');

      expect(result.success).toBe(true);
    });

    it('returns error when device not found', async () => {
      postgres.getDeviceById.mockResolvedValue(null);

      const result = await auth.verifyDevice('user-1', 'missing-device');

      expect(result.success).toBe(false);
      expect(result.error).toBe(ERROR_MESSAGES.DEVICE_NOT_FOUND);
    });

    it('returns error when device belongs to another user', async () => {
      postgres.getDeviceById.mockResolvedValue({
        id: 'device-1',
        userId: 'user-2',
        deviceFingerprint: 'fp-1',
        isVerified: false,
      });

      const result = await auth.verifyDevice('user-1', 'device-1');

      expect(result.success).toBe(false);
      expect(result.error).toBe(ERROR_MESSAGES.FORBIDDEN);
    });
  });

  describe('revokeDevice', () => {
    it('returns success when device exists and belongs to user', async () => {
      postgres.getDeviceById.mockResolvedValue({
        id: 'device-1',
        userId: 'user-1',
        deviceFingerprint: 'fp-1',
        isVerified: true,
      });
      postgres.revokeAllRefreshTokensForDevice.mockResolvedValue(undefined);
      postgres.revokeDevice.mockResolvedValue(true);

      const result = await auth.revokeDevice('user-1', 'device-1');

      expect(result.success).toBe(true);
      expect(postgres.revokeAllRefreshTokensForDevice).toHaveBeenCalledWith('device-1');
      expect(postgres.revokeDevice).toHaveBeenCalledWith('device-1', 'user-1');
    });

    it('returns error when device not found', async () => {
      postgres.getDeviceById.mockResolvedValue(null);

      const result = await auth.revokeDevice('user-1', 'missing-device');

      expect(result.success).toBe(false);
      expect(result.error).toBe(ERROR_MESSAGES.DEVICE_NOT_FOUND);
    });

    it('returns error when device belongs to another user', async () => {
      postgres.getDeviceById.mockResolvedValue({
        id: 'device-1',
        userId: 'user-2',
        deviceFingerprint: 'fp-1',
        isVerified: true,
      });

      const result = await auth.revokeDevice('user-1', 'device-1');

      expect(result.success).toBe(false);
      expect(result.error).toBe(ERROR_MESSAGES.FORBIDDEN);
    });
  });

  describe('listDevices', () => {
    it('returns mapped devices with isCurrent flag', async () => {
      postgres.getUserDevices.mockResolvedValue([
        { id: 'device-1', userId: 'user-1', deviceName: 'Phone', deviceFingerprint: 'fp-1', isVerified: true, lastSeen: new Date('2026-06-01'), createdAt: new Date() },
        { id: 'device-2', userId: 'user-1', deviceName: 'Laptop', deviceFingerprint: 'fp-2', isVerified: false, lastSeen: new Date('2026-06-02'), createdAt: new Date() },
      ]);

      const result = await auth.listDevices('user-1', 'device-1');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('device-1');
      expect(result[0].isCurrent).toBe(true);
      expect(result[1].id).toBe('device-2');
      expect(result[1].isCurrent).toBe(false);
      expect(result[1].isVerified).toBe(false);
    });
  });

  describe('getJwks', () => {
    it('returns JWKs with kid, alg, and use', async () => {
      postgres.getActiveSigningKeys.mockResolvedValue([testKey]);

      const jwks = await auth.getJwks();

      expect(jwks.keys).toHaveLength(1);
      expect(jwks.keys[0].kid).toBe(testKey.kid);
      expect(jwks.keys[0].alg).toBe('RS256');
      expect(jwks.keys[0].use).toBe('sig');
      expect(jwks.keys[0].kty).toBe('RSA');
    });
  });

  describe('introspectToken', () => {
    it('returns active token info for valid access token', async () => {
      postgres.getActiveSigningKeys.mockResolvedValue([testKey]);

      // First init to load signing key
      await auth.init();

      const token = await (auth as any).generateAccessToken('user-1', 'alice', 'device-1');
      const result = await auth.introspectToken(token);

      expect(result.active).toBe(true);
      expect(result.sub).toBe('user-1');
      expect(result.username).toBe('alice');
      expect(result.device_id).toBe('device-1');
      expect(result.aud).toBe('test-audience');
      expect(result.iss).toBe('test-issuer');
      expect(result.exp).toBeDefined();
    });

    it('returns active false for invalid token', async () => {
      postgres.getActiveSigningKeys.mockResolvedValue([testKey]);

      const result = await auth.introspectToken('totally-invalid-token');

      expect(result.active).toBe(false);
      expect(result.error).toBe('Invalid token');
    });

    it('returns active false for wrong token type', async () => {
      postgres.getActiveSigningKeys.mockResolvedValue([testKey]);
      await auth.init();

      // Manually sign a token with type 'refresh' instead of 'access'
      const { SignJWT } = await import('jose');
      const { importPKCS8 } = await import('jose');
      const privateKey = await importPKCS8(testKey.privateKey, 'RS256');
      const badToken = await new SignJWT({
        sub: 'user-1',
        preferred_username: 'alice',
        type: 'refresh',
      })
        .setProtectedHeader({ alg: 'RS256', kid: testKey.kid, typ: 'JWT' })
        .setIssuer('test-issuer')
        .setAudience('test-audience')
        .setIssuedAt()
        .setExpirationTime('15m')
        .sign(privateKey);

      const result = await auth.introspectToken(badToken);

      expect(result.active).toBe(false);
      expect(result.error).toBe('Invalid token type');
    });
  });
});
