import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { startTestEnv, stopTestEnv, post, type TestEnv } from './helpers.js';

async function openAuthWs(env: TestEnv, username: string, password: string) {
  const fp = `fp-${username}`;
  const regRes = await post(env.baseUrl, '/api/auth/register', {
    username,
    password,
    deviceFingerprint: fp,
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

describe('Build group flow (integration)', () => {
  let env: TestEnv;
  let owner: { token: string; ws: WebSocket; userId: string };
  let worker: { token: string; ws: WebSocket; userId: string };
  let attacker: { token: string; ws: WebSocket; userId: string };
  let channelId: string;
  let taskId: string;

  beforeAll(async () => {
    env = await startTestEnv();
    [owner, worker, attacker] = await Promise.all([
      openAuthWs(env, 'owner_bg', 'Password1!'),
      openAuthWs(env, 'worker_bg', 'Password1!'),
      openAuthWs(env, 'attacker_bg', 'Password1!'),
    ]);
  }, 120000);

  afterAll(async () => {
    if (owner?.ws) owner.ws.close();
    if (worker?.ws) worker.ws.close();
    if (attacker?.ws) attacker.ws.close();
    if (env) await stopTestEnv(env);
  });

  it('routes task/artifact/status/clear messages between owner and worker sessions', async () => {
    // 1. Owner creates a build group channel
    const createRes = await post(env.baseUrl, '/api/channels', {
      name: 'build-group-1',
      displayName: 'Build Group 1',
      isPublic: false,
      channelType: 'build',
      buildPrompt: 'Build a test artifact',
    }, owner.token);
    expect(createRes.status).toBe(201);
    const createBody = await createRes.json() as any;
    expect(createBody.channel.channelType).toBe('build');
    channelId = createBody.channel.id;

    // 2. Owner invites worker via REST API
    const inviteRes = await post(env.baseUrl, `/api/channels/${channelId}/invite`, { username: 'worker_bg' }, owner.token);
    expect(inviteRes.status).toBe(200);

    // 3. Owner creates a build task via REST API
    const taskRes = await post(env.baseUrl, `/api/channels/${channelId}/build/tasks`, {
      title: 'Test build task',
      description: 'Build something useful',
    }, owner.token);
    expect(taskRes.status).toBe(201);
    const taskBody = await taskRes.json() as any;
    taskId = taskBody.task.id;
    expect(taskBody.task.status).toBe('pending');

    // 4. Owner assigns the task to the worker via WebSocket (broadcasts build_task_assign)
    const workerAssignMsg = waitForMessage(worker.ws, 'build_task_assign');

    owner.ws.send(JSON.stringify({
      type: 'build_task_assign',
      payload: {
        channelId,
        taskId,
        assignedTo: worker.userId,
        status: 'assigned',
        title: 'Test build task',
      },
    }));

    const assignMsg = await workerAssignMsg;
    expect(assignMsg.payload.taskId).toBe(taskId);
    expect(assignMsg.payload.assignedTo).toBe(worker.userId);

    // 5. Worker sends build_task_complete via WebSocket with artifact metadata
    const ownerCompleteMsg = waitForMessage(owner.ws, 'build_task_complete');

    worker.ws.send(JSON.stringify({
      type: 'build_task_complete',
      payload: {
        channelId,
        taskId,
        artifactFilename: 'artifact.zip',
        artifactSize: 1024,
        status: 'completed',
        title: 'Test build task',
      },
    }));

    const completeMsg = await ownerCompleteMsg;
    expect(completeMsg.payload.taskId).toBe(taskId);
    expect(completeMsg.payload.status).toBe('completed');
    expect(completeMsg.payload.artifactFilename).toBe('artifact.zip');
    expect(completeMsg.payload.artifactSize).toBe(1024);

    // 7. Owner sends build_artifact_request, worker responds with build_artifact_payload
    const workerArtifactRequest = waitForMessage(worker.ws, 'build_artifact_request');

    owner.ws.send(JSON.stringify({
      type: 'build_artifact_request',
      payload: { channelId, taskId },
    }));

    const artifactRequest = await workerArtifactRequest;
    expect(artifactRequest.payload.taskId).toBe(taskId);

    const ownerArtifactPayload = waitForMessage(owner.ws, 'build_artifact_payload');

    worker.ws.send(JSON.stringify({
      type: 'build_artifact_payload',
      payload: {
        channelId,
        taskId,
        filename: 'artifact.zip',
        data: 'UEsDBBQAAAAA',
      },
    }));

    const artifactPayload = await ownerArtifactPayload;
    expect(artifactPayload.payload.taskId).toBe(taskId);
    expect(artifactPayload.payload.filename).toBe('artifact.zip');
    expect(artifactPayload.payload.data).toBe('UEsDBBQAAAAA');
    expect(artifactPayload.payload.workerId).toBe(worker.userId);

    // 8. Owner sends build_artifact_clear_request, worker responds with build_artifact_cleared
    const workerArtifactClearRequest = waitForMessage(worker.ws, 'build_artifact_clear_request');

    owner.ws.send(JSON.stringify({
      type: 'build_artifact_clear_request',
      payload: { channelId, taskId },
    }));

    const clearRequest = await workerArtifactClearRequest;
    expect(clearRequest.payload.taskId).toBe(taskId);

    const ownerArtifactCleared = waitForMessage(owner.ws, 'build_artifact_cleared');

    worker.ws.send(JSON.stringify({
      type: 'build_artifact_cleared',
      payload: { channelId, taskId },
    }));

    const artifactCleared = await ownerArtifactCleared;
    expect(artifactCleared.payload.taskId).toBe(taskId);
    expect(artifactCleared.payload.workerId).toBe(worker.userId);

    // 9. Test context clearing: owner sends context_clear_request targeting worker
    const workerContextClear = waitForMessage(worker.ws, 'context_clear_request');

    owner.ws.send(JSON.stringify({
      type: 'context_clear_request',
      payload: { channelId, taskId, targetUsername: 'worker_bg' },
    }));

    const contextClear = await workerContextClear;
    expect(contextClear.payload.channelId).toBe(channelId);
    expect(contextClear.payload.taskId).toBe(taskId);
    expect(contextClear.payload.targetUsername).toBe('worker_bg');

    // Worker sends context_clear_ack
    const ownerContextClearAck = waitForMessage(owner.ws, 'context_clear_ack');

    worker.ws.send(JSON.stringify({
      type: 'context_clear_ack',
      payload: { channelId, taskId },
    }));

    const contextClearAck = await ownerContextClearAck;
    expect(contextClearAck.payload.channelId).toBe(channelId);
    expect(contextClearAck.payload.taskId).toBe(taskId);
    expect(contextClearAck.payload.userId).toBe(worker.userId);

    // 10. Test session status: worker sends session_status_report, owner receives it
    const ownerStatusReport = waitForMessage(owner.ws, 'session_status_report');

    worker.ws.send(JSON.stringify({
      type: 'session_status_report',
      payload: {
        channelId,
        remainingRequests: 42,
        contextWindowUsed: 0.75,
        selectedModel: 'claude-sonnet-4',
      },
    }));

    const statusReport = await ownerStatusReport;
    expect(statusReport.payload.channelId).toBe(channelId);
    expect(statusReport.payload.userId).toBe(worker.userId);
    expect(statusReport.payload.remainingRequests).toBe(42);
    expect(statusReport.payload.contextWindowUsed).toBe(0.75);
    expect(statusReport.payload.selectedModel).toBe('claude-sonnet-4');
  }, 60000);

  it('rejects spoofed, traversal, and non-owner artifact traffic across sessions', async () => {
    // Attacker is a real, authenticated member of the build group — but is NOT
    // the assigned worker for the task.
    const inviteRes = await post(env.baseUrl, `/api/channels/${channelId}/invite`, { username: 'attacker_bg' }, owner.token);
    expect(inviteRes.status).toBe(200);

    // Track any artifact payload the owner receives during this test.
    let ownerGotPayload = false;
    const ownerPayloadFlag = (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'build_artifact_payload') ownerGotPayload = true;
    };
    owner.ws.on('message', ownerPayloadFlag);

    // 1. Spoof: a non-assignee member cannot deliver an artifact to the owner.
    const attackerError = waitForMessage(attacker.ws, 'message_error');
    attacker.ws.send(JSON.stringify({
      type: 'build_artifact_payload',
      payload: { channelId, taskId, filename: 'artifact.zip', data: 'UEsDBBQAAAAA' },
    }));
    const err = await attackerError;
    expect(err.payload.message).toContain('assigned worker');
    await new Promise((r) => setTimeout(r, 200));
    expect(ownerGotPayload).toBe(false);

    // 2. Path traversal: even the legitimate worker cannot escape the task dir —
    //    the relay rejects the filename at the schema boundary, so nothing is
    //    forwarded to the owner.
    ownerGotPayload = false;
    worker.ws.send(JSON.stringify({
      type: 'build_artifact_payload',
      payload: { channelId, taskId, filename: '../../evil.txt', data: 'UEsDBBQAAAAA' },
    }));
    await new Promise((r) => setTimeout(r, 300));
    expect(ownerGotPayload).toBe(false);

    owner.ws.off('message', ownerPayloadFlag);

    // 3. A non-owner member cannot pull the worker's artifact.
    const attackerReqError = waitForMessage(attacker.ws, 'message_error');
    attacker.ws.send(JSON.stringify({
      type: 'build_artifact_request',
      payload: { channelId, taskId },
    }));
    const reqErr = await attackerReqError;
    expect(reqErr.payload.message).toContain('owner');

    // 4. Sanity: the assigned worker CAN still deliver a well-formed artifact.
    const ownerPayload = waitForMessage(owner.ws, 'build_artifact_payload');
    worker.ws.send(JSON.stringify({
      type: 'build_artifact_payload',
      payload: { channelId, taskId, filename: 'result.md', data: 'UEsDBBQAAAAA' },
    }));
    const payload = await ownerPayload;
    expect(payload.payload.filename).toBe('result.md');
    expect(payload.payload.workerId).toBe(worker.userId);
  }, 60000);
});
