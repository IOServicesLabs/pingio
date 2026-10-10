import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import type {
  ProtocolMessage,
  ConnectionStatus,
  Message,
  Presence,
  BuildTask,
  MemberSessionStatus,
  ContextShare,
  ContextShareStatus,
  ContextGitInfo,
} from '@pingio/shared';
import {
  RECONNECT_INTERVAL,
  MAX_RECONNECT_ATTEMPTS,
  CONNECTION_TIMEOUT,
  parseEncryptedEnvelope,
} from '@pingio/shared';
import { configManager } from '../config.js';
import { channelKeyStore } from './channel-keys.js';
import { decryptChannelMessage, decryptDmMessage } from './crypto.js';
import { dmKeyService } from './dm-keys.js';

// Decrypt an encrypted channel envelope in place (copy) when we hold the key.
// Unknown keys surface a placeholder prompting sync_channel_keys; DMs and
// plaintext pass through untouched.
function decryptIfNeeded(message: Message): Message {
  if (!message.channelId) return message;
  const envelope = parseEncryptedEnvelope(message.content);
  if (!envelope) return message;
  const key = channelKeyStore.getChannelKey(message.channelId, envelope.keyId);
  if (!key) {
    return { ...message, content: '🔒 [encrypted message — run sync_channel_keys to read]' };
  }
  const plaintext = decryptChannelMessage(key, message.channelId, message.content);
  return {
    ...message,
    content: plaintext !== null ? `🔒 ${plaintext}` : '🔒 [encrypted message — decryption failed]',
  };
}

// Decrypt an encrypted DM envelope using the pairwise key derived from the
// peer's published identity key. Refetches the peer key once on keyId mismatch
// (identity rotation). Plaintext and unrecognized content pass through.
async function decryptDmIfNeeded(message: Message): Promise<Message> {
  if (message.channelId) return message; // channel envelopes handled synchronously
  const envelope = parseEncryptedEnvelope(message.content);
  if (!envelope) return message;
  const myId = configManager.getConfig().identity.userId;
  const peerId = message.senderId === myId ? message.recipientId : message.senderId;
  if (!myId || !peerId) return message;
  try {
    let dmKey = await dmKeyService.getDmKey(peerId);
    if (dmKey && envelope.keyId !== dmKey.keyId) {
      dmKey = await dmKeyService.refreshPeerKey(peerId);
    }
    if (!dmKey || envelope.keyId !== dmKey.keyId) {
      return { ...message, content: '🔒 [encrypted DM — key unavailable]' };
    }
    const plaintext = decryptDmMessage(dmKey.key, myId, peerId, message.content);
    return {
      ...message,
      content: plaintext !== null ? `🔒 ${plaintext}` : '🔒 [encrypted DM — decryption failed]',
    };
  } catch {
    return { ...message, content: '🔒 [encrypted DM — could not verify key]' };
  }
}

export interface RelayClientEvents {
  'message:received': (message: Message) => void;
  'message:sent': (message: Message) => void;
  'message:delivered': (messageId: string) => void;
  'message:read': (messageId: string) => void;
  'presence:update': (userId: string, presence: Presence) => void;
  'typing': (userId: string, chatId: string, isTyping: boolean) => void;
  'status': (status: ConnectionStatus) => void;
  'error': (error: Error) => void;
  'p2p:offer': (data: { sourceUserId: string; offer: RTCSessionDescriptionInit; connectionId: string }) => void;
  'p2p:answer': (data: { targetUserId: string; answer: RTCSessionDescriptionInit; connectionId: string }) => void;
  'p2p:ice': (data: { sourceUserId: string; candidate: RTCIceCandidateInit; connectionId: string }) => void;
  'p2p:request': (data: { sourceUserId: string; connectionId: string }) => void;
  'p2p:response': (data: { targetUserId: string; accepted: boolean; connectionId: string; error?: string }) => void;
  'build:task': (task: BuildTask) => void;
  'build:session_status': (status: MemberSessionStatus & { username?: string }) => void;
  'build:context_clear_request': (payload: { channelId: string; taskId?: string; targetUsername?: string }) => void;
  'build:context_clear_ack': (payload: { channelId: string; taskId?: string; userId?: string; username?: string }) => void;
  'build:artifact_request': (payload: { channelId: string; taskId: string }) => void;
  'build:artifact_payload': (payload: { channelId: string; taskId: string; filename: string; data: string; workerId?: string; workerUsername?: string }) => void;
  'build:artifact_cleared': (payload: { channelId: string; taskId: string; workerId?: string; workerUsername?: string }) => void;
  'build:artifact_clear_request': (payload: { channelId: string; taskId: string }) => void;
  'collab:context_share': (share: ContextShare) => void;
  'collab:context_revoke': (payload: { channelId?: string; recipientId?: string; userId: string; username?: string }) => void;
  'collab:context_request': (payload: { channelId?: string; recipientId?: string; targetUsername?: string; requesterId: string; requesterUsername?: string }) => void;
}

export class RelayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private messageQueue: ProtocolMessage[] = [];
  private authToken: string | null = null;
  private deviceFingerprint: string | null = null;
  // Index into configManager.getRelayPool(); advances when the current relay
  // fails so reconnects land on the next pool member (federation failover).
  private poolIndex = 0;

  constructor() {
    super();
  }

  connect(token: string, deviceFingerprint?: string): void {
    this.authToken = token;
    this.deviceFingerprint = deviceFingerprint || null;
    this.poolIndex = 0;
    this.doConnect();
  }

  private doConnect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.setStatus('connecting');

    const pool = configManager.getRelayPool();
    const relayUrl = pool[this.poolIndex % pool.length];

    try {
      this.ws = new WebSocket(relayUrl);

      const connectionTimeout = setTimeout(() => {
        if (this.ws?.readyState !== WebSocket.OPEN) {
          this.ws?.close();
          this.handleError(new Error('Connection timeout'));
        }
      }, CONNECTION_TIMEOUT);

      this.ws.on('open', () => {
        clearTimeout(connectionTimeout);
        this.setStatus('connected');
        this.reconnectAttempts = 0;

        // Authenticate with device fingerprint
        this.send({
          id: uuidv4(),
          type: 'auth',
          timestamp: Date.now(),
          // Omit deviceFingerprint when absent — the relay's AuthPayloadSchema accepts a
          // string or nothing, but rejects null (z.string().optional()).
          payload: { token: this.authToken, deviceFingerprint: this.deviceFingerprint ?? undefined },
        });

        // Flush message queue
        this.flushQueue();

        // Start ping interval
        this.startPing();
      });

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString()) as ProtocolMessage;
          this.handleMessage(message);
        } catch (error) {
          console.error('Failed to parse message:', error);
        }
      });

      this.ws.on('close', (code) => {
        clearTimeout(connectionTimeout);
        this.stopPing();
        // 1013 = try again later: a decommissioned federation node telling us
        // to fail over to another pool relay immediately.
        if (code === 1013) {
          this.poolIndex++;
        }
        this.handleDisconnect();
      });

      this.ws.on('error', (error) => {
        clearTimeout(connectionTimeout);
        // Connection-level failure: try the next pool member on reconnect.
        this.poolIndex++;
        this.handleError(error);
      });
    } catch (error) {
      this.handleError(error as Error);
    }
  }

  disconnect(): void {
    this.stopReconnect();
    this.stopPing();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.setStatus('disconnected');
  }

  send(message: ProtocolMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    } else {
      this.messageQueue.push(message);
      return false;
    }
  }

  sendMessage(recipientId: string, content: string, isEphemeral = false): void {
    this.send({
      id: uuidv4(),
      type: 'message',
      timestamp: Date.now(),
      payload: {
        recipientId,
        content,
        isEphemeral,
        clientMessageId: uuidv4(),
      },
    });
  }

  sendChannelMessage(channelId: string, content: string, isEphemeral = false): void {
    this.send({
      id: uuidv4(),
      type: 'channel_message',
      timestamp: Date.now(),
      payload: {
        channelId,
        content,
        isEphemeral,
        clientMessageId: uuidv4(),
      },
    });
  }

  editMessage(messageId: string, content: string): void {
    this.send({
      id: uuidv4(),
      type: 'message_edit',
      timestamp: Date.now(),
      payload: { messageId, content },
    });
  }

  deleteMessage(messageId: string, deleteForEveryone = false): void {
    this.send({
      id: uuidv4(),
      type: 'message_delete',
      timestamp: Date.now(),
      payload: { messageId, deleteForEveryone },
    });
  }

  updatePresence(status: Presence['status'], message?: string): void {
    this.send({
      id: uuidv4(),
      type: 'presence_update',
      timestamp: Date.now(),
      payload: { status, message },
    });
  }

  sendTyping(chatId: string, isTyping: boolean): void {
    this.send({
      id: uuidv4(),
      type: 'typing',
      timestamp: Date.now(),
      payload: { chatId, isTyping },
    });
  }

  sendP2POffer(targetUserId: string, offer: RTCSessionDescriptionInit, connectionId: string): void {
    this.send({
      id: uuidv4(),
      type: 'p2p_offer',
      timestamp: Date.now(),
      payload: { targetUserId, offer, connectionId },
    });
  }

  sendP2PAnswer(sourceUserId: string, answer: RTCSessionDescriptionInit, connectionId: string): void {
    this.send({
      id: uuidv4(),
      type: 'p2p_answer',
      timestamp: Date.now(),
      payload: { sourceUserId, answer, connectionId },
    });
  }

  sendP2PIceCandidate(targetUserId: string, candidate: RTCIceCandidateInit, connectionId: string): void {
    this.send({
      id: uuidv4(),
      type: 'p2p_ice_candidate',
      timestamp: Date.now(),
      payload: { targetUserId, candidate, connectionId },
    });
  }

  sendBuildTaskCreate(channelId: string, title: string, description?: string): void {
    this.send({
      id: uuidv4(),
      type: 'build_task_create',
      timestamp: Date.now(),
      payload: { channelId, title, description, status: 'pending' },
    });
  }

  sendBuildTaskAssign(channelId: string, taskId: string, assignedTo: string): void {
    this.send({
      id: uuidv4(),
      type: 'build_task_assign',
      timestamp: Date.now(),
      payload: { channelId, taskId, assignedTo, status: 'assigned' },
    });
  }

  sendBuildTaskUpdate(channelId: string, taskId: string, updates: { title?: string; description?: string; status?: string }): void {
    this.send({
      id: uuidv4(),
      type: 'build_task_update',
      timestamp: Date.now(),
      payload: { channelId, taskId, ...updates },
    });
  }

  sendBuildTaskComplete(channelId: string, taskId: string, artifactFilename?: string, artifactSize?: number): void {
    this.send({
      id: uuidv4(),
      type: 'build_task_complete',
      timestamp: Date.now(),
      payload: { channelId, taskId, status: 'completed', artifactFilename, artifactSize },
    });
  }

  sendSessionStatusReport(channelId: string, status: Omit<MemberSessionStatus, 'userId' | 'channelId' | 'reportedAt'>): void {
    this.send({
      id: uuidv4(),
      type: 'session_status_report',
      timestamp: Date.now(),
      payload: { channelId, ...status },
    });
  }

  sendSessionStatusRequest(channelId: string): void {
    this.send({
      id: uuidv4(),
      type: 'session_status_request',
      timestamp: Date.now(),
      payload: { channelId },
    });
  }

  sendContextClearRequest(channelId: string, taskId?: string, targetUsername?: string): void {
    this.send({
      id: uuidv4(),
      type: 'context_clear_request',
      timestamp: Date.now(),
      payload: { channelId, taskId, targetUsername },
    });
  }

  sendContextClearAck(channelId: string, taskId?: string): void {
    this.send({
      id: uuidv4(),
      type: 'context_clear_ack',
      timestamp: Date.now(),
      payload: { channelId, taskId },
    });
  }

  sendBuildArtifactRequest(channelId: string, taskId: string): void {
    this.send({
      id: uuidv4(),
      type: 'build_artifact_request',
      timestamp: Date.now(),
      payload: { channelId, taskId },
    });
  }

  sendBuildArtifactPayload(channelId: string, taskId: string, filename: string, data: string): void {
    this.send({
      id: uuidv4(),
      type: 'build_artifact_payload',
      timestamp: Date.now(),
      payload: { channelId, taskId, filename, data },
    });
  }

  sendBuildArtifactCleared(channelId: string, taskId: string): void {
    this.send({
      id: uuidv4(),
      type: 'build_artifact_cleared',
      timestamp: Date.now(),
      payload: { channelId, taskId },
    });
  }

  sendBuildArtifactClearRequest(channelId: string, taskId: string): void {
    this.send({
      id: uuidv4(),
      type: 'build_artifact_clear_request',
      timestamp: Date.now(),
      payload: { channelId, taskId },
    });
  }

  sendContextShare(
    scope: { channelId?: string; recipientId?: string },
    share: {
      summary: string;
      details?: string;
      files?: string[];
      status?: ContextShareStatus;
      project?: string;
      git?: ContextGitInfo;
      taskId?: string;
      ttlMinutes?: number;
    }
  ): void {
    this.send({
      id: uuidv4(),
      type: 'context_share',
      timestamp: Date.now(),
      payload: { ...scope, ...share },
    });
  }

  sendContextShareRevoke(scope: { channelId?: string; recipientId?: string }): void {
    this.send({
      id: uuidv4(),
      type: 'context_share_revoke',
      timestamp: Date.now(),
      payload: scope,
    });
  }

  sendContextShareRequest(scope: { channelId?: string; recipientId?: string; targetUsername?: string }): void {
    this.send({
      id: uuidv4(),
      type: 'context_share_request',
      timestamp: Date.now(),
      payload: scope,
    });
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  // DM envelope decryption needs the peer's published key (async). Plaintext
  // and channel messages emit synchronously to preserve ordering; only DM
  // envelopes take the async path.
  private emitDm(event: 'message:received' | 'message:sent', message: Message): void {
    if (message.channelId || !parseEncryptedEnvelope(message.content)) {
      this.emit(event, message);
      return;
    }
    decryptDmIfNeeded(message)
      .then(m => this.emit(event, m))
      .catch(() => this.emit(event, message));
  }

  private handleMessage(message: ProtocolMessage): void {
    switch (message.type) {
      case 'message':
        this.emitDm('message:received', (message.payload as { message: Message }).message);
        break;
      case 'channel_message':
        this.emit('message:received', decryptIfNeeded((message.payload as { message: Message }).message));
        break;
      case 'message_sent':
        this.emitDm('message:sent', (message.payload as { message: Message }).message);
        break;
      case 'message_delivered':
        this.emit('message:delivered', (message.payload as { messageId: string }).messageId);
        break;
      case 'message_read':
        this.emit('message:read', (message.payload as { messageId: string }).messageId);
        break;
      case 'presence_update':
        const { userId, presence } = message.payload as { userId: string; presence: Presence };
        this.emit('presence:update', userId, presence);
        break;
      case 'typing':
        const { chatId, isTyping, userId: typingUserId } = message.payload as { userId: string; chatId: string; isTyping: boolean };
        this.emit('typing', typingUserId, chatId, isTyping);
        break;
      case 'p2p_offer':
        this.emit('p2p:offer', message.payload as { sourceUserId: string; offer: RTCSessionDescriptionInit; connectionId: string });
        break;
      case 'p2p_answer':
        this.emit('p2p:answer', message.payload as { targetUserId: string; answer: RTCSessionDescriptionInit; connectionId: string });
        break;
      case 'p2p_ice_candidate':
        this.emit('p2p:ice', message.payload as { sourceUserId: string; candidate: RTCIceCandidateInit; connectionId: string });
        break;
      case 'p2p_request':
        this.emit('p2p:request', message.payload as { sourceUserId: string; connectionId: string });
        break;
      case 'p2p_response':
        this.emit('p2p:response', message.payload as { targetUserId: string; accepted: boolean; connectionId: string; error?: string });
        break;
      case 'build_task_create':
      case 'build_task_assign':
      case 'build_task_update':
      case 'build_task_complete':
        this.emit('build:task', this.payloadToBuildTask(message.payload as any));
        break;
      case 'session_status_report':
        this.emit('build:session_status', message.payload as MemberSessionStatus & { username?: string });
        break;
      case 'context_clear_request':
        this.emit('build:context_clear_request', message.payload as { channelId: string; taskId?: string; targetUsername?: string });
        break;
      case 'context_clear_ack':
        this.emit('build:context_clear_ack', message.payload as { channelId: string; taskId?: string; userId?: string; username?: string });
        break;
      case 'build_artifact_request':
        this.emit('build:artifact_request', message.payload as { channelId: string; taskId: string });
        break;
      case 'build_artifact_payload':
        this.emit('build:artifact_payload', message.payload as { channelId: string; taskId: string; filename: string; data: string; workerId?: string; workerUsername?: string });
        break;
      case 'build_artifact_cleared':
        this.emit('build:artifact_cleared', message.payload as { channelId: string; taskId: string; workerId?: string; workerUsername?: string });
        break;
      case 'build_artifact_clear_request':
        this.emit('build:artifact_clear_request', message.payload as { channelId: string; taskId: string });
        break;
      case 'context_share':
        this.emit('collab:context_share', (message.payload as { share: ContextShare }).share);
        break;
      case 'context_share_revoke':
        this.emit('collab:context_revoke', message.payload as { channelId?: string; recipientId?: string; userId: string; username?: string });
        break;
      case 'context_share_request':
        this.emit('collab:context_request', message.payload as { channelId?: string; recipientId?: string; targetUsername?: string; requesterId: string; requesterUsername?: string });
        break;
      case 'pong':
        // Ping response received
        break;
      case 'auth_response':
        const { success, error } = message.payload as { success: boolean; error?: string };
        if (!success) {
          this.emit('error', new Error(error || 'Authentication failed'));
          this.disconnect();
        }
        break;
      case 'message_error':
        const { message: errorMsg } = message.payload as { code: string; message: string };
        this.emit('error', new Error(errorMsg));
        break;
    }
  }

  private handleDisconnect(): void {
    this.setStatus('disconnected');
    this.scheduleReconnect();
  }

  private handleError(error: Error): void {
    console.error('Relay client error:', error);
    this.setStatus('error');
    this.emit('error', error);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.setStatus('error');
      this.emit('error', new Error('Max reconnect attempts reached'));
      return;
    }

    this.setStatus('reconnecting');
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, RECONNECT_INTERVAL);
  }

  private stopReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      this.send({
        id: uuidv4(),
        type: 'ping',
        timestamp: Date.now(),
        payload: {},
      });
    }, 30000);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private flushQueue(): void {
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      if (message) this.send(message);
    }
  }

  private payloadToBuildTask(payload: any): BuildTask {
    return {
      id: payload.taskId,
      channelId: payload.channelId,
      ownerId: payload.ownerId,
      title: payload.title,
      description: payload.description,
      status: payload.status,
      assignedTo: payload.assignedTo,
      artifactFilename: payload.artifactFilename,
      artifactSize: payload.artifactSize,
      createdAt: new Date(payload.createdAt || Date.now()),
      assignedAt: payload.assignedAt ? new Date(payload.assignedAt) : undefined,
      completedAt: payload.completedAt ? new Date(payload.completedAt) : undefined,
      contextClearedAt: payload.contextClearedAt ? new Date(payload.contextClearedAt) : undefined,
    };
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.emit('status', status);
  }
}

export const relayClient = new RelayClient();
