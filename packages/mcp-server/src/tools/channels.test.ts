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
    sendChannelMessage: vi.fn(),
  },
}));

vi.mock('../services/storage.js', () => ({
  storageService: {
    getContacts: vi.fn(() => []),
  },
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
  validateChannelName: vi.fn(() => ({ valid: true })),
  parseEncryptedEnvelope: vi.fn((content: string) =>
    content.startsWith('{"v":1') ? { v: 1, alg: 'A256GCM', keyId: 'key-1', nonce: 'n', ct: 'c' } : null
  ),
}));

vi.mock('../services/channel-keys.js', () => ({
  channelKeyStore: {
    getLatestChannelKey: vi.fn(),
    getChannelKey: vi.fn(),
    getFlag: vi.fn(),
    setFlag: vi.fn(),
  },
}));

vi.mock('../services/crypto.js', () => ({
  encryptChannelMessage: vi.fn((_key: Buffer, keyId: string, _channelId: string, plaintext: string) =>
    `{"v":1,"alg":"A256GCM","keyId":"${keyId}","nonce":"n","ct":"encrypted-${plaintext}"}`
  ),
  decryptChannelMessage: vi.fn((_key: Buffer, _channelId: string, _content: string) => 'decrypted text'),
}));

vi.mock('./encryption.js', () => ({
  enableChannelEncryption: vi.fn(async () => ({ content: [{ type: 'text', text: '✓ key shared' }] })),
}));

describe('Channels tools', () => {
  let configManager: any;
  let relayClient: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const configMod = await import('../config.js');
    configManager = configMod.configManager;
    const relayMod = await import('../services/relay.js');
    relayClient = relayMod.relayClient;

    // Encryption defaults: no local keys, channel known-unencrypted.
    const { channelKeyStore } = await import('../services/channel-keys.js');
    (channelKeyStore.getLatestChannelKey as any).mockReturnValue(null);
    (channelKeyStore.getChannelKey as any).mockReturnValue(null);
    (channelKeyStore.getFlag as any).mockReturnValue(false);

    configManager.getConfig.mockReturnValue({
      identity: { authToken: 'test-token', userId: 'u1', username: 'alice' },
    });
  });

  describe('createChannel', () => {
    it('validates name and calls POST /api/channels', async () => {
      mockAxiosPost.mockResolvedValue({
        data: { channel: { id: 'ch-1', name: 'general', displayName: 'General' } },
      });

      const { createChannel } = await import('./channels.js');
      const result = await createChannel('general', 'General', false);

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/api/channels',
        { name: 'general', displayName: 'General', isPublic: false, channelType: 'social', buildPrompt: undefined, maxMembers: 50, encryptionEnabled: false },
        expect.any(Object)
      );
      expect(result.content[0].text).toBe('✓ #general (id: ch-1)');
    });

    it('creates an encrypted channel and distributes the key', async () => {
      mockAxiosPost.mockResolvedValue({
        data: { channel: { id: 'ch-9', name: 'vault', displayName: 'Vault' } },
      });

      const { createChannel } = await import('./channels.js');
      const { enableChannelEncryption } = await import('./encryption.js');
      const result = await createChannel('vault', 'Vault', false, 'social', undefined, 50, true);

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/api/channels',
        expect.objectContaining({ encryptionEnabled: true }),
        expect.any(Object)
      );
      expect(enableChannelEncryption).toHaveBeenCalledWith('ch-9');
      expect(result.content[0].text).toContain('🔒');
      expect(result.content[0].text).toContain('✓ key shared');
    });

    it('returns validation error for invalid channel name', async () => {
      const { validateChannelName } = await import('@pingio/shared');
      (validateChannelName as any).mockReturnValue({ valid: false, error: 'Too short' });

      const { createChannel } = await import('./channels.js');
      const result = await createChannel('x', 'X', false);

      expect(result.isError).toBe(true);
      expect(mockAxiosPost).not.toHaveBeenCalled();
    });
  });

  describe('joinChannel', () => {
    it('calls POST /api/channels/:id/join', async () => {
      mockAxiosPost.mockResolvedValue({ data: { success: true } });

      const { joinChannel } = await import('./channels.js');
      const result = await joinChannel('ch-1');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/api/channels/ch-1/join',
        {},
        expect.any(Object)
      );
      expect(result.content[0].text).toBe('✓ joined');
    });
  });

  describe('leaveChannel', () => {
    it('calls POST /api/channels/:id/leave (after bug fix)', async () => {
      mockAxiosPost.mockResolvedValue({ data: { success: true } });

      const { leaveChannel } = await import('./channels.js');
      const result = await leaveChannel('ch-1');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/api/channels/ch-1/leave',
        {},
        expect.any(Object)
      );
      expect(result.content[0].text).toBe('✓ left');
    });

    it('returns error when server returns error', async () => {
      const err = Object.assign(new Error('Not member'), {
        isAxiosError: true,
        response: { data: { error: 'Not a member of this channel' } },
      });
      mockAxiosPost.mockRejectedValue(err);

      const { leaveChannel } = await import('./channels.js');
      const result = await leaveChannel('ch-1');

      expect(result.isError).toBe(true);
    });
  });

  describe('inviteToChannel', () => {
    it('calls POST /api/channels/:id/invite (after bug fix)', async () => {
      mockAxiosPost.mockResolvedValue({ data: { success: true } });

      const { inviteToChannel } = await import('./channels.js');
      const result = await inviteToChannel('ch-1', 'bob');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/api/channels/ch-1/invite',
        { username: 'bob' },
        expect.any(Object)
      );
      expect(result.content[0].text).toBe('✓ @bob');
    });

    it('returns error when user not found', async () => {
      const err = Object.assign(new Error('Not found'), {
        isAxiosError: true,
        response: { data: { error: 'User not found' } },
      });
      mockAxiosPost.mockRejectedValue(err);

      const { inviteToChannel } = await import('./channels.js');
      const result = await inviteToChannel('ch-1', 'nobody');

      expect(result.isError).toBe(true);
    });
  });

  describe('sendChannelMessage', () => {
    it('sends plaintext when the channel is not encrypted', async () => {
      const { sendChannelMessage } = await import('./channels.js');
      const result = await sendChannelMessage('ch-1', 'Hello channel!');

      expect(relayClient.sendChannelMessage).toHaveBeenCalledWith('ch-1', 'Hello channel!');
      expect(result.content[0].text).toBe('✓');
    });

    it('encrypts when a local channel key exists', async () => {
      const { channelKeyStore } = await import('../services/channel-keys.js');
      (channelKeyStore.getLatestChannelKey as any).mockReturnValue({ keyId: 'key-1', key: Buffer.alloc(32) });

      const { sendChannelMessage } = await import('./channels.js');
      const result = await sendChannelMessage('ch-1', 'secret');

      const wire = (relayClient.sendChannelMessage as any).mock.calls[0][1];
      expect(wire.startsWith('{"v":1')).toBe(true);
      expect(wire).toContain('"ct":"encrypted-secret"');
      expect(result.content[0].text).toBe('✓ 🔒');
    });

    it('fails closed when the channel is encrypted but we hold no key', async () => {
      const { channelKeyStore } = await import('../services/channel-keys.js');
      (channelKeyStore.getFlag as any).mockReturnValue(true);

      const { sendChannelMessage } = await import('./channels.js');
      const result = await sendChannelMessage('ch-1', 'secret');

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('sync_channel_keys');
      expect(relayClient.sendChannelMessage).not.toHaveBeenCalled();
    });

    it('checks the server when the encryption flag is unknown', async () => {
      const { channelKeyStore } = await import('../services/channel-keys.js');
      (channelKeyStore.getFlag as any).mockReturnValue(null);
      mockAxiosGet.mockResolvedValue({ data: { channel: { encryptionEnabled: false } } });

      const { sendChannelMessage } = await import('./channels.js');
      const result = await sendChannelMessage('ch-1', 'hello');

      expect(mockAxiosGet).toHaveBeenCalledWith(
        'http://localhost:3000/api/channels/ch-1',
        expect.any(Object)
      );
      expect(channelKeyStore.setFlag).toHaveBeenCalledWith('ch-1', false);
      expect(result.content[0].text).toBe('✓');
    });

    it('does not send when the encryption state cannot be verified', async () => {
      const { channelKeyStore } = await import('../services/channel-keys.js');
      (channelKeyStore.getFlag as any).mockReturnValue(null);
      mockAxiosGet.mockRejectedValue(new Error('network down'));

      const { sendChannelMessage } = await import('./channels.js');
      const result = await sendChannelMessage('ch-1', 'hello');

      expect(result.isError).toBe(true);
      expect(relayClient.sendChannelMessage).not.toHaveBeenCalled();
    });
  });

  describe('getChannelHistory', () => {
    it('decrypts envelope messages with a local key', async () => {
      const { channelKeyStore } = await import('../services/channel-keys.js');
      (channelKeyStore.getChannelKey as any).mockReturnValue(Buffer.alloc(32));
      mockAxiosGet.mockResolvedValue({
        data: {
          messages: [
            { senderUsername: 'alice', content: '{"v":1,"alg":"A256GCM","keyId":"key-1","nonce":"n","ct":"c"}', createdAt: '2026-01-01T10:00:00Z' },
            { senderUsername: 'bob', content: 'plaintext hi', createdAt: '2026-01-01T10:01:00Z' },
          ],
        },
      });

      const { getChannelHistory } = await import('./channels.js');
      const result = await getChannelHistory('ch-1');

      expect(result.content[0].text).toContain('alice: 🔒 decrypted text');
      expect(result.content[0].text).toContain('bob: plaintext hi');
    });

    it('shows a placeholder for envelopes we cannot decrypt', async () => {
      const { channelKeyStore } = await import('../services/channel-keys.js');
      (channelKeyStore.getChannelKey as any).mockReturnValue(null);
      mockAxiosGet.mockResolvedValue({
        data: {
          messages: [
            { senderUsername: 'alice', content: '{"v":1,"alg":"A256GCM","keyId":"key-1","nonce":"n","ct":"c"}', createdAt: '2026-01-01T10:00:00Z' },
          ],
        },
      });

      const { getChannelHistory } = await import('./channels.js');
      const result = await getChannelHistory('ch-1');

      expect(result.content[0].text).toContain('run sync_channel_keys');
    });
  });

  describe('kickChannelMember', () => {
    it('resolves the username via contacts and calls the kick endpoint', async () => {
      const { storageService } = await import('../services/storage.js');
      (storageService.getContacts as any).mockReturnValue([
        { username: 'bob', contactId: 'u2', isBlocked: false },
      ]);
      mockAxiosPost.mockResolvedValue({ data: { success: true } });

      const { kickChannelMember } = await import('./channels.js');
      const result = await kickChannelMember('ch-1', 'bob');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/api/channels/ch-1/members/u2/kick',
        {},
        expect.any(Object)
      );
      expect(result.content[0].text).toBe('✓ kicked @bob');
    });

    it('falls back to user search when the user is not a contact', async () => {
      mockAxiosGet.mockResolvedValueOnce({ data: { users: [{ id: 'u7', username: 'carol' }] } });
      mockAxiosPost.mockResolvedValue({ data: { success: true } });

      const { kickChannelMember } = await import('./channels.js');
      const result = await kickChannelMember('ch-1', 'carol');

      expect(mockAxiosGet).toHaveBeenCalledWith(
        'http://localhost:3000/api/users/search?q=carol&limit=10',
        expect.any(Object)
      );
      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/api/channels/ch-1/members/u7/kick',
        {},
        expect.any(Object)
      );
      expect(result.isError).toBeUndefined();
    });

    it('errors without any HTTP call when the user cannot be resolved', async () => {
      mockAxiosGet.mockResolvedValueOnce({ data: { users: [] } });

      const { kickChannelMember } = await import('./channels.js');
      const result = await kickChannelMember('ch-1', 'ghost');

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('ghost');
      expect(mockAxiosPost).not.toHaveBeenCalled();
    });

    it('surfaces server authorization errors', async () => {
      const { storageService } = await import('../services/storage.js');
      (storageService.getContacts as any).mockReturnValue([
        { username: 'bob', contactId: 'u2', isBlocked: false },
      ]);
      mockAxiosPost.mockRejectedValue(Object.assign(new Error('Forbidden'), {
        isAxiosError: true,
        response: { status: 403, data: { error: 'Only the channel owner can kick an admin' } },
      }));

      const { kickChannelMember } = await import('./channels.js');
      const result = await kickChannelMember('ch-1', 'bob');

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Only the channel owner can kick an admin');
    });
  });

  describe('setChannelMemberRole', () => {
    it('rejects invalid roles before any HTTP call', async () => {
      const { setChannelMemberRole } = await import('./channels.js');
      const result = await setChannelMemberRole('ch-1', 'bob', 'superadmin' as any);

      expect(result.isError).toBe(true);
      expect(mockAxiosPost).not.toHaveBeenCalled();
    });

    it('posts the role change for a resolved user', async () => {
      const { storageService } = await import('../services/storage.js');
      (storageService.getContacts as any).mockReturnValue([
        { username: 'bob', contactId: 'u2', isBlocked: false },
      ]);
      mockAxiosPost.mockResolvedValue({ data: { success: true } });

      const { setChannelMemberRole } = await import('./channels.js');
      const result = await setChannelMemberRole('ch-1', 'bob', 'admin');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/api/channels/ch-1/members/u2/role',
        { role: 'admin' },
        expect.any(Object)
      );
      expect(result.content[0].text).toBe('✓ @bob is now admin');
    });

    it('reports ownership transfer distinctly', async () => {
      const { storageService } = await import('../services/storage.js');
      (storageService.getContacts as any).mockReturnValue([
        { username: 'bob', contactId: 'u2', isBlocked: false },
      ]);
      mockAxiosPost.mockResolvedValue({ data: { success: true, ownershipTransferred: true } });

      const { setChannelMemberRole } = await import('./channels.js');
      const result = await setChannelMemberRole('ch-1', 'bob', 'owner');

      expect(result.content[0].text).toContain('ownership transferred to @bob');
      expect(result.content[0].text).toContain('you are now an admin');
    });
  });

  describe('getChannelAuditLog', () => {
    it('formats events with actor, action, target and metadata', async () => {
      mockAxiosGet.mockResolvedValue({
        data: {
          events: [
            { action: 'member_kicked', actorUsername: 'alice', targetUsername: 'bob', metadata: { targetRole: 'member' }, createdAt: '2026-01-02T10:00:00Z' },
            { action: 'channel_created', actorUsername: 'alice', createdAt: '2026-01-01T10:00:00Z' },
          ],
        },
      });

      const { getChannelAuditLog } = await import('./channels.js');
      const result = await getChannelAuditLog('ch-1');

      expect(mockAxiosGet).toHaveBeenCalledWith(
        'http://localhost:3000/api/channels/ch-1/audit?limit=50',
        expect.any(Object)
      );
      expect(result.content[0].text).toContain('@alice member_kicked @bob');
      expect(result.content[0].text).toContain('{"targetRole":"member"}');
      expect(result.content[0].text).toContain('@alice channel_created');
    });

    it('reports when there are no events', async () => {
      mockAxiosGet.mockResolvedValue({ data: { events: [] } });

      const { getChannelAuditLog } = await import('./channels.js');
      const result = await getChannelAuditLog('ch-1');

      expect(result.content[0].text).toBe('No audit events');
    });

    it('surfaces 403 for non-admins', async () => {
      mockAxiosGet.mockRejectedValue(Object.assign(new Error('Forbidden'), {
        isAxiosError: true,
        response: { status: 403, data: { error: 'Only channel admins can read the audit log' } },
      }));

      const { getChannelAuditLog } = await import('./channels.js');
      const result = await getChannelAuditLog('ch-1');

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Only channel admins');
    });
  });

  describe('setChannelRetention', () => {
    it('posts the retention override', async () => {
      mockAxiosPost.mockResolvedValue({ data: { ok: true, retentionMinutes: 1440 } });

      const { setChannelRetention } = await import('./channels.js');
      const result = await setChannelRetention('ch-1', 1440);

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/api/channels/ch-1/retention',
        { retentionMinutes: 1440 },
        expect.any(Object)
      );
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('1440 minutes');
      expect(result.content[0].text).toContain('1.0 days');
    });

    it('clears the override with null', async () => {
      mockAxiosPost.mockResolvedValue({ data: { ok: true, retentionMinutes: null } });

      const { setChannelRetention } = await import('./channels.js');
      const result = await setChannelRetention('ch-1', null);

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'http://localhost:3000/api/channels/ch-1/retention',
        { retentionMinutes: null },
        expect.any(Object)
      );
      expect(result.content[0].text).toContain('server default');
    });

    it('surfaces relay errors (e.g. 403 for non-admins)', async () => {
      mockAxiosPost.mockRejectedValue(Object.assign(new Error('Forbidden'), {
        isAxiosError: true,
        response: { status: 403, data: { error: 'Only channel admins can change retention' } },
      }));

      const { setChannelRetention } = await import('./channels.js');
      const result = await setChannelRetention('ch-1', 60);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Only channel admins');
    });
  });
});
