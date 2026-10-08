import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthService } from './auth.js';

// Mock bcrypt to avoid slow hashing in tests
vi.mock('bcrypt', () => ({
  default: {
    hash: vi.fn(async (pw: string) => `hashed:${pw}`),
    compare: vi.fn(async (pw: string, hash: string) => hash === `hashed:${pw}`),
  },
}));

vi.mock('jsonwebtoken', () => ({
  default: {
    sign: vi.fn(() => 'mock-access-token'),
    verify: vi.fn((token: string) => {
      if (token === 'valid-token') return { userId: 'user-1', username: 'alice', type: 'access' };
      throw new Error('invalid');
    }),
  },
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
});

describe('AuthService', () => {
  let postgres: ReturnType<typeof makePostgres>;
  let auth: AuthService;

  beforeEach(() => {
    vi.clearAllMocks();
    postgres = makePostgres();
    auth = new AuthService(postgres as any);
  });

  describe('register', () => {
    it('returns userId + tokens on valid input', async () => {
      postgres.getUserByUsername.mockResolvedValue(null);
      postgres.createUser.mockResolvedValue({ id: 'user-1', username: 'alice', displayName: undefined });
      postgres.createDevice.mockResolvedValue({ id: 'device-1', isNew: true });
      postgres.createRefreshToken.mockResolvedValue('rt-id');

      const result = await auth.register('alice', 'password123', undefined, 'fp-1', 'Device A');

      expect(result.success).toBe(true);
      expect(result.user?.username).toBe('alice');
      expect(result.token).toBe('mock-access-token');
      expect(result.deviceId).toBe('device-1');
    });

    it('returns error on duplicate username', async () => {
      postgres.getUserByUsername.mockResolvedValue({ id: 'existing', username: 'alice' });

      const result = await auth.register('alice', 'password123');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('login', () => {
    it('returns tokens on correct password', async () => {
      postgres.getUserWithPassword.mockResolvedValue({
        id: 'user-1',
        username: 'alice',
        displayName: null,
        passwordHash: 'hashed:password123',
      });
      postgres.getDeviceByFingerprint.mockResolvedValue({ id: 'device-1', isVerified: true });
      postgres.updateDeviceLastSeen.mockResolvedValue(undefined);
      postgres.updateLastSeen.mockResolvedValue(undefined);
      postgres.createRefreshToken.mockResolvedValue('rt-id');

      const result = await auth.login('alice', 'password123', 'fp-1', 'Device A');

      expect(result.success).toBe(true);
      expect(result.token).toBe('mock-access-token');
    });

    it('returns error on wrong password', async () => {
      postgres.getUserWithPassword.mockResolvedValue({
        id: 'user-1',
        username: 'alice',
        passwordHash: 'hashed:correct',
      });

      const result = await auth.login('alice', 'wrongpassword');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('returns error on unknown user', async () => {
      postgres.getUserWithPassword.mockResolvedValue(null);

      const result = await auth.login('nobody', 'password');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('refreshToken', () => {
    it('returns new access token on valid refresh token', async () => {
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
      postgres.revokeRefreshToken.mockResolvedValue(true);
      postgres.createRefreshToken.mockResolvedValue('new-rt-id');
      postgres.updateDeviceLastSeen.mockResolvedValue(undefined);

      const result = await auth.refreshToken('some-refresh-token', 'fp-1');

      expect(result.success).toBe(true);
      expect(result.token).toBe('mock-access-token');
    });

    it('returns error on invalid/expired token', async () => {
      postgres.getRefreshTokenByHash.mockResolvedValue(null);

      const result = await auth.refreshToken('expired-token', 'fp-1');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
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
    });
  });

  describe('verifyToken', () => {
    it('returns decoded payload for valid token', async () => {
      const result = await auth.verifyToken('valid-token');
      expect(result).not.toBeNull();
      expect(result?.userId).toBe('user-1');
    });

    it('returns null for invalid token', async () => {
      const result = await auth.verifyToken('bad-token');
      expect(result).toBeNull();
    });
  });
});
