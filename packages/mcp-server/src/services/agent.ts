import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type {
  SamplingMessage,
  Tool,
  CreateMessageResultWithTools,
  SamplingMessageContentBlock,
} from '@modelcontextprotocol/sdk/types.js';
import type { Message, BuildTask } from '@pingio/shared';
import { v4 as uuidv4 } from 'uuid';
import type { ConfigManager } from '../config.js';
import type { RelayClient } from './relay.js';
import type { StorageService } from './storage.js';
import type { LocalMessage, AgentConfig, ChatSettings } from '../types/index.js';
import { dispatchTool } from '../tools/dispatcher.js';
import { TOOL_DEFINITIONS, DEFAULT_AGENT_TOOLS } from '../tools/definitions.js';
import {
  uploadArtifact,
  sendArtifactPayload,
  downloadArtifact,
  clearLocalArtifact,
  reportSessionStatus,
} from '../tools/build-groups.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const DEFAULT_SYSTEM_PROMPT = `You are an autonomous agent running inside a Pingio chat. You can send messages, read history, manage contacts, and use other available tools to help the user. Be concise and helpful. When you need to perform an action, use a tool. When you are done, respond with a short final message.`;

const DEFAULT_MAX_ITERATIONS = 10;
const HISTORY_LIMIT = 20;

// Loop breaker for auto-triggered agent turns. Two auto-mode agents replying to
// each other (or an agent reacting to its own echoed content) would otherwise
// ping-pong forever. We cap how many auto turns a single chat may run within a
// rolling window; a genuine conversation resumes once the window clears.
const MAX_AGENT_TURNS_PER_WINDOW = 12;
const AGENT_TURN_WINDOW_MS = 60_000;

const DEFAULT_ARTIFACT_DIR = path.join(os.homedir(), '.pingio', 'artifacts');
const ARTIFACT_DIR = process.env.LOCAL_ARTIFACT_DIR || DEFAULT_ARTIFACT_DIR;

const WORKER_SYSTEM_PROMPT = `You are a build-group worker agent. You have been assigned a task in a build group. Use the available tools to complete the task. When you are done, write your final result to a file under the local artifact directory and call upload_artifact to report completion. If the owner requests the artifact payload or asks you to clear it, respond automatically.`;

const ORCHESTRATOR_SYSTEM_PROMPT = `You are the owner/orchestrator of a build group. Members send you build requests. Your job is to turn each request into a build task, pick the least-loaded available worker by checking member statuses, assign the task, and request context clears when workers are near capacity. Be concise and report what you did.`;

// Auto-answering a context-share request spends a full agent turn (model
// tokens), so a chat can auto-answer at most one request per cooldown window —
// a spammy requester cannot drain the account.
const CONTEXT_SHARE_REQUEST_COOLDOWN_MS = 60_000;

export class AgentService {
  private activeChats = new Set<string>();
  // Task ids this session has already begun running as a worker, so a replayed
  // or duplicated `assigned` event (e.g. after a reconnect) does not run the
  // task twice. Cleared on failure so a re-assign can retry.
  private startedWorkerTasks = new Set<string>();
  // Task ids whose completed artifact this session has already auto-downloaded,
  // so a duplicated `completed` event does not re-download.
  private downloadedTasks = new Set<string>();
  // chatId -> recent auto-turn start times (ms), for the loop breaker.
  private turnTimestamps = new Map<string, number[]>();
  // chatId -> last auto-answered context-share request (ms cooldown).
  private contextShareTurns = new Map<string, number>();

  constructor(
    private server: Server,
    private relayClient: RelayClient,
    private storage: StorageService,
    private configManager: ConfigManager
  ) {
    this.relayClient.on('build:context_clear_request', (payload) => {
      this.handleContextClearRequest(payload).catch((err) => {
        console.error('Failed to handle context clear request:', err);
      });
    });

    this.relayClient.on('collab:context_request', (payload) => {
      this.handleContextShareRequest(payload).catch((err) => {
        console.error('Failed to handle context share request:', err);
      });
    });

    this.relayClient.on('build:task', (task) => {
      this.handleBuildTask(task).catch((err) => {
        console.error('Failed to handle build task event:', err);
      });
    });

    this.relayClient.on('build:artifact_request', (payload) => {
      this.handleArtifactRequest(payload).catch((err) => {
        console.error('Failed to handle artifact request:', err);
      });
    });

    this.relayClient.on('build:artifact_clear_request', (payload) => {
      this.handleArtifactClearRequest(payload).catch((err) => {
        console.error('Failed to handle artifact clear request:', err);
      });
    });
  }

  handleIncomingMessage(message: Message): void {
    const identity = this.configManager.getConfig().identity;
    if (!identity.userId) return;

    const resolved = this.resolveChat(message);
    if (!resolved) return;
    const { chatId, chatType } = resolved;

    this.saveIncomingMessage(chatId, message);

    const settings = this.storage.getChatSettings(chatId);
    if (!settings?.agent?.enabled) return;

    // Build-group orchestrator path
    if (
      settings.channelType === 'build' &&
      settings.ownerId === identity.userId &&
      chatType === 'channel'
    ) {
      if (message.senderId === identity.userId) return;
      this.runOrchestratorTurn(chatId, settings, message).catch((err) => {
        console.error(`Orchestrator turn failed for ${chatId}:`, err);
      });
      return;
    }

    if (!this.shouldTrigger(settings, message, identity.userId, identity.username)) return;

    this.runAgentTurn(chatId, settings, message).catch((err) => {
      console.error(`Agent turn failed for ${chatId}:`, err);
    });
  }

  private async handleContextClearRequest(payload: {
    channelId: string;
    taskId?: string;
    targetUsername?: string;
  }): Promise<void> {
    const identity = this.configManager.getConfig().identity;
    if (!identity.userId) return;

    // If a specific target username is provided, only act when it matches the local user.
    if (payload.targetUsername && payload.targetUsername !== identity.username) {
      return;
    }

    this.storage.clearMessages(payload.channelId);

    this.relayClient.sendContextClearAck(payload.channelId, payload.taskId);
  }

  // Auto-answer a context-share request by running an agent turn that composes
  // a fresh share_context snapshot for the requesting scope. Strictly opt-in:
  // requires agent mode enabled AND agent.autoShareContext for that chat.
  private async handleContextShareRequest(payload: {
    channelId?: string;
    recipientId?: string;
    targetUsername?: string;
    requesterId: string;
    requesterUsername?: string;
  }): Promise<void> {
    const identity = this.configManager.getConfig().identity;
    if (!identity.userId) return;

    // Channel requests may name a specific member — only act when it's us.
    if (payload.targetUsername && payload.targetUsername !== identity.username) return;

    // Never auto-answer our own requests.
    if (payload.requesterId === identity.userId) return;

    const chatId = payload.channelId ?? payload.requesterId;
    const settings = this.storage.getChatSettings(chatId);
    if (!settings?.agent?.enabled || !settings.agent.autoShareContext) return;

    const lastTurn = this.contextShareTurns.get(chatId) ?? 0;
    if (Date.now() - lastTurn < CONTEXT_SHARE_REQUEST_COOLDOWN_MS) return;
    this.contextShareTurns.set(chatId, Date.now());

    const requester = payload.requesterUsername ?? 'a chat member';
    const scopeArg = payload.channelId
      ? `channelId: "${payload.channelId}"`
      : `recipient: "${requester}"`;

    const syntheticMessage: Message = {
      id: uuidv4(),
      senderId: payload.requesterId,
      senderUsername: payload.requesterUsername ?? 'user',
      recipientId: payload.channelId ? undefined : identity.userId,
      channelId: payload.channelId,
      content:
        `[context request] @${requester} asked what you are currently working on. ` +
        `Call share_context once with ${scopeArg}, a concise summary of your current work, ` +
        `its status, and the relevant files — then send a one-line reply confirming the share.`,
      isEphemeral: false,
      createdAt: new Date(),
    };

    await this.runAgentTurn(chatId, settings, syntheticMessage);
  }

  private async handleBuildTask(task: BuildTask): Promise<void> {
    const identity = this.configManager.getConfig().identity;
    if (!identity.userId) return;

    if (task.status === 'assigned' && task.assignedTo === identity.userId) {
      // Guard synchronously (before any await) so concurrent duplicate events
      // cannot both pass the check.
      if (this.startedWorkerTasks.has(task.id)) return;
      this.startedWorkerTasks.add(task.id);
      try {
        await this.runWorkerTurn(task);
      } catch (err) {
        // Allow a later re-assign to retry a task that failed to run.
        this.startedWorkerTasks.delete(task.id);
        throw err;
      }
      return;
    }

    if (task.status === 'completed' && task.ownerId === identity.userId && task.artifactFilename) {
      if (this.downloadedTasks.has(task.id)) return;
      this.downloadedTasks.add(task.id);
      await this.downloadArtifactForTask(task.channelId, task.id);
    }
  }

  // Rolling-window rate check for auto-triggered turns. Records and allows a
  // turn if the chat is under the cap; returns false (and records nothing new)
  // when the chat has hit the cap within the window.
  private allowAutoTurn(chatId: string): boolean {
    const now = Date.now();
    const recent = (this.turnTimestamps.get(chatId) || []).filter(
      (t) => now - t < AGENT_TURN_WINDOW_MS
    );
    if (recent.length >= MAX_AGENT_TURNS_PER_WINDOW) {
      this.turnTimestamps.set(chatId, recent);
      return false;
    }
    recent.push(now);
    this.turnTimestamps.set(chatId, recent);
    return true;
  }

  private async runWorkerTurn(task: BuildTask): Promise<void> {
    const identity = this.configManager.getConfig().identity;
    const userId = identity.userId;
    const username = identity.username;
    if (!userId || !username) return;

    const settings = this.storage.getChatSettings(task.channelId);
    const systemPrompt = settings?.buildPrompt
      ? `${WORKER_SYSTEM_PROMPT}\n\nGroup build prompt: ${settings.buildPrompt}`
      : WORKER_SYSTEM_PROMPT;
    const allowedTools = settings?.agent?.allowedTools || DEFAULT_AGENT_TOOLS;
    const maxIterations = settings?.agent?.maxIterations || DEFAULT_MAX_ITERATIONS;
    const tools = this.buildTools(allowedTools);

    const taskPrompt = `Task ${task.id}: ${task.title}${task.description ? `\n${task.description}` : ''}`;

    const messages: SamplingMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text' as const, text: taskPrompt }],
      },
    ];

    // Report status before starting work
    await this.reportSessionStatusForChannel(task.channelId);

    for (let i = 0; i < maxIterations; i++) {
      const response = (await this.server.createMessage(
        {
          messages,
          systemPrompt,
          maxTokens: 4096,
          tools,
          toolChoice: { mode: 'auto' },
        },
        { timeout: 120000 }
      )) as CreateMessageResultWithTools;

      const content = Array.isArray(response.content) ? response.content : [response.content];
      const textParts: string[] = [];
      const toolUses: Array<{ type: 'tool_use'; name: string; id: string; input: Record<string, unknown> }> = [];

      for (const block of content as SamplingMessageContentBlock[]) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolUses.push(block);
        }
      }

      if (toolUses.length === 0) {
        const reply = textParts.join('\n').trim();
        if (reply) {
          await this.writeArtifactFile(task.channelId, task.id, 'result.md', reply);
          await uploadArtifact(task.channelId, task.id, this.getArtifactPath(task.channelId, task.id, 'result.md'));
        }
        await this.reportSessionStatusForChannel(task.channelId);
        return;
      }

      messages.push({
        role: 'assistant',
        content: toolUses.map((tu) => ({
          type: 'tool_use' as const,
          name: tu.name,
          id: tu.id,
          input: tu.input,
        })),
      });

      const results = await Promise.all(
        toolUses.map(async (tu) => {
          if (!allowedTools.includes(tu.name)) {
            return {
              toolUseId: tu.id,
              content: [
                {
                  type: 'text' as const,
                  text: `Tool "${tu.name}" is not in the agent's allowed tool list.`,
                },
              ],
              isError: true,
            };
          }

          const result = await dispatchTool(tu.name, tu.input);
          return {
            toolUseId: tu.id,
            content: [
              {
                type: 'text' as const,
                text: result.content.map((c) => c.text).join('\n'),
              },
            ],
            isError: result.isError || false,
          };
        })
      );

      messages.push({
        role: 'user',
        content: results.map((r) => ({
          type: 'tool_result' as const,
          toolUseId: r.toolUseId,
          content: r.content,
          isError: r.isError,
        })),
      });
    }

    await this.reportSessionStatusForChannel(task.channelId);
  }

  private async runOrchestratorTurn(
    chatId: string,
    settings: ChatSettings,
    incomingMessage: Message
  ): Promise<void> {
    const identity = this.configManager.getConfig().identity;
    const userId = identity.userId;
    const username = identity.username;
    if (!userId || !username) return;

    if (this.activeChats.has(chatId)) return;
    if (!this.allowAutoTurn(chatId)) {
      console.warn(`Orchestrator turn rate limit hit for ${chatId}; skipping to break a possible loop`);
      return;
    }
    this.activeChats.add(chatId);

    try {
      const systemPrompt = settings.buildPrompt
        ? `${ORCHESTRATOR_SYSTEM_PROMPT}\n\nGroup build prompt: ${settings.buildPrompt}`
        : ORCHESTRATOR_SYSTEM_PROMPT;
      const allowedTools = settings.agent?.allowedTools || DEFAULT_AGENT_TOOLS;
      const maxIterations = settings.agent?.maxIterations || DEFAULT_MAX_ITERATIONS;
      const tools = this.buildTools(allowedTools);

      const messages: SamplingMessage[] = this.buildHistoryMessages(chatId, incomingMessage, userId);

      for (let i = 0; i < maxIterations; i++) {
        const response = (await this.server.createMessage(
          {
            messages,
            systemPrompt,
            maxTokens: 4096,
            tools,
            toolChoice: { mode: 'auto' },
          },
          { timeout: 120000 }
        )) as CreateMessageResultWithTools;

        const content = Array.isArray(response.content) ? response.content : [response.content];
        const textParts: string[] = [];
        const toolUses: Array<{ type: 'tool_use'; name: string; id: string; input: Record<string, unknown> }> = [];

        for (const block of content as SamplingMessageContentBlock[]) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            toolUses.push(block);
          }
        }

        if (toolUses.length === 0) {
          const reply = textParts.join('\n').trim();
          if (reply) {
            await this.sendReply(chatId, settings, reply, { userId, username });
          }
          return;
        }

        messages.push({
          role: 'assistant',
          content: toolUses.map((tu) => ({
            type: 'tool_use' as const,
            name: tu.name,
            id: tu.id,
            input: tu.input,
          })),
        });

        const results = await Promise.all(
          toolUses.map(async (tu) => {
            if (!allowedTools.includes(tu.name)) {
              return {
                toolUseId: tu.id,
                content: [
                  {
                    type: 'text' as const,
                    text: `Tool "${tu.name}" is not in the agent's allowed tool list.`,
                  },
                ],
                isError: true,
              };
            }

            const result = await dispatchTool(tu.name, tu.input);
            return {
              toolUseId: tu.id,
              content: [
                {
                  type: 'text' as const,
                  text: result.content.map((c) => c.text).join('\n'),
                },
              ],
              isError: result.isError || false,
            };
          })
        );

        messages.push({
          role: 'user',
          content: results.map((r) => ({
            type: 'tool_result' as const,
            toolUseId: r.toolUseId,
            content: r.content,
            isError: r.isError,
          })),
        });
      }
    } finally {
      this.activeChats.delete(chatId);
    }
  }

  private async handleArtifactRequest(payload: { channelId: string; taskId: string }): Promise<void> {
    const settings = this.storage.getChatSettings(payload.channelId);
    if (!settings?.agent?.enabled || settings.agent.role !== 'worker') return;

    const dir = path.join(ARTIFACT_DIR, payload.channelId, payload.taskId);
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir);
    for (const filename of files) {
      await sendArtifactPayload(payload.channelId, payload.taskId, filename);
    }
  }

  private async handleArtifactClearRequest(payload: { channelId: string; taskId: string }): Promise<void> {
    const settings = this.storage.getChatSettings(payload.channelId);
    if (!settings?.agent?.enabled || settings.agent.role !== 'worker') return;

    await clearLocalArtifact(payload.channelId, payload.taskId);
  }

  private async downloadArtifactForTask(channelId: string, taskId: string): Promise<void> {
    const dir = path.join(ARTIFACT_DIR, channelId, taskId);
    await downloadArtifact(channelId, taskId, dir);
  }

  private getArtifactPath(channelId: string, taskId: string, filename: string): string {
    return path.join(ARTIFACT_DIR, channelId, taskId, filename);
  }

  private ensureArtifactDir(channelId: string, taskId: string): void {
    const dir = path.join(ARTIFACT_DIR, channelId, taskId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private writeArtifactFile(channelId: string, taskId: string, filename: string, data: string): void {
    this.ensureArtifactDir(channelId, taskId);
    fs.writeFileSync(this.getArtifactPath(channelId, taskId, filename), data, 'utf-8');
  }

  private async reportSessionStatusForChannel(channelId: string): Promise<void> {
    const messages = this.storage.getMessages(channelId);
    const contextWindowUsed = messages.length;
    await reportSessionStatus(channelId, undefined, contextWindowUsed, undefined);
  }

  async runAgentTurnWithTask(chatId: string, task: string, chatType?: 'dm' | 'channel'): Promise<void> {
    const identity = this.configManager.getConfig().identity;
    if (!identity.userId) {
      throw new Error('Not logged in');
    }

    let settings = this.storage.getChatSettings(chatId);
    if (!settings) {
      settings = {
        chatId,
        chatType: chatType || 'dm',
        isEphemeral: false,
        muteNotifications: false,
      };
    }

    const syntheticMessage: Message = {
      id: uuidv4(),
      senderId: identity.userId,
      senderUsername: identity.username || 'user',
      recipientId: settings.chatType === 'dm' ? identity.userId : undefined,
      channelId: settings.chatType === 'channel' ? chatId : undefined,
      content: task,
      isEphemeral: false,
      createdAt: new Date(),
    };

    // For manual triggers we still want the agent to act, but we skip the
    // normal "skip own messages" check by passing it directly to the engine.
    await this.runAgentTurn(chatId, settings, syntheticMessage, true);
  }

  private resolveChat(message: Message): { chatId: string; chatType: 'dm' | 'channel' } | null {
    const identity = this.configManager.getConfig().identity;
    if (!identity.userId) return null;

    if (message.channelId) {
      return { chatId: message.channelId, chatType: 'channel' };
    }

    if (message.senderId === identity.userId) {
      // Message we sent — key by recipient
      if (message.recipientId) {
        return { chatId: message.recipientId, chatType: 'dm' };
      }
      return null;
    }

    // Incoming DM — key by sender
    return { chatId: message.senderId, chatType: 'dm' };
  }

  private saveIncomingMessage(chatId: string, message: Message): void {
    const localMessage: LocalMessage = {
      ...message,
      isDelivered: true,
      isRead: true,
    };
    this.storage.saveMessage(chatId, localMessage);
  }

  private shouldTrigger(
    settings: ChatSettings,
    message: Message,
    currentUserId: string,
    currentUsername?: string
  ): boolean {
    const agent = settings.agent;
    if (!agent?.enabled) return false;

    // Never reply to our own messages (prevents loops)
    if (message.senderId === currentUserId) return false;

    if (settings.chatType === 'channel' && agent.mode === 'mention') {
      const keyword = agent.mentionKeyword || `@${currentUsername || 'agent'}`;
      return message.content.includes(keyword);
    }

    return true;
  }

  private async runAgentTurn(
    chatId: string,
    settings: ChatSettings,
    incomingMessage: Message,
    isManualTrigger = false
  ): Promise<void> {
    if (this.activeChats.has(chatId)) return;
    // Manual triggers are explicit user actions and bypass the loop breaker.
    if (!isManualTrigger && !this.allowAutoTurn(chatId)) {
      console.warn(`Agent turn rate limit hit for ${chatId}; skipping to break a possible loop`);
      return;
    }
    this.activeChats.add(chatId);

    try {
      const identity = this.configManager.getConfig().identity;
      const userId = identity.userId;
      const username = identity.username;
      if (!userId || !username) return;

      const agent = settings.agent!;
      const systemPrompt = agent.systemPrompt || DEFAULT_SYSTEM_PROMPT;
      const allowedTools = agent.allowedTools || DEFAULT_AGENT_TOOLS;
      const maxIterations = agent.maxIterations || DEFAULT_MAX_ITERATIONS;
      const tools = this.buildTools(allowedTools);

      const messages: SamplingMessage[] = this.buildHistoryMessages(
        chatId,
        incomingMessage,
        userId
      );

      for (let i = 0; i < maxIterations; i++) {
        const response = (await this.server.createMessage(
          {
            messages,
            systemPrompt,
            maxTokens: 4096,
            tools,
            toolChoice: { mode: 'auto' },
          },
          { timeout: 120000 }
        )) as CreateMessageResultWithTools;

        const content = Array.isArray(response.content)
          ? response.content
          : [response.content];

        const textParts: string[] = [];
        const toolUses: Array<{ type: 'tool_use'; name: string; id: string; input: Record<string, unknown> }> = [];

        for (const block of content as SamplingMessageContentBlock[]) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            toolUses.push(block);
          }
        }

        if (toolUses.length === 0) {
          const reply = textParts.join('\n').trim();
          if (reply) {
            await this.sendReply(chatId, settings, reply, { userId, username });
          }
          return;
        }

        // Add assistant message with tool_use blocks
        messages.push({
          role: 'assistant',
          content: toolUses.map((tu) => ({
            type: 'tool_use' as const,
            name: tu.name,
            id: tu.id,
            input: tu.input,
          })),
        });

        // Execute tools in parallel
        const results = await Promise.all(
          toolUses.map(async (tu) => {
            if (!allowedTools.includes(tu.name)) {
              return {
                toolUseId: tu.id,
                content: [
                  {
                    type: 'text' as const,
                    text: `Tool "${tu.name}" is not in the agent's allowed tool list.`,
                  },
                ],
                isError: true,
              };
            }

            const result = await dispatchTool(tu.name, tu.input);
            return {
              toolUseId: tu.id,
              content: [
                {
                  type: 'text' as const,
                  text: result.content.map((c) => c.text).join('\n'),
                },
              ],
              isError: result.isError || false,
            };
          })
        );

        messages.push({
          role: 'user',
          content: results.map((r) => ({
            type: 'tool_result' as const,
            toolUseId: r.toolUseId,
            content: r.content,
            isError: r.isError,
          })),
        });
      }

      await this.sendReply(
        chatId,
        settings,
        'I hit the maximum number of tool calls for this turn. Please clarify or break the task into smaller steps.',
        { userId, username }
      );
    } finally {
      this.activeChats.delete(chatId);
    }
  }

  private buildTools(allowedTools: string[]): Tool[] {
    return TOOL_DEFINITIONS.filter((t) => allowedTools.includes(t.name)).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Tool['inputSchema'],
    }));
  }

  private buildHistoryMessages(
    chatId: string,
    incomingMessage: Message,
    currentUserId: string
  ): SamplingMessage[] {
    const history = this.storage.getMessages(chatId).slice(-HISTORY_LIMIT);

    const messages: SamplingMessage[] = history.map((m) => ({
      role: m.senderId === currentUserId ? 'assistant' : 'user',
      content: [{ type: 'text' as const, text: m.content }],
    }));

    messages.push({
      role: 'user',
      content: [{ type: 'text' as const, text: incomingMessage.content }],
    });

    return messages;
  }

  private async sendReply(
    chatId: string,
    settings: ChatSettings,
    content: string,
    identity: { userId: string; username: string }
  ): Promise<void> {
    if (settings.chatType === 'channel') {
      this.relayClient.sendChannelMessage(chatId, content);
    } else {
      this.relayClient.sendMessage(chatId, content);
    }

    const outgoing: LocalMessage = {
      id: uuidv4(),
      senderId: identity.userId,
      senderUsername: identity.username,
      recipientId: settings.chatType === 'dm' ? chatId : undefined,
      channelId: settings.chatType === 'channel' ? chatId : undefined,
      content,
      isEphemeral: settings.isEphemeral,
      createdAt: new Date(),
      isDelivered: false,
    };
    this.storage.saveMessage(chatId, outgoing);
  }
}
