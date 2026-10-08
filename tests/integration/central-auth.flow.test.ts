import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocketPlugin from '@fastify/websocket';
import { PostgresStore as AuthPostgresStore } from '../../packages/auth-server/src/stores/postgres.js';
import { AuthService as CentralAuthService } from '../../packages/auth-server/src/services/auth.js';
import { PostgresStore as RelayPostgresStore } from '../../packages/relay-server/src/stores/postgres.js';
import { RedisStore } from '../../packages/relay-server/src/stores/redis.js';
import { AuthService as RelayAuthService } from '../../packages/relay-server/src/services/auth.js';
import { SessionService } from '../../packages/relay-server/src/services/session.js';
import { PresenceService } from '../../packages/relay-server/src/services/presence.js';
import { RateLimitService } from '../../packages/relay-server/src/services/rate-limit.js';
import { WebSocketHandler } from '../../packages/relay-server/src/websocket/handler.js';

interface CentralAuthEnv {
  fastify: FastifyInstance;
  postgres: AuthPostgresStore;
  authService: CentralAuthService;
  baseUrl: string;
}

interface RelayEnv {
  fastify: FastifyInstance;
  postgres: RelayPostgresStore;
  redis: RedisStore;
  baseUrl: string;
  wsUrl: string;
}

interface TestEnv {
  auth: CentralAuthEnv;
  relay: RelayEnv;
  pgContainer: StartedPostgreSqlContainer;
  redisContainer: StartedRedisContainer;
}

async function startAuthServer(pgContainer: StartedPostgreSqlContainer): Promise<CentralAuthEnv> {
  const postgres = new AuthPostgresStore(pgContainer.getConnectionUri());
  await postgres.init();

  const fastify = Fastify({ logger: false });
  await fastify.register(cors, { origin: true });

  let authService: CentralAuthService;
  let baseUrl = '';

  fastify.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  fastify.get('/.well-known/jwks.json', async () => authService.getJwks());

  fastify.get('/.well-known/openid-configuration', async () => {
    return {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      token_introspection_endpoint: `${baseUrl}/oauth/token/introspect`,
      jwks_uri: `${baseUrl}/.well-known/jwks.json`,
      response_types_supported: ['token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
    };
  });

  fastify.post('/oauth/register', async (request, reply) => {
    const { username, password, displayName, deviceFingerprint, deviceName } = request.body as any;

    const result = await authService.register(
      username,
      password,
      displayName,
      deviceFingerprint,
      deviceName
    );

    if (!result.success) {
      reply.status(result.suggestions ? 409 : 400);
      return { success: false, error: result.error, suggestions: result.suggestions };
    }

    reply.status(201);
    return {
      success: true,
      userId: result.user?.id,
      token: result.token,
      refreshToken: result.refreshToken,
      deviceId: result.deviceId,
    };
  });

  fastify.post('/oauth/token/introspect', async (request, reply) => {
    const { token } = request.body as { token: string };
    if (!token) {
      reply.status(400);
      return { active: false, error: 'Token is required' };
    }
    return await authService.introspectToken(token);
  });

  await fastify.listen({ port: 0, host: '127.0.0.1' });
  const address = fastify.server.address() as any;
  baseUrl = `http://127.0.0.1:${address.port}`;

  authService = new CentralAuthService(
    postgres,
    baseUrl,
    'pingio-relay'
  );
  await authService.init();

  return { fastify, postgres, authService, baseUrl };
}

async function startRelayServer(
  pgContainer: StartedPostgreSqlContainer,
  redisContainer: StartedRedisContainer,
  authIssuer: string
): Promise<RelayEnv> {
  const connectionUri = pgContainer.getConnectionUri();
  // Use a separate logical database on the same Postgres instance to avoid schema conflicts
  const relayDbUri = connectionUri.replace(/\/(\w+)$/, '/pingio_relay');
  // Ensure the database exists
  const tempPool = new (await import('pg')).Pool({ connectionString: connectionUri });
  await tempPool.query('CREATE DATABASE pingio_relay');
  await tempPool.end();

  const postgres = new RelayPostgresStore(relayDbUri);
  await postgres.init();

  const redis = new RedisStore(redisContainer.getConnectionUrl());
  const authService = new RelayAuthService(postgres, { mode: 'central', issuer: authIssuer, audience: 'pingio-relay' });
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

  fastify.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    connections: sessionService.getOnlineUserCount(),
    authMode: authService.getMode(),
  }));

  fastify.get('/api/channels', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = await authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const channels = await postgres.getUserChannels(decoded.userId);
    return { channels };
  });

  fastify.post('/api/channels', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = await authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { name, displayName, isPublic } = request.body as any;
    const existing = await postgres.getChannelByName(name);
    if (existing) { reply.status(409); return { error: 'Channel name already taken' }; }
    const channel = await postgres.createChannel(name, displayName, decoded.userId, isPublic);
    await postgres.joinChannel(channel.id, decoded.userId, true);
    reply.status(201);
    return { channel };
  });

  fastify.get('/api/channels/:channelId/messages', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { reply.status(401); return { error: 'Unauthorized' }; }
    const decoded = await authService.verifyToken(auth.slice(7));
    if (!decoded) { reply.status(401); return { error: 'Invalid token' }; }
    const { channelId } = request.params as any;
    const members = await postgres.getChannelMembers(channelId);
    const isMember = members.some((m: any) => m.userId === decoded.userId);
    if (!isMember) { reply.status(403); return { error: 'Not a member' }; }
    const messages = await postgres.getChannelHistory(channelId, undefined, 50);
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

  return { fastify, postgres, redis, baseUrl, wsUrl };
}

async function stopAuthEnv(env: CentralAuthEnv): Promise<void> {
  await env.fastify.close();
  await env.postgres.close();
}

async function stopRelayEnv(env: RelayEnv): Promise<void> {
  await env.fastify.close();
  await env.postgres.close();
  await env.redis.close();
}

function post(baseUrl: string, path: string, body: any, token?: string) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function waitForMessage(ws: WebSocket, type: string, timeoutMs = 10000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
    const handler = (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === type) {
        clearTimeout(t);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

describe('Central auth flow (integration)', () => {
  let env: TestEnv;

  beforeAll(async () => {
    const [pgContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:16-alpine').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);

    const auth = await startAuthServer(pgContainer);
    const relay = await startRelayServer(pgContainer, redisContainer, auth.baseUrl);

    env = { auth, relay, pgContainer, redisContainer };
  }, 120000);

  afterAll(async () => {
    if (env) {
      await stopRelayEnv(env.relay);
      await stopAuthEnv(env.auth);
      await env.pgContainer.stop();
      await env.redisContainer.stop();
    }
  });

  it('Register user on auth server → 201 with access token', async () => {
    const res = await post(env.auth.baseUrl, '/oauth/register', {
      username: 'alice_central',
      password: 'Password1!',
      displayName: 'Alice Central',
      deviceFingerprint: 'fp-alice-central',
      deviceName: 'Alice Device',
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.token).toBeTruthy();
    expect(body.userId).toBeTruthy();
  });

  it('Connect relay WebSocket with central auth token → auth_response success', async () => {
    const regRes = await post(env.auth.baseUrl, '/oauth/register', {
      username: 'bob_central',
      password: 'Password1!',
      deviceFingerprint: 'fp-bob-central',
      deviceName: 'Bob Device',
    });
    const { token } = await regRes.json() as any;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(env.relay.wsUrl);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Timeout waiting for auth_response'));
      }, 10000);

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', payload: { token } }));
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'auth_response') {
          clearTimeout(timeout);
          ws.close();
          expect(msg.payload.success).toBe(true);
          resolve();
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  });

  it('Relay health check reports central auth mode', async () => {
    const res = await fetch(`${env.relay.baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.authMode).toBe('central');
  });

  it('Create channel via relay REST with central token, then send message via WS and read back via REST', async () => {
    // Register carol on auth server
    const regRes = await post(env.auth.baseUrl, '/oauth/register', {
      username: 'carol_central',
      password: 'Password1!',
      deviceFingerprint: 'fp-carol-central',
      deviceName: 'Carol Device',
    });
    const { token, userId } = await regRes.json() as any;

    // Connect WebSocket to relay
    const ws = new WebSocket(env.relay.wsUrl);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('auth timeout')), 10000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', payload: { token } })));
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'auth_response' && msg.payload.success) { clearTimeout(t); resolve(); }
        if (msg.type === 'auth_response' && !msg.payload.success) { clearTimeout(t); reject(new Error(msg.payload.error)); }
      });
      ws.on('error', reject);
    });

    // Create channel via REST
    const createRes = await post(env.relay.baseUrl, '/api/channels', {
      name: 'central-test-channel',
      displayName: 'Central Test Channel',
      isPublic: true,
    }, token);
    expect(createRes.status).toBe(201);
    const { channel } = await createRes.json() as any;
    expect(channel.id).toBeTruthy();

    // Send channel message via WebSocket
    ws.send(JSON.stringify({
      type: 'channel_message',
      payload: {
        channelId: channel.id,
        content: 'Hello from central auth!',
        isEphemeral: false,
        clientMessageId: 'central-client-1',
      },
    }));

    // Give the relay a moment to process the message
    await new Promise(r => setTimeout(r, 500));

    // Read back via REST history
    const historyRes = await fetch(`${env.relay.baseUrl}/api/channels/${channel.id}/messages`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(historyRes.status).toBe(200);
    const { messages } = await historyRes.json() as any;
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages.some((m: any) => m.content === 'Hello from central auth!')).toBe(true);

    ws.close();
  });

  it('Bad token on relay WebSocket → auth_response error', async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(env.relay.wsUrl);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Timeout waiting for auth_response'));
      }, 10000);

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', payload: { token: 'invalid-token' } }));
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'auth_response') {
          clearTimeout(timeout);
          ws.close();
          expect(msg.payload.success).toBe(false);
          resolve();
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  });
});
