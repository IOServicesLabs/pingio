import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  configManager: {
    getConfig: vi.fn(),
    getEffectiveRelayUrl: vi.fn(() => 'ws://localhost:3000/ws'),
    getRestBaseUrl: vi.fn(() => 'http://localhost:3000'),
  },
}));

vi.mock('../services/relay.js', () => ({
  relayClient: {
    sendContextShare: vi.fn(),
    sendContextShareRevoke: vi.fn(),
    sendContextShareRequest: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock('../services/storage.js', () => ({
  storageService: {
    getContacts: vi.fn(() => []),
  },
}));

const mockAxiosGet = vi.fn();
vi.mock('axios', () => ({
  default: {
    get: mockAxiosGet,
    isAxiosError: vi.fn((e: any) => e?.isAxiosError === true),
  },
}));

describe('Collab tools', () => {
  let configManager: any;
  let relayClient: any;
  let storageService: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const configMod = await import('../config.js');
    configManager = configMod.configManager;
    const relayMod = await import('../services/relay.js');
    relayClient = relayMod.relayClient;
    const storageMod = await import('../services/storage.js');
    storageService = storageMod.storageService;

    configManager.getConfig.mockReturnValue({
      identity: { authToken: 'test-token', userId: 'u1', username: 'alice' },
    });
    storageService.getContacts.mockReturnValue([]);
  });

  describe('shareContext', () => {
    it('requires login', async () => {
      configManager.getConfig.mockReturnValue({ identity: {} });
      const { shareContext } = await import('./collab.js');
      const result = await shareContext({ summary: 'Working on auth', channelId: 'ch-1' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Not logged in');
    });

    it('requires exactly one scope', async () => {
      const { shareContext } = await import('./collab.js');

      const neither = await shareContext({ summary: 'Working on auth' });
      expect(neither.isError).toBe(true);
      expect(neither.content[0].text).toContain('exactly one');

      const both = await shareContext({ summary: 'Working on auth', channelId: 'ch-1', recipient: 'bob' });
      expect(both.isError).toBe(true);
      expect(both.content[0].text).toContain('exactly one');

      expect(relayClient.sendContextShare).not.toHaveBeenCalled();
    });

    it('rejects an over-long summary', async () => {
      const { shareContext } = await import('./collab.js');
      const result = await shareContext({ summary: 'x'.repeat(600), channelId: 'ch-1' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('summary');
    });

    it('sends a channel share with the cwd project name and default TTL', async () => {
      const { shareContext } = await import('./collab.js');
      const result = await shareContext({
        summary: 'Fixing token refresh',
        channelId: 'ch-1',
        files: ['src/auth.ts'],
        status: 'working',
      });

      expect(relayClient.sendContextShare).toHaveBeenCalledWith(
        { channelId: 'ch-1', recipientId: undefined },
        expect.objectContaining({
          summary: 'Fixing token refresh',
          files: ['src/auth.ts'],
          status: 'working',
          ttlMinutes: 240,
          project: expect.any(String),
        })
      );
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('✓');
    });

    it('clamps an excessive TTL to the maximum', async () => {
      const { shareContext } = await import('./collab.js');
      await shareContext({ summary: 'Long task', channelId: 'ch-1', ttlMinutes: 99999 });

      expect(relayClient.sendContextShare).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ ttlMinutes: 1440 })
      );
    });

    it('resolves a DM recipient from contacts without hitting the API', async () => {
      storageService.getContacts.mockReturnValue([
        { userId: 'u1', contactId: 'u2', username: 'bob', isBlocked: false },
      ]);

      const { shareContext } = await import('./collab.js');
      const result = await shareContext({ summary: 'Pairing on the API', recipient: 'bob' });

      expect(relayClient.sendContextShare).toHaveBeenCalledWith(
        { channelId: undefined, recipientId: 'u2' },
        expect.objectContaining({ summary: 'Pairing on the API' })
      );
      expect(mockAxiosGet).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('@bob');
    });

    it('resolves an unknown recipient via user search', async () => {
      mockAxiosGet.mockResolvedValue({ data: { users: [{ id: 'u9', username: 'carol' }] } });

      const { shareContext } = await import('./collab.js');
      await shareContext({ summary: 'Pairing', recipient: 'carol' });

      expect(mockAxiosGet).toHaveBeenCalledWith(
        'http://localhost:3000/api/users/search?q=carol&limit=10',
        expect.any(Object)
      );
      expect(relayClient.sendContextShare).toHaveBeenCalledWith(
        { channelId: undefined, recipientId: 'u9' },
        expect.any(Object)
      );
    });

    it('fails when the recipient does not exist', async () => {
      mockAxiosGet.mockResolvedValue({ data: { users: [] } });

      const { shareContext } = await import('./collab.js');
      const result = await shareContext({ summary: 'Pairing', recipient: 'nobody' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
      expect(relayClient.sendContextShare).not.toHaveBeenCalled();
    });

    it('refuses to share with a blocked contact', async () => {
      storageService.getContacts.mockReturnValue([
        { userId: 'u1', contactId: 'u2', username: 'bob', isBlocked: true },
      ]);

      const { shareContext } = await import('./collab.js');
      const result = await shareContext({ summary: 'Pairing', recipient: 'bob' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('blocked');
      expect(relayClient.sendContextShare).not.toHaveBeenCalled();
    });
  });

  describe('getSharedContext', () => {
    const share = {
      id: 's1',
      userId: 'u2',
      username: 'bob',
      channelId: 'ch-1',
      summary: 'Fixing token refresh',
      status: 'blocked',
      project: 'api',
      files: ['src/auth.ts'],
      details: '401 on refresh, investigating',
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
    };

    it('requires exactly one scope', async () => {
      const { getSharedContext } = await import('./collab.js');
      const result = await getSharedContext({});
      expect(result.isError).toBe(true);
    });

    it('fetches and formats channel context', async () => {
      mockAxiosGet.mockResolvedValue({ data: { shares: [share] } });

      const { getSharedContext } = await import('./collab.js');
      const result = await getSharedContext({ channelId: 'ch-1' });

      expect(mockAxiosGet).toHaveBeenCalledWith(
        'http://localhost:3000/api/channels/ch-1/context',
        expect.any(Object)
      );
      const text = result.content[0].text;
      expect(text).toContain('@bob [blocked] Fixing token refresh (api)');
      expect(text).toContain('files: src/auth.ts');
      expect(text).toContain('401 on refresh');
    });

    it('reports when nothing is shared', async () => {
      mockAxiosGet.mockResolvedValue({ data: { shares: [] } });

      const { getSharedContext } = await import('./collab.js');
      const result = await getSharedContext({ channelId: 'ch-1' });

      expect(result.content[0].text).toContain('No shared context');
    });

    it('fetches DM context for a known contact', async () => {
      storageService.getContacts.mockReturnValue([
        { userId: 'u1', contactId: 'u2', username: 'bob', isBlocked: false },
      ]);
      mockAxiosGet.mockResolvedValue({ data: { shares: [share] } });

      const { getSharedContext } = await import('./collab.js');
      const result = await getSharedContext({ contact: 'bob' });

      expect(mockAxiosGet).toHaveBeenCalledWith(
        'http://localhost:3000/api/context/dm/u2',
        expect.any(Object)
      );
      expect(result.content[0].text).toContain('@bob');
    });

    it('requires the DM peer to be a contact', async () => {
      const { getSharedContext } = await import('./collab.js');
      const result = await getSharedContext({ contact: 'stranger' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
      expect(mockAxiosGet).not.toHaveBeenCalled();
    });
  });

  describe('requestContextShare', () => {
    it('sends a channel request with an optional target', async () => {
      const { requestContextShare } = await import('./collab.js');
      const result = await requestContextShare({ channelId: 'ch-1', targetUsername: 'bob' });

      expect(relayClient.sendContextShareRequest).toHaveBeenCalledWith({
        channelId: 'ch-1',
        recipientId: undefined,
        targetUsername: 'bob',
      });
      expect(result.content[0].text).toContain('@bob');
    });

    it('resolves a DM recipient before sending', async () => {
      storageService.getContacts.mockReturnValue([
        { userId: 'u1', contactId: 'u2', username: 'bob', isBlocked: false },
      ]);

      const { requestContextShare } = await import('./collab.js');
      await requestContextShare({ recipient: 'bob' });

      expect(relayClient.sendContextShareRequest).toHaveBeenCalledWith({
        channelId: undefined,
        recipientId: 'u2',
        targetUsername: undefined,
      });
    });
  });

  describe('stopSharingContext', () => {
    it('sends a revoke for the channel scope', async () => {
      const { stopSharingContext } = await import('./collab.js');
      const result = await stopSharingContext({ channelId: 'ch-1' });

      expect(relayClient.sendContextShareRevoke).toHaveBeenCalledWith({
        channelId: 'ch-1',
        recipientId: undefined,
      });
      expect(result.content[0].text).toContain('✓');
    });

    it('requires a scope', async () => {
      const { stopSharingContext } = await import('./collab.js');
      const result = await stopSharingContext({});

      expect(result.isError).toBe(true);
      expect(relayClient.sendContextShareRevoke).not.toHaveBeenCalled();
    });
  });
});
