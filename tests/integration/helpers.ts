import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocketPlugin from '@fastify/websocket';
import { PostgresStore } from '../../packages/relay-server/src/stores/postgres.js';
import { RedisStore } from '../../packages/relay-server/src/stores/redis.js';
import { AuthService } from '../../packages/relay-server/src/services/auth.js';
import { SessionService } from '../../packages/relay-server/src/services/session.js';
import { PresenceService } from '../../packages/relay-server/src/services/presence.js';
import { RateLimitService } from '../../packages/relay-server/src/services/rate-limit.js';
import { WebSocketHandler } from '../../packages/relay-server/src/websocket/handler.js';

export interface TestEnv {
  fastify: FastifyInstance;
  postgres: PostgresStore;
  redis: RedisStore;
  authService: AuthService;
  pgContainer: StartedPostgreSqlContainer;
  redisContainer: StartedRedisContainer;
  baseUrl: string;
  wsUrl: string;
}

export async function startTestEnv(): Promise<TestEnv> {
  // Start containers in parallel
  const [pgContainer, redisContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);

  const postgres = new PostgresStore(pgContainer.getConnectionUri());
  await postgres.init();

  const redis = new RedisStore(redisContainer.getConnectionUrl());
  const authService = new AuthService(postgres);
  const sessionService = new SessionService(redis, postgres);
  const presenceService = new PresenceService(redis, sessionService);
  const rateLimitService = new RateLimitService(redis);

  const wsHandler = new WebSocketHandler(
    sessionService,
    authService,
    presenceService,
    rateLimitService,
    postgres
  );

  const fastify = Fastify({ logger: false });
  await fastify.register(cors, { origin: true });
  await fastify.register(websocketPlugin);

  // Mount all routes (same as server.ts)
  fastify.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    connections: sessionService.getOnlineUserCount(),
  }));

  fastify.post('/api/auth/register', async (request, reply) => {
    const { username, password, displayName, deviceFingerprint, deviceName } = request.body as any;
    const result = await authService.register(username, password, displayName, deviceFingerprint, deviceName);
    if (!result.success) { reply.status(409); return result; }
    reply.status(201);
    return { success: true, userId: result.user?.id, token: result.token, refreshToken: result.refreshToken, deviceId: result.deviceId };
  });

  fastify.post('/api/auth/login', async (request, reply) => {
    const { username, password, deviceFingerprint, deviceName } = request.body as any;
    const result = await authService.login(username, password, deviceFingerprint, deviceName, request.ip);
    if (!result.success) {
      if (result.verificationRequired) { reply.status(403); return result; }
      reply.status(401);
      return result;
    }
    return result;
  });

  fastify.post('/api/auth/refresh', async (request, reply) => {
    const { refreshToken, deviceFingerprint } = request.body as any;
    if (!refreshToken || !deviceFingerprint) { reply.status(400); return { success: false, error: 'Missing params' }; }
    const result = await authService.refreshToken(refreshToken, deviceFingerprint);
    if (!result.success) { reply.status(401); return result; }
    return result;
  });

  fastify.get('/api/contacts', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = await authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const contacts = await postgres.getContacts(decoded.userId);
    const presences = await presenceService.getBulkPresence(contacts.map((c: any) => c.contactId));
    return { contacts: contacts.map((c: any) => ({ ...c, presence: presences.get(c.contactId) })) };
  });

  fastify.post('/api/contacts', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = await authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { username, customName } = request.body as any;
    const contactUser = await postgres.getUserByUsername(username);
    if (!contactUser) { reply.status(404); return { error: 'User not found' }; }
    const contact = await postgres.addContact(decoded.userId, contactUser.id, customName);
    if (!contact) { reply.status(409); return { error: 'Already a contact' }; }
    reply.status(201);
    return { contact };
  });

  fastify.post('/api/contacts/:contactId/block', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = await authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { contactId } = request.params as any;
    await postgres.blockContact(decoded.userId, contactId, true);
    return { success: true };
  });

  fastify.post('/api/channels', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = await authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { name, displayName, isPublic, channelType, buildPrompt } = request.body as any;
    const existing = await postgres.getChannelByName(name);
    if (existing) { reply.status(409); return { error: 'Channel name already taken' }; }
    const channel = await postgres.createChannel(name, displayName, decoded.userId, isPublic, channelType, buildPrompt);
    await postgres.joinChannel(channel.id, decoded.userId, true);
    reply.status(201);
    return { channel };
  });

  fastify.post('/api/channels/:channelId/join', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = await authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { channelId } = request.params as any;
    const joined = await postgres.joinChannel(channelId, decoded.userId);
    if (!joined) { reply.status(409); return { error: 'Already a member' }; }
    return { success: true };
  });

  fastify.post('/api/channels/:channelId/leave', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = await authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { channelId } = request.params as any;
    const left = await postgres.leaveChannel(channelId, decoded.userId);
    if (!left) { reply.status(404); return { error: 'Not a member' }; }
    return { success: true };
  });

  fastify.post('/api/channels/:channelId/invite', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = await authService.verifyToken(auth.slice(7));
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
    return { success: true };
  });

  fastify.get('/api/channels/:channelId/build/tasks', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = await authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { channelId } = request.params as any;
    const { status, assignedTo } = request.query as any;
    const members = await postgres.getChannelMembers(channelId);
    if (!members.some((m: any) => m.userId === decoded.userId)) {
      reply.status(403); return { error: 'Not a member of this channel' };
    }
    const tasks = await postgres.getBuildTasks(channelId, status, assignedTo);
    return { tasks };
  });

  fastify.post('/api/channels/:channelId/build/tasks', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = await authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { channelId } = request.params as any;
    const { title, description } = request.body as any;
    const channel = await postgres.getChannel(channelId);
    if (!channel) { reply.status(404); return { error: 'Channel not found' }; }
    if (channel.channelType !== 'build') { reply.status(400); return { error: 'Not a build group' }; }
    const members = await postgres.getChannelMembers(channelId);
    if (!members.some((m: any) => m.userId === decoded.userId)) {
      reply.status(403); return { error: 'Not a member of this channel' };
    }
    const task = await postgres.createBuildTask(channelId, decoded.userId, title, description);
    reply.status(201);
    return { task };
  });

  fastify.post('/api/channels/:channelId/build/tasks/:taskId/assign', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = await authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { channelId, taskId } = request.params as any;
    const { username } = request.body as any;
    const channel = await postgres.getChannel(channelId);
    if (!channel) { reply.status(404); return { error: 'Channel not found' }; }
    if (channel.ownerId !== decoded.userId) {
      reply.status(403); return { error: 'Only the build group owner can assign tasks' };
    }
    const task = await postgres.getBuildTaskById(taskId);
    if (!task || task.channelId !== channelId) { reply.status(404); return { error: 'Task not found' }; }
    const targetUser = await postgres.getUserByUsername(username);
    if (!targetUser) { reply.status(404); return { error: 'User not found' }; }
    const members = await postgres.getChannelMembers(channelId);
    if (!members.some((m: any) => m.userId === targetUser.id)) {
      reply.status(403); return { error: 'User is not a member of this channel' };
    }
    const assigned = await postgres.assignBuildTask(taskId, targetUser.id);
    if (!assigned) { reply.status(500); return { error: 'Failed to assign task' }; }
    return { task: assigned };
  });

  fastify.post('/api/channels/:channelId/build/tasks/:taskId/complete', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = await authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { channelId, taskId } = request.params as any;
    const { artifactFilename, artifactSize } = request.body as any;
    const task = await postgres.getBuildTaskById(taskId);
    if (!task || task.channelId !== channelId) { reply.status(404); return { error: 'Task not found' }; }
    const members = await postgres.getChannelMembers(channelId);
    const isMember = members.some((m: any) => m.userId === decoded.userId);
    if (!isMember) { reply.status(403); return { error: 'Not a member of this channel' }; }
    if (task.assignedTo !== decoded.userId && task.ownerId !== decoded.userId) {
      reply.status(403); return { error: 'Only the assigned worker or owner can complete this task' };
    }
    const completed = await postgres.completeBuildTask(taskId, artifactFilename, artifactSize);
    if (!completed) { reply.status(500); return { error: 'Failed to complete task' }; }
    return { task: completed };
  });

  fastify.get('/api/channels/:channelId/members/status', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = await authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { channelId } = request.params as any;
    const members = await postgres.getChannelMembers(channelId);
    if (!members.some((m: any) => m.userId === decoded.userId)) {
      reply.status(403); return { error: 'Not a member of this channel' };
    }
    const statuses = await postgres.getMemberSessionStatuses(channelId);
    return { statuses };
  });

  fastify.post('/api/channels/:channelId/members/status', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = await authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { channelId } = request.params as any;
    const { remainingRequests, contextWindowUsed, selectedModel } = request.body as any;
    const members = await postgres.getChannelMembers(channelId);
    if (!members.some((m: any) => m.userId === decoded.userId)) {
      reply.status(403); return { error: 'Not a member of this channel' };
    }
    const status = await postgres.updateMemberSessionStatus(decoded.userId, channelId, {
      remainingRequests,
      contextWindowUsed,
      selectedModel,
    });
    return { status };
  });

  fastify.get('/api/messages/:contactId', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = await authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { contactId } = request.params as any;
    const { limit } = request.query as any;
    const messages = await postgres.getDMHistory(decoded.userId, contactId, undefined, parseInt(limit || '50'));
    return { messages };
  });

  fastify.register(async function (f) {
    f.get('/ws', { websocket: true }, (socket, req) => {
      wsHandler.handleConnection(socket, req.id);
    });
  });

  await fastify.listen({ port: 0, host: '127.0.0.1' });
  const address = fastify.server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;

  return { fastify, postgres, redis, authService, pgContainer, redisContainer, baseUrl, wsUrl };
}

export async function stopTestEnv(env: TestEnv): Promise<void> {
  await env.fastify.close();
  await env.postgres.close();
  await env.redis.close();
  await env.pgContainer.stop();
  await env.redisContainer.stop();
}

export function post(baseUrl: string, path: string, body: any, token?: string) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

export function get(baseUrl: string, path: string, token?: string) {
  return fetch(`${baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}
