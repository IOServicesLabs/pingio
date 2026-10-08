import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocketHandler } from './handler.js';

// Mock uuid
vi.mock('uuid', () => ({ v4: vi.fn(() => 'test-id') }));

function makeSocket() {
  const send = vi.fn();
  const close = vi.fn();
  const on = vi.fn();
  return { send, close, on, readyState: 1 }; // readyState 1 = OPEN
}

function makeServices() {
  const sessionService = {
    getSession: vi.fn(),
    createSession: vi.fn(),
    destroySession: vi.fn(),
    getSessionsByUser: vi.fn().mockImplementation(() => []),
    isUserOnline: vi.fn(),
    updateActivity: vi.fn(),
  };

  const authService = {
    verifyToken: vi.fn(),
    getUser: vi.fn(),
  };

  const presenceService = {
    updatePresence: vi.fn(),
    setTyping: vi.fn(),
    setOffline: vi.fn(),
  };

  const rateLimitService = {
    checkMessageRateLimit: vi.fn(() => true),
  };

  const postgres = {
    checkMutualContact: vi.fn(),
    isBlocked: vi.fn(() => ({ blockedBy: false, blockedTarget: false })),
    createMessage: vi.fn(),
    getMessage: vi.fn(),
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
    getChannelMembers: vi.fn(() => []),
    getChannel: vi.fn(),
    getUserByUsername: vi.fn(),
    createBuildTask: vi.fn(),
    getBuildTaskById: vi.fn(),
    assignBuildTask: vi.fn(),
    completeBuildTask: vi.fn(),
    updateBuildTask: vi.fn(),
    updateMemberSessionStatus: vi.fn(),
    updateBuildTaskContextCleared: vi.fn(),
    getDeviceByFingerprint: vi.fn(),
    getDeviceCount: vi.fn(),
    createDevice: vi.fn(),
    updateDeviceLastSeen: vi.fn(),
    upsertContextShare: vi.fn(),
    revokeContextShare: vi.fn(),
    getContextSharesForChannel: vi.fn(),
    getContextSharesForDM: vi.fn(),
    deleteExpiredContextShares: vi.fn(),
  };

  return { sessionService, authService, presenceService, rateLimitService, postgres };
}

describe('WebSocketHandler', () => {
  let services: ReturnType<typeof makeServices>;
  let handler: WebSocketHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    services = makeServices();
    handler = new WebSocketHandler(
      services.sessionService as any,
      services.authService as any,
      services.presenceService as any,
      services.rateLimitService as any,
      services.postgres as any
    );
  });

  function setupConnection(socketId: string) {
    const socket = makeSocket();
    // Capture event handlers
    const handlers: Record<string, Function> = {};
    socket.on.mockImplementation((event: string, cb: Function) => {
      handlers[event] = cb;
    });
    handler.handleConnection(socket as any, socketId);
    return { socket, handlers };
  }

  describe('auth message', () => {
    it('valid token → session created, auth_response success sent', async () => {
      const { socket, handlers } = setupConnection('sock-1');

      services.authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      services.authService.getUser.mockResolvedValue({ id: 'u1', username: 'alice' });
      services.sessionService.createSession.mockResolvedValue({ sessionId: 's1', userId: 'u1', username: 'alice', socketId: 'sock-1' });
      services.presenceService.updatePresence.mockResolvedValue(undefined);

      await handlers['message'](JSON.stringify({ type: 'auth', payload: { token: 'valid-token' } }));

      expect(services.authService.verifyToken).toHaveBeenCalledWith('valid-token');
      expect(services.sessionService.createSession).toHaveBeenCalled();
      expect(socket.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"auth_response"')
      );
      const sent = JSON.parse(socket.send.mock.calls[0][0]);
      expect(sent.payload.success).toBe(true);
    });

    it('invalid token → error sent', async () => {
      const { socket, handlers } = setupConnection('sock-2');

      services.authService.verifyToken.mockReturnValue(null);

      await handlers['message'](JSON.stringify({ type: 'auth', payload: { token: 'bad-token' } }));

      expect(services.sessionService.createSession).not.toHaveBeenCalled();
      const sent = JSON.parse(socket.send.mock.calls[0][0]);
      expect(sent.payload.success).toBe(false);
    });
  });

  describe('message send', () => {
    it('valid message → saved, delivered to recipient socket', async () => {
      const { handlers } = setupConnection('sock-1');
      const recipientSocket = makeSocket();

      services.sessionService.getSession.mockReturnValue({ userId: 'u1', username: 'alice', socketId: 'sock-1' });
      services.rateLimitService.checkMessageRateLimit.mockResolvedValue(true);
      services.postgres.checkMutualContact.mockResolvedValue(true);
      services.postgres.isBlocked.mockResolvedValue({ blockedBy: false, blockedTarget: false });
      services.postgres.createMessage.mockResolvedValue({
        id: 'msg-1', senderId: 'u1', senderUsername: 'alice', recipientId: 'u2', content: 'Hi', createdAt: new Date(),
      });
      services.sessionService.getSessionsByUser.mockReturnValue([{ socketId: 'sock-2', userId: 'u2' }]);

      // Register recipient socket by triggering a connection
      const recipientHandlers: Record<string, Function> = {};
      recipientSocket.on.mockImplementation((event: string, cb: Function) => {
        recipientHandlers[event] = cb;
      });
      handler.handleConnection(recipientSocket as any, 'sock-2');

      await handlers['message'](JSON.stringify({
        type: 'message',
        payload: { recipientId: 'u2', content: 'Hi', isEphemeral: false, clientMessageId: 'client-1' },
      }));

      expect(services.postgres.createMessage).toHaveBeenCalled();
    });

    it('no mutual contact → error sent', async () => {
      const { socket, handlers } = setupConnection('sock-1');

      services.sessionService.getSession.mockReturnValue({ userId: 'u1', username: 'alice', socketId: 'sock-1' });
      services.rateLimitService.checkMessageRateLimit.mockResolvedValue(true);
      services.postgres.checkMutualContact.mockResolvedValue(false);

      await handlers['message'](JSON.stringify({
        type: 'message',
        payload: { recipientId: 'u2', content: 'Hi', isEphemeral: false, clientMessageId: 'c1' },
      }));

      expect(services.postgres.createMessage).not.toHaveBeenCalled();
      const sent = JSON.parse(socket.send.mock.calls[0][0]);
      expect(sent.type).toBe('message_error');
    });
  });

  describe('ping', () => {
    it('responds with pong', async () => {
      const { socket, handlers } = setupConnection('sock-1');
      services.sessionService.updateActivity.mockResolvedValue(undefined);

      await handlers['message'](JSON.stringify({ type: 'ping', payload: {} }));

      const sent = JSON.parse(socket.send.mock.calls[0][0]);
      expect(sent.type).toBe('pong');
    });
  });

  describe('presence_update', () => {
    it('updates presence for authenticated user', async () => {
      const { handlers } = setupConnection('sock-1');
      services.sessionService.getSession.mockReturnValue({ userId: 'u1', username: 'alice' });
      services.presenceService.updatePresence.mockResolvedValue({ status: 'busy', lastSeen: new Date() });

      await handlers['message'](JSON.stringify({
        type: 'presence_update',
        payload: { status: 'busy' },
      }));

      expect(services.presenceService.updatePresence).toHaveBeenCalledWith('u1', 'alice', 'busy', undefined);
    });
  });

  describe('disconnect', () => {
    it('sets presence to offline when user has no remaining sessions', async () => {
      const { handlers } = setupConnection('sock-1');

      services.sessionService.destroySession.mockResolvedValue({ userId: 'u1', username: 'alice', socketId: 'sock-1' });
      services.sessionService.getSessionsByUser.mockReturnValue([]);
      services.presenceService.setOffline.mockResolvedValue(undefined);

      await handlers['close']();

      expect(services.presenceService.setOffline).toHaveBeenCalledWith('u1');
    });
  });

  describe('build_task_create', () => {
    it('creates and broadcasts a build task', async () => {
      const { handlers } = setupConnection('sock-1');
      const memberSocket = makeSocket();
      const memberHandlers: Record<string, Function> = {};
      memberSocket.on.mockImplementation((event: string, cb: Function) => {
        memberHandlers[event] = cb;
      });
      handler.handleConnection(memberSocket as any, 'sock-2');

      services.sessionService.getSession.mockReturnValue({ userId: 'u1', username: 'alice' });
      services.postgres.getChannel.mockResolvedValue({ id: '00000000-0000-0000-0000-000000000001', channelType: 'build', ownerId: 'u1' });
      services.postgres.getChannelMembers.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }] as any);
      services.postgres.createBuildTask.mockResolvedValue({
        id: '00000000-0000-0000-0000-000000000010', channelId: '00000000-0000-0000-0000-000000000001', ownerId: 'u1', title: 'Build', description: '',
        status: 'pending', assignedTo: undefined, artifactFilename: undefined, artifactSize: undefined,
        createdAt: new Date(), assignedAt: undefined, completedAt: undefined, contextClearedAt: undefined,
      });
      services.sessionService.getSessionsByUser.mockImplementation((userId: string) =>
        userId === 'u2' ? [{ socketId: 'sock-2' }] : []
      );

      await handlers['message'](JSON.stringify({
        type: 'build_task_create',
        payload: { channelId: '00000000-0000-0000-0000-000000000001', taskId: '00000000-0000-0000-0000-000000000010', title: 'Build', status: 'pending' },
      }));

      expect(services.postgres.createBuildTask).toHaveBeenCalledWith('00000000-0000-0000-0000-000000000001', 'u1', 'Build', undefined);
      expect(memberSocket.send).toHaveBeenCalledWith(expect.stringContaining('"type":"build_task_create"'));
    });
  });

  describe('session_status_report', () => {
    it('stores status and forwards to owner', async () => {
      const { handlers } = setupConnection('sock-1');
      const ownerSocket = makeSocket();
      const ownerHandlers: Record<string, Function> = {};
      ownerSocket.on.mockImplementation((event: string, cb: Function) => {
        ownerHandlers[event] = cb;
      });
      handler.handleConnection(ownerSocket as any, 'sock-owner');

      services.sessionService.getSession.mockReturnValue({ userId: 'u2', username: 'bob' });
      services.postgres.getChannelMembers.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }] as any);
      services.postgres.getChannel.mockResolvedValue({ id: '00000000-0000-0000-0000-000000000001', ownerId: 'u1' });
      services.sessionService.getSessionsByUser.mockImplementation((userId: string) =>
        userId === 'u1' ? [{ socketId: 'sock-owner' }] : []
      );

      await handlers['message'](JSON.stringify({
        type: 'session_status_report',
        payload: { channelId: '00000000-0000-0000-0000-000000000001', remainingRequests: 42, contextWindowUsed: 1000, selectedModel: 'sonnet' },
      }));

      expect(services.postgres.updateMemberSessionStatus).toHaveBeenCalledWith('u2', '00000000-0000-0000-0000-000000000001', {
        remainingRequests: 42,
        contextWindowUsed: 1000,
        selectedModel: 'sonnet',
      });
      expect(ownerSocket.send).toHaveBeenCalledWith(expect.stringContaining('"type":"session_status_report"'));
    });
  });

  describe('build_artifact_payload authorization', () => {
    const CH = '00000000-0000-0000-0000-000000000001';
    const TASK = '00000000-0000-0000-0000-000000000010';

    it('forwards artifact to owner when sender is the assigned worker', async () => {
      const { handlers } = setupConnection('sock-worker');
      const ownerSocket = makeSocket();
      ownerSocket.on.mockImplementation(() => {});
      handler.handleConnection(ownerSocket as any, 'sock-owner');

      services.sessionService.getSession.mockReturnValue({ userId: 'u2', username: 'bob' });
      services.postgres.getBuildTaskById.mockResolvedValue({
        id: TASK, channelId: CH, ownerId: 'u1', assignedTo: 'u2', status: 'assigned',
      });
      services.sessionService.getSessionsByUser.mockImplementation((userId: string) =>
        userId === 'u1' ? [{ socketId: 'sock-owner' }] : []
      );

      await handlers['message'](JSON.stringify({
        type: 'build_artifact_payload',
        payload: { channelId: CH, taskId: TASK, filename: 'out.txt', data: Buffer.from('hi').toString('base64') },
      }));

      expect(ownerSocket.send).toHaveBeenCalledWith(expect.stringContaining('"type":"build_artifact_payload"'));
    });

    it('rejects artifact from a non-assigned member (spoof) and does not forward', async () => {
      const { socket, handlers } = setupConnection('sock-attacker');
      const ownerSocket = makeSocket();
      ownerSocket.on.mockImplementation(() => {});
      handler.handleConnection(ownerSocket as any, 'sock-owner');

      // Attacker u3 is not the assigned worker (u2)
      services.sessionService.getSession.mockReturnValue({ userId: 'u3', username: 'mallory' });
      services.postgres.getBuildTaskById.mockResolvedValue({
        id: TASK, channelId: CH, ownerId: 'u1', assignedTo: 'u2', status: 'assigned',
      });
      services.sessionService.getSessionsByUser.mockImplementation((userId: string) =>
        userId === 'u1' ? [{ socketId: 'sock-owner' }] : []
      );

      await handlers['message'](JSON.stringify({
        type: 'build_artifact_payload',
        payload: { channelId: CH, taskId: TASK, filename: 'out.txt', data: Buffer.from('evil').toString('base64') },
      }));

      expect(ownerSocket.send).not.toHaveBeenCalledWith(expect.stringContaining('"type":"build_artifact_payload"'));
      const sent = JSON.parse(socket.send.mock.calls[0][0]);
      expect(sent.type).toBe('message_error');
    });

    it('rejects a traversal filename at the schema boundary (never reaches task lookup or forward)', async () => {
      const { handlers } = setupConnection('sock-worker');
      const ownerSocket = makeSocket();
      ownerSocket.on.mockImplementation(() => {});
      handler.handleConnection(ownerSocket as any, 'sock-owner');

      services.sessionService.getSession.mockReturnValue({ userId: 'u2', username: 'bob' });
      services.postgres.getBuildTaskById.mockResolvedValue({
        id: TASK, channelId: CH, ownerId: 'u1', assignedTo: 'u2', status: 'assigned',
      });
      services.sessionService.getSessionsByUser.mockImplementation((userId: string) =>
        userId === 'u1' ? [{ socketId: 'sock-owner' }] : []
      );

      await handlers['message'](JSON.stringify({
        type: 'build_artifact_payload',
        payload: { channelId: CH, taskId: TASK, filename: '../../evil.txt', data: Buffer.from('x').toString('base64') },
      }));

      // The malformed filename is rejected by the schema before the task is ever
      // looked up, so nothing is forwarded to the owner (fail-closed).
      expect(services.postgres.getBuildTaskById).not.toHaveBeenCalled();
      expect(ownerSocket.send).not.toHaveBeenCalled();
    });

    it('rejects artifact request from a non-owner', async () => {
      const { socket, handlers } = setupConnection('sock-member');
      services.sessionService.getSession.mockReturnValue({ userId: 'u2', username: 'bob' });
      services.postgres.getBuildTaskById.mockResolvedValue({
        id: TASK, channelId: CH, ownerId: 'u1', assignedTo: 'u2', status: 'assigned',
      });

      await handlers['message'](JSON.stringify({
        type: 'build_artifact_request',
        payload: { channelId: CH, taskId: TASK },
      }));

      const sent = JSON.parse(socket.send.mock.calls[0][0]);
      expect(sent.type).toBe('message_error');
      expect(sent.payload.message).toContain('owner');
    });
  });

  describe('context_clear_request', () => {
    it('owner requests clear for target worker', async () => {
      const { handlers } = setupConnection('sock-1');
      const workerSocket = makeSocket();
      const workerHandlers: Record<string, Function> = {};
      workerSocket.on.mockImplementation((event: string, cb: Function) => {
        workerHandlers[event] = cb;
      });
      handler.handleConnection(workerSocket as any, 'sock-worker');

      services.sessionService.getSession.mockReturnValue({ userId: 'u1', username: 'alice' });
      services.postgres.getChannel.mockResolvedValue({ id: '00000000-0000-0000-0000-000000000001', ownerId: 'u1' });
      services.postgres.getUserByUsername.mockResolvedValue({ id: 'u2', username: 'bob' });
      services.sessionService.getSessionsByUser.mockImplementation((userId: string) =>
        userId === 'u2' ? [{ socketId: 'sock-worker' }] : []
      );

      await handlers['message'](JSON.stringify({
        type: 'context_clear_request',
        payload: { channelId: '00000000-0000-0000-0000-000000000001', taskId: '00000000-0000-0000-0000-000000000010', targetUsername: 'bob' },
      }));

      expect(workerSocket.send).toHaveBeenCalledWith(expect.stringContaining('"type":"context_clear_request"'));
    });
  });

  describe('context sharing', () => {
    const CH = '00000000-0000-0000-0000-000000000001';
    const U2 = '00000000-0000-0000-0000-000000000002';

    const sampleShare = {
      id: '00000000-0000-0000-0000-000000000099',
      userId: 'u1',
      username: 'alice',
      channelId: CH,
      summary: 'Fixing token refresh',
      status: 'working',
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
    };

    it('rejects unauthenticated context_share', async () => {
      const { socket, handlers } = setupConnection('sock-1');
      services.sessionService.getSession.mockReturnValue(undefined);

      await handlers['message'](JSON.stringify({
        type: 'context_share',
        payload: { channelId: CH, summary: 'Working on auth' },
      }));

      const sent = JSON.parse(socket.send.mock.calls[0][0]);
      expect(sent.type).toBe('message_error');
      expect(sent.payload.code).toBe('unauthorized');
      expect(services.postgres.upsertContextShare).not.toHaveBeenCalled();
    });

    it('rejects a payload with both scopes or neither', async () => {
      const { socket, handlers } = setupConnection('sock-1');
      services.sessionService.getSession.mockReturnValue({ userId: 'u1', username: 'alice' });

      await handlers['message'](JSON.stringify({
        type: 'context_share',
        payload: { channelId: CH, recipientId: U2, summary: 'both scopes' },
      }));
      await handlers['message'](JSON.stringify({
        type: 'context_share',
        payload: { summary: 'no scope' },
      }));

      const first = JSON.parse(socket.send.mock.calls[0][0]);
      const second = JSON.parse(socket.send.mock.calls[1][0]);
      expect(first.payload.code).toBe('validation_error');
      expect(second.payload.code).toBe('validation_error');
      expect(services.postgres.upsertContextShare).not.toHaveBeenCalled();
    });

    it('rejects channel share from a non-member', async () => {
      const { socket, handlers } = setupConnection('sock-1');
      services.sessionService.getSession.mockReturnValue({ userId: 'u1', username: 'alice' });
      services.postgres.getChannelMembers.mockResolvedValue([{ userId: 'u2' }] as any);

      await handlers['message'](JSON.stringify({
        type: 'context_share',
        payload: { channelId: CH, summary: 'Working on auth' },
      }));

      const sent = JSON.parse(socket.send.mock.calls[0][0]);
      expect(sent.payload.code).toBe('forbidden');
      expect(services.postgres.upsertContextShare).not.toHaveBeenCalled();
    });

    it('stores a channel share and broadcasts it to all members', async () => {
      const { handlers } = setupConnection('sock-1');
      const memberSocket = makeSocket();
      memberSocket.on.mockImplementation(() => {});
      handler.handleConnection(memberSocket as any, 'sock-2');

      services.sessionService.getSession.mockReturnValue({ userId: 'u1', username: 'alice' });
      services.postgres.getChannelMembers.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }] as any);
      services.postgres.upsertContextShare.mockResolvedValue(sampleShare);
      services.sessionService.getSessionsByUser.mockImplementation((userId: string) =>
        userId === 'u2' ? [{ socketId: 'sock-2' }] : []
      );

      await handlers['message'](JSON.stringify({
        type: 'context_share',
        payload: { channelId: CH, summary: 'Fixing token refresh', files: ['src/auth.ts'], ttlMinutes: 60 },
      }));

      expect(services.postgres.upsertContextShare).toHaveBeenCalledWith(
        'u1',
        { channelId: CH, recipientId: undefined },
        expect.objectContaining({ summary: 'Fixing token refresh', files: ['src/auth.ts'], ttlMinutes: 60 })
      );
      expect(memberSocket.send).toHaveBeenCalledWith(expect.stringContaining('"type":"context_share"'));
    });

    it('passes git info through to the store', async () => {
      const { handlers } = setupConnection('sock-1');
      services.sessionService.getSession.mockReturnValue({ userId: 'u1', username: 'alice' });
      services.postgres.getChannelMembers.mockResolvedValue([{ userId: 'u1' }] as any);
      services.postgres.upsertContextShare.mockResolvedValue(sampleShare);

      const git = { branch: 'main', dirty: true, changedFiles: ['src/auth.ts'], diffStat: '1 file changed' };
      await handlers['message'](JSON.stringify({
        type: 'context_share',
        payload: { channelId: CH, summary: 'Fixing token refresh', git },
      }));

      expect(services.postgres.upsertContextShare).toHaveBeenCalledWith(
        'u1',
        { channelId: CH, recipientId: undefined },
        expect.objectContaining({ git })
      );
    });

    it('rejects a DM share to a non-mutual contact', async () => {
      const { socket, handlers } = setupConnection('sock-1');
      services.sessionService.getSession.mockReturnValue({ userId: 'u1', username: 'alice' });
      services.postgres.checkMutualContact.mockResolvedValue(false);

      await handlers['message'](JSON.stringify({
        type: 'context_share',
        payload: { recipientId: U2, summary: 'Pairing on the API' },
      }));

      const sent = JSON.parse(socket.send.mock.calls[0][0]);
      expect(sent.payload.code).toBe('not_mutual_contact');
      expect(services.postgres.upsertContextShare).not.toHaveBeenCalled();
    });

    it('rejects a DM share when blocked', async () => {
      const { socket, handlers } = setupConnection('sock-1');
      services.sessionService.getSession.mockReturnValue({ userId: 'u1', username: 'alice' });
      services.postgres.checkMutualContact.mockResolvedValue(true);
      services.postgres.isBlocked.mockResolvedValue({ blockedBy: true, blockedTarget: false });

      await handlers['message'](JSON.stringify({
        type: 'context_share',
        payload: { recipientId: U2, summary: 'Pairing on the API' },
      }));

      const sent = JSON.parse(socket.send.mock.calls[0][0]);
      expect(sent.payload.code).toBe('blocked');
      expect(services.postgres.upsertContextShare).not.toHaveBeenCalled();
    });

    it('stores a DM share and delivers it to the peer', async () => {
      const { handlers } = setupConnection('sock-1');
      const peerSocket = makeSocket();
      peerSocket.on.mockImplementation(() => {});
      handler.handleConnection(peerSocket as any, 'sock-2');

      services.sessionService.getSession.mockReturnValue({ userId: 'u1', username: 'alice' });
      services.postgres.checkMutualContact.mockResolvedValue(true);
      services.postgres.isBlocked.mockResolvedValue({ blockedBy: false, blockedTarget: false });
      services.postgres.upsertContextShare.mockResolvedValue({ ...sampleShare, channelId: undefined, recipientId: U2 });
      services.sessionService.getSessionsByUser.mockImplementation((userId: string) =>
        userId === U2 ? [{ socketId: 'sock-2' }] : []
      );

      await handlers['message'](JSON.stringify({
        type: 'context_share',
        payload: { recipientId: U2, summary: 'Pairing on the API' },
      }));

      expect(services.postgres.upsertContextShare).toHaveBeenCalledWith(
        'u1',
        { channelId: undefined, recipientId: U2 },
        expect.objectContaining({ summary: 'Pairing on the API' })
      );
      expect(peerSocket.send).toHaveBeenCalledWith(expect.stringContaining('"type":"context_share"'));
    });

    it('revoke deletes the share and notifies members', async () => {
      const { handlers } = setupConnection('sock-1');
      const memberSocket = makeSocket();
      memberSocket.on.mockImplementation(() => {});
      handler.handleConnection(memberSocket as any, 'sock-2');

      services.sessionService.getSession.mockReturnValue({ userId: 'u1', username: 'alice' });
      services.postgres.getChannelMembers.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }] as any);
      services.postgres.revokeContextShare.mockResolvedValue(true);
      services.sessionService.getSessionsByUser.mockImplementation((userId: string) =>
        userId === 'u2' ? [{ socketId: 'sock-2' }] : []
      );

      await handlers['message'](JSON.stringify({
        type: 'context_share_revoke',
        payload: { channelId: CH },
      }));

      expect(services.postgres.revokeContextShare).toHaveBeenCalledWith('u1', { channelId: CH, recipientId: undefined });
      expect(memberSocket.send).toHaveBeenCalledWith(expect.stringContaining('"type":"context_share_revoke"'));
    });

    it('revoke with no active share is a silent no-op', async () => {
      const { handlers } = setupConnection('sock-1');
      const memberSocket = makeSocket();
      memberSocket.on.mockImplementation(() => {});
      handler.handleConnection(memberSocket as any, 'sock-2');

      services.sessionService.getSession.mockReturnValue({ userId: 'u1', username: 'alice' });
      services.postgres.getChannelMembers.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }] as any);
      services.postgres.revokeContextShare.mockResolvedValue(false);

      await handlers['message'](JSON.stringify({
        type: 'context_share_revoke',
        payload: { channelId: CH },
      }));

      expect(memberSocket.send).not.toHaveBeenCalled();
    });

    it('context_share_request to a channel broadcasts to other members', async () => {
      const { socket, handlers } = setupConnection('sock-1');
      const memberSocket = makeSocket();
      memberSocket.on.mockImplementation(() => {});
      handler.handleConnection(memberSocket as any, 'sock-2');

      services.sessionService.getSession.mockReturnValue({ userId: 'u1', username: 'alice' });
      services.postgres.getChannelMembers.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }] as any);
      services.sessionService.getSessionsByUser.mockImplementation((userId: string) =>
        userId === 'u2' ? [{ socketId: 'sock-2' }] : []
      );

      await handlers['message'](JSON.stringify({
        type: 'context_share_request',
        payload: { channelId: CH },
      }));

      expect(memberSocket.send).toHaveBeenCalledWith(expect.stringContaining('"type":"context_share_request"'));
      // Requester is excluded from the broadcast
      expect(socket.send).not.toHaveBeenCalled();
    });

    it('context_share_request with targetUsername goes only to that member', async () => {
      const { handlers } = setupConnection('sock-1');
      const memberSocket = makeSocket();
      memberSocket.on.mockImplementation(() => {});
      handler.handleConnection(memberSocket as any, 'sock-2');

      services.sessionService.getSession.mockReturnValue({ userId: 'u1', username: 'alice' });
      services.postgres.getChannelMembers.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }] as any);
      services.postgres.getUserByUsername.mockResolvedValue({ id: 'u2', username: 'bob' });
      services.sessionService.getSessionsByUser.mockImplementation((userId: string) =>
        userId === 'u2' ? [{ socketId: 'sock-2' }] : []
      );

      await handlers['message'](JSON.stringify({
        type: 'context_share_request',
        payload: { channelId: CH, targetUsername: 'bob' },
      }));

      expect(memberSocket.send).toHaveBeenCalledWith(expect.stringContaining('"type":"context_share_request"'));
      const sent = JSON.parse(memberSocket.send.mock.calls[0][0]);
      expect(sent.payload.requesterUsername).toBe('alice');
    });

    it('context_share_request from a non-member is rejected', async () => {
      const { socket, handlers } = setupConnection('sock-1');
      services.sessionService.getSession.mockReturnValue({ userId: 'u1', username: 'alice' });
      services.postgres.getChannelMembers.mockResolvedValue([{ userId: 'u2' }] as any);

      await handlers['message'](JSON.stringify({
        type: 'context_share_request',
        payload: { channelId: CH },
      }));

      const sent = JSON.parse(socket.send.mock.calls[0][0]);
      expect(sent.payload.code).toBe('forbidden');
    });
  });
});
