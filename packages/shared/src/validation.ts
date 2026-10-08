import { z } from 'zod';
import {
  MAX_USERNAME_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_CHANNEL_NAME_LENGTH,
  MAX_STATUS_MESSAGE_LENGTH,
} from './constants.js';

// Username validation
export const UsernameSchema = z
  .string()
  .min(3, 'Username must be at least 3 characters')
  .max(MAX_USERNAME_LENGTH, `Username must be at most ${MAX_USERNAME_LENGTH} characters`)
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    'Username can only contain letters, numbers, underscores, and hyphens'
  );

// Password validation
export const PasswordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters');

// Display name validation
export const DisplayNameSchema = z
  .string()
  .max(MAX_DISPLAY_NAME_LENGTH, `Display name must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`)
  .optional();

// Message content validation
export const MessageContentSchema = z
  .string()
  .min(1, 'Message cannot be empty')
  .max(MAX_MESSAGE_LENGTH, `Message must be at most ${MAX_MESSAGE_LENGTH} characters`);

// Channel name validation
export const ChannelNameSchema = z
  .string()
  .min(3, 'Channel name must be at least 3 characters')
  .max(MAX_CHANNEL_NAME_LENGTH, `Channel name must be at most ${MAX_CHANNEL_NAME_LENGTH} characters`)
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    'Channel name can only contain letters, numbers, underscores, and hyphens'
  );

// Status message validation
export const StatusMessageSchema = z
  .string()
  .max(MAX_STATUS_MESSAGE_LENGTH, `Status message must be at most ${MAX_STATUS_MESSAGE_LENGTH} characters`)
  .optional();

// UUID validation
export const UUIDSchema = z.string().uuid('Invalid ID format');

// Email validation (optional, for future use)
export const EmailSchema = z.string().email('Invalid email format').optional();

// Token validation
export const TokenSchema = z.string().min(1, 'Token is required');

// Validation helper functions
export function validateUsername(username: string): { valid: boolean; error?: string } {
  const result = UsernameSchema.safeParse(username);
  if (result.success) {
    return { valid: true };
  }
  return { valid: false, error: result.error.errors[0]?.message };
}

export function validatePassword(password: string): { valid: boolean; error?: string } {
  const result = PasswordSchema.safeParse(password);
  if (result.success) {
    return { valid: true };
  }
  return { valid: false, error: result.error.errors[0]?.message };
}

export function validateMessageContent(content: string): { valid: boolean; error?: string } {
  const result = MessageContentSchema.safeParse(content);
  if (result.success) {
    return { valid: true };
  }
  return { valid: false, error: result.error.errors[0]?.message };
}

export function validateChannelName(name: string): { valid: boolean; error?: string } {
  const result = ChannelNameSchema.safeParse(name);
  if (result.success) {
    return { valid: true };
  }
  return { valid: false, error: result.error.errors[0]?.message };
}

// Sanitization helpers
export function sanitizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function sanitizeChannelName(name: string): string {
  return name.trim().toLowerCase();
}

export function sanitizeMessageContent(content: string): string {
  return content.trim();
}
