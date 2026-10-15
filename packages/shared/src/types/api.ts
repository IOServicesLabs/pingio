import { z } from 'zod';

// API request/response types for REST endpoints (if needed)

// Registration
export const RegisterRequestSchema = z.object({
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_-]+$/),
  password: z.string().min(8).max(128),
  displayName: z.string().max(64).optional(),
});

export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const RegisterResponseSchema = z.object({
  success: z.boolean(),
  userId: z.string().uuid().optional(),
  token: z.string().optional(),
  error: z.string().optional(),
});

export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;

// Login
export const LoginRequestSchema = z.object({
  username: z.string(),
  password: z.string(),
});

export type LoginRequest = z.infer<typeof LoginRequestSchema>;

// Message history
export const GetHistoryRequestSchema = z.object({
  contactId: z.string().optional(),
  channelId: z.string().optional(),
  before: z.date().optional(),
  limit: z.number().min(1).max(100).default(50),
});

export type GetHistoryRequest = z.infer<typeof GetHistoryRequestSchema>;

// User search
export const SearchUsersRequestSchema = z.object({
  query: z.string().min(1).max(64),
  limit: z.number().min(1).max(20).default(10),
});

export type SearchUsersRequest = z.infer<typeof SearchUsersRequestSchema>;

// Config types
export const ServerModeSchema = z.enum(['cloud', 'self-hosted', 'auto']);

export type ServerMode = z.infer<typeof ServerModeSchema>;

export const UserConfigSchema = z.object({
  mode: ServerModeSchema.default('auto'),
  cloudEndpoint: z.string().url().default('https://pingio.ioservices.io'),
  cloudRelayUrl: z.string().url().optional(),
  selfHosted: z.object({
    relayUrl: z.string().url().default('ws://localhost:5000/ws'),
    authUrl: z.string().url().optional(),
    enableLocalP2P: z.boolean().default(true),
    p2pPort: z.number().default(0), // 0 = auto
  }).default({}),
  identity: z.object({
    username: z.string().optional(),
    authToken: z.string().optional(),
    userId: z.string().uuid().optional(),
    refreshToken: z.string().optional(),
    deviceId: z.string().uuid().optional(),
  }).default({}),
  preferences: z.object({
    defaultEphemeral: z.boolean().default(false),
    notifications: z.boolean().default(true),
  }).default({}),
});

export type UserConfig = z.infer<typeof UserConfigSchema>;

// Error types
export const ApiErrorCodeSchema = z.enum([
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'VALIDATION_ERROR',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
  'P2P_CONNECTION_FAILED',
  'RELAY_CONNECTION_FAILED',
  'NOT_MUTUAL_CONTACT',
  'BLOCKED',
  'DEVICE_VERIFICATION_REQUIRED',
  'DEVICE_NOT_FOUND',
  'DEVICE_REVOKED',
  'MAX_DEVICES_REACHED',
]);

export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  code: ApiErrorCodeSchema,
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;

// Device types
export const DeviceSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  deviceName: z.string().optional(),
  deviceFingerprint: z.string(),
  lastIp: z.string().optional(),
  lastSeen: z.date().optional(),
  isVerified: z.boolean(),
  createdAt: z.date(),
});

export type Device = z.infer<typeof DeviceSchema>;

export const RefreshTokenSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  deviceId: z.string().uuid(),
  tokenHash: z.string(),
  expiresAt: z.date(),
  createdAt: z.date(),
});

export type RefreshToken = z.infer<typeof RefreshTokenSchema>;

// Extended login response with device verification
export const LoginResponseSchema = z.object({
  success: z.boolean(),
  token: z.string().optional(),
  refreshToken: z.string().optional(),
  deviceId: z.string().uuid().optional(),
  user: z.object({
    id: z.string().uuid(),
    username: z.string(),
    displayName: z.string().optional(),
  }).optional(),
  error: z.string().optional(),
  verificationRequired: z.boolean().optional(),
});

export type LoginResponse = z.infer<typeof LoginResponseSchema>;

// Device verification request
export const DeviceVerificationRequestSchema = z.object({
  deviceId: z.string().uuid(),
});

export type DeviceVerificationRequest = z.infer<typeof DeviceVerificationRequestSchema>;

// Device info
export const DeviceInfoSchema = z.object({
  id: z.string().uuid(),
  deviceName: z.string().optional(),
  lastSeen: z.date().optional(),
  isVerified: z.boolean(),
  isCurrent: z.boolean(),
});

export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

// List devices response
export const ListDevicesResponseSchema = z.object({
  success: z.boolean(),
  devices: z.array(DeviceInfoSchema).optional(),
  error: z.string().optional(),
});

export type ListDevicesResponse = z.infer<typeof ListDevicesResponseSchema>;

// Revoke device request
export const RevokeDeviceRequestSchema = z.object({
  deviceId: z.string().uuid(),
});

export type RevokeDeviceRequest = z.infer<typeof RevokeDeviceRequestSchema>;

// Token refresh request
export const TokenRefreshRequestSchema = z.object({
  refreshToken: z.string(),
  deviceFingerprint: z.string(),
});

export type TokenRefreshRequest = z.infer<typeof TokenRefreshRequestSchema>;

// Token refresh response
export const TokenRefreshResponseSchema = z.object({
  success: z.boolean(),
  token: z.string().optional(),
  refreshToken: z.string().optional(),
  error: z.string().optional(),
});

export type TokenRefreshResponse = z.infer<typeof TokenRefreshResponseSchema>;
