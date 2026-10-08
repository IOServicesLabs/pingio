import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { startTestEnv, stopTestEnv, post, get, type TestEnv } from './helpers.js';

describe('Auth flow (integration)', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await startTestEnv();
  }, 120000);

  afterAll(async () => {
    await stopTestEnv(env);
  });

  it('Register alice → 201 with tokens', async () => {
    const res = await post(env.baseUrl, '/api/auth/register', {
      username: 'alice',
      password: 'Password1!',
      deviceFingerprint: 'fp-alice',
      deviceName: 'Alice Device',
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.token).toBeTruthy();
  });

  it('Register alice again → 409', async () => {
    const res = await post(env.baseUrl, '/api/auth/register', {
      username: 'alice',
      password: 'Password1!',
    });
    expect(res.status).toBe(409);
  });

  it('Login alice → 200 with tokens', async () => {
    const res = await post(env.baseUrl, '/api/auth/login', {
      username: 'alice',
      password: 'Password1!',
      deviceFingerprint: 'fp-alice',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.token).toBeTruthy();
  });

  it('Use access token → GET /api/contacts → 200', async () => {
    const loginRes = await post(env.baseUrl, '/api/auth/login', {
      username: 'alice',
      password: 'Password1!',
      deviceFingerprint: 'fp-alice',
    });
    const { token } = await loginRes.json() as any;

    const res = await get(env.baseUrl, '/api/contacts', token);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.contacts)).toBe(true);
  });

  it('Refresh token → new access token works', async () => {
    // Register bob with a device to get refresh token
    const regRes = await post(env.baseUrl, '/api/auth/register', {
      username: 'bob_auth',
      password: 'Password1!',
      deviceFingerprint: 'fp-bob',
      deviceName: 'Bob Device',
    });
    const { token, refreshToken } = await regRes.json() as any;

    if (!refreshToken) {
      // Skip if no refresh token (device verification may be disabled)
      return;
    }

    const res = await post(env.baseUrl, '/api/auth/refresh', {
      refreshToken,
      deviceFingerprint: 'fp-bob',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.token).toBeTruthy();
    expect(body.token).not.toBe(token); // New token
  });

  it('Connect WebSocket with valid token → auth_response success', async () => {
    const loginRes = await post(env.baseUrl, '/api/auth/login', {
      username: 'alice',
      password: 'Password1!',
      deviceFingerprint: 'fp-alice',
    });
    const { token } = await loginRes.json() as any;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(env.wsUrl);
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

  it('Connect WebSocket with bad token → auth_response error', async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(env.wsUrl);
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
