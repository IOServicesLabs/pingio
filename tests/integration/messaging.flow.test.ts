import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { startTestEnv, stopTestEnv, post, get, type TestEnv } from './helpers.js';

async function registerAndConnect(env: TestEnv, username: string, password: string) {
  const fp = `fp-${username}`;
  const regRes = await post(env.baseUrl, '/api/auth/register', {
    username,
    password,
    deviceFingerprint: fp,
    deviceName: `${username} device`,
  });
  const regBody = await regRes.json() as any;
  const token = regBody.token;

  const ws = new WebSocket(env.wsUrl);
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

  return { token, ws, userId: regBody.userId };
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

describe('Messaging flow (integration)', () => {
  let env: TestEnv;
  let alice: { token: string; ws: WebSocket; userId: string };
  let bob: { token: string; ws: WebSocket; userId: string };

  beforeAll(async () => {
    env = await startTestEnv();
    [alice, bob] = await Promise.all([
      registerAndConnect(env, 'alice_msg', 'Password1!'),
      registerAndConnect(env, 'bob_msg', 'Password1!'),
    ]);
  }, 120000);

  afterAll(async () => {
    if (alice?.ws) alice.ws.close();
    if (bob?.ws) bob.ws.close();
    if (env) await stopTestEnv(env);
  });

  it('Alice adds bob as contact, bob adds alice', async () => {
    const r1 = await post(env.baseUrl, '/api/contacts', { username: 'bob_msg' }, alice.token);
    expect(r1.status).toBe(201);

    const r2 = await post(env.baseUrl, '/api/contacts', { username: 'alice_msg' }, bob.token);
    expect(r2.status).toBe(201);
  });

  it('Alice sends DM → bob receives it via WebSocket', async () => {
    const bobReceives = waitForMessage(bob.ws, 'message');

    alice.ws.send(JSON.stringify({
      type: 'message',
      payload: {
        recipientId: bob.userId,
        content: 'Hello Bob!',
        isEphemeral: false,
        clientMessageId: 'client-1',
      },
    }));

    const msg = await bobReceives;
    expect(msg.payload.message.content).toBe('Hello Bob!');
  });

  it('Bob sends reply → alice receives it', async () => {
    const aliceReceives = waitForMessage(alice.ws, 'message');

    bob.ws.send(JSON.stringify({
      type: 'message',
      payload: {
        recipientId: alice.userId,
        content: 'Hey Alice!',
        isEphemeral: false,
        clientMessageId: 'client-2',
      },
    }));

    const msg = await aliceReceives;
    expect(msg.payload.message.content).toBe('Hey Alice!');
  });

  it('Alice fetches history → both messages present', async () => {
    const res = await get(env.baseUrl, `/api/messages/${bob.userId}`, alice.token);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.messages.length).toBeGreaterThanOrEqual(2);
  });

  it('Alice edits message → bob receives message_edit event', async () => {
    // First, get alice's sent message ID
    const historyRes = await get(env.baseUrl, `/api/messages/${bob.userId}`, alice.token);
    const { messages } = await historyRes.json() as any;
    const aliceMsg = messages.find((m: any) => m.senderId === alice.userId);
    if (!aliceMsg) return; // Skip if message not found

    const bobReceivesEdit = waitForMessage(bob.ws, 'message_edit');

    alice.ws.send(JSON.stringify({
      type: 'message_edit',
      payload: { messageId: aliceMsg.id, content: 'Hello Bob! (edited)' },
    }));

    const editEvent = await bobReceivesEdit;
    expect(editEvent.payload.message.content).toBe('Hello Bob! (edited)');
  });

  it('Alice deletes message → bob receives message_delete event', async () => {
    // Get alice's message again
    const historyRes = await get(env.baseUrl, `/api/messages/${bob.userId}`, alice.token);
    const { messages } = await historyRes.json() as any;
    const aliceMsg = messages.find((m: any) => m.senderId === alice.userId);
    if (!aliceMsg) return;

    const bobReceivesDelete = waitForMessage(bob.ws, 'message_delete');

    alice.ws.send(JSON.stringify({
      type: 'message_delete',
      payload: { messageId: aliceMsg.id, deleteForEveryone: true },
    }));

    const deleteEvent = await bobReceivesDelete;
    expect(deleteEvent.payload.messageId).toBe(aliceMsg.id);
  });
});
