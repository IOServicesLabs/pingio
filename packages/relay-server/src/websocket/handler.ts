import type { WebSocket } from 'ws';
import type { SessionService, Session } from '../services/session.js';
import type { AuthService } from '../services/auth.js';
import type { PresenceService } from '../services/presence.js';
import type { RateLimitService } from '../services/rate-limit.js';
import type { PostgresStore } from '../stores/postgres.js';
import type { ProtocolMessage, MessagePayload } from '@pingio/shared';
import {
  ProtocolMessageTypeSchema,
  AuthPayloadSchema,
  SendMessagePayloadSchema,
  EditMessagePayloadSchema,
  DeleteMessagePayloadSchema,
  ChannelMessagePayloadSchema,
  PresenceUpdatePayloadSchema,
  TypingPayloadSchema,
  P2POfferPayloadSchema,
  P2PAnswerPayloadSchema,
  P2PIceCandidatePayloadSchema,
  P2PRequestPayloadSchema,
  P2PResponsePayloadSchema,
  BuildTaskPayloadSchema,
  MemberSessionStatusPayloadSchema,
  ContextClearPayloadSchema,
  BuildArtifactRequestPayloadSchema,
  BuildArtifactPayloadSchema,
  BuildArtifactClearedPayloadSchema,
  BuildArtifactClearRequestPayloadSchema,
  ContextSharePayloadSchema,
  ContextShareRevokePayloadSchema,
  ContextShareRequestPayloadSchema,
  AUTH_TIMEOUT,
  ERROR_MESSAGES,
  MAX_DEVICES_PER_USER,
} from '@pingio/shared';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';

// instanceof z.ZodError breaks when the schema lives in a different module
// instance (e.g. vitest processing a workspace dep, or a bundled client with
// its own zod copy). Duck-typing on the error name keeps validation errors
// classified correctly in every environment.
function isZodError(error: unknown): boolean {
  return error instanceof z.ZodError || (error as Error)?.name === 'ZodError';
}

export class WebSocketHandler {
  private sockets: Map<string, WebSocket> = new Map();
  private messageHandlers: Map<string, (socketId: string, payload: unknown) => Promise<void>> = new Map();

  constructor(
    private sessionService: SessionService,
    private authService: AuthService,
    private presenceService: PresenceService,
    private rateLimitService: RateLimitService,
    private postgres: PostgresStore
  ) {
    this.registerHandlers();
  }

  handleConnection(socket: WebSocket, socketId: string): void {
    this.sockets.set(socketId, socket);

    // Set authentication timeout
    const authTimeout = setTimeout(() => {
      if (!this.sessionService.getSession(socketId)) {
        this.sendError(socket, 'auth_timeout', 'Authentication timeout');
        socket.close(1008, 'Authentication timeout');
      }
    }, AUTH_TIMEOUT);

    socket.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString()) as ProtocolMessage;
        await this.handleMessage(socketId, message);
      } catch (error) {
        this.sendError(socket, 'parse_error', 'Invalid message format');
      }
    });

    socket.on('close', async () => {
      clearTimeout(authTimeout);
      try {
        await this.handleDisconnect(socketId);
      } catch (err) {
        // Cleanup errors during shutdown are not fatal; the Redis/Postgres
        // stores may already be closed by the time the socket close event fires.
      }
    });

    socket.on('error', (error) => {
      console.error(`WebSocket error for ${socketId}:`, error);
    });
  }

  private registerHandlers(): void {
    this.messageHandlers.set('auth', this.handleAuth.bind(this));
    this.messageHandlers.set('message', this.handleMessageSend.bind(this));
    this.messageHandlers.set('message_edit', this.handleMessageEdit.bind(this));
    this.messageHandlers.set('message_delete', this.handleMessageDelete.bind(this));
    this.messageHandlers.set('channel_message', this.handleChannelMessage.bind(this));
    this.messageHandlers.set('presence_update', this.handlePresenceUpdate.bind(this));
    this.messageHandlers.set('typing', this.handleTyping.bind(this));
    this.messageHandlers.set('p2p_offer', this.handleP2POffer.bind(this));
    this.messageHandlers.set('p2p_answer', this.handleP2PAnswer.bind(this));
    this.messageHandlers.set('p2p_ice_candidate', this.handleP2PIceCandidate.bind(this));
    this.messageHandlers.set('p2p_request', this.handleP2PRequest.bind(this));
    this.messageHandlers.set('p2p_response', this.handleP2PResponse.bind(this));
    this.messageHandlers.set('build_task_create', this.handleBuildTaskCreate.bind(this));
    this.messageHandlers.set('build_task_assign', this.handleBuildTaskAssign.bind(this));
    this.messageHandlers.set('build_task_update', this.handleBuildTaskUpdate.bind(this));
    this.messageHandlers.set('build_task_complete', this.handleBuildTaskComplete.bind(this));
    this.messageHandlers.set('session_status_report', this.handleSessionStatusReport.bind(this));
    this.messageHandlers.set('session_status_request', this.handleSessionStatusRequest.bind(this));
    this.messageHandlers.set('context_clear_request', this.handleContextClearRequest.bind(this));
    this.messageHandlers.set('context_clear_ack', this.handleContextClearAck.bind(this));
    this.messageHandlers.set('build_artifact_request', this.handleBuildArtifactRequest.bind(this));
    this.messageHandlers.set('build_artifact_payload', this.handleBuildArtifactPayload.bind(this));
    this.messageHandlers.set('build_artifact_cleared', this.handleBuildArtifactCleared.bind(this));
    this.messageHandlers.set('build_artifact_clear_request', this.handleBuildArtifactClearRequest.bind(this));
    this.messageHandlers.set('context_share', this.handleContextShare.bind(this));
    this.messageHandlers.set('context_share_revoke', this.handleContextShareRevoke.bind(this));
    this.messageHandlers.set('context_share_request', this.handleContextShareRequest.bind(this));
    this.messageHandlers.set('ping', this.handlePing.bind(this));
  }

  private async handleMessage(socketId: string, message: ProtocolMessage): Promise<void> {
    const handler = this.messageHandlers.get(message.type);
    if (!handler) {
      this.sendErrorToSocket(socketId, 'unknown_type', `Unknown message type: ${message.type}`);
      return;
    }

    try {
      await handler(socketId, message.payload);
    } catch (error) {
      console.error(`Error handling message type ${message.type}:`, error);
      this.sendErrorToSocket(socketId, 'handler_error', 'Failed to process message');
    }
  }

  private async checkDeviceVerification(userId: string, deviceIdFromToken?: string, deviceFingerprint?: string): Promise<{ verified: boolean; deviceId?: string; needsVerification?: boolean }> {
    // In central auth mode, device verification is handled by the auth service.
    // The relay trusts the token's device_id claim.
    if (process.env.AUTH_MODE === 'central') {
      return { verified: true, deviceId: deviceIdFromToken };
    }

    // If device verification is disabled, always return verified
    if (process.env.DEVICE_VERIFICATION_REQUIRED !== 'true') {
      return { verified: true };
    }

    if (!deviceFingerprint) {
      return { verified: false, needsVerification: true };
    }

    // Check if device exists
    const existingDevice = await this.postgres.getDeviceByFingerprint(userId, deviceFingerprint);

    if (existingDevice) {
      // Device exists - check if verified
      if (existingDevice.isVerified) {
        await this.postgres.updateDeviceLastSeen(existingDevice.id);
        return { verified: true, deviceId: existingDevice.id };
      } else {
        return { verified: false, deviceId: existingDevice.id, needsVerification: true };
      }
    }

    // Check device limit
    const deviceCount = await this.postgres.getDeviceCount(userId);
    if (deviceCount >= MAX_DEVICES_PER_USER) {
      return { verified: false, needsVerification: true };
    }

    // Create new unverified device
    const newDevice = await this.postgres.createDevice(userId, deviceFingerprint, undefined, undefined, false);
    if (newDevice) {
      return { verified: false, deviceId: newDevice.id, needsVerification: true };
    }

    return { verified: false, needsVerification: true };
  }

  private async handleAuth(socketId: string, payload: unknown): Promise<void> {
    const socket = this.sockets.get(socketId);
    if (!socket) return;

    try {
      const { token, deviceFingerprint } = AuthPayloadSchema.parse(payload) as { token: string; deviceFingerprint?: string };
      const decoded = await this.authService.verifyToken(token);

      if (!decoded) {
        this.send(socket, {
          id: uuidv4(),
          type: 'auth_response',
          timestamp: Date.now(),
          payload: { success: false, error: ERROR_MESSAGES.UNAUTHORIZED },
        });
        return;
      }

      // Check device verification
      const deviceCheck = await this.checkDeviceVerification(decoded.userId, decoded.deviceId, deviceFingerprint);

      if (!deviceCheck.verified && deviceCheck.needsVerification) {
        this.send(socket, {
          id: uuidv4(),
          type: 'auth_response',
          timestamp: Date.now(),
          payload: {
            success: false,
            verificationRequired: true,
            deviceId: deviceCheck.deviceId,
            error: ERROR_MESSAGES.DEVICE_VERIFICATION_REQUIRED,
          },
        });
        return;
      }

      // Create session with device info
      const session = await this.sessionService.createSession(
        decoded.userId,
        decoded.username,
        socketId,
        deviceCheck.deviceId
      );

      // Send success response
      const user = await this.authService.getUser(decoded.userId);
      this.send(socket, {
        id: uuidv4(),
        type: 'auth_response',
        timestamp: Date.now(),
        payload: { success: true, user, deviceId: deviceCheck.deviceId },
      });

      // Set initial presence
      await this.presenceService.updatePresence(decoded.userId, decoded.username, 'online');
    } catch (error) {
      if (isZodError(error)) {
        this.sendError(socket, 'validation_error', 'Invalid auth payload');
      } else {
        this.sendError(socket, 'auth_error', 'Authentication failed');
      }
    }
  }

  private async handleMessageSend(socketId: string, payload: unknown): Promise<void> {
    const session = this.sessionService.getSession(socketId);
    if (!session) {
      this.sendErrorToSocket(socketId, 'unauthorized', ERROR_MESSAGES.UNAUTHORIZED);
      return;
    }

    // Rate limit check
    const allowed = await this.rateLimitService.checkMessageRateLimit(session.userId);
    if (!allowed) {
      this.sendErrorToSocket(socketId, 'rate_limited', ERROR_MESSAGES.RATE_LIMITED);
      return;
    }

    try {
      const { recipientId, content, isEphemeral, clientMessageId } = SendMessagePayloadSchema.parse(payload);

      // Check mutual contact relationship
      const isMutualContact = await this.postgres.checkMutualContact(session.userId, recipientId);
      if (!isMutualContact) {
        this.sendErrorToSocket(socketId, 'not_mutual_contact', ERROR_MESSAGES.NOT_MUTUAL_CONTACT);
        return;
      }

      // Check blocked status
      const blockStatus = await this.postgres.isBlocked(session.userId, recipientId);
      if (blockStatus.blockedBy) {
        this.sendErrorToSocket(socketId, 'blocked', ERROR_MESSAGES.BLOCKED);
        return;
      }
      if (blockStatus.blockedTarget) {
        this.sendErrorToSocket(socketId, 'blocked', 'You have blocked this user');
        return;
      }

      // Create message in database
      const message = await this.postgres.createMessage(
        session.userId,
        content,
        recipientId,
        undefined,
        isEphemeral || false
      );

      // Send confirmation to sender
      const socket = this.sockets.get(socketId);
      if (socket) {
        this.send(socket, {
          id: uuidv4(),
          type: 'message_sent',
          timestamp: Date.now(),
          payload: { message, clientMessageId },
        });
      }

      // Try to deliver to recipient if online
      const recipientSessions = this.sessionService.getSessionsByUser(recipientId);
      for (const recipientSession of recipientSessions) {
        const recipientSocket = this.sockets.get(recipientSession.socketId);
        if (recipientSocket) {
          this.send(recipientSocket, {
            id: uuidv4(),
            type: 'message',
            timestamp: Date.now(),
            payload: { message },
          });
        }
      }
    } catch (error) {
      if (isZodError(error)) {
        this.sendErrorToSocket(socketId, 'validation_error', 'Invalid message payload');
      } else {
        this.sendErrorToSocket(socketId, 'message_error', 'Failed to send message');
      }
    }
  }

  private async handleMessageEdit(socketId: string, payload: unknown): Promise<void> {
    const session = this.sessionService.getSession(socketId);
    if (!session) {
      this.sendErrorToSocket(socketId, 'unauthorized', ERROR_MESSAGES.UNAUTHORIZED);
      return;
    }

    try {
      const { messageId, content } = EditMessagePayloadSchema.parse(payload);

      // Get the message to verify ownership
      const message = await this.postgres.getMessage(messageId);
      if (!message || message.senderId !== session.userId) {
        this.sendErrorToSocket(socketId, 'forbidden', ERROR_MESSAGES.FORBIDDEN);
        return;
      }

      // Edit the message
      const updated = await this.postgres.editMessage(messageId, content);
      if (!updated) {
        this.sendErrorToSocket(socketId, 'not_found', ERROR_MESSAGES.MESSAGE_NOT_FOUND);
        return;
      }

      // Notify recipient if it's a DM
      if (message.recipientId) {
        const recipientSessions = this.sessionService.getSessionsByUser(message.recipientId);
        for (const recipientSession of recipientSessions) {
          const recipientSocket = this.sockets.get(recipientSession.socketId);
          if (recipientSocket) {
            this.send(recipientSocket, {
              id: uuidv4(),
              type: 'message_edit',
              timestamp: Date.now(),
              payload: { message: updated },
            });
          }
        }
      }

      // Notify channel members if it's a channel message
      if (message.channelId) {
        const members = await this.postgres.getChannelMembers(message.channelId);
        for (const member of members) {
          if (member.userId === session.userId) continue;
          const memberSessions = this.sessionService.getSessionsByUser(member.userId);
          for (const memberSession of memberSessions) {
            const memberSocket = this.sockets.get(memberSession.socketId);
            if (memberSocket) {
              this.send(memberSocket, {
                id: uuidv4(),
                type: 'message_edit',
                timestamp: Date.now(),
                payload: { message: updated },
              });
            }
          }
        }
      }
    } catch (error) {
      this.sendErrorToSocket(socketId, 'validation_error', 'Invalid edit payload');
    }
  }

  private async handleMessageDelete(socketId: string, payload: unknown): Promise<void> {
    const session = this.sessionService.getSession(socketId);
    if (!session) {
      this.sendErrorToSocket(socketId, 'unauthorized', ERROR_MESSAGES.UNAUTHORIZED);
      return;
    }

    try {
      const { messageId, deleteForEveryone } = DeleteMessagePayloadSchema.parse(payload);

      // Get the message to verify ownership
      const message = await this.postgres.getMessage(messageId);
      if (!message || message.senderId !== session.userId) {
        this.sendErrorToSocket(socketId, 'forbidden', ERROR_MESSAGES.FORBIDDEN);
        return;
      }

      // Delete the message
      await this.postgres.deleteMessage(messageId, deleteForEveryone);

      // Notify recipient if deleting for everyone and it's a DM
      if (deleteForEveryone && message.recipientId) {
        const recipientSessions = this.sessionService.getSessionsByUser(message.recipientId);
        for (const recipientSession of recipientSessions) {
          const recipientSocket = this.sockets.get(recipientSession.socketId);
          if (recipientSocket) {
            this.send(recipientSocket, {
              id: uuidv4(),
              type: 'message_delete',
              timestamp: Date.now(),
              payload: { messageId },
            });
          }
        }
      }
    } catch (error) {
      this.sendErrorToSocket(socketId, 'validation_error', 'Invalid delete payload');
    }
  }

  private async handleChannelMessage(socketId: string, payload: unknown): Promise<void> {
    const session = this.sessionService.getSession(socketId);
    if (!session) {
      this.sendErrorToSocket(socketId, 'unauthorized', ERROR_MESSAGES.UNAUTHORIZED);
      return;
    }

    // Rate limit check
    const allowed = await this.rateLimitService.checkMessageRateLimit(session.userId);
    if (!allowed) {
      this.sendErrorToSocket(socketId, 'rate_limited', ERROR_MESSAGES.RATE_LIMITED);
      return;
    }

    try {
      const { channelId, content, isEphemeral, clientMessageId } = ChannelMessagePayloadSchema.parse(payload);

      // Check if user is a member of the channel
      const members = await this.postgres.getChannelMembers(channelId);
      const isMember = members.some(m => m.userId === session.userId);
      if (!isMember) {
        this.sendErrorToSocket(socketId, 'forbidden', ERROR_MESSAGES.NOT_IN_CHANNEL);
        return;
      }

      // Create message in database
      const message = await this.postgres.createMessage(
        session.userId,
        content,
        undefined,
        channelId,
        isEphemeral || false
      );

      // Send confirmation to sender
      const socket = this.sockets.get(socketId);
      if (socket) {
        this.send(socket, {
          id: uuidv4(),
          type: 'message_sent',
          timestamp: Date.now(),
          payload: { message, clientMessageId },
        });
      }

      // Broadcast to all channel members
      for (const member of members) {
        if (member.userId === session.userId) continue;
        const memberSessions = this.sessionService.getSessionsByUser(member.userId);
        for (const memberSession of memberSessions) {
          const memberSocket = this.sockets.get(memberSession.socketId);
          if (memberSocket) {
            this.send(memberSocket, {
              id: uuidv4(),
              type: 'channel_message',
              timestamp: Date.now(),
              payload: { message },
            });
          }
        }
      }
    } catch (error) {
      this.sendErrorToSocket(socketId, 'validation_error', 'Invalid channel message payload');
    }
  }

  private async handlePresenceUpdate(socketId: string, payload: unknown): Promise<void> {
    const session = this.sessionService.getSession(socketId);
    if (!session) {
      this.sendErrorToSocket(socketId, 'unauthorized', ERROR_MESSAGES.UNAUTHORIZED);
      return;
    }

    try {
      const { status, message } = PresenceUpdatePayloadSchema.parse(payload);
      await this.presenceService.updatePresence(session.userId, session.username, status, message);
    } catch (error) {
      this.sendErrorToSocket(socketId, 'validation_error', 'Invalid presence payload');
    }
  }

  private async handleTyping(socketId: string, payload: unknown): Promise<void> {
    const session = this.sessionService.getSession(socketId);
    if (!session) return;

    try {
      const { chatId, isTyping } = TypingPayloadSchema.parse(payload);
      await this.presenceService.setTyping(session.userId, chatId, isTyping);
    } catch (error) {
      // Silently ignore typing errors
    }
  }

  private async handleP2POffer(socketId: string, payload: unknown): Promise<void> {
    const session = this.sessionService.getSession(socketId);
    if (!session) {
      this.sendErrorToSocket(socketId, 'unauthorized', ERROR_MESSAGES.UNAUTHORIZED);
      return;
    }

    try {
      const { targetUserId, offer, connectionId } = P2POfferPayloadSchema.parse(payload);

      // Check mutual contact relationship for P2P
      const isMutualContact = await this.postgres.checkMutualContact(session.userId, targetUserId);
      if (!isMutualContact) {
        this.sendErrorToSocket(socketId, 'not_mutual_contact', ERROR_MESSAGES.NOT_MUTUAL_CONTACT);
        return;
      }

      // Check blocked status
      const blockStatus = await this.postgres.isBlocked(session.userId, targetUserId);
      if (blockStatus.blockedBy || blockStatus.blockedTarget) {
        this.sendErrorToSocket(socketId, 'blocked', ERROR_MESSAGES.BLOCKED);
        return;
      }

      // Forward to target user
      const targetSessions = this.sessionService.getSessionsByUser(targetUserId);
      for (const targetSession of targetSessions) {
        const targetSocket = this.sockets.get(targetSession.socketId);
        if (targetSocket) {
          this.send(targetSocket, {
            id: uuidv4(),
            type: 'p2p_offer',
            timestamp: Date.now(),
            payload: {
              sourceUserId: session.userId,
              offer,
              connectionId,
            },
          });
        }
      }
    } catch (error) {
      this.sendErrorToSocket(socketId, 'validation_error', 'Invalid P2P offer payload');
    }
  }

  private async handleP2PAnswer(socketId: string, payload: unknown): Promise<void> {
    const session = this.sessionService.getSession(socketId);
    if (!session) return;

    try {
      const { sourceUserId, answer, connectionId } = P2PAnswerPayloadSchema.parse(payload);

      // Forward to source user
      const sourceSessions = this.sessionService.getSessionsByUser(sourceUserId);
      for (const sourceSession of sourceSessions) {
        const sourceSocket = this.sockets.get(sourceSession.socketId);
        if (sourceSocket) {
          this.send(sourceSocket, {
            id: uuidv4(),
            type: 'p2p_answer',
            timestamp: Date.now(),
            payload: {
              targetUserId: session.userId,
              answer,
              connectionId,
            },
          });
        }
      }
    } catch (error) {
      // Silently ignore
    }
  }

  private async handleP2PIceCandidate(socketId: string, payload: unknown): Promise<void> {
    const session = this.sessionService.getSession(socketId);
    if (!session) return;

    try {
      const { targetUserId, candidate, connectionId } = P2PIceCandidatePayloadSchema.parse(payload);

      if (!targetUserId) return;

      // Forward to target user
      const targetSessions = this.sessionService.getSessionsByUser(targetUserId);
      for (const targetSession of targetSessions) {
        const targetSocket = this.sockets.get(targetSession.socketId);
        if (targetSocket) {
          this.send(targetSocket, {
            id: uuidv4(),
            type: 'p2p_ice_candidate',
            timestamp: Date.now(),
            payload: {
              sourceUserId: session.userId,
              candidate,
              connectionId,
            },
          });
        }
      }
    } catch (error) {
      // Silently ignore
    }
  }

  private async handleP2PRequest(socketId: string, payload: unknown): Promise<void> {
    const session = this.sessionService.getSession(socketId);
    if (!session) return;

    try {
      const { targetUserId, connectionId } = P2PRequestPayloadSchema.parse(payload);

      // Check mutual contact relationship for P2P
      const isMutualContact = await this.postgres.checkMutualContact(session.userId, targetUserId);
      if (!isMutualContact) {
        return; // Silently fail for P2P requests
      }

      // Check blocked status
      const blockStatus = await this.postgres.isBlocked(session.userId, targetUserId);
      if (blockStatus.blockedBy || blockStatus.blockedTarget) {
        return; // Silently fail
      }

      // Forward to target user
      const targetSessions = this.sessionService.getSessionsByUser(targetUserId);
      for (const targetSession of targetSessions) {
        const targetSocket = this.sockets.get(targetSession.socketId);
        if (targetSocket) {
          this.send(targetSocket, {
            id: uuidv4(),
            type: 'p2p_request',
            timestamp: Date.now(),
            payload: {
              sourceUserId: session.userId,
              connectionId,
            },
          });
        }
      }
    } catch (error) {
      // Silently ignore
    }
  }

  private async handleP2PResponse(socketId: string, payload: unknown): Promise<void> {
    const session = this.sessionService.getSession(socketId);
    if (!session) return;

    try {
      const { accepted, sourceUserId, connectionId, error } = P2PResponsePayloadSchema.parse(payload);

      // Forward to source user
      const sourceSessions = this.sessionService.getSessionsByUser(sourceUserId);
      for (const sourceSession of sourceSessions) {
        const sourceSocket = this.sockets.get(sourceSession.socketId);
        if (sourceSocket) {
          this.send(sourceSocket, {
            id: uuidv4(),
            type: 'p2p_response',
            timestamp: Date.now(),
            payload: {
              accepted,
              targetUserId: session.userId,
              connectionId,
              error,
            },
          });
        }
      }
    } catch (error) {
      // Silently ignore
    }
  }

  private async handlePing(socketId: string, payload: unknown): Promise<void> {
    const socket = this.sockets.get(socketId);
    if (socket) {
      this.send(socket, {
        id: uuidv4(),
        type: 'pong',
        timestamp: Date.now(),
        payload: {},
      });
    }
    await this.sessionService.updateActivity(socketId);
  }

  // Build group handlers
  private async handleBuildTaskCreate(socketId: string, payload: unknown): Promise<void> {
    const session = this.sessionService.getSession(socketId);
    if (!session) {
      this.sendErrorToSocket(socketId, 'unauthorized', ERROR_MESSAGES.UNAUTHORIZED);
      return;
    }

    try {
      const { channelId, title, description } = BuildTaskPayloadSchema.parse(payload);

      const channel = await this.postgres.getChannel(channelId);
      if (!channel || channel.channelType !== 'build') {
        this.sendErrorToSocket(socketId, 'not_build_group', 'Not a build group');
        return;
      }

      const members = await this.postgres.getChannelMembers(channelId);
      if (!members.some(m => m.userId === session.userId)) {
        this.sendErrorToSocket(socketId, 'forbidden', ERROR_MESSAGES.NOT_IN_CHANNEL);
        return;
      }

      const task = await this.postgres.createBuildTask(channelId, session.userId, title, description);
      this.broadcastToChannel(channelId, {
        id: uuidv4(),
        type: 'build_task_create',
        timestamp: Date.now(),
        payload: this.buildTaskToPayload(task),
      });
    } catch (error) {
      if (isZodError(error)) {
        this.sendErrorToSocket(socketId, 'validation_error', 'Invalid build task payload');
      } else {
        this.sendErrorToSocket(socketId, 'handler_error', 'Failed to create build task');
      }
    }
  }

  private async handleBuildTaskAssign(socketId: string, payload: unknown): Promise<void> {
    const session = this.sessionService.getSession(socketId);
    if (!session) {
      this.sendErrorToSocket(socketId, 'unauthorized', ERROR_MESSAGES.UNAUTHORIZED);
      return;
    }

    try {
      const { channelId, taskId, assignedTo } = BuildTaskPayloadSchema.parse(payload);
      if (!assignedTo) {
        this.sendErrorToSocket(socketId, 'validation_error', 'Missing assignedTo');
        return;
      }

      const channel = await this.postgres.getChannel(channelId);
      if (!channel || channel.ownerId !== session.userId) {
        this.sendErrorToSocket(socketId, 'forbidden', 'Only the owner can assign tasks');
        return;
      }

      const task = await this.postgres.getBuildTaskById(taskId);
      if (!task || task.channelId !== channelId) {
        this.sendErrorToSocket(socketId, 'not_found', 'Task not found');
        return;
      }

      const members = await this.postgres.getChannelMembers(channelId);
      if (!members.some(m => m.userId === assignedTo)) {
        this.sendErrorToSocket(socketId, 'forbidden', 'Assignee is not a member');
        return;
      }

      const assigned = await this.postgres.assignBuildTask(taskId, assignedTo);
      if (!assigned) {
        this.sendErrorToSocket(socketId, 'handler_error', 'Failed to assign task');
        return;
      }

      this.broadcastToChannel(channelId, {
        id: uuidv4(),
        type: 'build_task_assign',
        timestamp: Date.now(),
        payload: this.buildTaskToPayload(assigned),
      });
    } catch (error) {
      if (isZodError(error)) {
        this.sendErrorToSocket(socketId, 'validation_error', 'Invalid build task assign payload');
      } else {
        this.sendErrorToSocket(socketId, 'handler_error', 'Failed to assign build task');
      }
    }
  }

  private async handleBuildTaskUpdate(socketId: string, payload: unknown): Promise<void> {
    const session = this.sessionService.getSession(socketId);
    if (!session) {
      this.sendErrorToSocket(socketId, 'unauthorized', ERROR_MESSAGES.UNAUTHORIZED);
      return;
    }

    try {
      const { channelId, taskId, title, description, status } = BuildTaskPayloadSchema.parse(payload);

      const task = await this.postgres.getBuildTaskById(taskId);
      if (!task || task.channelId !== channelId) {
        this.sendErrorToSocket(socketId, 'not_found', 'Task not found');
        return;
      }

      const members = await this.postgres.getChannelMembers(channelId);
      if (!members.some(m => m.userId === session.userId)) {
        this.sendErrorToSocket(socketId, 'forbidden', ERROR_MESSAGES.NOT_IN_CHANNEL);
        return;
      }

      const updated = await this.postgres.updateBuildTask(taskId, { title, description, status });
      if (!updated) {
        this.sendErrorToSocket(socketId, 'handler_error', 'Failed to update task');
        return;
      }

      this.broadcastToChannel(channelId, {
        id: uuidv4(),
        type: 'build_task_update',
        timestamp: Date.now(),
        payload: this.buildTaskToPayload(updated),
      });
    } catch (error) {
      if (isZodError(error)) {
        this.sendErrorToSocket(socketId, 'validation_error', 'Invalid build task update payload');
      } else {
        this.sendErrorToSocket(socketId, 'handler_error', 'Failed to update build task');
      }
    }
  }

  private async handleBuildTaskComplete(socketId: string, payload: unknown): Promise<void> {
    const session = this.sessionService.getSession(socketId);
    if (!session) {
      this.sendErrorToSocket(socketId, 'unauthorized', ERROR_MESSAGES.UNAUTHORIZED);
      return;
    }

    try {
      const { channelId, taskId, artifactFilename, artifactSize } = BuildTaskPayloadSchema.parse(payload);

      const task = await this.postgres.getBuildTaskById(taskId);
      if (!task || task.channelId !== channelId) {
        this.sendErrorToSocket(socketId, 'not_found', 'Task not found');
        return;
      }

      const members = await this.postgres.getChannelMembers(channelId);
      if (!members.some(m => m.userId === session.userId)) {
        this.sendErrorToSocket(socketId, 'forbidden', ERROR_MESSAGES.NOT_IN_CHANNEL);
        return;
      }

      if (task.assignedTo !== session.userId && task.ownerId !== session.userId) {
        this.sendErrorToSocket(socketId, 'forbidden', 'Only the assigned worker or owner can complete this task');
        return;
      }

      const completed = await this.postgres.completeBuildTask(taskId, artifactFilename, artifactSize);
      if (!completed) {
        this.sendErrorToSocket(socketId, 'handler_error', 'Failed to complete task');
        return;
      }

      this.broadcastToChannel(channelId, {
        id: uuidv4(),
        type: 'build_task_complete',
        timestamp: Date.now(),
        payload: this.buildTaskToPayload(completed),
      });
    } catch (error) {
      if (isZodError(error)) {
        this.sendErrorToSocket(socketId, 'validation_error', 'Invalid build task complete payload');
      } else {
        this.sendErrorToSocket(socketId, 'handler_error', 'Failed to complete build task');
      }
    }
  }

  private async handleSessionStatusReport(socketId: string, payload: unknown): Promise<void> {
    const session = this.sessionService.getSession(socketId);
    if (!session) {
      this.sendErrorToSocket(socketId, 'unauthorized', ERROR_MESSAGES.UNAUTHORIZED);
      return;
    }

    try {
      const { channelId, remainingRequests, contextWindowUsed, selectedModel } = MemberSessionStatusPayloadSchema.parse(payload);

      const members = await this.postgres.getChannelMembers(channelId);
      if (!members.some(m => m.userId === session.userId)) {
        this.sendErrorToSocket(socketId, 'forbidden', ERROR_MESSAGES.NOT_IN_CHANNEL);
        return;
      }

      await this.postgres.updateMemberSessionStatus(session.userId, channelId, {
        remainingRequests,
        contextWindowUsed,
        selectedModel,
      });

      // Forward to channel owner(s)
      const channel = await this.postgres.getChannel(channelId);
      const ownerId = channel?.ownerId;
      if (ownerId && ownerId !== session.userId) {
        this.sendToUser(ownerId, {
          id: uuidv4(),
          type: 'session_status_report',
          timestamp: Date.now(),
          payload: {
            channelId,
            userId: session.userId,
            username: session.username,
            remainingRequests,
            contextWindowUsed,
            selectedModel,
          },
        });
      }
    } catch (error) {
      if (isZodError(error)) {
        this.sendErrorToSocket(socketId, 'validation_error', 'Invalid session status payload');
      } else {
        this.sendErrorToSocket(socketId, 'handler_error', 'Failed to report session status');
      }
    }
  }

  private async handleSessionStatusRequest(socketId: string, payload: unknown): Promise<void> {
    const session = this.sessionService.getSession(socketId);
    if (!session) {
      this.sendErrorToSocket(socketId, 'unauthorized', ERROR_MESSAGES.UNAUTHORIZED);
      return;
    }

    try {
      const { channelId } = MemberSessionStatusPayloadSchema.parse(payload);

      const channel = await this.postgres.getChannel(channelId);
      if (!channel || channel.ownerId !== session.userId) {
        this.sendErrorToSocket(socketId, 'forbidden', 'Only the owner can request session status');
        return;
      }

      this.broadcastToChannel(channelId, {
        id: uuidv4(),
        type: 'session_status_request',
        timestamp: Date.now(),
        payload: { channelId },
      }, session.userId);
    } catch (error) {
      if (isZodError(error)) {
        this.sendErrorToSocket(socketId, 'validation_error', 'Invalid session status request payload');
      }
    }
  }

  private async handleContextClearRequest(socketId: string, payload: unknown): Promise<void> {
    const session = this.sessionService.getSession(socketId);
    if (!session) {
      this.sendErrorToSocket(socketId, 'unauthorized', ERROR_MESSAGES.UNAUTHORIZED);
      return;
    }

    try {
      const { channelId, taskId, targetUsername } = ContextClearPayloadSchema.parse(payload);

      const channel = await this.postgres.getChannel(channelId);
      if (!channel || channel.ownerId !== session.userId) {
        this.sendErrorToSocket(socketId, 'forbidden', 'Only the owner can request context clearing');
        return;
      }

      if (targetUsername) {
        const targetUser = await this.postgres.getUserByUsername(targetUsername);
        if (targetUser) {
          this.sendToUser(targetUser.id, {
            id: uuidv4(),
            type: 'context_clear_request',
            timestamp: Date.now(),
            payload: { channelId, taskId, targetUsername },
          });
        }
      } else {
        this.broadcastToChannel(channelId, {
          id: uuidv4(),
          type: 'context_clear_request',
          timestamp: Date.now(),
          payload: { channelId, taskId },
        }, session.userId);
      }
    } catch (error) {
      if (isZodError(error)) {
        this.sendErrorToSocket(socketId, 'validation_error', 'Invalid context clear request payload');
      }
    }
  }

  private async handleContextClearAck(socketId: string, payload: unknown): Promise<void> {
    const session = this.sessionService.getSession(socketId);
    if (!session) {
      this.sendErrorToSocket(socketId, 'unauthorized', ERROR_MESSAGES.UNAUTHORIZED);
      return;
    }

    try {
      const { channelId, taskId } = ContextClearPayloadSchema.parse(payload);

      const channel = await this.postgres.getChannel(channelId);
      if (taskId) {
        const task = await this.postgres.getBuildTaskById(taskId);
        if (task && task.channelId === channelId) {
          await this.postgres.updateBuildTaskContextCleared(taskId);
        }
      }

      const ownerId = channel?.ownerId;
      if (ownerId && ownerId !== session.userId) {
        this.sendToUser(ownerId, {
          id: uuidv4(),
          type: 'context_clear_ack',
          timestamp: Date.now(),
          payload: { channelId, taskId, userId: session.userId, username: session.username },
        });
      }
    } catch (error) {
      if (isZodError(error)) {
        this.sendErrorToSocket(socketId, 'validation_error', 'Invalid context clear ack payload');
      }
    }
  }

  private async handleBuildArtifactRequest(socketId: string, payload: unknown): Promise<void> {
    const session = this.sessionService.getSession(socketId);
    if (!session) {
      this.sendErrorToSocket(socketId, 'unauthorized', ERROR_MESSAGES.UNAUTHORIZED);
      return;
    }

    try {
      const { channelId, taskId } = BuildArtifactRequestPayloadSchema.parse(payload);

      const task = await this.postgres.getBuildTaskById(taskId);
      if (!task || task.channelId !== channelId) {
        this.sendErrorToSocket(socketId, 'not_found', 'Task not found');
        return;
      }

      // Only the task owner may pull a worker's artifact.
      if (task.ownerId !== session.userId) {
        this.sendErrorToSocket(socketId, 'forbidden', 'Only the owner can request artifacts');
        return;
      }

      // Forward to assigned worker if known, otherwise broadcast to channel
      if (task.assignedTo) {
        this.sendToUser(task.assignedTo, {
          id: uuidv4(),
          type: 'build_artifact_request',
          timestamp: Date.now(),
          payload: { channelId, taskId },
        });
      } else {
        this.broadcastToChannel(channelId, {
          id: uuidv4(),
          type: 'build_artifact_request',
          timestamp: Date.now(),
          payload: { channelId, taskId },
        }, session.userId);
      }
    } catch (error) {
      if (isZodError(error)) {
        this.sendErrorToSocket(socketId, 'validation_error', 'Invalid artifact request payload');
      }
    }
  }

  private async handleBuildArtifactPayload(socketId: string, payload: unknown): Promise<void> {
    const session = this.sessionService.getSession(socketId);
    if (!session) {
      this.sendErrorToSocket(socketId, 'unauthorized', ERROR_MESSAGES.UNAUTHORIZED);
      return;
    }

    try {
      const { channelId, taskId, filename, data } = BuildArtifactPayloadSchema.parse(payload);

      const task = await this.postgres.getBuildTaskById(taskId);
      if (!task || task.channelId !== channelId) {
        this.sendErrorToSocket(socketId, 'not_found', 'Task not found');
        return;
      }

      // Only the assigned worker may deliver an artifact for this task. Without
      // this check any member (or anyone who guesses the ids) could push a
      // spoofed payload to the owner and win the first-writer-wins race.
      if (task.assignedTo !== session.userId) {
        this.sendErrorToSocket(socketId, 'forbidden', 'Only the assigned worker can send this artifact');
        return;
      }

      this.sendToUser(task.ownerId, {
        id: uuidv4(),
        type: 'build_artifact_payload',
        timestamp: Date.now(),
        payload: { channelId, taskId, filename, data, workerId: session.userId, workerUsername: session.username },
      });
    } catch (error) {
      if (isZodError(error)) {
        this.sendErrorToSocket(socketId, 'validation_error', 'Invalid artifact payload');
      }
    }
  }

  private async handleBuildArtifactCleared(socketId: string, payload: unknown): Promise<void> {
    const session = this.sessionService.getSession(socketId);
    if (!session) {
      this.sendErrorToSocket(socketId, 'unauthorized', ERROR_MESSAGES.UNAUTHORIZED);
      return;
    }

    try {
      const { channelId, taskId } = BuildArtifactClearedPayloadSchema.parse(payload);

      const task = await this.postgres.getBuildTaskById(taskId);
      if (!task || task.channelId !== channelId) {
        this.sendErrorToSocket(socketId, 'not_found', 'Task not found');
        return;
      }

      // Only the assigned worker reports its own artifact as cleared.
      if (task.assignedTo !== session.userId) {
        this.sendErrorToSocket(socketId, 'forbidden', 'Only the assigned worker can report artifact cleared');
        return;
      }

      this.sendToUser(task.ownerId, {
        id: uuidv4(),
        type: 'build_artifact_cleared',
        timestamp: Date.now(),
        payload: { channelId, taskId, workerId: session.userId, workerUsername: session.username },
      });
    } catch (error) {
      if (isZodError(error)) {
        this.sendErrorToSocket(socketId, 'validation_error', 'Invalid artifact cleared payload');
      }
    }
  }

  private async handleBuildArtifactClearRequest(socketId: string, payload: unknown): Promise<void> {
    const session = this.sessionService.getSession(socketId);
    if (!session) {
      this.sendErrorToSocket(socketId, 'unauthorized', ERROR_MESSAGES.UNAUTHORIZED);
      return;
    }

    try {
      const { channelId, taskId } = BuildArtifactClearRequestPayloadSchema.parse(payload);

      const task = await this.postgres.getBuildTaskById(taskId);
      if (!task || task.channelId !== channelId) {
        this.sendErrorToSocket(socketId, 'not_found', 'Task not found');
        return;
      }

      // Only the owner may tell a worker to delete its local artifact. This is
      // a data-loss / griefing vector otherwise.
      if (task.ownerId !== session.userId) {
        this.sendErrorToSocket(socketId, 'forbidden', 'Only the owner can request artifact clearing');
        return;
      }

      if (task.assignedTo) {
        this.sendToUser(task.assignedTo, {
          id: uuidv4(),
          type: 'build_artifact_clear_request',
          timestamp: Date.now(),
          payload: { channelId, taskId },
        });
      } else {
        this.broadcastToChannel(channelId, {
          id: uuidv4(),
          type: 'build_artifact_clear_request',
          timestamp: Date.now(),
          payload: { channelId, taskId },
        }, session.userId);
      }
    } catch (error) {
      if (isZodError(error)) {
        this.sendErrorToSocket(socketId, 'validation_error', 'Invalid artifact clear request payload');
      }
    }
  }

  private buildTaskToPayload(task: any): any {
    return {
      taskId: task.id,
      channelId: task.channelId,
      ownerId: task.ownerId,
      title: task.title,
      description: task.description,
      status: task.status,
      assignedTo: task.assignedTo,
      assignedAt: task.assignedAt ? new Date(task.assignedAt).getTime() : undefined,
      artifactFilename: task.artifactFilename,
      artifactSize: task.artifactSize,
      contextClearedAt: task.contextClearedAt ? new Date(task.contextClearedAt).getTime() : undefined,
    };
  }

  // Context sharing: publish/replace a work snapshot in a channel or DM.
  private async handleContextShare(socketId: string, payload: unknown): Promise<void> {
    const session = this.sessionService.getSession(socketId);
    if (!session) {
      this.sendErrorToSocket(socketId, 'unauthorized', ERROR_MESSAGES.UNAUTHORIZED);
      return;
    }

    const allowed = await this.rateLimitService.checkMessageRateLimit(session.userId);
    if (!allowed) {
      this.sendErrorToSocket(socketId, 'rate_limited', ERROR_MESSAGES.RATE_LIMITED);
      return;
    }

    try {
      const { channelId, recipientId, summary, details, files, status, project, git, taskId, ttlMinutes } =
        ContextSharePayloadSchema.parse(payload);

      if (channelId) {
        const members = await this.postgres.getChannelMembers(channelId);
        if (!members.some(m => m.userId === session.userId)) {
          this.sendErrorToSocket(socketId, 'forbidden', ERROR_MESSAGES.NOT_IN_CHANNEL);
          return;
        }
      } else if (recipientId) {
        // DM shares follow the same rules as DM messages
        const isMutualContact = await this.postgres.checkMutualContact(session.userId, recipientId);
        if (!isMutualContact) {
          this.sendErrorToSocket(socketId, 'not_mutual_contact', ERROR_MESSAGES.NOT_MUTUAL_CONTACT);
          return;
        }
        const blockStatus = await this.postgres.isBlocked(session.userId, recipientId);
        if (blockStatus.blockedBy || blockStatus.blockedTarget) {
          this.sendErrorToSocket(socketId, 'blocked', ERROR_MESSAGES.BLOCKED);
          return;
        }
      }

      const share = await this.postgres.upsertContextShare(
        session.userId,
        { channelId, recipientId },
        { summary, details, files, status, project, git, taskId, ttlMinutes }
      );
      // The row carries no username (it is joined on reads); attach it here so
      // the broadcast payload is complete.
      share.username = session.username;

      const message: ProtocolMessage = {
        id: uuidv4(),
        type: 'context_share',
        timestamp: Date.now(),
        payload: { share },
      };

      if (channelId) {
        // All members, including the sharer's other sessions/devices
        await this.broadcastToChannel(channelId, message);
      } else if (recipientId) {
        await this.sendToUser(recipientId, message);
        // Echo to the sharer's other sessions so their devices stay in sync
        await this.sendToUser(session.userId, message);
      }
    } catch (error) {
      if (isZodError(error)) {
        this.sendErrorToSocket(socketId, 'validation_error', 'Invalid context share payload');
      } else {
        this.sendErrorToSocket(socketId, 'handler_error', 'Failed to share context');
      }
    }
  }

  // Retract your own context share from a channel or DM.
  private async handleContextShareRevoke(socketId: string, payload: unknown): Promise<void> {
    const session = this.sessionService.getSession(socketId);
    if (!session) {
      this.sendErrorToSocket(socketId, 'unauthorized', ERROR_MESSAGES.UNAUTHORIZED);
      return;
    }

    try {
      const { channelId, recipientId } = ContextShareRevokePayloadSchema.parse(payload);

      if (channelId) {
        const members = await this.postgres.getChannelMembers(channelId);
        if (!members.some(m => m.userId === session.userId)) {
          this.sendErrorToSocket(socketId, 'forbidden', ERROR_MESSAGES.NOT_IN_CHANNEL);
          return;
        }
      }

      const revoked = await this.postgres.revokeContextShare(session.userId, { channelId, recipientId });
      if (!revoked) return; // Nothing shared in that scope — no-op

      const message: ProtocolMessage = {
        id: uuidv4(),
        type: 'context_share_revoke',
        timestamp: Date.now(),
        payload: { channelId, recipientId, userId: session.userId, username: session.username },
      };

      if (channelId) {
        await this.broadcastToChannel(channelId, message);
      } else if (recipientId) {
        await this.sendToUser(recipientId, message);
        await this.sendToUser(session.userId, message);
      }
    } catch (error) {
      if (isZodError(error)) {
        this.sendErrorToSocket(socketId, 'validation_error', 'Invalid context share revoke payload');
      } else {
        this.sendErrorToSocket(socketId, 'handler_error', 'Failed to revoke context share');
      }
    }
  }

  // Ask a peer (DM) or channel (optionally one member) to share their context.
  private async handleContextShareRequest(socketId: string, payload: unknown): Promise<void> {
    const session = this.sessionService.getSession(socketId);
    if (!session) {
      this.sendErrorToSocket(socketId, 'unauthorized', ERROR_MESSAGES.UNAUTHORIZED);
      return;
    }

    try {
      const { channelId, recipientId, targetUsername } = ContextShareRequestPayloadSchema.parse(payload);
      const requestPayload = {
        channelId,
        recipientId,
        targetUsername,
        requesterId: session.userId,
        requesterUsername: session.username,
      };

      if (channelId) {
        const members = await this.postgres.getChannelMembers(channelId);
        if (!members.some(m => m.userId === session.userId)) {
          this.sendErrorToSocket(socketId, 'forbidden', ERROR_MESSAGES.NOT_IN_CHANNEL);
          return;
        }

        if (targetUsername) {
          const target = await this.postgres.getUserByUsername(targetUsername);
          if (!target) {
            this.sendErrorToSocket(socketId, 'user_not_found', ERROR_MESSAGES.USER_NOT_FOUND);
            return;
          }
          if (!members.some(m => m.userId === target.id)) {
            this.sendErrorToSocket(socketId, 'not_in_channel', 'That user is not a member of this channel');
            return;
          }
          await this.sendToUser(target.id, {
            id: uuidv4(),
            type: 'context_share_request',
            timestamp: Date.now(),
            payload: requestPayload,
          });
        } else {
          await this.broadcastToChannel(channelId, {
            id: uuidv4(),
            type: 'context_share_request',
            timestamp: Date.now(),
            payload: requestPayload,
          }, session.userId);
        }
      } else if (recipientId) {
        const isMutualContact = await this.postgres.checkMutualContact(session.userId, recipientId);
        if (!isMutualContact) {
          this.sendErrorToSocket(socketId, 'not_mutual_contact', ERROR_MESSAGES.NOT_MUTUAL_CONTACT);
          return;
        }
        const blockStatus = await this.postgres.isBlocked(session.userId, recipientId);
        if (blockStatus.blockedBy || blockStatus.blockedTarget) {
          this.sendErrorToSocket(socketId, 'blocked', ERROR_MESSAGES.BLOCKED);
          return;
        }
        await this.sendToUser(recipientId, {
          id: uuidv4(),
          type: 'context_share_request',
          timestamp: Date.now(),
          payload: requestPayload,
        });
      }
    } catch (error) {
      if (isZodError(error)) {
        this.sendErrorToSocket(socketId, 'validation_error', 'Invalid context share request payload');
      } else {
        this.sendErrorToSocket(socketId, 'handler_error', 'Failed to request context share');
      }
    }
  }

  private async broadcastToChannel(
    channelId: string,
    message: ProtocolMessage,
    excludeUserId?: string
  ): Promise<void> {
    const members = await this.postgres.getChannelMembers(channelId);
    for (const member of members) {
      if (excludeUserId && member.userId === excludeUserId) continue;
      const sessions = this.sessionService.getSessionsByUser(member.userId);
      for (const session of sessions) {
        const socket = this.sockets.get(session.socketId);
        if (socket) {
          this.send(socket, message);
        }
      }
    }
  }

  private async sendToUser(userId: string, message: ProtocolMessage): Promise<void> {
    const sessions = this.sessionService.getSessionsByUser(userId);
    for (const session of sessions) {
      const socket = this.sockets.get(session.socketId);
      if (socket) {
        this.send(socket, message);
      }
    }
  }

  private async handleDisconnect(socketId: string): Promise<void> {
    const session = await this.sessionService.destroySession(socketId);
    this.sockets.delete(socketId);

    if (session) {
      // Check if user has other sessions
      const remainingSessions = this.sessionService.getSessionsByUser(session.userId);
      if (remainingSessions.length === 0) {
        // User is fully offline
        await this.presenceService.setOffline(session.userId);
      }
    }
  }

  private send(socket: WebSocket, message: ProtocolMessage): void {
    if (socket.readyState === 1) { // OPEN
      socket.send(JSON.stringify(message));
    }
  }

  private sendError(socket: WebSocket, code: string, message: string): void {
    this.send(socket, {
      id: uuidv4(),
      type: 'message_error',
      timestamp: Date.now(),
      payload: { code, message },
    });
  }

  private sendErrorToSocket(socketId: string, code: string, message: string): void {
    const socket = this.sockets.get(socketId);
    if (socket) {
      this.sendError(socket, code, message);
    }
  }
}
