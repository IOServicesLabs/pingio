import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  configManager: {
    getConfig: vi.fn(),
    getEffectiveRelayUrl: vi.fn(() => 'ws://localhost:3000/ws'),
    getRestBaseUrl: vi.fn(() => 'http://localhost:3000'),
    setIdentity: vi.fn(),
    clearIdentity: vi.fn(),
    discoverRelayUrl: vi.fn(),
  },
}));

vi.mock('../services/relay.js', () => ({
  relayClient: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    getStatus: vi.fn(() => 'connected'),
  },
}));

vi.mock('../services/storage.js', () => ({
  storageService: {
    clearAll: vi.fn(),
    saveContact: vi.fn(),
  },
}));

vi.mock('../services/p2p.js', () => ({
  p2pService: {
    initialize: vi.fn(),
    shutdown: vi.fn(),
  },
}));

vi.mock('../services/auth-client.js', () => ({
  registerUser: vi.fn(async (username: string, password: string, displayName?: string) => {
    const { default: axios } = await import('axios');
    const response = await axios.post('http://localhost:3000/api/auth/register', {
      username,
      password,
      displayName,
      deviceFingerprint: 'fp-test',
      deviceName: 'Test Device',
    });
    return response.data;
  }),
  login: vi.fn(async (username: string, password: string) => {
    const { default: axios } = await import('axios');
    try {
      const response = await axios.post('http://localhost:3000/api/auth/login', {
        username,
        password,
        deviceFingerprint: 'fp-test',
        deviceName: 'Test Device',
      });
      return response.data;
    } catch (error: any) {
      // Mirror the real auth-client: surface the server's error payload.
      if (axios.isAxiosError(error) && error.response?.data) {
        return error.response.data;
      }
      return { success: false, error: (error as Error).message };
    }
  }),
}));

const mockAxiosPost = vi.fn();
const mockAxiosGet = vi.fn();
vi.mock('axios', () => ({
  default: {
    post: mockAxiosPost,
    get: mockAxiosGet,
    isAxiosError: vi.fn((e: any) => e?.isAxiosError === true),
  },
}));

vi.mock('@pingio/shared', () => ({
  UsernameSchema: {},
  PasswordSchema: {},
  DisplayNameSchema: {},
  validateUsername: vi.fn(() => ({ valid: true })),
  validatePassword: vi.fn(() => ({ valid: true })),
}));

describe('Auth tools', () => {
  let configManager: any;
  let relayClient: any;
  let storageService: any;
  let p2pService: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const configMod = await import('../config.js');
    configManager = configMod.configManager;
    const relayMod = await import('../services/relay.js');
    relayClient = relayMod.relayClient;
    const storageMod = await import('../services/storage.js');
    storageService = storageMod.storageService;
    const p2pMod = await import('../services/p2p.js');
    p2pService = p2pMod.p2pService;

    configManager.getConfig.mockReturnValue({
      identity: { authToken: null, userId: null, username: null },
    });
  });

  describe('registerUser', () => {
    it('calls POST /api/auth/register, saves config, returns success', async () => {
      mockAxiosPost.mockResolvedValue({
        data: { success: true, userId: 'u1', token: 'tok', refreshToken: 'rt', deviceId: 'd1' },
      });

      const { registerUser } = await import('./auth.js');
      const result = await registerUser('alice', 'Password1!');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/api/auth/register',
        expect.objectContaining({ username: 'alice' })
      );
      expect(configManager.setIdentity).toHaveBeenCalled();
      expect(result.isError).toBeUndefined();
    });

    it('returns error on conflict (axios error)', async () => {
      const err = Object.assign(new Error('Conflict'), {
        isAxiosError: true,
        response: { data: { error: 'Username taken' } },
      });
      mockAxiosPost.mockRejectedValue(err);

      const { registerUser } = await import('./auth.js');
      const result = await registerUser('alice', 'Password1!');

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Registration failed');
    });
  });

  describe('login', () => {
    it('calls POST /api/auth/login, saves tokens, connects WS', async () => {
      mockAxiosPost.mockResolvedValue({
        data: {
          success: true,
          token: 'access-tok',
          refreshToken: 'refresh-tok',
          user: { id: 'u1', username: 'alice' },
          deviceId: 'd1',
        },
      });
      mockAxiosGet.mockResolvedValue({ data: { contacts: [] } });

      const { login } = await import('./auth.js');
      const result = await login('alice', 'Password1!');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/api/auth/login',
        expect.objectContaining({ username: 'alice' })
      );
      expect(relayClient.connect).toHaveBeenCalled();
      expect(result.isError).toBeUndefined();
    });

    it('succeeds with a bare userId when the server omits the user object (cloud shape)', async () => {
      // Cloud /oauth/login returns userId but no user — login must still work.
      mockAxiosPost.mockResolvedValue({
        data: {
          success: true,
          userId: 'u1',
          token: 'access-tok',
          refreshToken: 'refresh-tok',
          deviceId: 'd1',
        },
      });
      mockAxiosGet.mockResolvedValue({ data: { contacts: [] } });

      const { login } = await import('./auth.js');
      const result = await login('alice', 'Password1!');

      expect(result.isError).toBeUndefined();
      expect(configManager.setIdentity).toHaveBeenCalledWith(
        'alice', 'access-tok', 'u1', 'refresh-tok', 'd1'
      );
      expect(result.content[0].text).toContain('Successfully logged in as "alice"');
    });

    it('prompts for device verification when the server requires it', async () => {
      mockAxiosPost.mockRejectedValue(Object.assign(new Error('Forbidden'), {
        isAxiosError: true,
        response: {
          data: {
            success: false,
            verificationRequired: true,
            deviceId: 'dev-9',
            error: 'Device verification required',
          },
        },
      }));

      const { login } = await import('./auth.js');
      const result = await login('alice', 'Password1!');

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Login from new device detected');
      expect(result.content[0].text).toContain('verify_device(deviceId="dev-9")');
    });
  });

  describe('logout', () => {
    it('clears config and returns success message', async () => {
      const { logout } = await import('./auth.js');
      const result = await logout();

      expect(relayClient.disconnect).toHaveBeenCalled();
      expect(configManager.clearIdentity).toHaveBeenCalled();
      expect(storageService.clearAll).toHaveBeenCalled();
      expect(result.isError).toBeUndefined();
    });
  });

  describe('whoami', () => {
    it('returns username when logged in', async () => {
      configManager.getConfig.mockReturnValue({
        identity: { username: 'alice', userId: 'u1', authToken: 'tok' },
        mode: 'cloud',
      });
      configManager.getEffectiveRelayUrl.mockReturnValue('ws://localhost:3000/ws');

      const { whoami } = await import('./auth.js');
      const result = await whoami();

      expect(result.content[0].text).toContain('alice');
    });

    it('returns error message when not logged in', async () => {
      configManager.getConfig.mockReturnValue({
        identity: { username: null, userId: null, authToken: null },
      });

      const { whoami } = await import('./auth.js');
      const result = await whoami();

      expect(result.content[0].text).toContain('not logged in');
    });
  });
});
