import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAxiosPost = vi.fn();
const mockAxiosGet = vi.fn();
const mockAxiosPut = vi.fn();
vi.mock('axios', () => ({
  default: {
    post: mockAxiosPost,
    get: mockAxiosGet,
    put: mockAxiosPut,
    isAxiosError: vi.fn((e: any) => e?.isAxiosError === true),
  },
}));

vi.mock('../config.js', () => ({
  configManager: {
    getConfig: vi.fn(),
    getRestBaseUrl: vi.fn(() => 'http://localhost:3000'),
  },
}));

const mockIdentity = {
  publicKey: { kty: 'OKP', crv: 'X25519', x: 'mock-x' },
  privateKey: { kty: 'OKP', crv: 'X25519', x: 'mock-x', d: 'mock-d' },
  createdAt: '2026-01-01T00:00:00Z',
};

vi.mock('../services/crypto.js', () => ({
  getOrCreateIdentity: vi.fn(() => mockIdentity),
  publicKeyToBase64: vi.fn(() => 'bW9jay1wdWJrZXk'),
  identityFingerprint: vi.fn(() => 'abc123def456'),
  generateChannelKey: vi.fn(() => ({ key: Buffer.alloc(32, 9), keyId: '0123456789abcdef' })),
  wrapChannelKey: vi.fn((_key: Buffer, keyId: string, userId: string) => ({
    keyId,
    userId,
    ephemeralPublicKey: 'eph',
    wrappedKey: 'wrapped',
    nonce: 'nonce',
  })),
  unwrapChannelKey: vi.fn(() => Buffer.alloc(32, 9)),
}));

vi.mock('../services/channel-keys.js', () => ({
  channelKeyStore: {
    getLatestChannelKey: vi.fn(),
    getChannelKey: vi.fn(),
    storeChannelKey: vi.fn(),
    setFlag: vi.fn(),
    getFlag: vi.fn(),
  },
}));

describe('encryption tools', () => {
  let configManager: any;
  let crypto: any;
  let channelKeyStore: any;

  const authConfig = { identity: { authToken: 'tok', userId: 'u1', username: 'alice' } };

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ configManager } = await import('../config.js'));
    crypto = await import('../services/crypto.js');
    ({ channelKeyStore } = await import('../services/channel-keys.js'));
    configManager.getConfig.mockReturnValue(authConfig);
  });

  describe('publishEncryptionKey', () => {
    it('PUTs the identity public key', async () => {
      mockAxiosPut.mockResolvedValue({ data: { success: true } });

      const { publishEncryptionKey } = await import('./encryption.js');
      const result = await publishEncryptionKey();

      expect(result.isError).toBeUndefined();
      expect(mockAxiosPut).toHaveBeenCalledWith(
        'http://localhost:3000/api/encryption/keys',
        { publicKey: 'bW9jay1wdWJrZXk' },
        expect.any(Object)
      );
      expect(result.content[0].text).toContain('abc123def456');
    });

    it('requires login', async () => {
      configManager.getConfig.mockReturnValue({ identity: {} });
      const { publishEncryptionKey } = await import('./encryption.js');
      const result = await publishEncryptionKey();
      expect(result.isError).toBe(true);
      expect(mockAxiosPut).not.toHaveBeenCalled();
    });
  });

  describe('enableChannelEncryption', () => {
    it('enables the flag, generates a key, and posts shares for keyed members', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: { channel: { id: 'ch-1', name: 'vault', encryptionEnabled: false } },
      });
      mockAxiosPut.mockResolvedValue({ data: { success: true } });
      mockAxiosPost.mockResolvedValueOnce({ data: { success: true } }); // POST /encryption
      channelKeyStore.getLatestChannelKey.mockReturnValue(null);
      mockAxiosGet.mockResolvedValueOnce({
        data: {
          encryptionEnabled: true,
          keys: [
            { userId: 'u1', username: 'alice', publicKey: null },
            { userId: 'u2', username: 'bob', publicKey: 'bob-pub' },
            { userId: 'u3', username: 'carol', publicKey: null },
          ],
        },
      });
      mockAxiosPost.mockResolvedValueOnce({ data: { success: true, count: 2 } }); // POST /shares

      const { enableChannelEncryption } = await import('./encryption.js');
      const result = await enableChannelEncryption('ch-1');

      expect(result.isError).toBeUndefined();
      expect(mockAxiosPost).toHaveBeenNthCalledWith(
        1,
        'http://localhost:3000/api/channels/ch-1/encryption',
        {},
        expect.any(Object)
      );
      expect(channelKeyStore.storeChannelKey).toHaveBeenCalledWith('ch-1', '0123456789abcdef', expect.any(String));
      // u1 (self, local pubkey) and u2 got shares; carol (no key) did not.
      const sharesCall = mockAxiosPost.mock.calls[1];
      expect(sharesCall[0]).toBe('http://localhost:3000/api/channels/ch-1/encryption/shares');
      expect(sharesCall[1].keyId).toBe('0123456789abcdef');
      expect(sharesCall[1].shares.map((s: any) => s.userId)).toEqual(['u1', 'u2']);
      expect(result.content[0].text).toContain('2/3 members');
      expect(result.content[0].text).toContain('carol');
    });

    it('continues when the channel was enabled concurrently (409 race)', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: { channel: { id: 'ch-1', name: 'vault', encryptionEnabled: false } },
      });
      mockAxiosPut.mockResolvedValue({ data: { success: true } });
      mockAxiosPost.mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 409, data: { error: 'already enabled' } },
      });
      channelKeyStore.getLatestChannelKey.mockReturnValue({ keyId: 'fedcba9876543210', key: Buffer.alloc(32, 1) });
      mockAxiosGet.mockResolvedValueOnce({
        data: { encryptionEnabled: true, keys: [{ userId: 'u1', username: 'alice', publicKey: null }] },
      });
      mockAxiosPost.mockResolvedValueOnce({ data: { success: true, count: 1 } });

      const { enableChannelEncryption } = await import('./encryption.js');
      const result = await enableChannelEncryption('ch-1');

      expect(result.isError).toBeUndefined();
      // Existing key reused — no new key stored.
      expect(channelKeyStore.storeChannelKey).not.toHaveBeenCalled();
    });

    it('refuses to mint a parallel key when the channel is encrypted but we hold none', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: { channel: { id: 'ch-1', name: 'vault', encryptionEnabled: true } },
      });
      mockAxiosPut.mockResolvedValue({ data: { success: true } });
      channelKeyStore.getLatestChannelKey.mockReturnValue(null);

      const { enableChannelEncryption } = await import('./encryption.js');
      const result = await enableChannelEncryption('ch-1');

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('sync_channel_keys');
      expect(channelKeyStore.storeChannelKey).not.toHaveBeenCalled();
      expect(mockAxiosPost).not.toHaveBeenCalled();
    });

    it('surfaces a cross-member share conflict with a rotation hint', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: { channel: { id: 'ch-1', name: 'vault', encryptionEnabled: true } },
      });
      mockAxiosPut.mockResolvedValue({ data: { success: true } });
      channelKeyStore.getLatestChannelKey.mockReturnValue({ keyId: 'fedcba9876543210', key: Buffer.alloc(32, 1) });
      mockAxiosGet.mockResolvedValueOnce({
        data: { encryptionEnabled: true, keys: [{ userId: 'u2', username: 'bob', publicKey: 'bob-pub' }] },
      });
      mockAxiosPost.mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 409, data: { error: 'conflict' } },
      });

      const { enableChannelEncryption } = await import('./encryption.js');
      const result = await enableChannelEncryption('ch-1');

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('rotate_channel_key');
    });
  });

  describe('rotateChannelKey', () => {
    it('generates a fresh key and redistributes', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: { channel: { id: 'ch-1', name: 'vault', encryptionEnabled: true } },
      });
      channelKeyStore.getLatestChannelKey.mockReturnValue({ keyId: 'old-old-old-0000', key: Buffer.alloc(32, 1) });
      mockAxiosGet.mockResolvedValueOnce({
        data: { encryptionEnabled: true, keys: [{ userId: 'u1', username: 'alice', publicKey: 'a-pub' }] },
      });
      mockAxiosPost.mockResolvedValueOnce({ data: { success: true, count: 1 } });

      const { rotateChannelKey } = await import('./encryption.js');
      const result = await rotateChannelKey('ch-1');

      expect(result.isError).toBeUndefined();
      expect(channelKeyStore.storeChannelKey).toHaveBeenCalledWith('ch-1', '0123456789abcdef', expect.any(String));
      expect(result.content[0].text).toContain('0123456789abcdef');
    });

    it('errors when the channel is not encrypted', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: { channel: { id: 'ch-1', name: 'general', encryptionEnabled: false } },
      });

      const { rotateChannelKey } = await import('./encryption.js');
      const result = await rotateChannelKey('ch-1');

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('enable_channel_encryption');
    });
  });

  describe('syncChannelKeys', () => {
    it('unwraps and stores new shares for one channel', async () => {
      channelKeyStore.getChannelKey.mockReturnValue(null);
      mockAxiosGet.mockResolvedValueOnce({
        data: {
          encryptionEnabled: true,
          shares: [{ keyId: 'k1', ephemeralPublicKey: 'e', wrappedKey: 'w', nonce: 'n' }],
        },
      });

      const { syncChannelKeys } = await import('./encryption.js');
      const result = await syncChannelKeys('ch-1');

      expect(result.isError).toBeUndefined();
      expect(crypto.unwrapChannelKey).toHaveBeenCalled();
      expect(channelKeyStore.storeChannelKey).toHaveBeenCalledWith('ch-1', 'k1', expect.any(String));
      expect(result.content[0].text).toContain('1 new key');
    });

    it('skips shares already held and reports unwrap failures', async () => {
      channelKeyStore.getChannelKey
        .mockReturnValueOnce(Buffer.alloc(32, 1)) // k1 already held
        .mockReturnValueOnce(null); // k2 new
      crypto.unwrapChannelKey.mockReturnValue(null);
      mockAxiosGet.mockResolvedValueOnce({
        data: {
          encryptionEnabled: true,
          shares: [
            { keyId: 'k1', ephemeralPublicKey: 'e', wrappedKey: 'w', nonce: 'n' },
            { keyId: 'k2', ephemeralPublicKey: 'e', wrappedKey: 'w', nonce: 'n' },
          ],
        },
      });

      const { syncChannelKeys } = await import('./encryption.js');
      const result = await syncChannelKeys('ch-1');

      expect(result.content[0].text).toContain('0 new key');
      expect(result.content[0].text).toContain('could not be unwrapped');
      expect(channelKeyStore.storeChannelKey).not.toHaveBeenCalled();
    });

    it('syncs all encrypted channels when no channelId is given', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: {
          channels: [
            { id: 'ch-1', encryptionEnabled: true },
            { id: 'ch-2', encryptionEnabled: false },
            { id: 'ch-3', encryptionEnabled: true },
          ],
        },
      });
      mockAxiosGet.mockResolvedValue({ data: { encryptionEnabled: true, shares: [] } });

      const { syncChannelKeys } = await import('./encryption.js');
      const result = await syncChannelKeys();

      expect(mockAxiosGet).toHaveBeenCalledWith(
        'http://localhost:3000/api/channels/ch-1/encryption/shares/mine',
        expect.any(Object)
      );
      expect(mockAxiosGet).toHaveBeenCalledWith(
        'http://localhost:3000/api/channels/ch-3/encryption/shares/mine',
        expect.any(Object)
      );
      expect(mockAxiosGet).not.toHaveBeenCalledWith(
        'http://localhost:3000/api/channels/ch-2/encryption/shares/mine',
        expect.any(Object)
      );
      expect(result.isError).toBeUndefined();
    });

    it('short-circuits when there are no encrypted channels', async () => {
      mockAxiosGet.mockResolvedValueOnce({ data: { channels: [{ id: 'ch-2', encryptionEnabled: false }] } });

      const { syncChannelKeys } = await import('./encryption.js');
      const result = await syncChannelKeys();

      expect(result.content[0].text).toContain('No encrypted channels');
      expect(mockAxiosGet).toHaveBeenCalledTimes(1);
    });
  });
});
