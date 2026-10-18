#!/usr/bin/env node
import 'dotenv/config';
import Fastify, { FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { AuthService } from './services/auth.js';
import {
  SsoService,
  SsoError,
  renderLoginCodePage,
  renderLoginErrorPage,
} from './services/sso.js';
import { PostgresStore } from './stores/postgres.js';
import { FederationService, FederationError } from './services/federation.js';
import {
  UsernameSchema,
  PasswordSchema,
  DisplayNameSchema,
} from '@pingio/shared';

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ISSUER = process.env.ISSUER || `http://localhost:${PORT}`;
const AUDIENCE = process.env.AUDIENCE || 'pingio-relay';
const RELAY_ID = process.env.RELAY_ID;
const RELAY_URL = process.env.RELAY_URL || 'ws://localhost:3000/ws';

async function main() {
  const postgres = new PostgresStore();
  await postgres.init();
  console.log('Auth server PostgreSQL connected');

  const authService = new AuthService(postgres, ISSUER, AUDIENCE, RELAY_ID);
  await authService.init();
  console.log('Auth service initialized');

  // Enterprise SSO providers (OIDC clients) — invalid config fails boot fast.
  const ssoService = new SsoService(
    postgres,
    authService,
    ISSUER,
    SsoService.parseProviders(process.env.SSO_PROVIDERS)
  );
  if (ssoService.listProviders().length > 0) {
    console.log(
      `SSO providers: ${ssoService.listProviders().map(p => `${p.slug} (${p.name})`).join(', ')}`
    );
  }

  // Federation control plane: relay node registry + network version policy.
  const federationService = new FederationService(postgres, authService, {
    bootstrapToken: process.env.FEDERATION_BOOTSTRAP_TOKEN,
    adminToken: process.env.FEDERATION_ADMIN_TOKEN,
  });
  if (!process.env.FEDERATION_BOOTSTRAP_TOKEN) {
    console.log(
      'WARNING: FEDERATION_BOOTSTRAP_TOKEN unset — relay node registration is OPEN to anyone'
    );
  }

  const fastify = Fastify({
    logger: process.env.NODE_ENV === 'development',
    trustProxy: process.env.TRUST_PROXY === 'true',
  });

  await fastify.register(cors, {
    origin: process.env.CORS_ORIGIN === 'false' ? false : process.env.CORS_ORIGIN || true,
    credentials: true,
  });

  fastify.get('/health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      issuer: ISSUER,
      audience: AUDIENCE,
    };
  });

  fastify.get('/.well-known/jwks.json', async () => {
    return await authService.getJwks();
  });

  fastify.get('/.well-known/openid-configuration', async () => {
    return {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      token_introspection_endpoint: `${ISSUER}/oauth/token/introspect`,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`,
      response_types_supported: ['token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
    };
  });

  fastify.get('/.well-known/pingio', async () => {
    return {
      relay_id: RELAY_ID || null,
      relay_url: RELAY_URL,
      auth_issuer: ISSUER,
      federation_enabled: true,
      // Pool of registered relays clients may use for failover / load spread.
      // relay_url above remains the canonical primary.
      relays: await federationService.listPublicNodes(),
    };
  });

  // ---- Federation: node registry + version policy ----

  fastify.post('/api/federation/register', async (request, reply) => {
    const body = request.body as {
      name?: string;
      baseUrl?: string;
      wsUrl?: string;
      operator?: string;
      version?: string;
      bootstrapToken?: string;
    };

    try {
      const result = await federationService.register({
        name: body.name || '',
        baseUrl: body.baseUrl || '',
        wsUrl: body.wsUrl || '',
        operator: body.operator,
        version: body.version,
        bootstrapToken: body.bootstrapToken,
      });
      return { success: true, ...result };
    } catch (error) {
      if (error instanceof FederationError) {
        reply.status(
          error.code === 'duplicate_base_url' ? 409
          : error.code === 'invalid_bootstrap_token' ? 403
          : error.code === 'bootstrap_required' ? 401
          : 400
        );
        return { success: false, error: error.message, code: error.code };
      }
      throw error;
    }
  });

  fastify.post('/api/federation/heartbeat', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401);
      return { success: false, error: 'Node credential required' };
    }
    const body = (request.body || {}) as { version?: string };

    try {
      const result = await federationService.heartbeat(authHeader.slice(7), body.version);
      return { success: true, ...result };
    } catch (error) {
      if (error instanceof FederationError) {
        reply.status(error.code === 'unknown_node' ? 403 : 400);
        return { success: false, error: error.message, code: error.code };
      }
      throw error;
    }
  });

  fastify.get('/api/federation/relays', async () => {
    return { relays: await federationService.listPublicNodes() };
  });

  fastify.get('/api/federation/manifest/:component', async (request, reply) => {
    const { component } = request.params as { component: string };
    const policy = await federationService.getPolicy(component);
    if (!policy || !policy.manifest) {
      reply.status(404);
      return { success: false, error: 'No manifest published for this component' };
    }
    return {
      component: policy.component,
      currentVersion: policy.currentVersion,
      minSupportedVersion: policy.minSupportedVersion,
      graceEndsAt: policy.graceEndsAt?.toISOString(),
      manifest: policy.manifest,
    };
  });

  // ---- Federation admin (FEDERATION_ADMIN_TOKEN bearer) ----

  async function authenticateFederationAdmin(request: FastifyRequest, reply: import('fastify').FastifyReply): Promise<boolean> {
    const authHeader = request.headers.authorization;
    try {
      federationService.assertAdmin(authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined);
      return true;
    } catch (error) {
      if (error instanceof FederationError) {
        reply.status(error.code === 'invalid_bootstrap_token' ? 403 : 503);
        reply.send({ success: false, error: error.message });
        return false;
      }
      throw error;
    }
  }

  fastify.put('/api/federation/policy/:component', async (request, reply) => {
    if (!(await authenticateFederationAdmin(request, reply))) return;
    const { component } = request.params as { component: string };
    const body = request.body as {
      currentVersion?: string;
      minSupportedVersion?: string;
      graceHours?: number;
      artifactUrl?: string;
      artifactSha256?: string;
    };

    try {
      const policy = await federationService.setPolicy({
        component,
        currentVersion: body.currentVersion || '',
        minSupportedVersion: body.minSupportedVersion || '',
        graceHours: body.graceHours,
        artifactUrl: body.artifactUrl || '',
        artifactSha256: body.artifactSha256 || '',
      });
      return { success: true, policy };
    } catch (error) {
      if (error instanceof FederationError) {
        reply.status(400);
        return { success: false, error: error.message, code: error.code };
      }
      throw error;
    }
  });

  fastify.get('/api/federation/nodes', async (request, reply) => {
    if (!(await authenticateFederationAdmin(request, reply))) return;
    return { nodes: await federationService.listAllNodes() };
  });

  fastify.post('/api/federation/nodes/:id/decommission', async (request, reply) => {
    if (!(await authenticateFederationAdmin(request, reply))) return;
    const { id } = request.params as { id: string };
    const body = (request.body || {}) as { reason?: string };
    try {
      await federationService.decommissionNode(id, body.reason);
      return { success: true };
    } catch (error) {
      if (error instanceof FederationError) {
        reply.status(404);
        return { success: false, error: error.message, code: error.code };
      }
      throw error;
    }
  });

  fastify.post('/api/federation/nodes/:id/reactivate', async (request, reply) => {
    if (!(await authenticateFederationAdmin(request, reply))) return;
    const { id } = request.params as { id: string };
    try {
      await federationService.reactivateNode(id);
      return { success: true };
    } catch (error) {
      if (error instanceof FederationError) {
        reply.status(404);
        return { success: false, error: error.message, code: error.code };
      }
      throw error;
    }
  });


  fastify.post('/oauth/register', async (request, reply) => {
    const body = request.body as {
      username: string;
      password: string;
      displayName?: string;
      deviceFingerprint?: string;
      deviceName?: string;
    };

    const usernameResult = UsernameSchema.safeParse(body.username);
    if (!usernameResult.success) {
      reply.status(400);
      return { success: false, error: usernameResult.error.errors[0]?.message };
    }

    const passwordResult = PasswordSchema.safeParse(body.password);
    if (!passwordResult.success) {
      reply.status(400);
      return { success: false, error: passwordResult.error.errors[0]?.message };
    }

    const displayNameResult = DisplayNameSchema.safeParse(body.displayName);
    if (body.displayName && !displayNameResult.success) {
      reply.status(400);
      return { success: false, error: displayNameResult.error.errors[0]?.message };
    }

    const result = await authService.register(
      usernameResult.data,
      passwordResult.data,
      displayNameResult.data,
      body.deviceFingerprint,
      body.deviceName
    );

    if (!result.success) {
      reply.status(result.suggestions ? 409 : 400);
      return {
        success: false,
        error: result.error,
        suggestions: result.suggestions,
        verificationRequired: result.verificationRequired,
        deviceId: result.deviceId,
      };
    }

    return {
      success: true,
      userId: result.user?.id,
      token: result.token,
      refreshToken: result.refreshToken,
      deviceId: result.deviceId,
      // Include the user object — self-hosted relays return it and MCP
      // clients expect it; without it login reports "incomplete response".
      user: result.user,
    };
  });

  fastify.post('/oauth/login', async (request, reply) => {
    const body = request.body as {
      username: string;
      password: string;
      deviceFingerprint?: string;
      deviceName?: string;
    };

    if (!body.username || !body.password) {
      reply.status(400);
      return { success: false, error: 'Username and password are required' };
    }

    const ipAddress = request.ip;
    const result = await authService.login(
      body.username,
      body.password,
      body.deviceFingerprint,
      body.deviceName,
      ipAddress
    );

    if (!result.success) {
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
      return { success: false, error: result.error };
    }

    return {
      success: true,
      userId: result.user?.id,
      token: result.token,
      refreshToken: result.refreshToken,
      deviceId: result.deviceId,
      // Include the user object — self-hosted relays return it and MCP
      // clients expect it; without it login reports "incomplete response".
      user: result.user,
    };
  });

  fastify.post('/oauth/refresh', async (request, reply) => {
    const body = request.body as { refreshToken: string; deviceFingerprint: string };

    if (!body.refreshToken || !body.deviceFingerprint) {
      reply.status(400);
      return { success: false, error: 'Refresh token and device fingerprint are required' };
    }

    const result = await authService.refreshToken(body.refreshToken, body.deviceFingerprint);

    if (!result.success) {
      reply.status(401);
      return { success: false, error: result.error };
    }

    return {
      success: true,
      token: result.token,
      refreshToken: result.refreshToken,
      deviceId: result.deviceId,
    };
  });

  fastify.post('/oauth/token/introspect', async (request, reply) => {
    const body = request.body as { token: string };
    if (!body.token) {
      reply.status(400);
      return { active: false, error: 'Token is required' };
    }
    return await authService.introspectToken(body.token);
  });

  // ---- Enterprise SSO (upstream OIDC providers) ----

  fastify.get('/oauth/sso/providers', async () => {
    return { providers: ssoService.listProviders() };
  });

  fastify.post('/oauth/sso/start', async (request, reply) => {
    const body = request.body as { slug?: string };
    if (!body.slug || typeof body.slug !== 'string') {
      reply.status(400);
      return { success: false, error: 'Provider slug is required' };
    }

    try {
      const { authorizeUrl, expiresAt } = await ssoService.startLogin(body.slug);
      return { success: true, authorizeUrl, expiresAt: expiresAt.toISOString() };
    } catch (error) {
      if (error instanceof SsoError) {
        reply.status(error.code === 'unknown_provider' ? 404 : 502);
        return { success: false, error: error.message, code: error.code };
      }
      throw error;
    }
  });

  fastify.get('/oauth/sso/:slug/callback', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const query = request.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };

    reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
    reply.type('text/html');

    try {
      const result = await ssoService.handleCallback(slug, query);
      return renderLoginCodePage(result.code, result.username, result.expiresAt);
    } catch (error) {
      if (error instanceof SsoError) {
        reply.status(error.code === 'unknown_provider' ? 404 : 400);
        return renderLoginErrorPage(error.message);
      }
      request.log.error(error, 'SSO callback failed');
      reply.status(500);
      return renderLoginErrorPage('An unexpected error occurred during SSO login');
    }
  });

  fastify.post('/oauth/sso/complete', async (request, reply) => {
    const body = request.body as {
      code?: string;
      deviceFingerprint?: string;
      deviceName?: string;
    };
    if (!body.code || typeof body.code !== 'string') {
      reply.status(400);
      return { success: false, error: 'Login code is required' };
    }

    const result = await ssoService.completeLogin(
      body.code,
      body.deviceFingerprint,
      body.deviceName,
      request.ip
    );

    if (!result.success) {
      reply.status(401);
      return { success: false, error: result.error };
    }

    return {
      success: true,
      userId: result.user?.id,
      username: result.user?.username,
      token: result.token,
      refreshToken: result.refreshToken,
      deviceId: result.deviceId,
    };
  });

  // Device endpoints (protected)
  async function authenticate(request: FastifyRequest): Promise<{
    userId: string;
    username: string;
    deviceId?: string;
  } | null> {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7);
    const introspection = await authService.introspectToken(token);
    if (!introspection.active || !introspection.sub) return null;
    return {
      userId: introspection.sub,
      username: introspection.username || '',
      deviceId: introspection.device_id,
    };
  }

  fastify.get('/oauth/devices', async (request, reply) => {
    const user = await authenticate(request);
    if (!user) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }
    const devices = await authService.listDevices(user.userId, user.deviceId);
    return { success: true, devices };
  });

  fastify.post('/oauth/devices/verify', async (request, reply) => {
    const user = await authenticate(request);
    if (!user) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }
    const { deviceId } = request.body as { deviceId: string };
    if (!deviceId) {
      reply.status(400);
      return { success: false, error: 'Missing deviceId' };
    }
    const result = await authService.verifyDevice(user.userId, deviceId);
    if (!result.success) {
      reply.status(400);
      return result;
    }
    return { success: true };
  });

  fastify.post('/oauth/devices/revoke', async (request, reply) => {
    const user = await authenticate(request);
    if (!user) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }
    const { deviceId } = request.body as { deviceId: string };
    if (!deviceId) {
      reply.status(400);
      return { success: false, error: 'Missing deviceId' };
    }
    const result = await authService.revokeDevice(user.userId, deviceId);
    if (!result.success) {
      reply.status(400);
      return result;
    }
    return { success: true };
  });

  try {
    await fastify.listen({ port: PORT, host: HOST });
    console.log(`Auth server listening on ${HOST}:${PORT}`);
  } catch (err) {
    console.error('Failed to start auth server:', err);
    process.exit(1);
  }

  process.on('SIGINT', async () => {
    console.log('\nShutting down auth server gracefully...');
    await fastify.close();
    await postgres.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nShutting down auth server gracefully...');
    await fastify.close();
    await postgres.close();
    process.exit(0);
  });
}

main();
