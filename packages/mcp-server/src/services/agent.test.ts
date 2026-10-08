import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentService } from '../services/agent.js';
import { dispatchTool } from '../tools/dispatcher.js';
import {
  uploadArtifact,
  sendArtifactPayload,
  downloadArtifact,
  clearLocalArtifact,
  reportSessionStatus,
} from '../tools/build-groups.js';
import type { Message } from '@pingio/shared';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ARTIFACT_DIR = path.join(os.homedir(), '.pingio', 'artifacts');

const mockCreateMessage = vi.fn();
const mockSendMessage = vi.fn();
const mockSendChannelMessage = vi.fn();

vi.mock('../tools/dispatcher.js', () => ({
  dispatchTool: vi.fn(),
}));

vi.mock('../tools/build-groups.js', () => ({
  uploadArtifact: vi.fn(),
  sendArtifactPayload: vi.fn(),
  downloadArtifact: vi.fn(),
  clearLocalArtifact: vi.fn(),
  reportSessionStatus: vi.fn(),
}));

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid'),
}));

describe('AgentService', () => {
  let agentService: AgentService;
  let storage: any;
  let configManager: any;
  let relayClient: any;
  let server: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    // Clean artifact dirs used by these tests
    for (const taskDir of ['ch-1/task-1', 'ch-1/task-2']) {
      const p = path.join(ARTIFACT_DIR, taskDir);
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    }

    storage = {
      getChatSettings: vi.fn(),
      setChatSettings: vi.fn(),
      getMessages: vi.fn(() => []),
      saveMessage: vi.fn(),
      clearMessages: vi.fn(),
    };

    configManager = {
      getConfig: vi.fn(() => ({
        identity: { userId: 'u1', username: 'alice', authToken: 'token' },
      })),
    };

    relayClient = {
      sendMessage: mockSendMessage,
      sendChannelMessage: mockSendChannelMessage,
      sendContextClearAck: vi.fn(),
      on: vi.fn(),
    };

    server = { createMessage: mockCreateMessage };

    agentService = new AgentService(server, relayClient, storage, configManager);
  });

  function incomingDm(overrides: Partial<Message> = {}): Message {
    return {
      id: 'msg-1',
      senderId: 'u2',
      senderUsername: 'bob',
      recipientId: 'u1',
      content: 'Hello agent',
      isEphemeral: false,
      createdAt: new Date(),
      ...overrides,
    } as Message;
  }

  it('ignores incoming messages when not logged in', () => {
    configManager.getConfig.mockReturnValue({ identity: {} });
    agentService.handleIncomingMessage(incomingDm());
    expect(storage.saveMessage).not.toHaveBeenCalled();
  });

  it('persists incoming messages', () => {
    storage.getChatSettings.mockReturnValue(null);
    agentService.handleIncomingMessage(incomingDm());
    expect(storage.saveMessage).toHaveBeenCalledWith(
      'u2',
      expect.objectContaining({ id: 'msg-1', content: 'Hello agent', isDelivered: true, isRead: true })
    );
  });

  it('does not trigger when agent mode is disabled', () => {
    storage.getChatSettings.mockReturnValue({ chatId: 'u2', chatType: 'dm', isEphemeral: false, muteNotifications: false });
    agentService.handleIncomingMessage(incomingDm());
    expect(mockCreateMessage).not.toHaveBeenCalled();
  });

  it('does not trigger on messages sent by the current user', async () => {
    storage.getChatSettings.mockReturnValue({
      chatId: 'u2',
      chatType: 'dm',
      isEphemeral: false,
      muteNotifications: false,
      agent: { enabled: true, mode: 'auto' },
    });
    agentService.handleIncomingMessage(incomingDm({ senderId: 'u1', senderUsername: 'alice', recipientId: 'u2' }));
    await vi.waitFor(() => expect(mockCreateMessage).not.toHaveBeenCalled());
  });

  it('triggers a text reply in auto mode', async () => {
    storage.getChatSettings.mockReturnValue({
      chatId: 'u2',
      chatType: 'dm',
      isEphemeral: false,
      muteNotifications: false,
      agent: { enabled: true, mode: 'auto' },
    });
    mockCreateMessage.mockResolvedValue({ content: [{ type: 'text', text: 'Hi there!' }] });

    agentService.handleIncomingMessage(incomingDm());

    await vi.waitFor(() => expect(mockSendMessage).toHaveBeenCalled());
    expect(mockSendMessage).toHaveBeenCalledWith('u2', 'Hi there!');
    expect(storage.saveMessage).toHaveBeenCalledWith(
      'u2',
      expect.objectContaining({ senderId: 'u1', content: 'Hi there!' })
    );
  });

  it('executes tool calls and sends the final reply', async () => {
    storage.getChatSettings.mockReturnValue({
      chatId: 'u2',
      chatType: 'dm',
      isEphemeral: false,
      muteNotifications: false,
      agent: { enabled: true, mode: 'auto', allowedTools: ['send_message'] },
    });

    mockCreateMessage
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            name: 'send_message',
            id: 'tu-1',
            input: { recipient: 'u3', content: 'Forwarded' },
          },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Done' }] });

    (vi.mocked(dispatchTool) as any).mockResolvedValue({ content: [{ type: 'text', text: '✓ @u3' }] });

    agentService.handleIncomingMessage(incomingDm());

    await vi.waitFor(() => expect(mockSendMessage).toHaveBeenCalled());
    expect(dispatchTool).toHaveBeenCalledWith('send_message', { recipient: 'u3', content: 'Forwarded' });
    expect(mockSendMessage).toHaveBeenCalledWith('u2', 'Done');
  });

  it('rejects tools not in the allowed list', async () => {
    storage.getChatSettings.mockReturnValue({
      chatId: 'u2',
      chatType: 'dm',
      isEphemeral: false,
      muteNotifications: false,
      agent: { enabled: true, mode: 'auto', allowedTools: ['send_message'] },
    });

    mockCreateMessage
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            name: 'create_channel',
            id: 'tu-1',
            input: { name: 'test', displayName: 'Test' },
          },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'I cannot use that tool.' }] });

    agentService.handleIncomingMessage(incomingDm());

    await vi.waitFor(() => expect(mockSendMessage).toHaveBeenCalled());
    expect(dispatchTool).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith('u2', 'I cannot use that tool.');
  });

  it('respects mention mode in channels', async () => {
    storage.getChatSettings.mockReturnValue({
      chatId: 'ch-1',
      chatType: 'channel',
      isEphemeral: false,
      muteNotifications: false,
      agent: { enabled: true, mode: 'mention' },
    });
    mockCreateMessage.mockResolvedValue({ content: [{ type: 'text', text: 'Yes?' }] });

    agentService.handleIncomingMessage(
      incomingDm({
        senderId: 'u2',
        recipientId: undefined,
        channelId: 'ch-1',
        content: 'Hey alice',
      })
    );

    // Without mention keyword, no sampling request should happen
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockCreateMessage).not.toHaveBeenCalled();

    agentService.handleIncomingMessage(
      incomingDm({
        senderId: 'u2',
        recipientId: undefined,
        channelId: 'ch-1',
        content: 'Hey @alice',
      })
    );

    await vi.waitFor(() => expect(mockSendChannelMessage).toHaveBeenCalled());
    expect(mockSendChannelMessage).toHaveBeenCalledWith('ch-1', 'Yes?');
  });

  it('supports manual trigger_agent with a task', async () => {
    storage.getChatSettings.mockReturnValue({
      chatId: 'u2',
      chatType: 'dm',
      isEphemeral: false,
      muteNotifications: false,
      agent: { enabled: true, mode: 'auto' },
    });
    mockCreateMessage.mockResolvedValue({ content: [{ type: 'text', text: 'Task result' }] });

    await agentService.runAgentTurnWithTask('u2', 'Do a thing', 'dm');

    await vi.waitFor(() => expect(mockSendMessage).toHaveBeenCalled());
    expect(mockSendMessage).toHaveBeenCalledWith('u2', 'Task result');
  });

  it('registers listeners for build-group events', () => {
    expect(relayClient.on).toHaveBeenCalledWith('build:context_clear_request', expect.any(Function));
    expect(relayClient.on).toHaveBeenCalledWith('build:task', expect.any(Function));
    expect(relayClient.on).toHaveBeenCalledWith('build:artifact_request', expect.any(Function));
    expect(relayClient.on).toHaveBeenCalledWith('build:artifact_clear_request', expect.any(Function));
  });

  it('clears channel messages and acks when context clear targets the local user', async () => {
    const handler = relayClient.on.mock.calls.find((call: any[]) => call[0] === 'build:context_clear_request')![1];

    await handler({ channelId: 'ch-1', taskId: 'task-1', targetUsername: 'alice' });

    expect(storage.clearMessages).toHaveBeenCalledWith('ch-1');
    expect(relayClient.sendContextClearAck).toHaveBeenCalledWith('ch-1', 'task-1');
  });

  it('ignores context clear requests targeting another user', async () => {
    const handler = relayClient.on.mock.calls.find((call: any[]) => call[0] === 'build:context_clear_request')![1];

    await handler({ channelId: 'ch-1', taskId: 'task-1', targetUsername: 'bob' });

    expect(storage.clearMessages).not.toHaveBeenCalled();
    expect(relayClient.sendContextClearAck).not.toHaveBeenCalled();
  });

  it('runs worker turn when a build task is assigned to the current user', async () => {
    storage.getChatSettings.mockReturnValue({
      chatId: 'ch-1',
      chatType: 'channel',
      channelType: 'build',
      isEphemeral: false,
      muteNotifications: false,
      agent: { enabled: true, role: 'worker' },
    });
    mockCreateMessage.mockResolvedValue({ content: [{ type: 'text', text: 'Done' }] });

    const handler = relayClient.on.mock.calls.find((call: any[]) => call[0] === 'build:task')![1];
    await handler({
      id: 'task-1',
      channelId: 'ch-1',
      ownerId: 'u2',
      title: 'Build thing',
      description: 'desc',
      status: 'assigned',
      assignedTo: 'u1',
      createdAt: new Date(),
    });

    await vi.waitFor(() => expect(uploadArtifact).toHaveBeenCalled());
    expect(mockCreateMessage).toHaveBeenCalled();
    expect(reportSessionStatus).toHaveBeenCalled();
  });

  it('ignores build task assignments targeting another user', async () => {
    const handler = relayClient.on.mock.calls.find((call: any[]) => call[0] === 'build:task')![1];
    await handler({
      id: 'task-1',
      channelId: 'ch-1',
      ownerId: 'u2',
      title: 'Build thing',
      status: 'assigned',
      assignedTo: 'u3',
      createdAt: new Date(),
    });

    expect(mockCreateMessage).not.toHaveBeenCalled();
  });

  it('downloads artifact when a task owned by the current user completes with an artifact', async () => {
    const handler = relayClient.on.mock.calls.find((call: any[]) => call[0] === 'build:task')![1];
    await handler({
      id: 'task-1',
      channelId: 'ch-1',
      ownerId: 'u1',
      title: 'Build thing',
      status: 'completed',
      artifactFilename: 'result.md',
      createdAt: new Date(),
    });

    await vi.waitFor(() => expect(downloadArtifact).toHaveBeenCalled());
    expect(downloadArtifact).toHaveBeenCalledWith('ch-1', 'task-1', expect.any(String));
  });

  it('runs orchestrator turn for incoming messages in an owned build group', async () => {
    storage.getChatSettings.mockReturnValue({
      chatId: 'ch-1',
      chatType: 'channel',
      channelType: 'build',
      ownerId: 'u1',
      isEphemeral: false,
      muteNotifications: false,
      agent: { enabled: true, role: 'orchestrator' },
    });
    mockCreateMessage.mockResolvedValue({ content: [{ type: 'text', text: 'Task created and assigned' }] });

    agentService.handleIncomingMessage(
      incomingDm({
        senderId: 'u2',
        senderUsername: 'bob',
        recipientId: undefined,
        channelId: 'ch-1',
        content: 'Build a feature',
      })
    );

    await vi.waitFor(() => expect(mockSendChannelMessage).toHaveBeenCalled());
    expect(mockSendChannelMessage).toHaveBeenCalledWith('ch-1', 'Task created and assigned');
  });

  it('sends artifact payload when worker receives artifact request', async () => {
    storage.getChatSettings.mockReturnValue({
      chatId: 'ch-1',
      chatType: 'channel',
      channelType: 'build',
      isEphemeral: false,
      muteNotifications: false,
      agent: { enabled: true, role: 'worker' },
    });

    const dir = path.join(ARTIFACT_DIR, 'ch-1', 'task-2');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'result.md'), 'artifact data');

    const handler = relayClient.on.mock.calls.find((call: any[]) => call[0] === 'build:artifact_request')![1];
    await handler({ channelId: 'ch-1', taskId: 'task-2' });

    expect(sendArtifactPayload).toHaveBeenCalledWith('ch-1', 'task-2', 'result.md');
  });

  it('clears local artifact when worker receives artifact clear request', async () => {
    storage.getChatSettings.mockReturnValue({
      chatId: 'ch-1',
      chatType: 'channel',
      channelType: 'build',
      isEphemeral: false,
      muteNotifications: false,
      agent: { enabled: true, role: 'worker' },
    });

    const handler = relayClient.on.mock.calls.find((call: any[]) => call[0] === 'build:artifact_clear_request')![1];
    await handler({ channelId: 'ch-1', taskId: 'task-1' });

    expect(clearLocalArtifact).toHaveBeenCalledWith('ch-1', 'task-1');
  });

  it('runs an assigned build task only once when the event is delivered twice', async () => {
    storage.getChatSettings.mockReturnValue({
      chatId: 'ch-1',
      chatType: 'channel',
      channelType: 'build',
      isEphemeral: false,
      muteNotifications: false,
      agent: { enabled: true, role: 'worker' },
    });
    mockCreateMessage.mockResolvedValue({ content: [{ type: 'text', text: 'Done' }] });

    const handler = relayClient.on.mock.calls.find((call: any[]) => call[0] === 'build:task')![1];
    const task = {
      id: 'task-1',
      channelId: 'ch-1',
      ownerId: 'u2',
      title: 'Build thing',
      description: 'desc',
      status: 'assigned',
      assignedTo: 'u1',
      createdAt: new Date(),
    };

    // Duplicate delivery of the same assigned event (e.g. after a reconnect).
    await handler(task);
    await handler(task);

    await vi.waitFor(() => expect(uploadArtifact).toHaveBeenCalled());
    expect(uploadArtifact).toHaveBeenCalledTimes(1);
    expect(mockCreateMessage).toHaveBeenCalledTimes(1);
  });

  it('downloads a completed task artifact only once when the event is delivered twice', async () => {
    const handler = relayClient.on.mock.calls.find((call: any[]) => call[0] === 'build:task')![1];
    const task = {
      id: 'task-1',
      channelId: 'ch-1',
      ownerId: 'u1',
      title: 'Build thing',
      status: 'completed',
      artifactFilename: 'result.md',
      createdAt: new Date(),
    };

    await handler(task);
    await handler(task);

    await vi.waitFor(() => expect(downloadArtifact).toHaveBeenCalled());
    expect(downloadArtifact).toHaveBeenCalledTimes(1);
  });

  it('throttles a runaway auto-reply loop after the per-chat cap', async () => {
    storage.getChatSettings.mockReturnValue({
      chatId: 'u2',
      chatType: 'dm',
      isEphemeral: false,
      muteNotifications: false,
      agent: { enabled: true, mode: 'auto' },
    });
    mockCreateMessage.mockResolvedValue({ content: [{ type: 'text', text: 'reply' }] });

    const BURST = 30;
    for (let i = 0; i < BURST; i++) {
      agentService.handleIncomingMessage(incomingDm({ id: `m-${i}` }));
      // Let each turn's microtasks flush so the next message is sequential
      // (not dropped by the concurrent-turn guard) and counts against the cap.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // The loop breaker must cap the number of actual turns well below the burst.
    expect(mockCreateMessage.mock.calls.length).toBeLessThanOrEqual(12);
    expect(mockCreateMessage.mock.calls.length).toBeLessThan(BURST);
    expect(mockCreateMessage.mock.calls.length).toBeGreaterThan(0);
  });

  describe('context share request auto-response', () => {
    function getContextRequestHandler(): (payload: any) => Promise<void> {
      return relayClient.on.mock.calls.find((call: any[]) => call[0] === 'collab:context_request')![1];
    }

    function agentSettings(chatId: string, chatType: 'dm' | 'channel', autoShareContext?: boolean) {
      return {
        chatId,
        chatType,
        isEphemeral: false,
        muteNotifications: false,
        agent: { enabled: true, mode: 'auto', allowedTools: ['share_context', 'send_message', 'send_channel_message'], autoShareContext },
      };
    }

    it('ignores requests when autoShareContext is not enabled', async () => {
      storage.getChatSettings.mockReturnValue(agentSettings('ch-1', 'channel'));
      const handler = getContextRequestHandler();

      await handler({ channelId: 'ch-1', requesterId: 'u2', requesterUsername: 'bob' });

      expect(mockCreateMessage).not.toHaveBeenCalled();
    });

    it('ignores requests when agent mode is disabled', async () => {
      storage.getChatSettings.mockReturnValue({
        chatId: 'ch-1',
        chatType: 'channel',
        isEphemeral: false,
        muteNotifications: false,
        agent: { enabled: false, mode: 'auto', autoShareContext: true },
      });
      const handler = getContextRequestHandler();

      await handler({ channelId: 'ch-1', requesterId: 'u2', requesterUsername: 'bob' });

      expect(mockCreateMessage).not.toHaveBeenCalled();
    });

    it('ignores requests targeting another member', async () => {
      storage.getChatSettings.mockReturnValue(agentSettings('ch-1', 'channel', true));
      const handler = getContextRequestHandler();

      await handler({ channelId: 'ch-1', targetUsername: 'carol', requesterId: 'u2', requesterUsername: 'bob' });

      expect(mockCreateMessage).not.toHaveBeenCalled();
    });

    it('ignores our own requests', async () => {
      storage.getChatSettings.mockReturnValue(agentSettings('ch-1', 'channel', true));
      const handler = getContextRequestHandler();

      await handler({ channelId: 'ch-1', requesterId: 'u1', requesterUsername: 'alice' });

      expect(mockCreateMessage).not.toHaveBeenCalled();
    });

    it('auto-shares context to the requesting channel when opted in', async () => {
      storage.getChatSettings.mockReturnValue(agentSettings('ch-1', 'channel', true));
      mockCreateMessage
        .mockResolvedValueOnce({
          content: [
            {
              type: 'tool_use',
              name: 'share_context',
              id: 'tu-1',
              input: { summary: 'Fixing the WS reconnect bug', status: 'working', channelId: 'ch-1' },
            },
          ],
        })
        .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Shared my current work.' }] });
      (vi.mocked(dispatchTool) as any).mockResolvedValue({ content: [{ type: 'text', text: '✓ context shared' }] });

      const handler = getContextRequestHandler();
      await handler({ channelId: 'ch-1', requesterId: 'u2', requesterUsername: 'bob' });

      await vi.waitFor(() => expect(mockSendChannelMessage).toHaveBeenCalled());
      expect(dispatchTool).toHaveBeenCalledWith(
        'share_context',
        expect.objectContaining({ channelId: 'ch-1', summary: 'Fixing the WS reconnect bug' })
      );
      expect(mockSendChannelMessage).toHaveBeenCalledWith('ch-1', 'Shared my current work.');
      // The synthetic prompt names the requester and scope so the model shares to the right place
      // (the messages array is mutated in place across turns, so find it rather than indexing).
      const firstCallMessages = mockCreateMessage.mock.calls[0][0].messages;
      const prompt = firstCallMessages.find((m: any) => m.content?.[0]?.text?.includes('[context request]'))?.content[0].text;
      expect(prompt).toContain('@bob');
      expect(prompt).toContain('channelId: "ch-1"');
    });

    it('auto-shares context back to the DM requester', async () => {
      storage.getChatSettings.mockReturnValue(agentSettings('u2', 'dm', true));
      mockCreateMessage
        .mockResolvedValueOnce({
          content: [
            {
              type: 'tool_use',
              name: 'share_context',
              id: 'tu-1',
              input: { summary: 'Reviewing the auth PR', recipient: 'bob' },
            },
          ],
        })
        .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Done' }] });
      (vi.mocked(dispatchTool) as any).mockResolvedValue({ content: [{ type: 'text', text: '✓ context shared' }] });

      const handler = getContextRequestHandler();
      await handler({ recipientId: 'u1', requesterId: 'u2', requesterUsername: 'bob' });

      await vi.waitFor(() => expect(mockSendMessage).toHaveBeenCalled());
      expect(dispatchTool).toHaveBeenCalledWith('share_context', expect.objectContaining({ recipient: 'bob' }));
      expect(mockSendMessage).toHaveBeenCalledWith('u2', 'Done');
    });

    it('rate-limits auto-answers to one per cooldown window', async () => {
      storage.getChatSettings.mockReturnValue(agentSettings('ch-1', 'channel', true));
      mockCreateMessage.mockResolvedValue({ content: [{ type: 'text', text: 'shared' }] });

      const handler = getContextRequestHandler();
      await handler({ channelId: 'ch-1', requesterId: 'u2', requesterUsername: 'bob' });
      await vi.waitFor(() => expect(mockSendChannelMessage).toHaveBeenCalled());

      // Second request inside the cooldown window is dropped.
      await handler({ channelId: 'ch-1', requesterId: 'u2', requesterUsername: 'bob' });

      expect(mockCreateMessage).toHaveBeenCalledTimes(1);
    });
  });
});
