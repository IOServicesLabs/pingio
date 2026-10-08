import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostgresStore } from './postgres.js';

// Mock pg module
const mockQuery = vi.fn();
const mockRelease = vi.fn();
const mockConnect = vi.fn(() => ({ query: mockQuery, release: mockRelease }));
const mockPoolEnd = vi.fn();

vi.mock('pg', () => ({
  default: {
    Pool: vi.fn(() => ({
      query: mockQuery,
      connect: mockConnect,
      end: mockPoolEnd,
    })),
  },
}));

// Mock uuid to produce predictable IDs
vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid'),
}));

describe('PostgresStore', () => {
  let store: PostgresStore;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Make createTables a no-op
    mockConnect.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [] }), release: mockRelease });
    store = new PostgresStore('postgresql://test');
    // Skip init since we don't need tables in unit tests
  });

  describe('createUser', () => {
    it('returns mapped User on success', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          username: 'alice',
          display_name: 'Alice',
          created_at: new Date('2024-01-01'),
          last_seen_at: new Date('2024-01-01'),
          password_hash: 'hashed',
        }],
      });

      const user = await store.createUser('alice', 'hashed', 'Alice');

      expect(user).not.toBeNull();
      expect(user?.username).toBe('alice');
      expect(user?.displayName).toBe('Alice');
    });

    it('returns null on duplicate username (23505 error)', async () => {
      const err = Object.assign(new Error('unique'), { code: '23505' });
      mockQuery.mockRejectedValueOnce(err);

      const user = await store.createUser('alice', 'hashed');

      expect(user).toBeNull();
    });
  });

  describe('getUserByUsername', () => {
    it('returns mapped User when found', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'u1', username: 'alice', display_name: null, created_at: new Date(), last_seen_at: null }],
      });

      const user = await store.getUserByUsername('alice');

      expect(user?.username).toBe('alice');
    });

    it('returns null when not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const user = await store.getUserByUsername('nobody');

      expect(user).toBeNull();
    });
  });

  describe('getUserById', () => {
    it('returns mapped User when found', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'u1', username: 'alice', display_name: null, created_at: new Date(), last_seen_at: null }],
      });

      const user = await store.getUserById('u1');

      expect(user?.id).toBe('u1');
    });

    it('returns null when not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const user = await store.getUserById('missing');

      expect(user).toBeNull();
    });
  });

  describe('addContact / getContacts', () => {
    it('addContact returns mapped Contact on success', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          user_id: 'u1',
          contact_id: 'u2',
          username: 'bob',
          display_name: null,
          custom_name: null,
          is_blocked: false,
          created_at: new Date(),
        }],
      });

      const contact = await store.addContact('u1', 'u2');

      expect(contact).not.toBeNull();
      expect(contact?.username).toBe('bob');
    });

    it('addContact returns null on duplicate (23505)', async () => {
      const err = Object.assign(new Error('unique'), { code: '23505' });
      mockQuery.mockRejectedValueOnce(err);

      const contact = await store.addContact('u1', 'u2');

      expect(contact).toBeNull();
    });

    it('getContacts returns list of contacts', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { user_id: 'u1', contact_id: 'u2', username: 'bob', display_name: null, custom_name: null, is_blocked: false, created_at: new Date() },
          { user_id: 'u1', contact_id: 'u3', username: 'carol', display_name: null, custom_name: null, is_blocked: false, created_at: new Date() },
        ],
      });

      const contacts = await store.getContacts('u1');

      expect(contacts).toHaveLength(2);
      expect(contacts[0].username).toBe('bob');
    });
  });

  describe('createMessage / getDMHistory', () => {
    it('createMessage returns Message with id', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'msg-1',
          sender_id: 'u1',
          sender_username: 'alice',
          recipient_id: 'u2',
          channel_id: null,
          content: 'Hello',
          is_ephemeral: false,
          created_at: new Date(),
          edited_at: null,
          deleted_at: null,
        }],
      });

      const msg = await store.createMessage('u1', 'Hello', 'u2');

      expect(msg.id).toBe('msg-1');
      expect(msg.content).toBe('Hello');
    });

    it('getDMHistory returns array of messages', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 'm1', sender_id: 'u1', sender_username: 'alice', recipient_id: 'u2', channel_id: null, content: 'Hi', is_ephemeral: false, created_at: new Date(), edited_at: null, deleted_at: null },
        ],
      });

      const messages = await store.getDMHistory('u1', 'u2');

      expect(messages).toHaveLength(1);
    });
  });

  describe('createChannel / getChannelById', () => {
    it('createChannel returns Channel', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'ch-1',
          name: 'general',
          display_name: 'General',
          is_public: true,
          created_by: 'u1',
          created_at: new Date(),
          member_count: 0,
        }],
      });

      const channel = await store.createChannel('general', 'General', 'u1', true);

      expect(channel.name).toBe('general');
      expect(channel.isPublic).toBe(true);
    });
  });

  describe('blockContact / isBlocked', () => {
    it('blockContact returns true when row updated', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const result = await store.blockContact('u1', 'u2', true);

      expect(result).toBe(true);
    });

    it('blockContact returns false when no row found', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      const result = await store.blockContact('u1', 'u9', true);

      expect(result).toBe(false);
    });

    it('isBlocked returns block status for both directions', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ blocked_target: true, blocked_by: false }],
      });

      const result = await store.isBlocked('u1', 'u2');

      expect(result.blockedTarget).toBe(true);
      expect(result.blockedBy).toBe(false);
    });
  });

  describe('joinChannel / leaveChannel / addChannelMember', () => {
    it('joinChannel returns true on first join', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const result = await store.joinChannel('ch-1', 'u1');

      expect(result).toBe(true);
    });

    it('joinChannel returns false on duplicate (23505)', async () => {
      const err = Object.assign(new Error('unique'), { code: '23505' });
      mockQuery.mockRejectedValueOnce(err);

      const result = await store.joinChannel('ch-1', 'u1');

      expect(result).toBe(false);
    });

    it('leaveChannel returns true when member removed', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const result = await store.leaveChannel('ch-1', 'u1');

      expect(result).toBe(true);
    });
  });

  describe('build tasks', () => {
    it('createBuildTask returns a pending task', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'task-1',
          channel_id: 'ch-1',
          owner_id: 'u1',
          title: 'Build feature',
          description: 'Do it',
          status: 'pending',
          assigned_to: null,
          artifact_filename: null,
          artifact_size: null,
          created_at: new Date(),
          assigned_at: null,
          completed_at: null,
          context_cleared_at: null,
        }],
      });

      const task = await store.createBuildTask('ch-1', 'u1', 'Build feature', 'Do it');

      expect(task.title).toBe('Build feature');
      expect(task.status).toBe('pending');
    });

    it('assignBuildTask updates status and assigned_to', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'task-1',
          channel_id: 'ch-1',
          owner_id: 'u1',
          title: 'Build feature',
          description: null,
          status: 'assigned',
          assigned_to: 'u2',
          artifact_filename: null,
          artifact_size: null,
          created_at: new Date(),
          assigned_at: new Date(),
          completed_at: null,
          context_cleared_at: null,
        }],
      });

      const task = await store.assignBuildTask('task-1', 'u2');

      expect(task?.status).toBe('assigned');
      expect(task?.assignedTo).toBe('u2');
    });

    it('completeBuildTask stores artifact metadata', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'task-1',
          channel_id: 'ch-1',
          owner_id: 'u1',
          title: 'Build feature',
          description: null,
          status: 'completed',
          assigned_to: 'u2',
          artifact_filename: 'result.zip',
          artifact_size: 1234,
          created_at: new Date(),
          assigned_at: new Date(),
          completed_at: new Date(),
          context_cleared_at: null,
        }],
      });

      const task = await store.completeBuildTask('task-1', 'result.zip', 1234);

      expect(task?.status).toBe('completed');
      expect(task?.artifactFilename).toBe('result.zip');
      expect(task?.artifactSize).toBe(1234);
    });

    it('getBuildTasks filters by status', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'task-1',
          channel_id: 'ch-1',
          owner_id: 'u1',
          title: 'Build feature',
          description: null,
          status: 'pending',
          assigned_to: null,
          artifact_filename: null,
          artifact_size: null,
          created_at: new Date(),
          assigned_at: null,
          completed_at: null,
          context_cleared_at: null,
        }],
      });

      const tasks = await store.getBuildTasks('ch-1', 'pending');

      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe('pending');
    });

    it('updateBuildTask updates title and status', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'task-1',
          channel_id: 'ch-1',
          owner_id: 'u1',
          title: 'Renamed',
          description: null,
          status: 'cancelled',
          assigned_to: null,
          artifact_filename: null,
          artifact_size: null,
          created_at: new Date(),
          assigned_at: null,
          completed_at: null,
          context_cleared_at: null,
        }],
      });

      const task = await store.updateBuildTask('task-1', { title: 'Renamed', status: 'cancelled' });

      expect(task?.title).toBe('Renamed');
      expect(task?.status).toBe('cancelled');
    });
  });

  describe('member session status', () => {
    it('updateMemberSessionStatus stores report', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          user_id: 'u1',
          channel_id: 'ch-1',
          reported_at: new Date(),
          remaining_requests: 50,
          context_window_used: 1200,
          selected_model: 'claude-sonnet-4',
        }],
      });

      const status = await store.updateMemberSessionStatus('u1', 'ch-1', {
        remainingRequests: 50,
        contextWindowUsed: 1200,
        selectedModel: 'claude-sonnet-4',
      });

      expect(status.userId).toBe('u1');
      expect(status.remainingRequests).toBe(50);
    });

    it('getMemberSessionStatuses returns channel reports', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          user_id: 'u1',
          channel_id: 'ch-1',
          reported_at: new Date(),
          remaining_requests: 10,
          context_window_used: 500,
          selected_model: 'claude-haiku-4',
        }],
      });

      const statuses = await store.getMemberSessionStatuses('ch-1');

      expect(statuses).toHaveLength(1);
      expect(statuses[0].selectedModel).toBe('claude-haiku-4');
    });
  });

  describe('context shares', () => {
    const shareRow = {
      id: 's1',
      user_id: 'u1',
      username: 'alice',
      channel_id: 'ch-1',
      recipient_id: null,
      summary: 'Fixing token refresh',
      details: null,
      files: ['src/auth.ts'],
      status: 'working',
      project: 'api',
      task_id: null,
      created_at: new Date(),
      updated_at: new Date(),
      expires_at: new Date(Date.now() + 3600_000),
    };

    it('upsertContextShare targets the channel partial unique index', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [shareRow] });

      const share = await store.upsertContextShare('u1', { channelId: 'ch-1' }, {
        summary: 'Fixing token refresh',
        files: ['src/auth.ts'],
      });

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('ON CONFLICT (user_id, channel_id) WHERE channel_id IS NOT NULL');
      expect(params[1]).toBe('u1');
      expect(params[2]).toBe('ch-1');
      expect(params[3]).toBeNull(); // recipient_id
      expect(params[9]).toBeNull(); // git
      expect(params[11]).toBe(240); // default TTL minutes
      expect(share.summary).toBe('Fixing token refresh');
      expect(share.files).toEqual(['src/auth.ts']);
      expect(share.git).toBeUndefined();
    });

    it('upsertContextShare targets the DM partial unique index and respects a custom TTL', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ ...shareRow, channel_id: null, recipient_id: 'u2' }],
      });

      await store.upsertContextShare('u1', { recipientId: 'u2' }, {
        summary: 'Pairing',
        ttlMinutes: 30,
      });

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('ON CONFLICT (user_id, recipient_id) WHERE recipient_id IS NOT NULL');
      expect(params[2]).toBeNull(); // channel_id
      expect(params[3]).toBe('u2');
      expect(params[11]).toBe(30);
    });

    it('upsertContextShare serializes git info and maps it back from the row', async () => {
      const git = { branch: 'main', dirty: true, changedFiles: ['src/auth.ts'], diffStat: '1 file changed' };
      mockQuery.mockResolvedValueOnce({ rows: [{ ...shareRow, git }] });

      const share = await store.upsertContextShare('u1', { channelId: 'ch-1' }, {
        summary: 'Fixing token refresh',
        git,
      });

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('git = $10');
      expect(params[9]).toBe(JSON.stringify(git));
      expect(share.git).toEqual(git);
    });

    it('revokeContextShare deletes only within the given scope', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const revoked = await store.revokeContextShare('u1', { channelId: 'ch-1' });

      expect(revoked).toBe(true);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('DELETE FROM context_shares');
      expect(params).toEqual(['u1', 'ch-1', null]);
    });

    it('revokeContextShare returns false when nothing was shared', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      const revoked = await store.revokeContextShare('u1', { channelId: 'ch-1' });

      expect(revoked).toBe(false);
    });

    it('getContextSharesForChannel filters expired shares and joins usernames', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [shareRow] });

      const shares = await store.getContextSharesForChannel('ch-1');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('cs.expires_at > NOW()');
      expect(params).toEqual(['ch-1']);
      expect(shares).toHaveLength(1);
      expect(shares[0].username).toBe('alice');
      expect(shares[0].channelId).toBe('ch-1');
    });

    it('getContextSharesForDM matches both directions of the conversation', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await store.getContextSharesForDM('u1', 'u2');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('cs.recipient_id = $2');
      expect(sql).toContain('cs.recipient_id = $1');
      expect(params).toEqual(['u1', 'u2']);
    });

    it('deleteExpiredContextShares sweeps and reports the count', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 3 });

      const deleted = await store.deleteExpiredContextShares();

      expect(deleted).toBe(3);
      expect(mockQuery.mock.calls[0][0]).toContain('expires_at <= NOW()');
    });
  });

  describe('message retention', () => {
    it('setChannelRetention updates the override and reports success', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const ok = await store.setChannelRetention('ch-1', 1440);

      expect(ok).toBe(true);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('UPDATE channels SET retention_minutes = $2');
      expect(params).toEqual(['ch-1', 1440]);
    });

    it('setChannelRetention accepts null to clear the override', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      const ok = await store.setChannelRetention('ch-1', null);

      expect(ok).toBe(false); // unknown channel
      expect(mockQuery.mock.calls[0][1]).toEqual(['ch-1', null]);
    });

    it('deleteExpiredMessages applies channel override with server-default fallback', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 5 })  // channel sweep
        .mockResolvedValueOnce({ rowCount: 2 }); // DM sweep

      const result = await store.deleteExpiredMessages(10080);

      expect(result).toEqual({ channelDeleted: 5, dmDeleted: 2 });
      const [channelSql, channelParams] = mockQuery.mock.calls[0];
      expect(channelSql).toContain('COALESCE(c.retention_minutes, $1) > 0');
      expect(channelParams).toEqual([10080]);
      const [dmSql, dmParams] = mockQuery.mock.calls[1];
      expect(dmSql).toContain('channel_id IS NULL');
      expect(dmSql).toContain('$1 > 0');
      expect(dmParams).toEqual([10080]);
    });

    it('deleteExpiredMessages with default 0 still honors channel overrides', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 4 })
        .mockResolvedValueOnce({ rowCount: 0 });

      const result = await store.deleteExpiredMessages(0);

      // The COALESCE keeps channel overrides live; the $1 > 0 guard makes the
      // DM query a no-op.
      expect(result).toEqual({ channelDeleted: 4, dmDeleted: 0 });
      expect(mockQuery.mock.calls[0][1]).toEqual([0]);
      expect(mockQuery.mock.calls[1][1]).toEqual([0]);
    });
  });

  describe('channel encryption', () => {
    it('createChannel maps encryption_enabled', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'ch-1',
          name: 'vault',
          display_name: 'Vault',
          is_public: false,
          created_by: 'u1',
          created_at: new Date(),
          member_count: 0,
          encryption_enabled: true,
        }],
      });

      const channel = await store.createChannel('vault', 'Vault', 'u1', false, 'social', undefined, 50, true);

      expect(channel.encryptionEnabled).toBe(true);
      const [, params] = mockQuery.mock.calls[0];
      expect(params[9]).toBe(true);
    });

    it('upsertEncryptionKey inserts with ON CONFLICT update', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await store.upsertEncryptionKey('u1', 'pubkey-b64');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('ON CONFLICT (user_id) DO UPDATE');
      expect(params).toEqual(['u1', 'pubkey-b64']);
    });

    it('getChannelEncryptionKeys left-joins members with their public keys', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { user_id: 'u1', username: 'alice', x25519_public_key: 'key-a' },
          { user_id: 'u2', username: 'bob', x25519_public_key: null },
        ],
      });

      const keys = await store.getChannelEncryptionKeys('ch-1');

      expect(keys).toEqual([
        { userId: 'u1', username: 'alice', publicKey: 'key-a' },
        { userId: 'u2', username: 'bob', publicKey: null },
      ]);
      expect(mockQuery.mock.calls[0][0]).toContain('LEFT JOIN user_encryption_keys');
    });

    it('getEncryptionKey returns the published identity key with username', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          user_id: 'u1',
          username: 'alice',
          x25519_public_key: 'key-a',
          updated_at: new Date('2026-01-01'),
        }],
      });

      const key = await store.getEncryptionKey('u1');

      expect(key).toEqual({
        userId: 'u1',
        username: 'alice',
        publicKey: 'key-a',
        updatedAt: new Date('2026-01-01'),
      });
      expect(mockQuery.mock.calls[0][0]).toContain('FROM user_encryption_keys');
    });

    it('getEncryptionKey returns null when no key is published', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      expect(await store.getEncryptionKey('u-missing')).toBeNull();
    });

    it('setChannelEncryptionEnabled reports whether the flag flipped', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      expect(await store.setChannelEncryptionEnabled('ch-1')).toBe(true);
      expect(mockQuery.mock.calls[0][0]).toContain('encryption_enabled = FALSE');

      mockQuery.mockResolvedValueOnce({ rowCount: 0 });
      expect(await store.setChannelEncryptionEnabled('ch-1')).toBe(false);
    });

    it('upsertChannelKeyShares inserts all shares in one transaction', async () => {
      mockConnect.mockReturnValue({ query: mockQuery, release: mockRelease });
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // existing shares lookup
        .mockResolvedValue({ rows: [] }); // inserts + COMMIT

      const shares = [
        { userId: 'u1', ephemeralPublicKey: 'eph1', wrappedKey: 'wrap1', nonce: 'n1' },
        { userId: 'u2', ephemeralPublicKey: 'eph2', wrappedKey: 'wrap2', nonce: 'n2' },
      ];
      const result = await store.upsertChannelKeyShares('ch-1', '0123456789abcdef', 'admin-1', shares);

      expect(result.conflict).toEqual([]);
      const statements = mockQuery.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(statements[0]).toBe('BEGIN');
      expect(statements.filter(s => s.includes('ON CONFLICT (channel_id, user_id, key_id)'))).toHaveLength(2);
      expect(statements[statements.length - 1]).toBe('COMMIT');
    });

    it('upsertChannelKeyShares refuses to replace shares created by another member', async () => {
      mockConnect.mockReturnValue({ query: mockQuery, release: mockRelease });
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [{ user_id: 'u2', created_by: 'other-admin' }] }); // existing

      const result = await store.upsertChannelKeyShares('ch-1', '0123456789abcdef', 'admin-1', [
        { userId: 'u2', ephemeralPublicKey: 'eph', wrappedKey: 'wrap', nonce: 'n' },
      ]);

      expect(result.conflict).toEqual(['u2']);
      const statements = mockQuery.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(statements).toContain('ROLLBACK');
      expect(statements.some(s => s.includes('INSERT INTO channel_key_shares'))).toBe(false);
    });

    it('getChannelKeySharesForUser maps rows newest-first', async () => {
      const updatedAt = new Date('2026-01-02');
      mockQuery.mockResolvedValueOnce({
        rows: [{
          key_id: '0123456789abcdef',
          ephemeral_public_key: 'eph',
          wrapped_key: 'wrap',
          nonce: 'n',
          created_by: 'admin-1',
          updated_at: updatedAt,
        }],
      });

      const shares = await store.getChannelKeySharesForUser('ch-1', 'u1');

      expect(shares).toEqual([{
        keyId: '0123456789abcdef',
        ephemeralPublicKey: 'eph',
        wrappedKey: 'wrap',
        nonce: 'n',
        createdBy: 'admin-1',
        updatedAt,
      }]);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('ORDER BY updated_at DESC');
      expect(params).toEqual(['ch-1', 'u1']);
    });
  });

  describe('member roles', () => {
    it('joinChannel sets role admin when isAdmin is true', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await store.joinChannel('ch-1', 'u1', true);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('role');
      expect(params).toEqual(['ch-1', 'u1', true, 'admin']);
    });

    it('joinChannel defaults role to member', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await store.joinChannel('ch-1', 'u1');

      const [, params] = mockQuery.mock.calls[0];
      expect(params).toEqual(['ch-1', 'u1', false, 'member']);
    });

    it('getChannelMember returns the mapped member with role', async () => {
      const joinedAt = new Date('2026-01-01');
      mockQuery.mockResolvedValueOnce({
        rows: [{
          channel_id: 'ch-1',
          user_id: 'u1',
          username: 'alice',
          is_admin: true,
          role: 'owner',
          joined_at: joinedAt,
        }],
      });

      const member = await store.getChannelMember('ch-1', 'u1');

      expect(member).toEqual({
        channelId: 'ch-1',
        userId: 'u1',
        username: 'alice',
        isAdmin: true,
        role: 'owner',
        joinedAt,
      });
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('cm.user_id = $2');
      expect(params).toEqual(['ch-1', 'u1']);
    });

    it('getChannelMember falls back to is_admin when role is missing (legacy row)', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          channel_id: 'ch-1',
          user_id: 'u1',
          username: 'alice',
          is_admin: true,
          role: null,
          joined_at: new Date(),
        }],
      });

      const member = await store.getChannelMember('ch-1', 'u1');

      expect(member?.role).toBe('admin');
    });

    it('getChannelMember returns null when not a member', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const member = await store.getChannelMember('ch-1', 'u9');

      expect(member).toBeNull();
    });

    it('setChannelMemberRole updates role and keeps is_admin in sync', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const result = await store.setChannelMemberRole('ch-1', 'u2', 'admin');

      expect(result).toBe(true);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('UPDATE channel_members');
      expect(params).toEqual(['ch-1', 'u2', 'admin', true]);
    });

    it('setChannelMemberRole clears is_admin for member role', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await store.setChannelMemberRole('ch-1', 'u2', 'member');

      const [, params] = mockQuery.mock.calls[0];
      expect(params).toEqual(['ch-1', 'u2', 'member', false]);
    });

    it('setChannelMemberRole returns false when the member does not exist', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      const result = await store.setChannelMemberRole('ch-1', 'u9', 'admin');

      expect(result).toBe(false);
    });
  });

  describe('channel audit log', () => {
    it('addAuditEvent inserts with metadata as JSON', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await store.addAuditEvent('ch-1', 'u1', 'member_kicked', 'u2', { targetRole: 'member' });

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('INSERT INTO channel_audit_events');
      expect(params).toEqual(['ch-1', 'u1', 'member_kicked', 'u2', '{"targetRole":"member"}']);
    });

    it('addAuditEvent stores nulls for missing target and metadata', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await store.addAuditEvent('ch-1', 'u1', 'encryption_enabled');

      const [, params] = mockQuery.mock.calls[0];
      expect(params).toEqual(['ch-1', 'u1', 'encryption_enabled', null, null]);
    });

    it('getAuditEvents joins actor and target usernames, newest first', async () => {
      const createdAt = new Date('2026-01-03');
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'ev-1',
          channel_id: 'ch-1',
          actor_id: 'u1',
          actor_username: 'alice',
          action: 'role_changed',
          target_id: 'u2',
          target_username: 'bob',
          metadata: { from: 'member', to: 'admin' },
          created_at: createdAt,
        }],
      });

      const events = await store.getAuditEvents('ch-1', 25);

      expect(events).toEqual([{
        id: 'ev-1',
        channelId: 'ch-1',
        actorId: 'u1',
        actorUsername: 'alice',
        action: 'role_changed',
        targetId: 'u2',
        targetUsername: 'bob',
        metadata: { from: 'member', to: 'admin' },
        createdAt,
      }]);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('ORDER BY e.created_at DESC');
      expect(params).toEqual(['ch-1', 25]);
    });

    it('getAuditEvents omits null actor/target fields', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'ev-2',
          channel_id: 'ch-1',
          actor_id: null,
          actor_username: null,
          action: 'channel_created',
          target_id: null,
          target_username: null,
          metadata: null,
          created_at: new Date(),
        }],
      });

      const events = await store.getAuditEvents('ch-1');

      expect(events[0].actorId).toBeUndefined();
      expect(events[0].actorUsername).toBeUndefined();
      expect(events[0].targetId).toBeUndefined();
      expect(events[0].metadata).toBeUndefined();
    });
  });
});
