import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  configManager: {
    getConfig: vi.fn(),
    getRestBaseUrl: vi.fn().mockReturnValue('http://localhost:3000'),
  },
}));

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    isAxiosError: (error: any) => error?.isAxiosError === true,
  },
}));

vi.mock('../services/relay.js', () => ({
  relayClient: {
    updatePresence: vi.fn(),
    sendTyping: vi.fn(),
  },
}));

vi.mock('../services/storage.js', () => ({
  storageService: {
    getContacts: vi.fn(),
  },
}));

vi.mock('@pingio/shared', () => ({
  PRESENCE_STATUSES: ['online', 'away', 'busy', 'offline'],
}));

describe('Presence tools', () => {
  let configManager: any;
  let relayClient: any;
  let storageService: any;
  let axiosGet: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const configMod = await import('../config.js');
    configManager = configMod.configManager;
    const relayMod = await import('../services/relay.js');
    relayClient = relayMod.relayClient;
    const storageMod = await import('../services/storage.js');
    storageService = storageMod.storageService;
    axiosGet = (await import('axios')).default.get as any;

    configManager.getConfig.mockReturnValue({
      identity: { authToken: 'test-token', userId: 'u1', username: 'alice' },
    });
    configManager.getRestBaseUrl.mockReturnValue('http://localhost:3000');
  });

  describe('setStatus', () => {
    it('validates status and calls relayClient.updatePresence', async () => {
      const { setStatus } = await import('./presence.js');
      const result = await setStatus('busy', 'In a meeting');

      expect(relayClient.updatePresence).toHaveBeenCalledWith('busy', 'In a meeting');
      expect(result.content[0].text).toContain('busy');
    });

    it('returns error for invalid status', async () => {
      const { setStatus } = await import('./presence.js');
      const result = await setStatus('invisible' as any);

      expect(result.isError).toBe(true);
      expect(relayClient.updatePresence).not.toHaveBeenCalled();
    });

    it('returns error when not logged in', async () => {
      configManager.getConfig.mockReturnValue({ identity: { authToken: null } });

      const { setStatus } = await import('./presence.js');
      const result = await setStatus('online');

      expect(result.isError).toBe(true);
    });
  });

  describe('typing', () => {
    it('looks up contact and calls relayClient.sendTyping', async () => {
      storageService.getContacts.mockReturnValue([
        { username: 'bob', contactId: 'u2', isBlocked: false, unreadCount: 0 },
      ]);

      const { typing } = await import('./presence.js');
      const result = await typing('bob', true);

      expect(relayClient.sendTyping).toHaveBeenCalledWith('u2', true);
      expect(result.isError).toBeUndefined();
    });

    it('returns error if contact not found', async () => {
      storageService.getContacts.mockReturnValue([]);

      const { typing } = await import('./presence.js');
      const result = await typing('nobody', true);

      expect(result.isError).toBe(true);
      expect(relayClient.sendTyping).not.toHaveBeenCalled();
    });

    it('sends typing=false to stop indicator', async () => {
      storageService.getContacts.mockReturnValue([
        { username: 'bob', contactId: 'u2', isBlocked: false, unreadCount: 0 },
      ]);

      const { typing } = await import('./presence.js');
      await typing('bob', false);

      expect(relayClient.sendTyping).toHaveBeenCalledWith('u2', false);
    });
  });

  describe('getUserStatus', () => {
    it('returns error when not logged in', async () => {
      configManager.getConfig.mockReturnValue({ identity: { authToken: null } });

      const { getUserStatus } = await import('./presence.js');
      const result = await getUserStatus('bob');

      expect(result.isError).toBe(true);
      expect(axiosGet).not.toHaveBeenCalled();
    });

    it('returns error for an unknown contact (presence is mutual-contacts only)', async () => {
      storageService.getContacts.mockReturnValue([]);

      const { getUserStatus } = await import('./presence.js');
      const result = await getUserStatus('stranger');

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('mutual contacts');
      expect(axiosGet).not.toHaveBeenCalled();
    });

    it('renders status, custom message and lastSeen for a contact', async () => {
      storageService.getContacts.mockReturnValue([
        { username: 'bob', contactId: 'u2', isBlocked: false, unreadCount: 0 },
      ]);
      axiosGet.mockResolvedValue({
        data: { presence: { status: 'busy', message: 'in a meeting', lastSeen: '2026-01-01T10:00:00.000Z' } },
      });

      const { getUserStatus } = await import('./presence.js');
      const result = await getUserStatus('bob');

      expect(axiosGet).toHaveBeenCalledWith(
        'http://localhost:3000/api/users/u2/presence',
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) })
      );
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('@bob is busy');
      expect(result.content[0].text).toContain('"in a meeting"');
      expect(result.content[0].text).toContain('last seen');
    });

    it('renders offline when the relay returns no presence record', async () => {
      storageService.getContacts.mockReturnValue([
        { username: 'bob', contactId: 'u2', isBlocked: false, unreadCount: 0 },
      ]);
      axiosGet.mockResolvedValue({ data: { presence: null } });

      const { getUserStatus } = await import('./presence.js');
      const result = await getUserStatus('bob');

      expect(result.content[0].text).toBe('@bob is offline');
    });

    it('surfaces relay errors (e.g. 403 non-mutual)', async () => {
      storageService.getContacts.mockReturnValue([
        { username: 'bob', contactId: 'u2', isBlocked: false, unreadCount: 0 },
      ]);
      axiosGet.mockRejectedValue(Object.assign(new Error('Forbidden'), {
        isAxiosError: true,
        response: { status: 403, data: { error: 'Only mutual contacts can see presence' } },
      }));

      const { getUserStatus } = await import('./presence.js');
      const result = await getUserStatus('bob');

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Only mutual contacts');
    });
  });
});
