import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { startTestEnv, stopTestEnv, post, get, type TestEnv } from './helpers.js';

async function registerAndConnect(env: TestEnv, username: string) {
  const regRes = await post(env.baseUrl, '/api/auth/register', {
    username,
    password: 'Password1!',
    deviceFingerprint: `fp-${username}`,
    deviceName: `${username} device`,
  });
  const regBody = await regRes.json() as any;
  const token = regBody.token;
  const userId = regBody.userId;

  const ws = new WebSocket(env.wsUrl);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('auth timeout')), 10000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', payload: { token } })));
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'auth_response' && msg.payload.success) { clearTimeout(t); resolve(); }
      if (msg.type === 'auth_response' && !msg.payload.success) { clearTimeout(t); reject(new Error(msg.payload.error)); }
    });
    ws.on('error', reject);
  });

  return { token, ws, userId };
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

describe('Channel flow (integration)', () => {
  let env: TestEnv;
  let alice: { token: string; ws: WebSocket; userId: string };
  let bob: { token: string; ws: WebSocket; userId: string };
  let carol: { token: string; ws: WebSocket; userId: string };
  let channelId: string;

  beforeAll(async () => {
    env = await startTestEnv();
    [alice, bob, carol] = await Promise.all([
      registerAndConnect(env, 'alice_ch'),
      registerAndConnect(env, 'bob_ch'),
      registerAndConnect(env, 'carol_ch'),
    ]);
  }, 120000);

  afterAll(async () => {
    if (alice?.ws) alice.ws.close();
    if (bob?.ws) bob.ws.close();
    if (carol?.ws) carol.ws.close();
    if (env) await stopTestEnv(env);
  });

  it('Alice creates public channel → 201', async () => {
    const res = await post(env.baseUrl, '/api/channels', {
      name: 'test-channel',
      displayName: 'Test Channel',
      isPublic: true,
    }, alice.token);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.channel.name).toBe('test-channel');
    channelId = body.channel.id;
  });

  it('Bob joins channel → 200', async () => {
    const res = await post(env.baseUrl, `/api/channels/${channelId}/join`, {}, bob.token);
    expect(res.status).toBe(200);
  });

  it('Alice sends channel message → bob receives channel_message event', async () => {
    const bobReceives = waitForMessage(bob.ws, 'channel_message');

    alice.ws.send(JSON.stringify({
      type: 'channel_message',
      payload: {
        channelId,
        content: 'Hello channel!',
        isEphemeral: false,
        clientMessageId: 'ch-client-1',
      },
    }));

    const msg = await bobReceives;
    expect(msg.payload.message.content).toBe('Hello channel!');
    expect(msg.payload.message.channelId).toBe(channelId);
  });

  it('Alice invites carol → carol can send', async () => {
    const res = await post(env.baseUrl, `/api/channels/${channelId}/invite`, { username: 'carol_ch' }, alice.token);
    expect(res.status).toBe(200);

    // Carol sends a message - alice should receive it
    const aliceReceives = waitForMessage(alice.ws, 'channel_message');

    carol.ws.send(JSON.stringify({
      type: 'channel_message',
      payload: {
        channelId,
        content: 'Hi everyone!',
        isEphemeral: false,
        clientMessageId: 'ch-carol-1',
      },
    }));

    const msg = await aliceReceives;
    expect(msg.payload.message.content).toBe('Hi everyone!');
  });

  it('Bob leaves channel → no longer receives messages', async () => {
    const leaveRes = await post(env.baseUrl, `/api/channels/${channelId}/leave`, {}, bob.token);
    expect(leaveRes.status).toBe(200);

    // Set up listener for bob - should NOT receive alice's next message
    let bobReceived = false;
    const bobListener = (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'channel_message') {
        bobReceived = true;
      }
    };
    bob.ws.on('message', bobListener);

    // Alice sends a message after bob left
    alice.ws.send(JSON.stringify({
      type: 'channel_message',
      payload: {
        channelId,
        content: 'Bob should not see this',
        isEphemeral: false,
        clientMessageId: 'ch-after-leave',
      },
    }));

    // Wait a bit for any potential delivery
    await new Promise(r => setTimeout(r, 1000));
    bob.ws.off('message', bobListener);

    expect(bobReceived).toBe(false);
  });
});
