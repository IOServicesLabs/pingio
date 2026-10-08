import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  enableAgentMode,
  disableAgentMode,
  configureAgent,
  getAgentStatus,
  triggerAgent,
  setAgentService,
  AGENT_TOOL_DEFINITIONS,
} from './agent.js';

const mockRunAgentTurnWithTask = vi.fn();

vi.mock('../services/storage.js', () => ({
  storageService: {
    getChatSettings: vi.fn(),
    setChatSettings: vi.fn(),
    settings: new Map(),
  },
}));

import { storageService } from '../services/storage.js';

describe('agent management tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (storageService as any).settings.clear();
    setAgentService({ runAgentTurnWithTask: mockRunAgentTurnWithTask } as any);
  });

  it('enableAgentMode stores an AgentConfig with defaults', async () => {
    (storageService.getChatSettings as any).mockReturnValue(null);

    const result = await enableAgentMode('chat-1', 'dm', 'mention');

    expect(result.isError).toBeUndefined();
    expect(storageService.setChatSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        chatType: 'dm',
        agent: expect.objectContaining({ enabled: true, mode: 'mention' }),
      })
    );
    const agent = (storageService.setChatSettings as any).mock.calls[0][0].agent;
    expect(agent.allowedTools).toBeDefined();
    expect(agent.allowedTools.length).toBeGreaterThan(0);
  });

  it('disableAgentMode disables the agent without removing settings', async () => {
    (storageService.getChatSettings as any).mockReturnValue({
      chatId: 'chat-1',
      chatType: 'dm',
      isEphemeral: false,
      muteNotifications: false,
      agent: { enabled: true, mode: 'auto' },
    });

    const result = await disableAgentMode('chat-1');

    expect(result.isError).toBeUndefined();
    expect(storageService.setChatSettings).toHaveBeenCalledWith(
      expect.objectContaining({ agent: expect.objectContaining({ enabled: false }) })
    );
  });

  it('configureAgent returns error if agent is not enabled', async () => {
    (storageService.getChatSettings as any).mockReturnValue({ chatId: 'chat-1', chatType: 'dm', isEphemeral: false, muteNotifications: false });

    const result = await configureAgent('chat-1', { maxIterations: 5 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not enabled');
  });

  it('configureAgent updates existing agent config', async () => {
    (storageService.getChatSettings as any).mockReturnValue({
      chatId: 'chat-1',
      chatType: 'dm',
      isEphemeral: false,
      muteNotifications: false,
      agent: { enabled: true, mode: 'auto', allowedTools: ['send_message'], maxIterations: 10 },
    });

    const result = await configureAgent('chat-1', { maxIterations: 5, mode: 'mention' });

    expect(result.isError).toBeUndefined();
    expect(storageService.setChatSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ enabled: true, mode: 'mention', maxIterations: 5 }),
      })
    );
  });

  it('getAgentStatus reports a single chat', async () => {
    (storageService.getChatSettings as any).mockReturnValue({
      chatId: 'chat-1',
      chatType: 'dm',
      isEphemeral: false,
      muteNotifications: false,
      agent: { enabled: true, mode: 'auto' },
    });

    const result = await getAgentStatus('chat-1');

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('"enabled": true');
  });

  it('getAgentStatus lists all configured agents', async () => {
    (storageService as any).settings.set('chat-1', {
      chatId: 'chat-1',
      agent: { enabled: true, mode: 'auto' },
    });
    (storageService as any).settings.set('chat-2', {
      chatId: 'chat-2',
      agent: { enabled: true, mode: 'mention' },
    });

    const result = await getAgentStatus();

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(2);
  });

  it('triggerAgent runs an agent turn', async () => {
    (storageService.getChatSettings as any).mockReturnValue({ chatId: 'chat-1', chatType: 'dm' });

    const result = await triggerAgent('chat-1', 'research something');

    expect(result.isError).toBeUndefined();
    expect(mockRunAgentTurnWithTask).toHaveBeenCalledWith('chat-1', 'research something', 'dm');
  });

  it('triggerAgent returns error if agent service is not set', async () => {
    setAgentService(null as any);
    (storageService.getChatSettings as any).mockReturnValue({ chatId: 'chat-1', chatType: 'dm' });

    const result = await triggerAgent('chat-1', 'task');

    expect(result.isError).toBe(true);
  });

  it('exports one tool definition per management tool', () => {
    const names = AGENT_TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual([
      'enable_agent_mode',
      'disable_agent_mode',
      'configure_agent',
      'get_agent_status',
      'trigger_agent',
    ]);
  });
});
