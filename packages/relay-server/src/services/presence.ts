import type { RedisStore } from '../stores/redis.js';
import type { SessionService } from './session.js';
import type { Presence, User } from '@pingio/shared';

export interface PresenceUpdate {
  userId: string;
  username: string;
  presence: Presence;
}

export class PresenceService {
  constructor(
    private redis: RedisStore,
    private sessionService: SessionService
  ) {}

  async updatePresence(
    userId: string,
    username: string,
    status: Presence['status'],
    message?: string
  ): Promise<Presence> {
    const presence: Presence = {
      status,
      message,
      lastSeen: new Date(),
    };

    await this.redis.setPresence(userId, presence);

    return presence;
  }

  async setTyping(userId: string, chatId: string, isTyping: boolean): Promise<void> {
    if (isTyping) {
      await this.redis.setTyping(userId, chatId);
    } else {
      await this.redis.clearTyping(userId, chatId);
    }
  }

  async getTypingUsers(chatId: string): Promise<string[]> {
    return await this.redis.getTypingUsers(chatId);
  }

  async getPresence(userId: string): Promise<Presence | null> {
    // First check Redis
    const presence = await this.redis.getPresence(userId);
    if (presence) {
      return presence;
    }

    // Check if user has any active sessions
    const isOnline = await this.sessionService.isUserOnline(userId);
    if (isOnline) {
      return {
        status: 'online',
        lastSeen: new Date(),
      };
    }

    return null;
  }

  async getBulkPresence(userIds: string[]): Promise<Map<string, Presence>> {
    const presences = await this.redis.getMultiplePresence(userIds);
    const result = new Map<string, Presence>();

    for (const [userId, presence] of Object.entries(presences)) {
      result.set(userId, presence);
    }

    // Check for users with sessions but no explicit presence
    for (const userId of userIds) {
      if (!result.has(userId)) {
        const isOnline = await this.sessionService.isUserOnline(userId);
        if (isOnline) {
          result.set(userId, {
            status: 'online',
            lastSeen: new Date(),
          });
        }
      }
    }

    return result;
  }

  async setOffline(userId: string): Promise<void> {
    await this.redis.removePresence(userId);
  }

  async broadcastPresenceUpdate(
    userId: string,
    presence: Presence,
    broadcast: (userIds: string[], message: unknown) => void
  ): Promise<void> {
    // This would typically notify contacts
    // For now, we'll skip this as it requires contact relationships
  }
}
