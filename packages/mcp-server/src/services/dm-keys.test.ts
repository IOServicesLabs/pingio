import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAxiosGet = vi.fn();
vi.mock('axios', () => ({
  default: {
    get: mockAxiosGet,
    isAxiosError: vi.fn((e: any) => e?.isAxiosError === true),
  },
}));

vi.mock('../config.js', () => ({
  configManager: {
    getConfig: vi.fn(),
    getRestBaseUrl: vi.fn(() => 'http://localhost:3000'),
  },
}));

vi.mock('./crypto.js', () => ({
  getOrCreateIdentity: vi.fn(() => ({
    publicKey: { kty: 'OKP', crv: 'X25519', x: 'mock-x' },
    privateKey: { kty: 'OKP', crv: 'X25519', x: 'mock-x', d: 'mock-d' },
    createdAt: '2026-01-01T00:00:00Z',
  })),
  deriveDmKey: vi.fn((_identity: any, peerPub: string, _myId: string, peerId: string) => ({
    key: Buffer.alloc(32, 7),
    keyId: `key-${peerId}`,
  })),
}));

describe('DmKeyService', () => {
  let configManager: any;
  let dmKeyService: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ configManager } = await import('../config.js'));
    ({ dmKeyService } = await import('./dm-keys.js'));
    dmKeyService.clear();
    configManager.getConfig.mockReturnValue({
      identity: { authToken: 'tok', userId: 'u1', username: 'alice' },
    });
  });

  it('fetches the peer key, derives the pairwise key, and caches it', async () => {
    mockAxiosGet.mockResolvedValue({
      data: { userId: 'u2', username: 'bob', publicKey: 'Ym9iLXB1Yg', updatedAt: '2026-01-01' },
    });

    const first = await dmKeyService.getDmKey('u2');
    const second = await dmKeyService.getDmKey('u2');

    expect(mockAxiosGet).toHaveBeenCalledTimes(1); // cached on second call
    expect(mockAxiosGet).toHaveBeenCalledWith(
      'http://localhost:3000/api/users/u2/encryption-key',
      expect.any(Object)
    );
    expect(first.keyId).toBe('key-u2');
    expect(second).toBe(first);
  });

  it('returns null and caches the miss when the peer has no key published', async () => {
    mockAxiosGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 404, data: { error: 'no key' } },
    });

    const result = await dmKeyService.getDmKey('u3');
    const again = await dmKeyService.getDmKey('u3');

    expect(result).toBeNull();
    expect(again).toBeNull();
    expect(mockAxiosGet).toHaveBeenCalledTimes(1); // miss is cached
  });

  it('propagates non-404 fetch errors', async () => {
    mockAxiosGet.mockRejectedValue(new Error('network down'));

    await expect(dmKeyService.getDmKey('u2')).rejects.toThrow('network down');
  });

  it('returns null when logged out', async () => {
    configManager.getConfig.mockReturnValue({ identity: {} });

    const result = await dmKeyService.getDmKey('u2');

    expect(result).toBeNull();
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it('refreshPeerKey drops the cache and refetches', async () => {
    mockAxiosGet.mockResolvedValue({
      data: { userId: 'u2', username: 'bob', publicKey: 'bmV3LWtleQ', updatedAt: '2026-01-02' },
    });

    await dmKeyService.getDmKey('u2');
    const refreshed = await dmKeyService.refreshPeerKey('u2');

    expect(mockAxiosGet).toHaveBeenCalledTimes(2);
    expect(refreshed.peerPublicKey).toBe('bmV3LWtleQ');
  });

  it('returns null when derivation fails (malformed peer key)', async () => {
    const crypto = await import('./crypto.js');
    (crypto.deriveDmKey as any).mockReturnValueOnce(null);
    mockAxiosGet.mockResolvedValue({
      data: { userId: 'u2', username: 'bob', publicKey: 'aGFpbGFz', updatedAt: '2026-01-01' },
    });

    const result = await dmKeyService.getDmKey('u2');

    expect(result).toBeNull();
  });
});
