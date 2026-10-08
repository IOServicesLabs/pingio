import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import dotenv from 'dotenv';
import { z } from 'zod';
import { PostgresStore } from './stores/postgres.js';
import { RedisStore } from './stores/redis.js';
import { AuthService } from './services/auth.js';
import { SessionService } from './services/session.js';
import { PresenceService } from './services/presence.js';
import { RateLimitService } from './services/rate-limit.js';
import { WebSocketHandler } from './websocket/handler.js';
import { WS_MAX_PAYLOAD_BYTES, ChannelKeyShareSchema, ChannelRoleSchema, MIN_CHANNEL_RETENTION_MINUTES, MAX_CHANNEL_RETENTION_MINUTES } from '@pingio/shared';
import type { ChannelAuditAction } from '@pingio/shared';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';

// Server-wide message retention in minutes; 0 = keep forever. Channels can
// override with their own retention_minutes (POST /api/channels/:id/retention).
const DEFAULT_MESSAGE_RETENTION_MINUTES = Math.max(
  parseInt(process.env.MESSAGE_RETENTION_MINUTES || '0', 10) || 0,
  0
);
// How often the retention sweeper runs (also runs once at startup).
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

// keyId is supplied once at the top level; each share carries only its
// per-member wrap material.
const PostKeySharesBodySchema = z.object({
  keyId: z.string().length(16).regex(/^[0-9a-f]+$/),
  shares: z.array(ChannelKeyShareSchema.omit({ keyId: true })).min(1).max(64),
});

async function main() {
  // Initialize stores
  const postgres = new PostgresStore();
  await postgres.init();
  console.log('PostgreSQL connected');

  const redis = new RedisStore(process.env.REDIS_URL);
  console.log('Redis connected');

  // Initialize services
  const authService = new AuthService(postgres);
  const sessionService = new SessionService(redis, postgres);
  const presenceService = new PresenceService(redis, sessionService);
  const rateLimitService = new RateLimitService(redis);

  // Initialize WebSocket handler
  const wsHandler = new WebSocketHandler(
    sessionService,
    authService,
    presenceService,
    rateLimitService,
    postgres
  );

  // Create Fastify instance
  const fastify = Fastify({
    logger: process.env.NODE_ENV === 'development',
    trustProxy: process.env.TRUST_PROXY === 'true',
  });

  // Channel audit log writer: an audit failure must not block the action that
  // triggered it, but it is always logged loudly.
  const audit = (
    channelId: string,
    actorId: string | null,
    action: ChannelAuditAction,
    targetId?: string | null,
    metadata?: Record<string, unknown>
  ): void => {
    postgres
      .addAuditEvent(channelId, actorId, action, targetId, metadata)
      .catch(err => fastify.log.error({ err, channelId, action }, 'channel audit write failed'));
  };

  // Register plugins
  const corsOrigin = process.env.CORS_ORIGIN;
  await fastify.register(cors, {
    origin:
      corsOrigin === 'false'
        ? false
        : corsOrigin
          ? corsOrigin
          : process.env.NODE_ENV === 'production'
            ? false
            : true,
    credentials: true,
  });

  // Cap individual WebSocket frames so a hostile or buggy peer cannot force the
  // relay to buffer an unbounded message (e.g. a giant artifact payload).
  await fastify.register(websocket, {
    options: { maxPayload: WS_MAX_PAYLOAD_BYTES },
  });

  // Health check endpoint
  fastify.get('/health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      connections: sessionService.getOnlineUserCount(),
      authMode: authService.getMode(),
    };
  });

  // Well-known Pingio metadata
  fastify.get('/.well-known/pingio', async () => {
    return {
      relay_id: process.env.RELAY_ID || null,
      relay_url: `ws://${process.env.RELAY_HOST || 'localhost'}:${PORT}/ws`,
      auth_issuer: process.env.CENTRAL_AUTH_ISSUER || null,
      federation_enabled: false,
    };
  });

  // REST API routes
  // Local-only auth routes
  if (authService.getMode() === 'local') {
    // Registration
    fastify.post('/api/auth/register', async (request, reply) => {
      const { username, password, displayName, deviceFingerprint, deviceName } = request.body as {
      username: string;
      password: string;
      displayName?: string;
      deviceFingerprint?: string;
      deviceName?: string;
    };

    const result = await authService.register(username, password, displayName, deviceFingerprint, deviceName);

    if (!result.success) {
      reply.status(409);
      return { success: false, error: result.error };
    }

    return {
      success: true,
      userId: result.user?.id,
      token: result.token,
      refreshToken: result.refreshToken,
      deviceId: result.deviceId,
    };
  });

  // Login
  fastify.post('/api/auth/login', async (request, reply) => {
    const { username, password, deviceFingerprint, deviceName } = request.body as {
      username: string;
      password: string;
      deviceFingerprint?: string;
      deviceName?: string;
    };

    // Get client IP
    const ipAddress = request.ip;

    const result = await authService.login(username, password, deviceFingerprint, deviceName, ipAddress);

    if (!result.success) {
      // Check if verification is required
      if (result.verificationRequired) {
        reply.status(403);
        return {
          success: false,
          verificationRequired: true,
          deviceId: result.deviceId,
          error: result.error,
        };
      }
      reply.status(401);
      return result;
    }

    return result;
  });

  // Token refresh
  fastify.post('/api/auth/refresh', async (request, reply) => {
    const { refreshToken, deviceFingerprint } = request.body as {
      refreshToken: string;
      deviceFingerprint: string;
    };

    if (!refreshToken || !deviceFingerprint) {
      reply.status(400);
      return { success: false, error: 'Missing refresh token or device fingerprint' };
    }

    const result = await authService.refreshToken(refreshToken, deviceFingerprint);

    if (!result.success) {
      reply.status(401);
      return result;
    }

    return result;
  });

  // List devices (protected)
  fastify.get('/api/devices', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const devices = await authService.listDevices(decoded.userId);
    return { success: true, devices };
  });

  // Verify device (protected - from a trusted device)
  fastify.post('/api/devices/verify', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { deviceId } = request.body as { deviceId: string };

    if (!deviceId) {
      reply.status(400);
      return { success: false, error: 'Missing deviceId' };
    }

    const result = await authService.verifyDevice(decoded.userId, deviceId);

    if (!result.success) {
      reply.status(400);
      return result;
    }

    return { success: true };
  });

  // Revoke device (protected)
  fastify.post('/api/devices/revoke', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { deviceId } = request.body as { deviceId: string };

    if (!deviceId) {
      reply.status(400);
      return { success: false, error: 'Missing deviceId' };
    }

    const result = await authService.revokeDevice(decoded.userId, deviceId);

    if (!result.success) {
      reply.status(400);
      return result;
    }

    return { success: true };
  });

  } // End local-only auth routes

  // User search
  fastify.get('/api/users/search', async (request) => {
    const { q, limit } = request.query as { q: string; limit?: string };
    const users = await postgres.searchUsers(q, parseInt(limit || '10'));
    return { users };
  });

  // Get user profile (protected)
  fastify.get('/api/users/:userId', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const user = await postgres.getUserById(userId);

    if (!user) {
      reply.status(404);
      return { error: 'User not found' };
    }

    const presence = await presenceService.getPresence(userId);

    return {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        presence,
      },
    };
  });

  // Get a user's published X25519 identity public key (protected) — used to
  // establish pairwise DM encryption. 404 when the user has no key published.
  fastify.get('/api/users/:userId/encryption-key', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { userId } = request.params as { userId: string };
    const key = await postgres.getEncryptionKey(userId);

    if (!key) {
      reply.status(404);
      return { error: 'User not found or has no encryption key published' };
    }

    return { userId: key.userId, username: key.username, publicKey: key.publicKey, updatedAt: key.updatedAt };
  });

  // Presence lookup (protected). Presence is contacts-scoped: you can only
  // read your own status or a mutual contact's. Users with no live session and
  // no stored record read as offline.
  fastify.get('/api/users/:userId/presence', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { userId } = request.params as { userId: string };

    if (userId !== decoded.userId) {
      const mutual = await postgres.checkMutualContact(decoded.userId, userId);
      if (!mutual) {
        reply.status(403);
        return { error: 'Only mutual contacts can see presence' };
      }
    }

    const presence = await presenceService.getPresence(userId);
    return { presence: presence ?? { status: 'offline' } };
  });

  // Get contacts (protected)
  fastify.get('/api/contacts', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const contacts = await postgres.getContacts(decoded.userId);

    // Get presence for contacts
    const contactIds = contacts.map(c => c.contactId);
    const presences = await presenceService.getBulkPresence(contactIds);

    const contactsWithPresence = contacts.map(contact => ({
      ...contact,
      presence: presences.get(contact.contactId),
    }));

    return { contacts: contactsWithPresence };
  });

  // Add contact (protected)
  fastify.post('/api/contacts', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { username, customName } = request.body as {
      username: string;
      customName?: string;
    };

    const contactUser = await postgres.getUserByUsername(username);
    if (!contactUser) {
      reply.status(404);
      return { error: 'User not found' };
    }

    const contact = await postgres.addContact(decoded.userId, contactUser.id, customName);

    if (!contact) {
      reply.status(409);
      return { error: 'Already a contact' };
    }

    return { contact };
  });

  // Block contact (protected)
  fastify.post('/api/contacts/:contactId/block', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { contactId } = request.params as { contactId: string };

    await postgres.blockContact(decoded.userId, contactId, true);

    return { success: true };
  });

  // Unblock contact (protected)
  fastify.post('/api/contacts/:contactId/unblock', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { contactId } = request.params as { contactId: string };

    await postgres.blockContact(decoded.userId, contactId, false);

    return { success: true };
  });

  // Message history (protected)
  fastify.get('/api/messages/:contactId', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { contactId } = request.params as { contactId: string };
    const { before, limit } = request.query as { before?: string; limit?: string };

    const messages = await postgres.getDMHistory(
      decoded.userId,
      contactId,
      before ? new Date(before) : undefined,
      parseInt(limit || '50')
    );

    return { messages };
  });

  // Channels (protected)
  fastify.get('/api/channels', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { public: publicOnly } = request.query as { public?: string };

    if (publicOnly === 'true') {
      const channels = await postgres.getPublicChannels();
      return { channels };
    }

    const channels = await postgres.getUserChannels(decoded.userId);
    return { channels };
  });

  // Create channel (protected)
  fastify.post('/api/channels', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { name, displayName, isPublic, channelType, buildPrompt, maxMembers, encryptionEnabled } = request.body as {
      name: string;
      displayName: string;
      isPublic?: boolean;
      channelType?: 'social' | 'build';
      buildPrompt?: string;
      maxMembers?: number;
      encryptionEnabled?: boolean;
    };

    // Check if name is taken
    const existing = await postgres.getChannelByName(name);
    if (existing) {
      reply.status(409);
      return { error: 'Channel name already taken' };
    }

    const channel = await postgres.createChannel(
      name,
      displayName,
      decoded.userId,
      isPublic,
      channelType,
      buildPrompt,
      maxMembers,
      encryptionEnabled === true
    );

    // Add creator as owner (join as admin, then elevate so role stays in sync)
    await postgres.joinChannel(channel.id, decoded.userId, true);
    await postgres.setChannelMemberRole(channel.id, decoded.userId, 'owner');
    audit(channel.id, decoded.userId, 'channel_created', null, {
      name: channel.name,
      channelType: channel.channelType,
      isPublic: channel.isPublic,
      encryptionEnabled: channel.encryptionEnabled,
    });

    return { channel };
  });

  // Join channel (protected)
  fastify.post('/api/channels/:channelId/join', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { channelId } = request.params as { channelId: string };

    const joined = await postgres.joinChannel(channelId, decoded.userId);

    if (!joined) {
      reply.status(409);
      return { error: 'Already a member' };
    }

    audit(channelId, decoded.userId, 'member_joined', decoded.userId, { via: 'join' });

    return { success: true };
  });

  // Leave channel (protected)
  fastify.post('/api/channels/:channelId/leave', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { channelId } = request.params as { channelId: string };

    // The owner cannot leave while other members remain — transfer ownership
    // first, or be the last member out.
    const self = await postgres.getChannelMember(channelId, decoded.userId);
    if (self?.role === 'owner') {
      const members = await postgres.getChannelMembers(channelId);
      if (members.length > 1) {
        reply.status(403);
        return { error: 'The channel owner must transfer ownership before leaving' };
      }
    }

    const left = await postgres.leaveChannel(channelId, decoded.userId);

    if (!left) {
      reply.status(404);
      return { error: 'Not a member of this channel' };
    }

    audit(channelId, decoded.userId, 'member_left', decoded.userId);

    return { success: true };
  });

  // Invite to channel (protected)
  fastify.post('/api/channels/:channelId/invite', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { channelId } = request.params as { channelId: string };
    const { username } = request.body as { username: string };

    // Check requester is a member
    const members = await postgres.getChannelMembers(channelId);
    const isMember = members.some(m => m.userId === decoded.userId);
    if (!isMember) {
      reply.status(403);
      return { error: 'Not a member of this channel' };
    }

    // Look up target user
    const targetUser = await postgres.getUserByUsername(username);
    if (!targetUser) {
      reply.status(404);
      return { error: 'User not found' };
    }

    const joined = await postgres.joinChannel(channelId, targetUser.id);

    if (!joined) {
      reply.status(409);
      return { error: 'User is already a member' };
    }

    audit(channelId, decoded.userId, 'member_joined', targetUser.id, { via: 'direct_invite' });

    return { success: true };
  });

  // Create invite code for channel (protected)
  fastify.post('/api/channels/:channelId/invites', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { channelId } = request.params as { channelId: string };
    const { maxUses, expiresInHours } = request.body as { maxUses?: number; expiresInHours?: number };

    const members = await postgres.getChannelMembers(channelId);
    const isMember = members.some(m => m.userId === decoded.userId);
    if (!isMember) {
      reply.status(403);
      return { error: 'Not a member of this channel' };
    }

    const expiresAt = expiresInHours ? new Date(Date.now() + expiresInHours * 3600_000) : undefined;
    const invite = await postgres.createChannelInvite(channelId, decoded.userId, maxUses, expiresAt);

    audit(channelId, decoded.userId, 'invite_created', null, {
      maxUses: maxUses ?? null,
      expiresAt: expiresAt?.toISOString() ?? null,
      codeSuffix: invite.inviteCode.slice(-4),
    });

    return { invite };
  });

  // Join channel by invite code (protected)
  fastify.post('/api/channels/join-by-invite', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { inviteCode } = request.body as { inviteCode: string };

    const channel = await postgres.useInviteCode(inviteCode, decoded.userId);

    if (!channel) {
      reply.status(404);
      return { error: 'Invalid or expired invite code' };
    }

    // Never log the full code — an active code in the audit log would be reusable.
    audit(channel.id, decoded.userId, 'invite_used', decoded.userId, {
      codeSuffix: inviteCode.slice(-4),
    });
    audit(channel.id, decoded.userId, 'member_joined', decoded.userId, { via: 'invite_code' });

    return { channel };
  });

  // Change a member's role (protected). Admins manage members; only the owner
  // can promote to/demote from admin, and ownership transfer (role 'owner')
  // demotes the current owner to admin. The owner's role cannot otherwise be
  // changed.
  fastify.post('/api/channels/:channelId/members/:userId/role', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { channelId, userId } = request.params as { channelId: string; userId: string };

    const parsed = z.object({ role: ChannelRoleSchema }).safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid role', details: parsed.error.issues.map(i => i.message) };
    }
    const { role } = parsed.data;

    const actor = await postgres.getChannelMember(channelId, decoded.userId);
    if (!actor?.isAdmin) {
      reply.status(403);
      return { error: 'Only channel admins can change member roles' };
    }

    const target = await postgres.getChannelMember(channelId, userId);
    if (!target) {
      reply.status(404);
      return { error: 'User is not a member of this channel' };
    }

    if (userId === decoded.userId) {
      reply.status(400);
      return { error: 'Cannot change your own role' };
    }

    if (target.role === 'owner') {
      reply.status(403);
      return { error: "Cannot change the channel owner's role" };
    }

    // Only the owner can promote to admin or demote an admin.
    if ((role === 'admin' || target.role === 'admin') && actor.role !== 'owner') {
      reply.status(403);
      return { error: 'Only the channel owner can grant or revoke admin' };
    }

    if (role === 'owner') {
      // Ownership transfer: only the current owner, and they become an admin.
      if (actor.role !== 'owner') {
        reply.status(403);
        return { error: 'Only the channel owner can transfer ownership' };
      }
      await postgres.setChannelMemberRole(channelId, userId, 'owner');
      await postgres.setChannelMemberRole(channelId, decoded.userId, 'admin');
      audit(channelId, decoded.userId, 'role_changed', userId, {
        from: target.role,
        to: 'owner',
        ownershipTransfer: true,
      });
      return { success: true, ownershipTransferred: true };
    }

    if (target.role === role) {
      reply.status(409);
      return { error: `User already has role '${role}'` };
    }

    await postgres.setChannelMemberRole(channelId, userId, role);
    audit(channelId, decoded.userId, 'role_changed', userId, { from: target.role, to: role });

    return { success: true };
  });

  // Kick a member from a channel (protected). Admins kick members; only the
  // owner can kick an admin; the owner cannot be kicked.
  fastify.post('/api/channels/:channelId/members/:userId/kick', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { channelId, userId } = request.params as { channelId: string; userId: string };

    if (userId === decoded.userId) {
      reply.status(400);
      return { error: 'Cannot kick yourself — use leave instead' };
    }

    const actor = await postgres.getChannelMember(channelId, decoded.userId);
    if (!actor?.isAdmin) {
      reply.status(403);
      return { error: 'Only channel admins can kick members' };
    }

    const target = await postgres.getChannelMember(channelId, userId);
    if (!target) {
      reply.status(404);
      return { error: 'User is not a member of this channel' };
    }

    if (target.role === 'owner') {
      reply.status(403);
      return { error: 'Cannot kick the channel owner' };
    }

    if (target.role === 'admin' && actor.role !== 'owner') {
      reply.status(403);
      return { error: 'Only the channel owner can kick an admin' };
    }

    await postgres.leaveChannel(channelId, userId);
    audit(channelId, decoded.userId, 'member_kicked', userId, { targetRole: target.role });

    return { success: true };
  });

  // Channel audit log (protected, owner/admin only). Newest first.
  fastify.get('/api/channels/:channelId/audit', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { channelId } = request.params as { channelId: string };
    const { limit: limitParam } = request.query as { limit?: string };
    const limit = Math.min(Math.max(parseInt(limitParam || '100', 10) || 100, 1), 500);

    const actor = await postgres.getChannelMember(channelId, decoded.userId);
    if (!actor?.isAdmin) {
      reply.status(403);
      return { error: 'Only channel admins can read the audit log' };
    }

    const events = await postgres.getAuditEvents(channelId, limit);
    return { events };
  });

  // Set or clear per-channel message retention (owner/admin only). Body:
  // { retentionMinutes: number | null } — null clears the override so the
  // server-wide MESSAGE_RETENTION_MINUTES default applies.
  fastify.post('/api/channels/:channelId/retention', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { channelId } = request.params as { channelId: string };
    const body = request.body as { retentionMinutes?: number | null } | undefined;
    const retentionMinutes = body?.retentionMinutes ?? null;

    if (
      retentionMinutes !== null &&
      (!Number.isInteger(retentionMinutes) ||
        retentionMinutes < MIN_CHANNEL_RETENTION_MINUTES ||
        retentionMinutes > MAX_CHANNEL_RETENTION_MINUTES)
    ) {
      reply.status(400);
      return {
        error: `retentionMinutes must be null or an integer between ${MIN_CHANNEL_RETENTION_MINUTES} and ${MAX_CHANNEL_RETENTION_MINUTES}`,
      };
    }

    const actor = await postgres.getChannelMember(channelId, decoded.userId);
    if (!actor?.isAdmin) {
      reply.status(403);
      return { error: 'Only channel admins can change retention' };
    }

    const updated = await postgres.setChannelRetention(channelId, retentionMinutes);
    if (!updated) {
      reply.status(404);
      return { error: 'Channel not found' };
    }

    audit(channelId, decoded.userId, 'retention_changed', null, { retentionMinutes });
    return { ok: true, retentionMinutes };
  });

  // Channel messages (protected)
  fastify.get('/api/channels/:channelId/messages', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { channelId } = request.params as { channelId: string };
    const { before, limit } = request.query as { before?: string; limit?: string };

    // Check membership
    const members = await postgres.getChannelMembers(channelId);
    const isMember = members.some(m => m.userId === decoded.userId);

    if (!isMember) {
      reply.status(403);
      return { error: 'Not a member of this channel' };
    }

    const messages = await postgres.getChannelHistory(
      channelId,
      before ? new Date(before) : undefined,
      parseInt(limit || '50')
    );

    return { messages };
  });

  // Single channel detail (member-only)
  fastify.get('/api/channels/:channelId', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { channelId } = request.params as { channelId: string };
    const channel = await postgres.getChannel(channelId);
    if (!channel) {
      reply.status(404);
      return { error: 'Channel not found' };
    }

    const members = await postgres.getChannelMembers(channelId);
    const isMember = members.some(m => m.userId === decoded.userId);
    if (!isMember) {
      reply.status(403);
      return { error: 'Not a member of this channel' };
    }

    return { channel };
  });

  // --- E2E encryption key management -------------------------------------
  // The relay only ever stores public identity keys and opaque wrapped key
  // shares; plaintext channel keys and message content stay client-side.

  // Publish (or rotate) my X25519 identity public key (protected)
  fastify.put('/api/encryption/keys', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { publicKey } = request.body as { publicKey?: string };
    const raw = publicKey ? Buffer.from(publicKey, 'base64') : null;
    if (!publicKey || !raw || raw.length !== 32 || raw.toString('base64') !== publicKey) {
      reply.status(400);
      return { error: 'publicKey must be a base64-encoded 32-byte X25519 public key' };
    }

    await postgres.upsertEncryptionKey(decoded.userId, publicKey);
    return { success: true };
  });

  // List channel members' encryption public keys (member-only)
  fastify.get('/api/channels/:channelId/encryption/keys', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { channelId } = request.params as { channelId: string };
    const channel = await postgres.getChannel(channelId);
    if (!channel) {
      reply.status(404);
      return { error: 'Channel not found' };
    }

    const members = await postgres.getChannelMembers(channelId);
    const isMember = members.some(m => m.userId === decoded.userId);
    if (!isMember) {
      reply.status(403);
      return { error: 'Not a member of this channel' };
    }

    const keys = await postgres.getChannelEncryptionKeys(channelId);
    return { encryptionEnabled: channel.encryptionEnabled, keys };
  });

  // Enable encryption for a channel (admin-only, one-way)
  fastify.post('/api/channels/:channelId/encryption', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { channelId } = request.params as { channelId: string };
    const channel = await postgres.getChannel(channelId);
    if (!channel) {
      reply.status(404);
      return { error: 'Channel not found' };
    }

    const members = await postgres.getChannelMembers(channelId);
    const me = members.find(m => m.userId === decoded.userId);
    if (!me?.isAdmin) {
      reply.status(403);
      return { error: 'Only channel admins can enable encryption' };
    }

    if (channel.encryptionEnabled) {
      reply.status(409);
      return { error: 'Encryption is already enabled for this channel' };
    }

    await postgres.setChannelEncryptionEnabled(channelId);
    audit(channelId, decoded.userId, 'encryption_enabled');
    return { success: true, encryptionEnabled: true };
  });

  // Post wrapped key shares for a channel key (member-only). Shares created
  // by another member are never overwritten — a conflict returns 409.
  fastify.post('/api/channels/:channelId/encryption/shares', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { channelId } = request.params as { channelId: string };
    const channel = await postgres.getChannel(channelId);
    if (!channel) {
      reply.status(404);
      return { error: 'Channel not found' };
    }

    const members = await postgres.getChannelMembers(channelId);
    const isMember = members.some(m => m.userId === decoded.userId);
    if (!isMember) {
      reply.status(403);
      return { error: 'Not a member of this channel' };
    }

    if (!channel.encryptionEnabled) {
      reply.status(409);
      return { error: 'Encryption is not enabled for this channel' };
    }

    const parsed = PostKeySharesBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid shares payload', details: parsed.error.issues.map(i => i.message) };
    }
    const { keyId, shares } = parsed.data;

    // Every share payload must decode to the expected byte sizes.
    for (const share of shares) {
      const eph = Buffer.from(share.ephemeralPublicKey, 'base64');
      const wrapped = Buffer.from(share.wrappedKey, 'base64');
      const nonce = Buffer.from(share.nonce, 'base64');
      if (eph.length !== 32 || nonce.length !== 12 || wrapped.length < 48 || wrapped.length > 80) {
        reply.status(400);
        return { error: 'Share fields must be base64: 32-byte ephemeral key, 12-byte nonce, 48-80 byte wrapped key' };
      }
    }

    // Shares may only target current members.
    const memberIds = new Set(members.map(m => m.userId));
    const outsider = shares.find(s => !memberIds.has(s.userId));
    if (outsider) {
      reply.status(400);
      return { error: `Share target ${outsider.userId} is not a member of this channel` };
    }

    const { conflict } = await postgres.upsertChannelKeyShares(channelId, keyId, decoded.userId, shares);
    if (conflict.length > 0) {
      reply.status(409);
      return { error: 'Some shares for this key were created by another member', conflictUserIds: conflict };
    }

    audit(channelId, decoded.userId, 'key_shares_posted', null, { keyId, count: shares.length });

    return { success: true, keyId, count: shares.length };
  });

  // Fetch my wrapped key shares for a channel (member-only)
  fastify.get('/api/channels/:channelId/encryption/shares/mine', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);

    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { channelId } = request.params as { channelId: string };
    const channel = await postgres.getChannel(channelId);
    if (!channel) {
      reply.status(404);
      return { error: 'Channel not found' };
    }

    const members = await postgres.getChannelMembers(channelId);
    const isMember = members.some(m => m.userId === decoded.userId);
    if (!isMember) {
      reply.status(403);
      return { error: 'Not a member of this channel' };
    }

    const shares = await postgres.getChannelKeySharesForUser(channelId, decoded.userId);
    return { encryptionEnabled: channel.encryptionEnabled, shares };
  });

  // Build group task routes (protected)
  fastify.get('/api/channels/:channelId/build/tasks', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);
    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { channelId } = request.params as { channelId: string };
    const { status, assignedTo } = request.query as { status?: string; assignedTo?: string };

    const members = await postgres.getChannelMembers(channelId);
    if (!members.some(m => m.userId === decoded.userId)) {
      reply.status(403);
      return { error: 'Not a member of this channel' };
    }

    const tasks = await postgres.getBuildTasks(channelId, status, assignedTo);
    return { tasks };
  });

  fastify.post('/api/channels/:channelId/build/tasks', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);
    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { channelId } = request.params as { channelId: string };
    const { title, description } = request.body as { title: string; description?: string };

    const channel = await postgres.getChannel(channelId);
    if (!channel) {
      reply.status(404);
      return { error: 'Channel not found' };
    }
    if (channel.channelType !== 'build') {
      reply.status(400);
      return { error: 'Not a build group' };
    }

    const members = await postgres.getChannelMembers(channelId);
    if (!members.some(m => m.userId === decoded.userId)) {
      reply.status(403);
      return { error: 'Not a member of this channel' };
    }

    const task = await postgres.createBuildTask(channelId, decoded.userId, title, description);
    reply.status(201);
    return { task };
  });

  fastify.post('/api/channels/:channelId/build/tasks/:taskId/assign', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);
    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { channelId, taskId } = request.params as { channelId: string; taskId: string };
    const { username } = request.body as { username: string };

    const channel = await postgres.getChannel(channelId);
    if (!channel) {
      reply.status(404);
      return { error: 'Channel not found' };
    }
    if (channel.ownerId !== decoded.userId) {
      reply.status(403);
      return { error: 'Only the build group owner can assign tasks' };
    }

    const task = await postgres.getBuildTaskById(taskId);
    if (!task || task.channelId !== channelId) {
      reply.status(404);
      return { error: 'Task not found' };
    }

    const targetUser = await postgres.getUserByUsername(username);
    if (!targetUser) {
      reply.status(404);
      return { error: 'User not found' };
    }

    const members = await postgres.getChannelMembers(channelId);
    if (!members.some(m => m.userId === targetUser.id)) {
      reply.status(403);
      return { error: 'User is not a member of this channel' };
    }

    const assigned = await postgres.assignBuildTask(taskId, targetUser.id);
    if (!assigned) {
      reply.status(500);
      return { error: 'Failed to assign task' };
    }

    return { task: assigned };
  });

  fastify.post('/api/channels/:channelId/build/tasks/:taskId/complete', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);
    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { channelId, taskId } = request.params as { channelId: string; taskId: string };
    const { artifactFilename, artifactSize } = request.body as { artifactFilename?: string; artifactSize?: number };

    const task = await postgres.getBuildTaskById(taskId);
    if (!task || task.channelId !== channelId) {
      reply.status(404);
      return { error: 'Task not found' };
    }

    const members = await postgres.getChannelMembers(channelId);
    const isMember = members.some(m => m.userId === decoded.userId);
    if (!isMember) {
      reply.status(403);
      return { error: 'Not a member of this channel' };
    }

    if (task.assignedTo !== decoded.userId && task.ownerId !== decoded.userId) {
      reply.status(403);
      return { error: 'Only the assigned worker or owner can complete this task' };
    }

    const completed = await postgres.completeBuildTask(taskId, artifactFilename, artifactSize);
    if (!completed) {
      reply.status(500);
      return { error: 'Failed to complete task' };
    }

    return { task: completed };
  });

  // Member session status routes (protected)
  fastify.get('/api/channels/:channelId/members/status', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);
    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { channelId } = request.params as { channelId: string };

    const members = await postgres.getChannelMembers(channelId);
    if (!members.some(m => m.userId === decoded.userId)) {
      reply.status(403);
      return { error: 'Not a member of this channel' };
    }

    const statuses = await postgres.getMemberSessionStatuses(channelId);
    return { statuses };
  });

  fastify.post('/api/channels/:channelId/members/status', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);
    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { channelId } = request.params as { channelId: string };
    const { remainingRequests, contextWindowUsed, selectedModel } = request.body as {
      remainingRequests?: number;
      contextWindowUsed?: number;
      selectedModel?: string;
    };

    const members = await postgres.getChannelMembers(channelId);
    if (!members.some(m => m.userId === decoded.userId)) {
      reply.status(403);
      return { error: 'Not a member of this channel' };
    }

    const status = await postgres.updateMemberSessionStatus(decoded.userId, channelId, {
      remainingRequests,
      contextWindowUsed,
      selectedModel,
    });

    return { status };
  });

  // Context sharing routes (protected)
  fastify.get('/api/channels/:channelId/context', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);
    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { channelId } = request.params as { channelId: string };

    const members = await postgres.getChannelMembers(channelId);
    if (!members.some(m => m.userId === decoded.userId)) {
      reply.status(403);
      return { error: 'Not a member of this channel' };
    }

    await postgres.deleteExpiredContextShares();
    const shares = await postgres.getContextSharesForChannel(channelId);
    return { shares };
  });

  fastify.get('/api/context/dm/:userId', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const token = authHeader.slice(7);
    const decoded = await authService.verifyToken(token);
    if (!decoded) {
      reply.status(401);
      return { error: 'Invalid token' };
    }

    const { userId } = request.params as { userId: string };

    const peer = await postgres.getUserById(userId);
    if (!peer) {
      reply.status(404);
      return { error: 'User not found' };
    }

    const isMutual = await postgres.checkMutualContact(decoded.userId, userId);
    if (!isMutual) {
      reply.status(403);
      return { error: 'Not a mutual contact' };
    }

    await postgres.deleteExpiredContextShares();
    const shares = await postgres.getContextSharesForDM(decoded.userId, userId);
    return { shares };
  });

  // WebSocket route
  fastify.register(async function (fastify) {
    fastify.get('/ws', { websocket: true }, (socket, req) => {
      const socketId = req.id;
      wsHandler.handleConnection(socket, socketId);
    });
  });

  // Start server
  try {
    await fastify.listen({ port: PORT, host: HOST });
    console.log(`Relay server listening on ${HOST}:${PORT}`);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }

  // Message retention sweeper: purges messages past their channel's (or the
  // server-wide default's) TTL. Runs once at startup, then hourly; sweep
  // failures are logged and retried on the next tick.
  const sweepRetention = async () => {
    try {
      const { channelDeleted, dmDeleted } = await postgres.deleteExpiredMessages(DEFAULT_MESSAGE_RETENTION_MINUTES);
      if (channelDeleted + dmDeleted > 0) {
        console.log(`Retention sweep purged ${channelDeleted} channel and ${dmDeleted} DM messages`);
      }
    } catch (err) {
      console.error('Retention sweep failed:', err);
    }
  };
  void sweepRetention();
  setInterval(sweepRetention, RETENTION_SWEEP_INTERVAL_MS).unref();

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down gracefully...');
    await fastify.close();
    await postgres.close();
    await redis.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nShutting down gracefully...');
    await fastify.close();
    await postgres.close();
    await redis.close();
    process.exit(0);
  });
}

main().catch(console.error);
