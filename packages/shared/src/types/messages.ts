import { z } from 'zod';
import {
  MAX_CONTEXT_SUMMARY_LENGTH,
  MAX_CONTEXT_DETAILS_LENGTH,
  MAX_CONTEXT_FILES,
  MAX_CONTEXT_FILE_LENGTH,
  MAX_CONTEXT_PROJECT_LENGTH,
  MAX_CONTEXT_GIT_FILES,
  MAX_CONTEXT_GIT_BRANCH_LENGTH,
  MAX_CONTEXT_GIT_STAT_LENGTH,
  MIN_CHANNEL_RETENTION_MINUTES,
  MAX_CHANNEL_RETENTION_MINUTES,
} from '../constants.js';

// Presence schema - defined first (no dependencies)
export const PresenceSchema = z.object({
  status: z.enum(['online', 'away', 'busy', 'offline']),
  message: z.string().max(128).optional(),
  lastSeen: z.date(),
  isTyping: z.boolean().optional(),
  typingIn: z.string().optional(), // channel ID or user ID
});

export type Presence = z.infer<typeof PresenceSchema>;

// User schema
export const UserSchema = z.object({
  id: z.string().uuid(),
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_-]+$/),
  displayName: z.string().max(64).optional(),
  createdAt: z.date(),
  lastSeenAt: z.date().optional(),
});

export type User = z.infer<typeof UserSchema>;

// User with presence
export const UserSchemaWithPresence = UserSchema.extend({
  presence: PresenceSchema.optional(),
});

export type UserWithPresence = z.infer<typeof UserSchemaWithPresence>;

// Contact schema
export const ContactSchema = z.object({
  userId: z.string().uuid(),
  contactId: z.string().uuid(),
  username: z.string(),
  displayName: z.string().optional(),
  customName: z.string().max(64).optional(),
  isBlocked: z.boolean().default(false),
  presence: PresenceSchema.optional(),
  createdAt: z.date(),
});

export type Contact = z.infer<typeof ContactSchema>;

// Message schema
export const MessageSchema = z.object({
  id: z.string().uuid(),
  senderId: z.string().uuid(),
  senderUsername: z.string(),
  recipientId: z.string().uuid().optional(), // For DMs
  channelId: z.string().uuid().optional(), // For channel messages
  content: z.string().min(1).max(4096),
  isEphemeral: z.boolean().default(false),
  createdAt: z.date(),
  editedAt: z.date().optional(),
  deletedAt: z.date().optional(),
});

export type Message = z.infer<typeof MessageSchema>;

// Channel type
export const ChannelTypeSchema = z.enum(['social', 'build']);
export type ChannelType = z.infer<typeof ChannelTypeSchema>;

// Channel schema
export const ChannelSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(3).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  displayName: z.string().max(64),
  isPublic: z.boolean().default(false),
  channelType: ChannelTypeSchema.default('social'),
  createdBy: z.string().uuid(),
  ownerId: z.string().uuid().optional(),
  buildPrompt: z.string().optional(),
  maxMembers: z.number().default(50),
  encryptionEnabled: z.boolean().default(false),
  // Per-channel message TTL in minutes; null = inherit the server-wide default
  // (MESSAGE_RETENTION_MINUTES), which itself defaults to "keep forever".
  retentionMinutes: z.number().int().min(MIN_CHANNEL_RETENTION_MINUTES).max(MAX_CHANNEL_RETENTION_MINUTES).nullable().optional(),
  createdAt: z.date(),
  memberCount: z.number().optional(),
});

export type Channel = z.infer<typeof ChannelSchema>;

// Channel member roles. 'owner' is the channel creator (exactly one,
// transfer-or-delete only via ownership handoff); 'admin' manages members and
// settings; 'member' is default. isAdmin stays true for owner and admin.
export const ChannelRoleSchema = z.enum(['owner', 'admin', 'member']);
export type ChannelRole = z.infer<typeof ChannelRoleSchema>;

// Channel member schema
export const ChannelMemberSchema = z.object({
  channelId: z.string().uuid(),
  userId: z.string().uuid(),
  username: z.string(),
  isAdmin: z.boolean().default(false),
  role: ChannelRoleSchema.default('member'),
  joinedAt: z.date(),
});

export type ChannelMember = z.infer<typeof ChannelMemberSchema>;

// Chat settings schema
export const ChatSettingsSchema = z.object({
  chatId: z.string(), // userId for DMs, channelId for channels
  isEphemeral: z.boolean().default(false),
  muteNotifications: z.boolean().default(false),
  updatedAt: z.date(),
});

export type ChatSettings = z.infer<typeof ChatSettingsSchema>;

// Build task schema
export const BuildTaskStatusSchema = z.enum(['pending', 'assigned', 'completed', 'failed', 'cancelled']);
export type BuildTaskStatus = z.infer<typeof BuildTaskStatusSchema>;

export const BuildTaskSchema = z.object({
  id: z.string().uuid(),
  channelId: z.string().uuid(),
  ownerId: z.string().uuid(),
  title: z.string(),
  description: z.string().optional(),
  status: BuildTaskStatusSchema,
  assignedTo: z.string().uuid().optional(),
  artifactFilename: z.string().optional(),
  artifactSize: z.number().optional(),
  createdAt: z.date(),
  assignedAt: z.date().optional(),
  completedAt: z.date().optional(),
  contextClearedAt: z.date().optional(),
});

export type BuildTask = z.infer<typeof BuildTaskSchema>;

// Member session status schema
export const MemberSessionStatusSchema = z.object({
  userId: z.string().uuid(),
  channelId: z.string().uuid(),
  reportedAt: z.date(),
  remainingRequests: z.number().optional(),
  contextWindowUsed: z.number().optional(),
  selectedModel: z.string().optional(),
});

export type MemberSessionStatus = z.infer<typeof MemberSessionStatusSchema>;

// Context share status — what the sharer is doing right now
export const ContextShareStatusSchema = z.enum(['working', 'blocked', 'reviewing', 'done']);
export type ContextShareStatus = z.infer<typeof ContextShareStatusSchema>;

// Auto-captured local git state attached to a context share (opt-in). The
// relay stores and forwards it verbatim — it is metadata about the sharer's
// working tree, never file contents.
export const ContextGitInfoSchema = z.object({
  branch: z.string().min(1).max(MAX_CONTEXT_GIT_BRANCH_LENGTH),
  dirty: z.boolean(),
  changedFiles: z.array(z.string().max(MAX_CONTEXT_FILE_LENGTH)).max(MAX_CONTEXT_GIT_FILES).optional(),
  // Shortstat summary line, e.g. "3 files changed, 40 insertions(+), 12 deletions(-)".
  diffStat: z.string().max(MAX_CONTEXT_GIT_STAT_LENGTH).optional(),
});

export type ContextGitInfo = z.infer<typeof ContextGitInfoSchema>;

// Context share — an ephemeral, self-expiring snapshot of what a user is
// working on, shared into a channel or DM conversation for live collaboration
// (pair programming, reviews, handoffs). One live share per user per scope;
// re-sharing replaces the previous snapshot.
export const ContextShareSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  username: z.string(),
  channelId: z.string().uuid().optional(), // set when shared to a channel
  recipientId: z.string().uuid().optional(), // set when shared to a DM peer
  summary: z.string().min(1).max(MAX_CONTEXT_SUMMARY_LENGTH),
  details: z.string().max(MAX_CONTEXT_DETAILS_LENGTH).optional(),
  files: z.array(z.string().max(MAX_CONTEXT_FILE_LENGTH)).max(MAX_CONTEXT_FILES).optional(),
  status: ContextShareStatusSchema.default('working'),
  project: z.string().max(MAX_CONTEXT_PROJECT_LENGTH).optional(),
  git: ContextGitInfoSchema.optional(),
  taskId: z.string().uuid().optional(), // linked build task, if any
  createdAt: z.date(),
  updatedAt: z.date(),
  expiresAt: z.date(),
});

export type ContextShare = z.infer<typeof ContextShareSchema>;

// Channel audit log — security-relevant events for a channel, readable by
// owner/admins only. Written by the relay; content is metadata only.
export const ChannelAuditActionSchema = z.enum([
  'channel_created',
  'member_joined',
  'member_left',
  'member_kicked',
  'role_changed',
  'invite_created',
  'invite_used',
  'encryption_enabled',
  'key_shares_posted',
  'retention_changed',
]);
export type ChannelAuditAction = z.infer<typeof ChannelAuditActionSchema>;

export const ChannelAuditEventSchema = z.object({
  id: z.string().uuid(),
  channelId: z.string().uuid(),
  actorId: z.string().uuid().optional(), // who performed the action
  actorUsername: z.string().optional(),
  action: ChannelAuditActionSchema,
  targetId: z.string().uuid().optional(), // affected user, when applicable
  targetUsername: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.date(),
});
export type ChannelAuditEvent = z.infer<typeof ChannelAuditEventSchema>;

// Connection status
export const ConnectionStatusSchema = z.enum([
  'disconnected',
  'connecting',
  'connected',
  'reconnecting',
  'error'
]);

export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;
