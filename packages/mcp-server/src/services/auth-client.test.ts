import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAxiosPost = vi.fn();
const mockAxiosGet = vi.fn();
const mockIsAxiosError = vi.fn((e: any) => e?.isAxiosError === true);

vi.mock('axios', () => ({
  default: {
    post: mockAxiosPost,
    get: mockAxiosGet,
    isAxiosError: mockIsAxiosError,
  },
}));

const mockGetConfig = vi.fn();
const mockGetAuthBaseUrl = vi.fn();

vi.mock('../config.js', () => ({
  configManager: {
    getConfig: mockGetConfig,
    getAuthBaseUrl: mockGetAuthBaseUrl,
  },
}));

const mockGetDeviceFingerprint = vi.fn(() => 'fp-test');
const mockGetDeviceName = vi.fn(() => 'Test Device');

vi.mock('../tools/devices.js', () => ({
  getDeviceFingerprint: mockGetDeviceFingerprint,
  getDeviceName: mockGetDeviceName,
}));

describe('auth-client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthBaseUrl.mockReturnValue('http://localhost:3000');
  });

  describe('registerUser', () => {
    it('uses /oauth/register in cloud mode', async () => {
      mockGetConfig.mockReturnValue({ mode: 'cloud' });
      mockAxiosPost.mockResolvedValue({
        data: { success: true, userId: 'u1', token: 'tok', refreshToken: 'rt', deviceId: 'd1' },
      });

      const { registerUser } = await import('./auth-client.js');
      const result = await registerUser('alice', 'Password1!', 'Alice');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/oauth/register',
        expect.objectContaining({
          username: 'alice',
          password: 'Password1!',
          displayName: 'Alice',
          deviceFingerprint: 'fp-test',
          deviceName: 'Test Device',
        })
      );
      expect(result).toEqual({
        success: true,
        userId: 'u1',
        token: 'tok',
        refreshToken: 'rt',
        deviceId: 'd1',
      });
    });

    it('uses /api/auth/register in self-hosted mode', async () => {
      mockGetConfig.mockReturnValue({ mode: 'self-hosted' });
      mockAxiosPost.mockResolvedValue({
        data: { success: true, userId: 'u2', token: 'tok2', refreshToken: 'rt2', deviceId: 'd2' },
      });

      const { registerUser } = await import('./auth-client.js');
      const result = await registerUser('bob', 'Password2!');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/api/auth/register',
        expect.objectContaining({
          username: 'bob',
          password: 'Password2!',
          deviceFingerprint: 'fp-test',
          deviceName: 'Test Device',
        })
      );
      expect(result).toEqual({
        success: true,
        userId: 'u2',
        token: 'tok2',
        refreshToken: 'rt2',
        deviceId: 'd2',
      });
    });

    it('returns error.response.data on axios error', async () => {
      mockGetConfig.mockReturnValue({ mode: 'self-hosted' });
      const err = Object.assign(new Error('Conflict'), {
        isAxiosError: true,
        response: { data: { success: false, error: 'Username taken' } },
      });
      mockAxiosPost.mockRejectedValue(err);

      const { registerUser } = await import('./auth-client.js');
      const result = await registerUser('alice', 'Password1!');

      expect(result).toEqual({ success: false, error: 'Username taken' });
    });

    it('returns generic error on non-axios error', async () => {
      mockGetConfig.mockReturnValue({ mode: 'self-hosted' });
      mockAxiosPost.mockRejectedValue(new Error('Network failure'));

      const { registerUser } = await import('./auth-client.js');
      const result = await registerUser('alice', 'Password1!');

      expect(result).toEqual({ success: false, error: 'Network failure' });
    });
  });

  describe('login', () => {
    it('uses /oauth/login in cloud mode', async () => {
      mockGetConfig.mockReturnValue({ mode: 'cloud' });
      mockAxiosPost.mockResolvedValue({
        data: { success: true, token: 'tok', refreshToken: 'rt', user: { id: 'u1', username: 'alice' }, deviceId: 'd1' },
      });

      const { login } = await import('./auth-client.js');
      const result = await login('alice', 'Password1!');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/oauth/login',
        expect.objectContaining({
          username: 'alice',
          password: 'Password1!',
          deviceFingerprint: 'fp-test',
          deviceName: 'Test Device',
        })
      );
      expect(result.success).toBe(true);
    });

    it('uses /api/auth/login in self-hosted mode', async () => {
      mockGetConfig.mockReturnValue({ mode: 'self-hosted' });
      mockAxiosPost.mockResolvedValue({
        data: { success: true, token: 'tok', refreshToken: 'rt', user: { id: 'u1', username: 'bob' }, deviceId: 'd1' },
      });

      const { login } = await import('./auth-client.js');
      const result = await login('bob', 'Password2!');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/api/auth/login',
        expect.objectContaining({ username: 'bob', password: 'Password2!' })
      );
      expect(result.success).toBe(true);
    });

    it('returns error.response.data on axios error', async () => {
      mockGetConfig.mockReturnValue({ mode: 'cloud' });
      const err = Object.assign(new Error('Unauthorized'), {
        isAxiosError: true,
        response: { data: { success: false, error: 'Invalid credentials' } },
      });
      mockAxiosPost.mockRejectedValue(err);

      const { login } = await import('./auth-client.js');
      const result = await login('alice', 'wrong');

      expect(result).toEqual({ success: false, error: 'Invalid credentials' });
    });
  });

  describe('refreshToken', () => {
    it('uses /oauth/refresh in cloud mode', async () => {
      mockGetConfig.mockReturnValue({ mode: 'cloud' });
      mockAxiosPost.mockResolvedValue({
        data: { success: true, token: 'new-tok', refreshToken: 'new-rt' },
      });

      const { refreshToken } = await import('./auth-client.js');
      const result = await refreshToken('rt-old');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/oauth/refresh',
        expect.objectContaining({ refreshToken: 'rt-old', deviceFingerprint: 'fp-test' })
      );
      expect(result).toEqual({ success: true, token: 'new-tok', refreshToken: 'new-rt' });
    });

    it('uses /api/auth/refresh in self-hosted mode', async () => {
      mockGetConfig.mockReturnValue({ mode: 'self-hosted' });
      mockAxiosPost.mockResolvedValue({
        data: { success: true, token: 'new-tok', refreshToken: 'new-rt' },
      });

      const { refreshToken } = await import('./auth-client.js');
      const result = await refreshToken('rt-old');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/api/auth/refresh',
        expect.objectContaining({ refreshToken: 'rt-old', deviceFingerprint: 'fp-test' })
      );
      expect(result).toEqual({ success: true, token: 'new-tok', refreshToken: 'new-rt' });
    });

    it('returns error.response.data on axios error', async () => {
      mockGetConfig.mockReturnValue({ mode: 'self-hosted' });
      const err = Object.assign(new Error('Forbidden'), {
        isAxiosError: true,
        response: { data: { success: false, error: 'Invalid refresh token' } },
      });
      mockAxiosPost.mockRejectedValue(err);

      const { refreshToken } = await import('./auth-client.js');
      const result = await refreshToken('bad-rt');

      expect(result).toEqual({ success: false, error: 'Invalid refresh token' });
    });
  });

  describe('listDevices', () => {
    it('uses /oauth/devices in cloud mode', async () => {
      mockGetConfig.mockReturnValue({ mode: 'cloud' });
      mockAxiosGet.mockResolvedValue({
        data: { success: true, devices: [{ id: 'd1', deviceName: 'Phone', isVerified: true, isCurrent: true }] },
      });

      const { listDevices } = await import('./auth-client.js');
      const result = await listDevices('tok');

      expect(mockAxiosGet).toHaveBeenCalledWith('http://localhost:3000/oauth/devices', {
        headers: { Authorization: 'Bearer tok' },
      });
      expect(result.success).toBe(true);
      expect(result.devices).toHaveLength(1);
    });

    it('uses /api/devices in self-hosted mode', async () => {
      mockGetConfig.mockReturnValue({ mode: 'self-hosted' });
      mockAxiosGet.mockResolvedValue({
        data: { success: true, devices: [{ id: 'd2', deviceName: 'Laptop', isVerified: false, isCurrent: false }] },
      });

      const { listDevices } = await import('./auth-client.js');
      const result = await listDevices('tok');

      expect(mockAxiosGet).toHaveBeenCalledWith('http://localhost:3000/api/devices', {
        headers: { Authorization: 'Bearer tok' },
      });
      expect(result.success).toBe(true);
      expect(result.devices).toHaveLength(1);
    });

    it('returns error.response.data on axios error', async () => {
      mockGetConfig.mockReturnValue({ mode: 'cloud' });
      const err = Object.assign(new Error('Unauthorized'), {
        isAxiosError: true,
        response: { data: { success: false, error: 'Bad token' } },
      });
      mockAxiosGet.mockRejectedValue(err);

      const { listDevices } = await import('./auth-client.js');
      const result = await listDevices('bad');

      expect(result).toEqual({ success: false, error: 'Bad token' });
    });
  });

  describe('verifyDevice', () => {
    it('uses /oauth/devices/verify in cloud mode', async () => {
      mockGetConfig.mockReturnValue({ mode: 'cloud' });
      mockAxiosPost.mockResolvedValue({ data: { success: true } });

      const { verifyDevice } = await import('./auth-client.js');
      const result = await verifyDevice('tok', 'd1');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/oauth/devices/verify',
        { deviceId: 'd1' },
        { headers: { Authorization: 'Bearer tok' } }
      );
      expect(result).toEqual({ success: true });
    });

    it('uses /api/devices/verify in self-hosted mode', async () => {
      mockGetConfig.mockReturnValue({ mode: 'self-hosted' });
      mockAxiosPost.mockResolvedValue({ data: { success: true } });

      const { verifyDevice } = await import('./auth-client.js');
      const result = await verifyDevice('tok', 'd2');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/api/devices/verify',
        { deviceId: 'd2' },
        { headers: { Authorization: 'Bearer tok' } }
      );
      expect(result).toEqual({ success: true });
    });

    it('returns error.response.data on axios error', async () => {
      mockGetConfig.mockReturnValue({ mode: 'self-hosted' });
      const err = Object.assign(new Error('Not found'), {
        isAxiosError: true,
        response: { data: { success: false, error: 'Device not found' } },
      });
      mockAxiosPost.mockRejectedValue(err);

      const { verifyDevice } = await import('./auth-client.js');
      const result = await verifyDevice('tok', 'd-missing');

      expect(result).toEqual({ success: false, error: 'Device not found' });
    });
  });

  describe('revokeDevice', () => {
    it('uses /oauth/devices/revoke in cloud mode', async () => {
      mockGetConfig.mockReturnValue({ mode: 'cloud' });
      mockAxiosPost.mockResolvedValue({ data: { success: true } });

      const { revokeDevice } = await import('./auth-client.js');
      const result = await revokeDevice('tok', 'd1');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/oauth/devices/revoke',
        { deviceId: 'd1' },
        { headers: { Authorization: 'Bearer tok' } }
      );
      expect(result).toEqual({ success: true });
    });

    it('uses /api/devices/revoke in self-hosted mode', async () => {
      mockGetConfig.mockReturnValue({ mode: 'self-hosted' });
      mockAxiosPost.mockResolvedValue({ data: { success: true } });

      const { revokeDevice } = await import('./auth-client.js');
      const result = await revokeDevice('tok', 'd2');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/api/devices/revoke',
        { deviceId: 'd2' },
        { headers: { Authorization: 'Bearer tok' } }
      );
      expect(result).toEqual({ success: true });
    });

    it('returns error.response.data on axios error', async () => {
      mockGetConfig.mockReturnValue({ mode: 'cloud' });
      const err = Object.assign(new Error('Forbidden'), {
        isAxiosError: true,
        response: { data: { success: false, error: 'Cannot revoke own device' } },
      });
      mockAxiosPost.mockRejectedValue(err);

      const { revokeDevice } = await import('./auth-client.js');
      const result = await revokeDevice('tok', 'd-current');

      expect(result).toEqual({ success: false, error: 'Cannot revoke own device' });
    });
  });

  describe('SSO', () => {
    describe('listSsoProviders', () => {
      it('fetches providers from the auth server in cloud mode', async () => {
        mockGetConfig.mockReturnValue({ mode: 'cloud' });
        mockAxiosGet.mockResolvedValue({
          data: { providers: [{ slug: 'acme', name: 'Acme Corp SSO' }] },
        });

        const { listSsoProviders } = await import('./auth-client.js');
        const result = await listSsoProviders();

        expect(mockAxiosGet).toHaveBeenCalledWith('http://localhost:3000/oauth/sso/providers');
        expect(result).toEqual({
          success: true,
          providers: [{ slug: 'acme', name: 'Acme Corp SSO' }],
        });
      });

      it('is unavailable in self-hosted mode', async () => {
        mockGetConfig.mockReturnValue({ mode: 'self-hosted' });

        const { listSsoProviders } = await import('./auth-client.js');
        const result = await listSsoProviders();

        expect(result.success).toBe(false);
        expect(result.error).toContain('cloud mode');
        expect(mockAxiosGet).not.toHaveBeenCalled();
      });
    });

    describe('startSsoLogin', () => {
      it('posts the slug to /oauth/sso/start', async () => {
        mockGetConfig.mockReturnValue({ mode: 'cloud' });
        mockAxiosPost.mockResolvedValue({
          data: { success: true, authorizeUrl: 'https://idp.acme.example/authorize?x=1', expiresAt: '2026-01-01T00:10:00Z' },
        });

        const { startSsoLogin } = await import('./auth-client.js');
        const result = await startSsoLogin('acme');

        expect(mockAxiosPost).toHaveBeenCalledWith('http://localhost:3000/oauth/sso/start', { slug: 'acme' });
        expect(result.success).toBe(true);
        expect(result.authorizeUrl).toContain('idp.acme.example');
      });

      it('returns the server error for an unknown provider', async () => {
        mockGetConfig.mockReturnValue({ mode: 'cloud' });
        const err = Object.assign(new Error('Not Found'), {
          isAxiosError: true,
          response: { data: { success: false, error: 'Unknown SSO provider: nope', code: 'unknown_provider' } },
        });
        mockAxiosPost.mockRejectedValue(err);

        const { startSsoLogin } = await import('./auth-client.js');
        const result = await startSsoLogin('nope');

        expect(result.success).toBe(false);
        expect(result.error).toContain('Unknown SSO provider');
      });

      it('is unavailable in self-hosted mode', async () => {
        mockGetConfig.mockReturnValue({ mode: 'self-hosted' });

        const { startSsoLogin } = await import('./auth-client.js');
        const result = await startSsoLogin('acme');

        expect(result.success).toBe(false);
        expect(mockAxiosPost).not.toHaveBeenCalled();
      });
    });

    describe('completeSsoLogin', () => {
      it('posts the code with device info to /oauth/sso/complete', async () => {
        mockGetConfig.mockReturnValue({ mode: 'cloud' });
        mockAxiosPost.mockResolvedValue({
          data: { success: true, userId: 'u1', username: 'alice', token: 'tok', refreshToken: 'rt', deviceId: 'd1' },
        });

        const { completeSsoLogin } = await import('./auth-client.js');
        const result = await completeSsoLogin('ABCD-EFGH-JKMN');

        expect(mockAxiosPost).toHaveBeenCalledWith('http://localhost:3000/oauth/sso/complete', {
          code: 'ABCD-EFGH-JKMN',
          deviceFingerprint: 'fp-test',
          deviceName: 'Test Device',
        });
        expect(result).toEqual({
          success: true, userId: 'u1', username: 'alice', token: 'tok', refreshToken: 'rt', deviceId: 'd1',
        });
      });

      it('returns the server error for a bad code', async () => {
        mockGetConfig.mockReturnValue({ mode: 'cloud' });
        const err = Object.assign(new Error('Unauthorized'), {
          isAxiosError: true,
          response: { data: { success: false, error: 'Login code is invalid, expired, or already used' } },
        });
        mockAxiosPost.mockRejectedValue(err);

        const { completeSsoLogin } = await import('./auth-client.js');
        const result = await completeSsoLogin('XXXX-XXXX-XXXX');

        expect(result.success).toBe(false);
        expect(result.error).toContain('invalid, expired, or already used');
      });

      it('is unavailable in self-hosted mode', async () => {
        mockGetConfig.mockReturnValue({ mode: 'self-hosted' });

        const { completeSsoLogin } = await import('./auth-client.js');
        const result = await completeSsoLogin('ABCD-EFGH-JKMN');

        expect(result.success).toBe(false);
        expect(mockAxiosPost).not.toHaveBeenCalled();
      });
    });
  });
});
