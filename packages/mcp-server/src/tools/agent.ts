import type { ToolResult } from '../types/index.js';
import type { AgentService } from '../services/agent.js';
import { storageService } from '../services/storage.js';
import { DEFAULT_AGENT_TOOLS } from './definitions.js';

let agentService: AgentService | null = null;

export const AGENT_TOOL_DEFINITIONS = [
  {
    name: 'enable_agent_mode',
    description: 'Enable agent mode for a DM or channel so incoming messages trigger an autonomous agent turn',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string', description: 'UUID of the contact (DM) or channel' },
        chatType: { type: 'string', enum: ['dm', 'channel'], description: 'Type of chat' },
        mode: {
          type: 'string',
          enum: ['auto', 'mention'],
          description: 'auto = reply to every message; mention = only when the keyword is used',
        },
        systemPrompt: {
          type: 'string',
          description: 'Optional system prompt override for the agent',
        },
        allowedTools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tool names the agent is allowed to call (defaults to a safe list)',
        },
        maxIterations: {
          type: 'number',
          description: 'Maximum agent tool-call iterations per turn (default 10)',
        },
        mentionKeyword: {
          type: 'string',
          description: 'Keyword that triggers the agent in mention mode (default @<your-username>)',
        },
        channelType: {
          type: 'string',
          enum: ['social', 'build'],
          description: 'Channel type (for channel chats)',
        },
        ownerId: {
          type: 'string',
          description: 'User ID of the channel owner (for build-group orchestrator detection)',
        },
        buildPrompt: {
          type: 'string',
          description: 'Build prompt for build groups',
        },
        role: {
          type: 'string',
          enum: ['orchestrator', 'worker'],
          description: 'Agent role in a build group',
        },
        autoShareContext: {
          type: 'boolean',
          description:
            'Automatically answer context share requests in this chat with a fresh share_context snapshot (default off — opt-in because it exposes your current work)',
        },
      },
      required: ['chatId', 'chatType'],
    },
  },
  {
    name: 'disable_agent_mode',
    description: 'Disable agent mode for a chat',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string' },
      },
      required: ['chatId'],
    },
  },
  {
    name: 'configure_agent',
    description: 'Update agent configuration for a chat',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string' },
        mode: { type: 'string', enum: ['auto', 'mention'] },
        systemPrompt: { type: 'string' },
        allowedTools: { type: 'array', items: { type: 'string' } },
        maxIterations: { type: 'number' },
        mentionKeyword: { type: 'string' },
        autoShareContext: {
          type: 'boolean',
          description: 'Automatically answer context share requests with a fresh share_context snapshot',
        },
      },
      required: ['chatId'],
    },
  },
  {
    name: 'get_agent_status',
    description: 'Show agent configuration for a chat, or all configured agents',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: {
          type: 'string',
          description: 'Optional chat ID to filter to a single chat',
        },
      },
    },
  },
  {
    name: 'trigger_agent',
    description: 'Manually trigger one agent turn with a custom task',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string' },
        task: { type: 'string', description: 'Task/message to send to the agent' },
      },
      required: ['chatId', 'task'],
    },
  },
];

export function setAgentService(service: AgentService): void {
  agentService = service;
}

export async function enableAgentMode(
  chatId: string,
  chatType: 'dm' | 'channel',
  mode: 'auto' | 'mention' = 'auto',
  systemPrompt?: string,
  allowedTools?: string[],
  maxIterations?: number,
  mentionKeyword?: string,
  channelType?: 'social' | 'build',
  ownerId?: string,
  buildPrompt?: string,
  role?: 'orchestrator' | 'worker',
  autoShareContext?: boolean
): Promise<ToolResult> {
  const existing = storageService.getChatSettings(chatId);

  storageService.setChatSettings({
    chatId,
    chatType,
    isEphemeral: existing?.isEphemeral || false,
    muteNotifications: existing?.muteNotifications || false,
    channelType,
    ownerId,
    buildPrompt,
    agent: {
      enabled: true,
      mode,
      systemPrompt,
      allowedTools: allowedTools?.length ? allowedTools : DEFAULT_AGENT_TOOLS,
      maxIterations,
      mentionKeyword,
      role,
      autoShareContext,
    },
  });

  return {
    content: [{ type: 'text', text: `✓ Agent mode enabled for ${chatType} ${chatId}` }],
  };
}

export async function disableAgentMode(chatId: string): Promise<ToolResult> {
  const existing = storageService.getChatSettings(chatId);
  if (!existing) {
    return {
      content: [{ type: 'text', text: `No settings found for ${chatId}` }],
      isError: true,
    };
  }

  storageService.setChatSettings({
    ...existing,
    agent: { ...existing.agent, enabled: false } as any,
  });

  return {
    content: [{ type: 'text', text: `✓ Agent mode disabled for ${chatId}` }],
  };
}

export async function configureAgent(
  chatId: string,
  updates: {
    mode?: 'auto' | 'mention';
    systemPrompt?: string;
    allowedTools?: string[];
    maxIterations?: number;
    mentionKeyword?: string;
    role?: 'orchestrator' | 'worker';
    autoShareContext?: boolean;
    channelType?: 'social' | 'build';
    ownerId?: string;
    buildPrompt?: string;
  }
): Promise<ToolResult> {
  const existing = storageService.getChatSettings(chatId);
  if (!existing?.agent) {
    return {
      content: [{ type: 'text', text: `Agent mode is not enabled for ${chatId}. Call enable_agent_mode first.` }],
      isError: true,
    };
  }

  storageService.setChatSettings({
    ...existing,
    channelType: updates.channelType ?? existing.channelType,
    ownerId: updates.ownerId ?? existing.ownerId,
    buildPrompt: updates.buildPrompt ?? existing.buildPrompt,
    agent: {
      ...existing.agent,
      ...updates,
      autoShareContext: updates.autoShareContext ?? existing.agent.autoShareContext,
      allowedTools:
        updates.allowedTools?.length ? updates.allowedTools : existing.agent.allowedTools,
    },
  });

  return {
    content: [{ type: 'text', text: `✓ Agent config updated for ${chatId}` }],
  };
}

export async function getAgentStatus(chatId?: string): Promise<ToolResult> {
  if (chatId) {
    const settings = storageService.getChatSettings(chatId);
    if (!settings?.agent) {
      return {
        content: [{ type: 'text', text: `No agent configured for ${chatId}` }],
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(settings.agent, null, 2) }],
    };
  }

  const all = storageService['settings'] as Map<string, { chatId: string; agent?: any }>;
  const agents: any[] = [];
  for (const [, settings] of all) {
    if (settings.agent) {
      agents.push({ chatId: settings.chatId, agent: settings.agent });
    }
  }

  if (agents.length === 0) {
    return {
      content: [{ type: 'text', text: 'No agents configured' }],
    };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(agents, null, 2) }],
  };
}

export async function triggerAgent(chatId: string, task: string): Promise<ToolResult> {
  if (!agentService) {
    return {
      content: [{ type: 'text', text: 'Agent service is not initialized' }],
      isError: true,
    };
  }

  const settings = storageService.getChatSettings(chatId);
  const chatType = settings?.chatType || 'dm';

  await agentService.runAgentTurnWithTask(chatId, task, chatType);

  return {
    content: [{ type: 'text', text: `✓ Agent turn triggered for ${chatId}` }],
  };
}
