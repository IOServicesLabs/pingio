import { z } from 'zod';
import { MessageSchema, UserSchema, ChannelSchema, PresenceSchema, ContextShareStatusSchema, ContextGitInfoSchema } from './messages.js';
import {
  MAX_ARTIFACT_FILENAME_LENGTH,
  WS_MAX_PAYLOAD_BYTES,
  MAX_CONTEXT_SUMMARY_LENGTH,
  MAX_CONTEXT_DETAILS_LENGTH,
  MAX_CONTEXT_FILES,
  MAX_CONTEXT_FILE_LENGTH,
  MAX_CONTEXT_PROJECT_LENGTH,
  MAX_CONTEXT_SHARE_TTL_MINUTES,
} from '../constants.js';

// A safe artifact filename is a plain basename: no path separators, no NUL, and
// not a directory-traversal token. Rejecting these at the protocol boundary is
// the first line of defense against writing artifacts outside their task dir.
export const SafeArtifactFilenameSchema = z
  .string()
  .min(1)
  .max(MAX_ARTIFACT_FILENAME_LENGTH)
  .refine(
    (name) =>
      !name.includes('/') &&
      !name.includes('\\') &&
      !name.includes('\0') &&
      name !== '.' &&
      name !== '..',
    { message: 'Invalid artifact filename' }
  );

// Protocol message types for WebSocket communication
export const ProtocolMessageTypeSchema = z.enum([
  // Connection
  'auth',
  'auth_response',
  'ping',
  'pong',

  // Messages
  'message',
  'message_sent',
  'message_delivered',
  'message_read',
  'message_edit',
  'message_delete',
  'message_error',

  // Channels
  'channel_join',
  'channel_leave',
  'channel_message',
  'channel_invite',
  'channel_member_joined',
  'channel_member_left',

  // Presence
  'presence_update',
  'presence_request',
  'presence_response',
  'typing',
  'typing_start',
  'typing_stop',

  // P2P
  'p2p_offer',
  'p2p_answer',
  'p2p_ice_candidate',
  'p2p_request',
  'p2p_response',

  // Build groups
  'build_task_create',
  'build_task_assign',
  'build_task_update',
  'build_task_complete',
  'session_status_report',
  'session_status_request',
  'context_clear_request',
  'context_clear_ack',

  // Artifact transfer
  'build_artifact_request',
  'build_artifact_payload',
  'build_artifact_cleared',
  'build_artifact_clear_request',

  // Context sharing (work snapshots)
  'context_share',
  'context_share_revoke',
  'context_share_request',
]);

export type ProtocolMessageType = z.infer<typeof ProtocolMessageTypeSchema>;

// Base protocol message
export const ProtocolMessageSchema = z.object({
  id: z.string().uuid(),
  type: ProtocolMessageTypeSchema,
  timestamp: z.number(),
  payload: z.unknown(),
});

export type ProtocolMessage = z.infer<typeof ProtocolMessageSchema>;

// Auth messages
export const AuthPayloadSchema = z.object({
  token: z.string(),
  deviceId: z.string().optional(),
  deviceFingerprint: z.string().optional(),
});

export type AuthPayload = z.infer<typeof AuthPayloadSchema>;

export const AuthResponsePayloadSchema = z.object({
  success: z.boolean(),
  user: UserSchema.optional(),
  deviceId: z.string().uuid().optional(),
  error: z.string().optional(),
  verificationRequired: z.boolean().optional(),
});

export type AuthResponsePayload = z.infer<typeof AuthResponsePayloadSchema>;

// Message payloads
export const SendMessagePayloadSchema = z.object({
  recipientId: z.string(),
  content: z.string().min(1).max(4096),
  isEphemeral: z.boolean().optional(),
  clientMessageId: z.string().optional(),
});

export type SendMessagePayload = z.infer<typeof SendMessagePayloadSchema>;

export const MessagePayloadSchema = z.object({
  message: MessageSchema,
  clientMessageId: z.string().optional(),
});

export type MessagePayload = z.infer<typeof MessagePayloadSchema>;

export const MessageStatusPayloadSchema = z.object({
  messageId: z.string().uuid(),
  timestamp: z.number(),
  recipientId: z.string().optional(),
});

export type MessageStatusPayload = z.infer<typeof MessageStatusPayloadSchema>;

export const EditMessagePayloadSchema = z.object({
  messageId: z.string().uuid(),
  content: z.string().min(1).max(4096),
});

export type EditMessagePayload = z.infer<typeof EditMessagePayloadSchema>;

export const DeleteMessagePayloadSchema = z.object({
  messageId: z.string().uuid(),
  deleteForEveryone: z.boolean().default(false),
});

export type DeleteMessagePayload = z.infer<typeof DeleteMessagePayloadSchema>;

// Channel payloads
export const ChannelJoinPayloadSchema = z.object({
  channelId: z.string().uuid(),
  inviteCode: z.string().optional(),
});

export type ChannelJoinPayload = z.infer<typeof ChannelJoinPayloadSchema>;

export const ChannelMessagePayloadSchema = z.object({
  channelId: z.string().uuid(),
  content: z.string().min(1).max(4096),
  isEphemeral: z.boolean().optional(),
  clientMessageId: z.string().optional(),
});

export type ChannelMessagePayload = z.infer<typeof ChannelMessagePayloadSchema>;

// Presence payloads
export const PresenceUpdatePayloadSchema = z.object({
  status: z.enum(['online', 'away', 'busy', 'offline']),
  message: z.string().max(128).optional(),
});

export type PresenceUpdatePayload = z.infer<typeof PresenceUpdatePayloadSchema>;

export const TypingPayloadSchema = z.object({
  chatId: z.string(), // userId for DMs, channelId for channels
  isTyping: z.boolean(),
});

export type TypingPayload = z.infer<typeof TypingPayloadSchema>;

// P2P payloads
export const P2POfferPayloadSchema = z.object({
  targetUserId: z.string().uuid(),
  offer: z.object({
    type: z.literal('offer'),
    sdp: z.string(),
  }),
  connectionId: z.string(),
});

export type P2POfferPayload = z.infer<typeof P2POfferPayloadSchema>;

export const P2PAnswerPayloadSchema = z.object({
  sourceUserId: z.string().uuid(),
  answer: z.object({
    type: z.literal('answer'),
    sdp: z.string(),
  }),
  connectionId: z.string(),
});

export type P2PAnswerPayload = z.infer<typeof P2PAnswerPayloadSchema>;

export const P2PIceCandidatePayloadSchema = z.object({
  targetUserId: z.string().uuid().optional(),
  sourceUserId: z.string().uuid().optional(),
  candidate: z.object({
    candidate: z.string(),
    sdpMid: z.string().optional(),
    sdpMLineIndex: z.number().optional(),
  }),
  connectionId: z.string(),
});

export type P2PIceCandidatePayload = z.infer<typeof P2PIceCandidatePayloadSchema>;

export const P2PRequestPayloadSchema = z.object({
  targetUserId: z.string().uuid(),
  connectionId: z.string(),
});

export type P2PRequestPayload = z.infer<typeof P2PRequestPayloadSchema>;

export const P2PResponsePayloadSchema = z.object({
  accepted: z.boolean(),
  sourceUserId: z.string().uuid(),
  connectionId: z.string(),
  error: z.string().optional(),
});

export type P2PResponsePayload = z.infer<typeof P2PResponsePayloadSchema>;

// Build group payloads
export const BuildTaskPayloadSchema = z.object({
  taskId: z.string().uuid(),
  channelId: z.string().uuid(),
  ownerId: z.string().uuid().optional(),
  title: z.string(),
  description: z.string().optional(),
  status: z.enum(['pending', 'assigned', 'completed', 'failed', 'cancelled']),
  assignedTo: z.string().uuid().optional(),
  assignedAt: z.number().optional(),
  artifactFilename: SafeArtifactFilenameSchema.optional(),
  artifactSize: z.number().nonnegative().optional(),
  contextClearedAt: z.number().optional(),
});

export type BuildTaskPayload = z.infer<typeof BuildTaskPayloadSchema>;

export const MemberSessionStatusPayloadSchema = z.object({
  channelId: z.string().uuid(),
  remainingRequests: z.number().optional(),
  contextWindowUsed: z.number().optional(),
  selectedModel: z.string().optional(),
});

export type MemberSessionStatusPayload = z.infer<typeof MemberSessionStatusPayloadSchema>;

export const ContextClearPayloadSchema = z.object({
  channelId: z.string().uuid(),
  taskId: z.string().uuid().optional(),
  targetUsername: z.string().optional(),
});

export type ContextClearPayload = z.infer<typeof ContextClearPayloadSchema>;

// Artifact transfer payloads
export const BuildArtifactRequestPayloadSchema = z.object({
  channelId: z.string().uuid(),
  taskId: z.string().uuid(),
});

export type BuildArtifactRequestPayload = z.infer<typeof BuildArtifactRequestPayloadSchema>;

export const BuildArtifactPayloadSchema = z.object({
  channelId: z.string().uuid(),
  taskId: z.string().uuid(),
  filename: SafeArtifactFilenameSchema,
  // base64 encoded file contents; bounded to a coarse frame ceiling here, with
  // the precise per-artifact byte limit enforced by the MCP server on receive.
  data: z.string().max(WS_MAX_PAYLOAD_BYTES),
});

export type BuildArtifactPayload = z.infer<typeof BuildArtifactPayloadSchema>;

export const BuildArtifactClearedPayloadSchema = z.object({
  channelId: z.string().uuid(),
  taskId: z.string().uuid(),
});

export type BuildArtifactClearedPayload = z.infer<typeof BuildArtifactClearedPayloadSchema>;

export const BuildArtifactClearRequestPayloadSchema = z.object({
  channelId: z.string().uuid(),
  taskId: z.string().uuid(),
});

export type BuildArtifactClearRequestPayload = z.infer<typeof BuildArtifactClearRequestPayloadSchema>;

// Context sharing payloads. A share is scoped to exactly one conversation:
// a channel (channelId) or a DM peer (recipientId).
export const ContextSharePayloadSchema = z.object({
  channelId: z.string().uuid().optional(),
  recipientId: z.string().uuid().optional(),
  summary: z.string().min(1).max(MAX_CONTEXT_SUMMARY_LENGTH),
  details: z.string().max(MAX_CONTEXT_DETAILS_LENGTH).optional(),
  files: z.array(z.string().max(MAX_CONTEXT_FILE_LENGTH)).max(MAX_CONTEXT_FILES).optional(),
  status: ContextShareStatusSchema.optional(),
  project: z.string().max(MAX_CONTEXT_PROJECT_LENGTH).optional(),
  git: ContextGitInfoSchema.optional(),
  taskId: z.string().uuid().optional(),
  ttlMinutes: z.number().int().min(1).max(MAX_CONTEXT_SHARE_TTL_MINUTES).optional(),
}).refine(
  (d) => (d.channelId ? 1 : 0) + (d.recipientId ? 1 : 0) === 1,
  { message: 'Exactly one of channelId or recipientId is required' }
);

export type ContextSharePayload = z.infer<typeof ContextSharePayloadSchema>;

export const ContextShareRevokePayloadSchema = z.object({
  channelId: z.string().uuid().optional(),
  recipientId: z.string().uuid().optional(),
}).refine(
  (d) => (d.channelId ? 1 : 0) + (d.recipientId ? 1 : 0) === 1,
  { message: 'Exactly one of channelId or recipientId is required' }
);

export type ContextShareRevokePayload = z.infer<typeof ContextShareRevokePayloadSchema>;

export const ContextShareRequestPayloadSchema = z.object({
  channelId: z.string().uuid().optional(),
  recipientId: z.string().uuid().optional(),
  targetUsername: z.string().max(32).optional(),
}).refine(
  (d) => (d.channelId ? 1 : 0) + (d.recipientId ? 1 : 0) === 1,
  { message: 'Exactly one of channelId or recipientId is required' }
);

export type ContextShareRequestPayload = z.infer<typeof ContextShareRequestPayloadSchema>;

// Union type for all protocol payloads
export type ProtocolPayload =
  | AuthPayload
  | AuthResponsePayload
  | SendMessagePayload
  | MessagePayload
  | MessageStatusPayload
  | EditMessagePayload
  | DeleteMessagePayload
  | ChannelJoinPayload
  | ChannelMessagePayload
  | PresenceUpdatePayload
  | TypingPayload
  | P2POfferPayload
  | P2PAnswerPayload
  | P2PIceCandidatePayload
  | P2PRequestPayload
  | P2PResponsePayload
  | BuildTaskPayload
  | MemberSessionStatusPayload
  | ContextClearPayload
  | BuildArtifactRequestPayload
  | BuildArtifactPayload
  | BuildArtifactClearedPayload
  | BuildArtifactClearRequestPayload
  | ContextSharePayload
  | ContextShareRevokePayload
  | ContextShareRequestPayload;
