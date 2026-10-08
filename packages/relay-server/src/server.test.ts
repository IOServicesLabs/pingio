import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';

// Build a minimal version of the server for inject-based testing
async function buildServer() {
  const postgres = {
    getUserByUsername: vi.fn(),
    getUserById: vi.fn(),
    createUser: vi.fn(),
    searchUsers: vi.fn(),
    getContacts: vi.fn(),
    addContact: vi.fn(),
    blockContact: vi.fn(),
    checkMutualContact: vi.fn(),
    createChannel: vi.fn(),
    getChannelByName: vi.fn(),
    getChannelMembers: vi.fn(),
    joinChannel: vi.fn(),
    leaveChannel: vi.fn(),
    getDMHistory: vi.fn(),
    getChannelHistory: vi.fn(),
    getPublicChannels: vi.fn(),
    getUserChannels: vi.fn(),
    getChannel: vi.fn(),
    getDeviceByFingerprint: vi.fn(),
    getDeviceById: vi.fn(),
    getDeviceCount: vi.fn(),
    getUserDevices: vi.fn(),
    createDevice: vi.fn(),
    updateDeviceLastSeen: vi.fn(),
    verifyDevice: vi.fn(),
    revokeDevice: vi.fn(),
    revokeAllRefreshTokensForDevice: vi.fn(),
    createRefreshToken: vi.fn(),
    getRefreshTokenByHash: vi.fn(),
    revokeRefreshToken: vi.fn(),
    getUserWithPassword: vi.fn(),
    updateLastSeen: vi.fn(),
    createBuildTask: vi.fn(),
    getBuildTasks: vi.fn(),
    getBuildTaskById: vi.fn(),
    assignBuildTask: vi.fn(),
    completeBuildTask: vi.fn(),
    updateMemberSessionStatus: vi.fn(),
    getMemberSessionStatuses: vi.fn(),
    upsertEncryptionKey: vi.fn(),
    getEncryptionKey: vi.fn(),
    getChannelEncryptionKeys: vi.fn(),
    setChannelEncryptionEnabled: vi.fn(),
    upsertChannelKeyShares: vi.fn(),
    getChannelKeySharesForUser: vi.fn(),
    getChannelMember: vi.fn(),
    setChannelMemberRole: vi.fn(),
    setChannelRetention: vi.fn(),
    addAuditEvent: vi.fn(),
    getAuditEvents: vi.fn(),
  };

  const authService = {
    register: vi.fn(),
    login: vi.fn(),
    refreshToken: vi.fn(),
    verifyToken: vi.fn(),
    verifyDevice: vi.fn(),
    listDevices: vi.fn(),
    revokeDevice: vi.fn(),
    getUser: vi.fn(),
  };

  const sessionService = {
    getOnlineUserCount: vi.fn(() => 0),
    createSession: vi.fn(),
    destroySession: vi.fn(),
    getSession: vi.fn(),
    getSessionsByUser: vi.fn(() => []),
    isUserOnline: vi.fn(),
    updateActivity: vi.fn(),
  };

  const presenceService = {
    getPresence: vi.fn(),
    getBulkPresence: vi.fn().mockImplementation(() => new Map()),
    updatePresence: vi.fn(),
    setOffline: vi.fn(),
  };

  const fastify = Fastify({ logger: false });
  await fastify.register(cors, { origin: true });
  await fastify.register(websocket);

  // Health
  fastify.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    connections: sessionService.getOnlineUserCount(),
  }));

  // Auth register
  fastify.post('/api/auth/register', async (request, reply) => {
    const body = request.body as any;
    const result = await authService.register(body.username, body.password, body.displayName, body.deviceFingerprint, body.deviceName);
    if (!result.success) {
      reply.status(409);
      return { success: false, error: result.error };
    }
    reply.status(201);
    return { success: true, userId: result.user?.id, token: result.token, refreshToken: result.refreshToken, deviceId: result.deviceId };
  });

  // Auth login
  fastify.post('/api/auth/login', async (request, reply) => {
    const body = request.body as any;
    const result = await authService.login(body.username, body.password, body.deviceFingerprint, body.deviceName, request.ip);
    if (!result.success) {
      if (result.verificationRequired) { reply.status(403); return result; }
      reply.status(401);
      return result;
    }
    return result;
  });

  // Auth refresh
  fastify.post('/api/auth/refresh', async (request, reply) => {
    const { refreshToken, deviceFingerprint } = request.body as any;
    if (!refreshToken || !deviceFingerprint) { reply.status(400); return { success: false, error: 'Missing params' }; }
    const result = await authService.refreshToken(refreshToken, deviceFingerprint);
    if (!result.success) { reply.status(401); return result; }
    return result;
  });

  // User search
  fastify.get('/api/users/search', async (request) => {
    const { q, limit } = request.query as any;
    const users = await postgres.searchUsers(q, parseInt(limit || '10'));
    return { users };
  });

  // Published encryption identity key (protected)
  fastify.get('/api/users/:userId/encryption-key', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = await authService.verifyToken(authHeader.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { userId } = request.params as any;
    const key = await postgres.getEncryptionKey(userId);
    if (!key) { reply.status(404); return { error: 'User not found or has no encryption key published' }; }
    return { userId: key.userId, username: key.username, publicKey: key.publicKey, updatedAt: key.updatedAt };
  });

  // Presence (mutual contacts only)
  fastify.get('/api/users/:userId/presence', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = await authService.verifyToken(authHeader.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { userId } = request.params as any;
    if (userId !== decoded.userId) {
      const mutual = await postgres.checkMutualContact(decoded.userId, userId);
      if (!mutual) { reply.status(403); return { error: 'Only mutual contacts can see presence' }; }
    }
    const presence = await presenceService.getPresence(userId);
    return { presence: presence ?? { status: 'offline' } };
  });

  // Contacts
  fastify.get('/api/contacts', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const contacts = await postgres.getContacts(decoded.userId);
    const presences = await presenceService.getBulkPresence(contacts.map((c: any) => c.contactId));
    return { contacts: contacts.map((c: any) => ({ ...c, presence: presences.get(c.contactId) })) };
  });

  fastify.post('/api/contacts', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { username } = request.body as any;
    const contactUser = await postgres.getUserByUsername(username);
    if (!contactUser) { reply.status(404); return { error: 'User not found' }; }
    const contact = await postgres.addContact(decoded.userId, contactUser.id);
    if (!contact) { reply.status(409); return { error: 'Already a contact' }; }
    reply.status(201);
    return { contact };
  });

  // Block/unblock
  fastify.post('/api/contacts/:contactId/block', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { contactId } = request.params as any;
    await postgres.blockContact(decoded.userId, contactId, true);
    return { success: true };
  });

  // Channels
  fastify.post('/api/channels', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { name, displayName, isPublic } = request.body as any;
    const existing = await postgres.getChannelByName(name);
    if (existing) { reply.status(409); return { error: 'Channel name already taken' }; }
    const channel = await postgres.createChannel(name, displayName, decoded.userId, isPublic);
    await postgres.joinChannel(channel.id, decoded.userId, true);
    await postgres.setChannelMemberRole(channel.id, decoded.userId, 'owner');
    await postgres.addAuditEvent(channel.id, decoded.userId, 'channel_created', null, { name: channel.name });
    reply.status(201);
    return { channel };
  });

  fastify.post('/api/channels/:channelId/join', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { channelId } = request.params as any;
    const joined = await postgres.joinChannel(channelId, decoded.userId);
    if (!joined) { reply.status(409); return { error: 'Already a member' }; }
    await postgres.addAuditEvent(channelId, decoded.userId, 'member_joined', decoded.userId, { via: 'join' });
    return { success: true };
  });

  fastify.post('/api/channels/:channelId/leave', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { channelId } = request.params as any;
    const self = await postgres.getChannelMember(channelId, decoded.userId);
    if (self?.role === 'owner') {
      const members = await postgres.getChannelMembers(channelId);
      if (members.length > 1) { reply.status(403); return { error: 'The channel owner must transfer ownership before leaving' }; }
    }
    const left = await postgres.leaveChannel(channelId, decoded.userId);
    if (!left) { reply.status(404); return { error: 'Not a member' }; }
    await postgres.addAuditEvent(channelId, decoded.userId, 'member_left', decoded.userId);
    return { success: true };
  });

  fastify.post('/api/channels/:channelId/invite', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { channelId } = request.params as any;
    const { username } = request.body as any;
    const members = await postgres.getChannelMembers(channelId);
    const isMember = members.some((m: any) => m.userId === decoded.userId);
    if (!isMember) { reply.status(403); return { error: 'Not a member' }; }
    const target = await postgres.getUserByUsername(username);
    if (!target) { reply.status(404); return { error: 'User not found' }; }
    const joined = await postgres.joinChannel(channelId, target.id);
    if (!joined) { reply.status(409); return { error: 'Already a member' }; }
    await postgres.addAuditEvent(channelId, decoded.userId, 'member_joined', target.id, { via: 'direct_invite' });
    return { success: true };
  });

  // Member role changes (mirrors server.ts authorization rules)
  fastify.post('/api/channels/:channelId/members/:userId/role', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { channelId, userId } = request.params as any;
    const { role } = request.body as any;
    if (!['owner', 'admin', 'member'].includes(role)) { reply.status(400); return { error: 'Invalid role' }; }
    const actor = await postgres.getChannelMember(channelId, decoded.userId);
    if (!actor?.isAdmin) { reply.status(403); return { error: 'Only channel admins can change member roles' }; }
    const target = await postgres.getChannelMember(channelId, userId);
    if (!target) { reply.status(404); return { error: 'User is not a member of this channel' }; }
    if (userId === decoded.userId) { reply.status(400); return { error: 'Cannot change your own role' }; }
    if (target.role === 'owner') { reply.status(403); return { error: "Cannot change the channel owner's role" }; }
    if ((role === 'admin' || target.role === 'admin') && actor.role !== 'owner') {
      reply.status(403); return { error: 'Only the channel owner can grant or revoke admin' };
    }
    if (role === 'owner') {
      if (actor.role !== 'owner') { reply.status(403); return { error: 'Only the channel owner can transfer ownership' }; }
      await postgres.setChannelMemberRole(channelId, userId, 'owner');
      await postgres.setChannelMemberRole(channelId, decoded.userId, 'admin');
      await postgres.addAuditEvent(channelId, decoded.userId, 'role_changed', userId, { from: target.role, to: 'owner', ownershipTransfer: true });
      return { success: true, ownershipTransferred: true };
    }
    if (target.role === role) { reply.status(409); return { error: `User already has role '${role}'` }; }
    await postgres.setChannelMemberRole(channelId, userId, role);
    await postgres.addAuditEvent(channelId, decoded.userId, 'role_changed', userId, { from: target.role, to: role });
    return { success: true };
  });

  // Kick a member (mirrors server.ts authorization rules)
  fastify.post('/api/channels/:channelId/members/:userId/kick', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { channelId, userId } = request.params as any;
    if (userId === decoded.userId) { reply.status(400); return { error: 'Cannot kick yourself — use leave instead' }; }
    const actor = await postgres.getChannelMember(channelId, decoded.userId);
    if (!actor?.isAdmin) { reply.status(403); return { error: 'Only channel admins can kick members' }; }
    const target = await postgres.getChannelMember(channelId, userId);
    if (!target) { reply.status(404); return { error: 'User is not a member of this channel' }; }
    if (target.role === 'owner') { reply.status(403); return { error: 'Cannot kick the channel owner' }; }
    if (target.role === 'admin' && actor.role !== 'owner') {
      reply.status(403); return { error: 'Only the channel owner can kick an admin' };
    }
    await postgres.leaveChannel(channelId, userId);
    await postgres.addAuditEvent(channelId, decoded.userId, 'member_kicked', userId, { targetRole: target.role });
    return { success: true };
  });

  // Audit log (owner/admin only)
  fastify.get('/api/channels/:channelId/audit', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { channelId } = request.params as any;
    const { limit: limitParam } = request.query as any;
    const limit = Math.min(Math.max(parseInt(limitParam || '100', 10) || 100, 1), 500);
    const actor = await postgres.getChannelMember(channelId, decoded.userId);
    if (!actor?.isAdmin) { reply.status(403); return { error: 'Only channel admins can read the audit log' }; }
    const events = await postgres.getAuditEvents(channelId, limit);
    return { events };
  });

  // Message retention (owner/admin only)
  fastify.post('/api/channels/:channelId/retention', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { channelId } = request.params as any;
    const retentionMinutes = (request.body as any)?.retentionMinutes ?? null;
    if (
      retentionMinutes !== null &&
      (!Number.isInteger(retentionMinutes) || retentionMinutes < 60 || retentionMinutes > 366 * 24 * 60)
    ) {
      reply.status(400);
      return { error: 'retentionMinutes must be null or an integer between 60 and 527040' };
    }
    const actor = await postgres.getChannelMember(channelId, decoded.userId);
    if (!actor?.isAdmin) { reply.status(403); return { error: 'Only channel admins can change retention' }; }
    const updated = await postgres.setChannelRetention(channelId, retentionMinutes);
    if (!updated) { reply.status(404); return { error: 'Channel not found' }; }
    await postgres.addAuditEvent(channelId, decoded.userId, 'retention_changed', null, { retentionMinutes });
    return { ok: true, retentionMinutes };
  });

  // Build group task routes
  fastify.get('/api/channels/:channelId/build/tasks', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { channelId } = request.params as any;
    const { status, assignedTo } = request.query as any;
    const members = await postgres.getChannelMembers(channelId);
    if (!members.some((m: any) => m.userId === decoded.userId)) { reply.status(403); return { error: 'Not a member' }; }
    const tasks = await postgres.getBuildTasks(channelId, status, assignedTo);
    return { tasks };
  });

  fastify.post('/api/channels/:channelId/build/tasks', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { channelId } = request.params as any;
    const { title, description } = request.body as any;
    const channel = await postgres.getChannel(channelId);
    if (!channel) { reply.status(404); return { error: 'Channel not found' }; }
    if (channel.channelType !== 'build') { reply.status(400); return { error: 'Not a build group' }; }
    const members = await postgres.getChannelMembers(channelId);
    if (!members.some((m: any) => m.userId === decoded.userId)) { reply.status(403); return { error: 'Not a member' }; }
    const task = await postgres.createBuildTask(channelId, decoded.userId, title, description);
    reply.status(201);
    return { task };
  });

  fastify.post('/api/channels/:channelId/build/tasks/:taskId/assign', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { channelId, taskId } = request.params as any;
    const { username } = request.body as any;
    const channel = await postgres.getChannel(channelId);
    if (!channel) { reply.status(404); return { error: 'Channel not found' }; }
    if (channel.ownerId !== decoded.userId) { reply.status(403); return { error: 'Only owner can assign' }; }
    const task = await postgres.getBuildTaskById(taskId);
    if (!task || task.channelId !== channelId) { reply.status(404); return { error: 'Task not found' }; }
    const target = await postgres.getUserByUsername(username);
    if (!target) { reply.status(404); return { error: 'User not found' }; }
    const members = await postgres.getChannelMembers(channelId);
    if (!members.some((m: any) => m.userId === target.id)) { reply.status(403); return { error: 'Not a member' }; }
    const assigned = await postgres.assignBuildTask(taskId, target.id);
    return { task: assigned };
  });

  fastify.post('/api/channels/:channelId/build/tasks/:taskId/complete', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { channelId, taskId } = request.params as any;
    const { artifactFilename, artifactSize } = request.body as any;
    const task = await postgres.getBuildTaskById(taskId);
    if (!task || task.channelId !== channelId) { reply.status(404); return { error: 'Task not found' }; }
    const members = await postgres.getChannelMembers(channelId);
    if (!members.some((m: any) => m.userId === decoded.userId)) { reply.status(403); return { error: 'Not a member' }; }
    if (task.assignedTo !== decoded.userId && task.ownerId !== decoded.userId) { reply.status(403); return { error: 'Forbidden' }; }
    const completed = await postgres.completeBuildTask(taskId, artifactFilename, artifactSize);
    return { task: completed };
  });

  // Member session status routes
  fastify.get('/api/channels/:channelId/members/status', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { channelId } = request.params as any;
    const members = await postgres.getChannelMembers(channelId);
    if (!members.some((m: any) => m.userId === decoded.userId)) { reply.status(403); return { error: 'Not a member' }; }
    const statuses = await postgres.getMemberSessionStatuses(channelId);
    return { statuses };
  });

  fastify.post('/api/channels/:channelId/members/status', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { channelId } = request.params as any;
    const { remainingRequests, contextWindowUsed, selectedModel } = request.body as any;
    const members = await postgres.getChannelMembers(channelId);
    if (!members.some((m: any) => m.userId === decoded.userId)) { reply.status(403); return { error: 'Not a member' }; }
    const status = await postgres.updateMemberSessionStatus(decoded.userId, channelId, { remainingRequests, contextWindowUsed, selectedModel });
    return { status };
  });

  // Encryption routes — faithful replicas of the real ones in server.ts,
  // exercising auth, membership, admin and share-conflict checks.
  fastify.put('/api/encryption/keys', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { publicKey } = request.body as any;
    const raw = publicKey ? Buffer.from(publicKey, 'base64') : null;
    if (!publicKey || !raw || raw.length !== 32 || raw.toString('base64') !== publicKey) {
      reply.status(400);
      return { error: 'publicKey must be a base64-encoded 32-byte X25519 public key' };
    }
    await postgres.upsertEncryptionKey(decoded.userId, publicKey);
    return { success: true };
  });

  fastify.get('/api/channels/:channelId/encryption/keys', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { channelId } = request.params as any;
    const channel = await postgres.getChannel(channelId);
    if (!channel) { reply.status(404); return { error: 'Channel not found' }; }
    const members = await postgres.getChannelMembers(channelId);
    if (!members.some((m: any) => m.userId === decoded.userId)) { reply.status(403); return { error: 'Not a member of this channel' }; }
    const keys = await postgres.getChannelEncryptionKeys(channelId);
    return { encryptionEnabled: channel.encryptionEnabled, keys };
  });

  fastify.post('/api/channels/:channelId/encryption', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { channelId } = request.params as any;
    const channel = await postgres.getChannel(channelId);
    if (!channel) { reply.status(404); return { error: 'Channel not found' }; }
    const members = await postgres.getChannelMembers(channelId);
    const me = members.find((m: any) => m.userId === decoded.userId);
    if (!me?.isAdmin) { reply.status(403); return { error: 'Only channel admins can enable encryption' }; }
    if (channel.encryptionEnabled) { reply.status(409); return { error: 'Encryption is already enabled for this channel' }; }
    await postgres.setChannelEncryptionEnabled(channelId);
    return { success: true, encryptionEnabled: true };
  });

  fastify.post('/api/channels/:channelId/encryption/shares', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { channelId } = request.params as any;
    const channel = await postgres.getChannel(channelId);
    if (!channel) { reply.status(404); return { error: 'Channel not found' }; }
    const members = await postgres.getChannelMembers(channelId);
    if (!members.some((m: any) => m.userId === decoded.userId)) { reply.status(403); return { error: 'Not a member of this channel' }; }
    if (!channel.encryptionEnabled) { reply.status(409); return { error: 'Encryption is not enabled for this channel' }; }
    const { keyId, shares } = request.body as any;
    if (!/^[0-9a-f]{16}$/.test(keyId ?? '') || !Array.isArray(shares) || shares.length === 0 || shares.length > 64) {
      reply.status(400);
      return { error: 'Invalid shares payload' };
    }
    for (const share of shares) {
      const eph = Buffer.from(share.ephemeralPublicKey ?? '', 'base64');
      const wrapped = Buffer.from(share.wrappedKey ?? '', 'base64');
      const nonce = Buffer.from(share.nonce ?? '', 'base64');
      if (eph.length !== 32 || nonce.length !== 12 || wrapped.length < 48 || wrapped.length > 80) {
        reply.status(400);
        return { error: 'Share fields must be base64: 32-byte ephemeral key, 12-byte nonce, 48-80 byte wrapped key' };
      }
    }
    const memberIds = new Set(members.map((m: any) => m.userId));
    const outsider = shares.find((s: any) => !memberIds.has(s.userId));
    if (outsider) { reply.status(400); return { error: `Share target ${outsider.userId} is not a member of this channel` }; }
    const { conflict } = await postgres.upsertChannelKeyShares(channelId, keyId, decoded.userId, shares);
    if (conflict.length > 0) {
      reply.status(409);
      return { error: 'Some shares for this key were created by another member', conflictUserIds: conflict };
    }
    return { success: true, keyId, count: shares.length };
  });

  fastify.get('/api/channels/:channelId/encryption/shares/mine', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { channelId } = request.params as any;
    const channel = await postgres.getChannel(channelId);
    if (!channel) { reply.status(404); return { error: 'Channel not found' }; }
    const members = await postgres.getChannelMembers(channelId);
    if (!members.some((m: any) => m.userId === decoded.userId)) { reply.status(403); return { error: 'Not a member of this channel' }; }
    const shares = await postgres.getChannelKeySharesForUser(channelId, decoded.userId);
    return { encryptionEnabled: channel.encryptionEnabled, shares };
  });

  return { fastify, authService, postgres, sessionService, presenceService };
}

describe('REST endpoints (Fastify inject)', () => {
  let fastify: any;
  let authService: any;
  let postgres: any;
  let presenceService: any;

  beforeAll(async () => {
    const built = await buildServer();
    fastify = built.fastify;
    authService = built.authService;
    postgres = built.postgres;
    presenceService = built.presenceService;
    await fastify.ready();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await fastify.close();
  });

  describe('GET /health', () => {
    it('returns 200 with status ok', async () => {
      const res = await fastify.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).status).toBe('ok');
    });
  });

  describe('POST /api/auth/register', () => {
    it('returns 201 on success', async () => {
      authService.register.mockResolvedValue({
        success: true,
        user: { id: 'u1', username: 'alice' },
        token: 'tok',
        refreshToken: 'rt',
        deviceId: 'd1',
      });

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'alice', password: 'Password1!' },
      });

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).success).toBe(true);
    });

    it('returns 409 on duplicate', async () => {
      authService.register.mockResolvedValue({ success: false, error: 'Username taken' });

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'alice', password: 'Password1!' },
      });

      expect(res.statusCode).toBe(409);
    });
  });

  describe('POST /api/auth/login', () => {
    it('returns 200 + tokens on success', async () => {
      authService.login.mockResolvedValue({
        success: true,
        token: 'access',
        refreshToken: 'refresh',
        user: { id: 'u1', username: 'alice' },
      });

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'alice', password: 'Password1!' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).token).toBe('access');
    });

    it('returns 401 on wrong password', async () => {
      authService.login.mockResolvedValue({ success: false, error: 'Invalid credentials' });

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'alice', password: 'wrong' },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /api/auth/refresh', () => {
    it('returns 200 + new token', async () => {
      authService.refreshToken.mockResolvedValue({ success: true, token: 'new-access' });

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        payload: { refreshToken: 'rt', deviceFingerprint: 'fp' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).token).toBe('new-access');
    });
  });

  describe('GET /api/users/search', () => {
    it('returns 200 + array', async () => {
      postgres.searchUsers.mockResolvedValue([{ id: 'u1', username: 'alice' }]);

      const res = await fastify.inject({
        method: 'GET',
        url: '/api/users/search?q=alice',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).users).toHaveLength(1);
    });
  });

  describe('GET /api/users/:userId/encryption-key', () => {
    it('returns 401 without auth', async () => {
      const res = await fastify.inject({ method: 'GET', url: '/api/users/u2/encryption-key' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 with an invalid token', async () => {
      authService.verifyToken.mockResolvedValue(null);

      const res = await fastify.inject({
        method: 'GET',
        url: '/api/users/u2/encryption-key',
        headers: { authorization: 'Bearer bad' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when the user has no published key', async () => {
      authService.verifyToken.mockResolvedValue({ userId: 'u1', username: 'alice' });
      postgres.getEncryptionKey.mockResolvedValue(null);

      const res = await fastify.inject({
        method: 'GET',
        url: '/api/users/u2/encryption-key',
        headers: { authorization: 'Bearer ok' },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 200 with the published key', async () => {
      authService.verifyToken.mockResolvedValue({ userId: 'u1', username: 'alice' });
      postgres.getEncryptionKey.mockResolvedValue({
        userId: 'u2',
        username: 'bob',
        publicKey: 'pubkey-b64',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      const res = await fastify.inject({
        method: 'GET',
        url: '/api/users/u2/encryption-key',
        headers: { authorization: 'Bearer ok' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.userId).toBe('u2');
      expect(body.username).toBe('bob');
      expect(body.publicKey).toBe('pubkey-b64');
    });
  });

  describe('GET /api/users/:userId/presence', () => {
    it('returns 401 without auth', async () => {
      const res = await fastify.inject({ method: 'GET', url: '/api/users/u2/presence' });
      expect(res.statusCode).toBe(401);
      expect(presenceService.getPresence).not.toHaveBeenCalled();
    });

    it('returns 403 for non-mutual contacts', async () => {
      authService.verifyToken.mockResolvedValue({ userId: 'u1', username: 'alice' });
      postgres.checkMutualContact.mockResolvedValue(false);

      const res = await fastify.inject({
        method: 'GET',
        url: '/api/users/u2/presence',
        headers: { authorization: 'Bearer ok' },
      });

      expect(res.statusCode).toBe(403);
      expect(presenceService.getPresence).not.toHaveBeenCalled();
    });

    it('reads as offline when there is no presence record or session', async () => {
      authService.verifyToken.mockResolvedValue({ userId: 'u1', username: 'alice' });
      postgres.checkMutualContact.mockResolvedValue(true);
      presenceService.getPresence.mockResolvedValue(null);

      const res = await fastify.inject({
        method: 'GET',
        url: '/api/users/u2/presence',
        headers: { authorization: 'Bearer ok' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).presence.status).toBe('offline');
    });

    it('returns the live presence record for a mutual contact', async () => {
      authService.verifyToken.mockResolvedValue({ userId: 'u1', username: 'alice' });
      postgres.checkMutualContact.mockResolvedValue(true);
      presenceService.getPresence.mockResolvedValue({
        status: 'busy',
        message: 'in a meeting',
        lastSeen: '2026-01-01T10:00:00.000Z',
      });

      const res = await fastify.inject({
        method: 'GET',
        url: '/api/users/u2/presence',
        headers: { authorization: 'Bearer ok' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.presence.status).toBe('busy');
      expect(body.presence.message).toBe('in a meeting');
    });

    it('allows a self-lookup without the mutual-contact check', async () => {
      authService.verifyToken.mockResolvedValue({ userId: 'u1', username: 'alice' });
      presenceService.getPresence.mockResolvedValue({ status: 'online', lastSeen: '2026-01-01T10:00:00.000Z' });

      const res = await fastify.inject({
        method: 'GET',
        url: '/api/users/u1/presence',
        headers: { authorization: 'Bearer ok' },
      });

      expect(res.statusCode).toBe(200);
      expect(postgres.checkMutualContact).not.toHaveBeenCalled();
      expect(JSON.parse(res.body).presence.status).toBe('online');
    });
  });

  describe('GET /api/contacts', () => {
    it('returns 401 without auth', async () => {
      const res = await fastify.inject({ method: 'GET', url: '/api/contacts' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 200 with valid auth', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getContacts.mockResolvedValue([]);

      const res = await fastify.inject({
        method: 'GET',
        url: '/api/contacts',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('POST /api/contacts', () => {
    it('returns 201 on success', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getUserByUsername.mockResolvedValue({ id: 'u2', username: 'bob' });
      postgres.addContact.mockResolvedValue({ userId: 'u1', contactId: 'u2', username: 'bob' });

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/contacts',
        headers: { authorization: 'Bearer valid-token' },
        payload: { username: 'bob' },
      });

      expect(res.statusCode).toBe(201);
    });
  });

  describe('POST /api/contacts/:id/block', () => {
    it('returns 200 on success', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.blockContact.mockResolvedValue(true);

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/contacts/u2/block',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).success).toBe(true);
    });
  });

  describe('POST /api/channels', () => {
    it('returns 201 on success', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getChannelByName.mockResolvedValue(null);
      postgres.createChannel.mockResolvedValue({ id: 'ch-1', name: 'general', displayName: 'General', isPublic: false });
      postgres.joinChannel.mockResolvedValue(true);

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/channels',
        headers: { authorization: 'Bearer valid-token' },
        payload: { name: 'general', displayName: 'General', isPublic: false },
      });

      expect(res.statusCode).toBe(201);
    });
  });

  describe('POST /api/channels/:id/join', () => {
    it('returns 200 on success', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.joinChannel.mockResolvedValue(true);

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/join',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('POST /api/channels/:id/leave', () => {
    it('returns 200 on success', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.leaveChannel.mockResolvedValue(true);

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/leave',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('POST /api/channels/:id/invite', () => {
    it('returns 200 when requester is member and target found', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getChannelMembers.mockResolvedValue([{ userId: 'u1', username: 'alice', isAdmin: true }]);
      postgres.getUserByUsername.mockResolvedValue({ id: 'u2', username: 'bob' });
      postgres.joinChannel.mockResolvedValue(true);

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/invite',
        headers: { authorization: 'Bearer valid-token' },
        payload: { username: 'bob' },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('Build group endpoints', () => {
    it('POST /api/channels/:id/build/tasks creates a task', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getChannel.mockResolvedValue({ id: 'ch-1', channelType: 'build', ownerId: 'u1' });
      postgres.getChannelMembers.mockResolvedValue([{ userId: 'u1' }]);
      postgres.createBuildTask.mockResolvedValue({ id: 'task-1', title: 'Build', status: 'pending' });

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/build/tasks',
        headers: { authorization: 'Bearer valid-token' },
        payload: { title: 'Build', description: 'desc' },
      });

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).task.id).toBe('task-1');
    });

    it('POST /api/channels/:id/build/tasks rejects non-build channels', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getChannel.mockResolvedValue({ id: 'ch-1', channelType: 'social', ownerId: 'u1' });
      postgres.getChannelMembers.mockResolvedValue([{ userId: 'u1' }]);

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/build/tasks',
        headers: { authorization: 'Bearer valid-token' },
        payload: { title: 'Build' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('POST /api/channels/:id/build/tasks/:taskId/assign assigns to member', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getChannel.mockResolvedValue({ id: 'ch-1', channelType: 'build', ownerId: 'u1' });
      postgres.getBuildTaskById.mockResolvedValue({ id: 'task-1', channelId: 'ch-1' });
      postgres.getUserByUsername.mockResolvedValue({ id: 'u2', username: 'bob' });
      postgres.getChannelMembers.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
      postgres.assignBuildTask.mockResolvedValue({ id: 'task-1', assignedTo: 'u2', status: 'assigned' });

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/build/tasks/task-1/assign',
        headers: { authorization: 'Bearer valid-token' },
        payload: { username: 'bob' },
      });

      expect(res.statusCode).toBe(200);
    });

    it('GET /api/channels/:id/members/status returns statuses', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getChannelMembers.mockResolvedValue([{ userId: 'u1' }]);
      postgres.getMemberSessionStatuses.mockResolvedValue([{ userId: 'u1', remainingRequests: 10 }]);

      const res = await fastify.inject({
        method: 'GET',
        url: '/api/channels/ch-1/members/status',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).statuses).toHaveLength(1);
    });
  });

  describe('encryption routes', () => {
    const validKey = Buffer.alloc(32, 1).toString('base64');
    const validShare = {
      userId: 'u2',
      ephemeralPublicKey: Buffer.alloc(32, 2).toString('base64'),
      wrappedKey: Buffer.alloc(48, 3).toString('base64'),
      nonce: Buffer.alloc(12, 4).toString('base64'),
    };

    it('PUT /api/encryption/keys stores a valid 32-byte key', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });

      const res = await fastify.inject({
        method: 'PUT',
        url: '/api/encryption/keys',
        headers: { authorization: 'Bearer valid-token' },
        payload: { publicKey: validKey },
      });

      expect(res.statusCode).toBe(200);
      expect(postgres.upsertEncryptionKey).toHaveBeenCalledWith('u1', validKey);
    });

    it('PUT /api/encryption/keys rejects malformed keys', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });

      for (const publicKey of ['not-base64!!!', Buffer.alloc(16, 1).toString('base64'), '']) {
        const res = await fastify.inject({
          method: 'PUT',
          url: '/api/encryption/keys',
          headers: { authorization: 'Bearer valid-token' },
          payload: { publicKey },
        });
        expect(res.statusCode).toBe(400);
      }
      expect(postgres.upsertEncryptionKey).not.toHaveBeenCalled();
    });

    it('GET /api/channels/:id/encryption/keys requires membership', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'outsider', username: 'mallory' });
      postgres.getChannel.mockResolvedValue({ id: 'ch-1', encryptionEnabled: true });
      postgres.getChannelMembers.mockResolvedValue([{ userId: 'u1' }]);

      const res = await fastify.inject({
        method: 'GET',
        url: '/api/channels/ch-1/encryption/keys',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('GET /api/channels/:id/encryption/keys returns member keys and flag', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getChannel.mockResolvedValue({ id: 'ch-1', encryptionEnabled: true });
      postgres.getChannelMembers.mockResolvedValue([{ userId: 'u1' }]);
      postgres.getChannelEncryptionKeys.mockResolvedValue([
        { userId: 'u1', username: 'alice', publicKey: validKey },
        { userId: 'u2', username: 'bob', publicKey: null },
      ]);

      const res = await fastify.inject({
        method: 'GET',
        url: '/api/channels/ch-1/encryption/keys',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.encryptionEnabled).toBe(true);
      expect(body.keys).toHaveLength(2);
    });

    it('POST /api/channels/:id/encryption is admin-only', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u2', username: 'bob' });
      postgres.getChannel.mockResolvedValue({ id: 'ch-1', encryptionEnabled: false });
      postgres.getChannelMembers.mockResolvedValue([
        { userId: 'u1', isAdmin: true },
        { userId: 'u2', isAdmin: false },
      ]);

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/encryption',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(403);
      expect(postgres.setChannelEncryptionEnabled).not.toHaveBeenCalled();
    });

    it('POST /api/channels/:id/encryption enables for an admin, 409 when already enabled', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getChannel.mockResolvedValue({ id: 'ch-1', encryptionEnabled: false });
      postgres.getChannelMembers.mockResolvedValue([{ userId: 'u1', isAdmin: true }]);

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/encryption',
        headers: { authorization: 'Bearer valid-token' },
      });
      expect(res.statusCode).toBe(200);
      expect(postgres.setChannelEncryptionEnabled).toHaveBeenCalledWith('ch-1');

      postgres.getChannel.mockResolvedValue({ id: 'ch-1', encryptionEnabled: true });
      const res2 = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/encryption',
        headers: { authorization: 'Bearer valid-token' },
      });
      expect(res2.statusCode).toBe(409);
    });

    it('POST /api/channels/:id/encryption/shares stores valid shares', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getChannel.mockResolvedValue({ id: 'ch-1', encryptionEnabled: true });
      postgres.getChannelMembers.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
      postgres.upsertChannelKeyShares.mockResolvedValue({ conflict: [] });

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/encryption/shares',
        headers: { authorization: 'Bearer valid-token' },
        payload: { keyId: '0123456789abcdef', shares: [validShare] },
      });

      expect(res.statusCode).toBe(200);
      expect(postgres.upsertChannelKeyShares).toHaveBeenCalledWith('ch-1', '0123456789abcdef', 'u1', [validShare]);
    });

    it('POST /api/channels/:id/encryption/shares rejects bad sizes, outsiders, unencrypted channels', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getChannelMembers.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
      postgres.getChannel.mockResolvedValue({ id: 'ch-1', encryptionEnabled: true });

      const post = (payload: unknown) =>
        fastify.inject({
          method: 'POST',
          url: '/api/channels/ch-1/encryption/shares',
          headers: { authorization: 'Bearer valid-token' },
          payload: payload as any,
        });

      // Bad keyId
      expect((await post({ keyId: 'nope', shares: [validShare] })).statusCode).toBe(400);
      // Bad nonce size
      expect(
        (await post({ keyId: '0123456789abcdef', shares: [{ ...validShare, nonce: Buffer.alloc(4, 1).toString('base64') }] })).statusCode
      ).toBe(400);
      // Share target not a member
      expect(
        (await post({ keyId: '0123456789abcdef', shares: [{ ...validShare, userId: 'outsider' }] })).statusCode
      ).toBe(400);
      // Channel not encrypted
      postgres.getChannel.mockResolvedValue({ id: 'ch-1', encryptionEnabled: false });
      expect((await post({ keyId: '0123456789abcdef', shares: [validShare] })).statusCode).toBe(409);

      expect(postgres.upsertChannelKeyShares).not.toHaveBeenCalled();
    });

    it('POST /api/channels/:id/encryption/shares surfaces cross-member conflicts as 409', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getChannel.mockResolvedValue({ id: 'ch-1', encryptionEnabled: true });
      postgres.getChannelMembers.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
      postgres.upsertChannelKeyShares.mockResolvedValue({ conflict: ['u2'] });

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/encryption/shares',
        headers: { authorization: 'Bearer valid-token' },
        payload: { keyId: '0123456789abcdef', shares: [validShare] },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).conflictUserIds).toEqual(['u2']);
    });

    it('GET /api/channels/:id/encryption/shares/mine returns only my shares', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getChannel.mockResolvedValue({ id: 'ch-1', encryptionEnabled: true });
      postgres.getChannelMembers.mockResolvedValue([{ userId: 'u1' }]);
      postgres.getChannelKeySharesForUser.mockResolvedValue([{ keyId: '0123456789abcdef', ...validShare }]);

      const res = await fastify.inject({
        method: 'GET',
        url: '/api/channels/ch-1/encryption/shares/mine',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(200);
      expect(postgres.getChannelKeySharesForUser).toHaveBeenCalledWith('ch-1', 'u1');
      expect(JSON.parse(res.body).shares).toHaveLength(1);
    });
  });

  describe('POST /api/channels/:id/members/:userId/role', () => {
    const owner = { userId: 'u1', username: 'alice', role: 'owner', isAdmin: true };
    const admin = { userId: 'u1', username: 'alice', role: 'admin', isAdmin: true };
    const plainMember = { userId: 'u1', username: 'alice', role: 'member', isAdmin: false };

    it('owner promotes a member to admin and audits it', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getChannelMember
        .mockResolvedValueOnce(owner) // actor
        .mockResolvedValueOnce({ userId: 'u2', username: 'bob', role: 'member', isAdmin: false }); // target
      postgres.setChannelMemberRole.mockResolvedValue(true);

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/members/u2/role',
        headers: { authorization: 'Bearer valid-token' },
        payload: { role: 'admin' },
      });

      expect(res.statusCode).toBe(200);
      expect(postgres.setChannelMemberRole).toHaveBeenCalledWith('ch-1', 'u2', 'admin');
      expect(postgres.addAuditEvent).toHaveBeenCalledWith('ch-1', 'u1', 'role_changed', 'u2', { from: 'member', to: 'admin' });
    });

    it('admin cannot grant admin (owner only)', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getChannelMember
        .mockResolvedValueOnce(admin)
        .mockResolvedValueOnce({ userId: 'u2', username: 'bob', role: 'member', isAdmin: false });

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/members/u2/role',
        headers: { authorization: 'Bearer valid-token' },
        payload: { role: 'admin' },
      });

      expect(res.statusCode).toBe(403);
      expect(postgres.setChannelMemberRole).not.toHaveBeenCalled();
    });

    it('admin cannot demote another admin (owner only)', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getChannelMember
        .mockResolvedValueOnce(admin)
        .mockResolvedValueOnce({ userId: 'u2', username: 'bob', role: 'admin', isAdmin: true });

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/members/u2/role',
        headers: { authorization: 'Bearer valid-token' },
        payload: { role: 'member' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('ownership transfer demotes the current owner to admin', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getChannelMember
        .mockResolvedValueOnce(owner)
        .mockResolvedValueOnce({ userId: 'u2', username: 'bob', role: 'admin', isAdmin: true });
      postgres.setChannelMemberRole.mockResolvedValue(true);

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/members/u2/role',
        headers: { authorization: 'Bearer valid-token' },
        payload: { role: 'owner' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).ownershipTransferred).toBe(true);
      expect(postgres.setChannelMemberRole).toHaveBeenCalledWith('ch-1', 'u2', 'owner');
      expect(postgres.setChannelMemberRole).toHaveBeenCalledWith('ch-1', 'u1', 'admin');
    });

    it("the owner's role cannot be changed", async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getChannelMember
        .mockResolvedValueOnce(owner)
        .mockResolvedValueOnce({ userId: 'u9', username: 'eve', role: 'owner', isAdmin: true });

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/members/u9/role',
        headers: { authorization: 'Bearer valid-token' },
        payload: { role: 'member' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('rejects non-admin actors, missing targets, self-changes, and bad roles', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });

      // Bad role
      let res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/members/u2/role',
        headers: { authorization: 'Bearer valid-token' },
        payload: { role: 'superadmin' },
      });
      expect(res.statusCode).toBe(400);

      // Non-admin actor
      postgres.getChannelMember.mockResolvedValueOnce(plainMember);
      res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/members/u2/role',
        headers: { authorization: 'Bearer valid-token' },
        payload: { role: 'member' },
      });
      expect(res.statusCode).toBe(403);

      // Target not a member
      postgres.getChannelMember.mockResolvedValueOnce(admin).mockResolvedValueOnce(null);
      res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/members/u9/role',
        headers: { authorization: 'Bearer valid-token' },
        payload: { role: 'admin' },
      });
      expect(res.statusCode).toBe(404);

      // Self-change
      postgres.getChannelMember.mockResolvedValueOnce(owner).mockResolvedValueOnce(owner);
      res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/members/u1/role',
        headers: { authorization: 'Bearer valid-token' },
        payload: { role: 'admin' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/channels/:id/members/:userId/kick', () => {
    const owner = { userId: 'u1', username: 'alice', role: 'owner', isAdmin: true };
    const admin = { userId: 'u1', username: 'alice', role: 'admin', isAdmin: true };

    it('admin kicks a member and audits it', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getChannelMember
        .mockResolvedValueOnce(admin)
        .mockResolvedValueOnce({ userId: 'u2', username: 'bob', role: 'member', isAdmin: false });
      postgres.leaveChannel.mockResolvedValue(true);

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/members/u2/kick',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(200);
      expect(postgres.leaveChannel).toHaveBeenCalledWith('ch-1', 'u2');
      expect(postgres.addAuditEvent).toHaveBeenCalledWith('ch-1', 'u1', 'member_kicked', 'u2', { targetRole: 'member' });
    });

    it('admin cannot kick another admin; owner can', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getChannelMember
        .mockResolvedValueOnce(admin)
        .mockResolvedValueOnce({ userId: 'u2', username: 'bob', role: 'admin', isAdmin: true });

      let res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/members/u2/kick',
        headers: { authorization: 'Bearer valid-token' },
      });
      expect(res.statusCode).toBe(403);
      expect(postgres.leaveChannel).not.toHaveBeenCalled();

      postgres.getChannelMember
        .mockResolvedValueOnce(owner)
        .mockResolvedValueOnce({ userId: 'u2', username: 'bob', role: 'admin', isAdmin: true });
      postgres.leaveChannel.mockResolvedValue(true);

      res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/members/u2/kick',
        headers: { authorization: 'Bearer valid-token' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('the owner cannot be kicked and you cannot kick yourself', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });

      // Self
      let res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/members/u1/kick',
        headers: { authorization: 'Bearer valid-token' },
      });
      expect(res.statusCode).toBe(400);

      // Owner target
      postgres.getChannelMember
        .mockResolvedValueOnce(owner)
        .mockResolvedValueOnce({ userId: 'u9', username: 'eve', role: 'owner', isAdmin: true });
      res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/members/u9/kick',
        headers: { authorization: 'Bearer valid-token' },
      });
      expect(res.statusCode).toBe(403);
      expect(postgres.leaveChannel).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/channels/:id/audit', () => {
    it('returns events for an admin, newest first, with a clamped limit', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getChannelMember.mockResolvedValue({ userId: 'u1', role: 'admin', isAdmin: true });
      postgres.getAuditEvents.mockResolvedValue([
        { id: 'ev-2', action: 'member_kicked', actorUsername: 'alice', targetUsername: 'bob', createdAt: '2026-01-02' },
        { id: 'ev-1', action: 'channel_created', actorUsername: 'alice', createdAt: '2026-01-01' },
      ]);

      const res = await fastify.inject({
        method: 'GET',
        url: '/api/channels/ch-1/audit?limit=99999',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(200);
      expect(postgres.getAuditEvents).toHaveBeenCalledWith('ch-1', 500); // clamped
      expect(JSON.parse(res.body).events).toHaveLength(2);
    });

    it('is forbidden for plain members', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u2', username: 'bob' });
      postgres.getChannelMember.mockResolvedValue({ userId: 'u2', role: 'member', isAdmin: false });

      const res = await fastify.inject({
        method: 'GET',
        url: '/api/channels/ch-1/audit',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(403);
      expect(postgres.getAuditEvents).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/channels/:id/retention', () => {
    it('requires auth', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/retention',
        payload: { retentionMinutes: 1440 },
      });

      expect(res.statusCode).toBe(401);
      expect(postgres.setChannelRetention).not.toHaveBeenCalled();
    });

    it('rejects out-of-range and non-integer values', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getChannelMember.mockResolvedValue({ userId: 'u1', role: 'owner', isAdmin: true });

      for (const bad of [30, 527041, 1.5, '1440']) {
        const res = await fastify.inject({
          method: 'POST',
          url: '/api/channels/ch-1/retention',
          headers: { authorization: 'Bearer valid-token' },
          payload: { retentionMinutes: bad },
        });
        expect(res.statusCode).toBe(400);
      }
      expect(postgres.setChannelRetention).not.toHaveBeenCalled();
    });

    it('is forbidden for plain members', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u2', username: 'bob' });
      postgres.getChannelMember.mockResolvedValue({ userId: 'u2', role: 'member', isAdmin: false });

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/retention',
        headers: { authorization: 'Bearer valid-token' },
        payload: { retentionMinutes: 1440 },
      });

      expect(res.statusCode).toBe(403);
      expect(postgres.setChannelRetention).not.toHaveBeenCalled();
    });

    it('sets the override and audits the change', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getChannelMember.mockResolvedValue({ userId: 'u1', role: 'owner', isAdmin: true });
      postgres.setChannelRetention.mockResolvedValue(true);

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/retention',
        headers: { authorization: 'Bearer valid-token' },
        payload: { retentionMinutes: 1440 },
      });

      expect(res.statusCode).toBe(200);
      expect(postgres.setChannelRetention).toHaveBeenCalledWith('ch-1', 1440);
      expect(postgres.addAuditEvent).toHaveBeenCalledWith('ch-1', 'u1', 'retention_changed', null, { retentionMinutes: 1440 });
      expect(JSON.parse(res.body).retentionMinutes).toBe(1440);
    });

    it('clears the override when retentionMinutes is omitted or null', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getChannelMember.mockResolvedValue({ userId: 'u1', role: 'admin', isAdmin: true });
      postgres.setChannelRetention.mockResolvedValue(true);

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/retention',
        headers: { authorization: 'Bearer valid-token' },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(postgres.setChannelRetention).toHaveBeenCalledWith('ch-1', null);
    });

    it('404s when the channel does not exist', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getChannelMember.mockResolvedValue({ userId: 'u1', role: 'owner', isAdmin: true });
      postgres.setChannelRetention.mockResolvedValue(false);

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-unknown/retention',
        headers: { authorization: 'Bearer valid-token' },
        payload: { retentionMinutes: 60 },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('leave channel owner guard', () => {
    it('owner cannot leave while other members remain', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getChannelMember.mockResolvedValue({ userId: 'u1', role: 'owner', isAdmin: true });
      postgres.getChannelMembers.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/leave',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(403);
      expect(postgres.leaveChannel).not.toHaveBeenCalled();
    });

    it('owner can leave as the last member', async () => {
      authService.verifyToken.mockReturnValue({ userId: 'u1', username: 'alice' });
      postgres.getChannelMember.mockResolvedValue({ userId: 'u1', role: 'owner', isAdmin: true });
      postgres.getChannelMembers.mockResolvedValue([{ userId: 'u1' }]);
      postgres.leaveChannel.mockResolvedValue(true);

      const res = await fastify.inject({
        method: 'POST',
        url: '/api/channels/ch-1/leave',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(200);
    });
  });
});
