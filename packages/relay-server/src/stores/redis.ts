import Redis from 'ioredis';
import type { Presence } from '@pingio/shared';
import { PRESENCE_HEARTBEAT_INTERVAL } from '@pingio/shared';

export class RedisStore {
  private redis: Redis;
  private subRedis: Redis; // Separate connection for pub/sub

  constructor(connectionString?: string) {
    if (connectionString) {
      // Support both full Redis URLs (redis://host:port) and simple hostnames
      if (connectionString.startsWith('redis://') || connectionString.startsWith('rediss://')) {
        // Parse redis://host:port format manually
        try {
          // Remove protocol prefix
          const withoutProtocol = connectionString.replace(/^rediss?:\/\//, '');
          // Split host:port
          const [host, portStr] = withoutProtocol.split(':');
          const port = portStr ? parseInt(portStr) : 6379;
          console.log(`Connecting to Redis at ${host}:${port}`);
          this.redis = new Redis({ host, port, family: 4 });
          this.subRedis = new Redis({ host, port, family: 4 });
        } catch (err) {
          console.error('Failed to parse Redis URL, using full string:', err);
          this.redis = new Redis(connectionString);
          this.subRedis = new Redis(connectionString);
        }
      } else {
        console.log(`Connecting to Redis at ${connectionString}:6379`);
        this.redis = new Redis({ host: connectionString, port: 6379, family: 4 });
        this.subRedis = new Redis({ host: connectionString, port: 6379, family: 4 });
      }
    } else {
      console.log('Connecting to Redis at localhost:6379');
      this.redis = new Redis({ family: 4 });
      this.subRedis = new Redis({ family: 4 });
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
    await this.subRedis.quit();
  }

  // Session management
  async setSession(userId: string, sessionId: string, socketId: string): Promise<void> {
    await this.redis.hset(`sessions:${userId}`, sessionId, socketId);
    await this.redis.expire(`sessions:${userId}`, 86400); // 24 hours
  }

  async removeSession(userId: string, sessionId: string): Promise<void> {
    await this.redis.hdel(`sessions:${userId}`, sessionId);
  }

  async getSessions(userId: string): Promise<Record<string, string>> {
    return await this.redis.hgetall(`sessions:${userId}`);
  }

  async getSessionSocket(userId: string, sessionId: string): Promise<string | null> {
    return await this.redis.hget(`sessions:${userId}`, sessionId);
  }

  // Presence management
  async setPresence(userId: string, presence: Presence): Promise<void> {
    const key = `presence:${userId}`;
    await this.redis.setex(
      key,
      Math.ceil(PRESENCE_HEARTBEAT_INTERVAL / 1000) * 2,
      JSON.stringify(presence)
    );
  }

  async getPresence(userId: string): Promise<Presence | null> {
    const data = await this.redis.get(`presence:${userId}`);
    return data ? JSON.parse(data) : null;
  }

  async getMultiplePresence(userIds: string[]): Promise<Record<string, Presence>> {
    if (userIds.length === 0) return {};

    const keys = userIds.map(id => `presence:${id}`);
    const results = await this.redis.mget(...keys);

    const presence: Record<string, Presence> = {};
    userIds.forEach((userId, index) => {
      const raw = results[index];
      if (raw) {
        presence[userId] = JSON.parse(raw);
      }
    });

    return presence;
  }

  async removePresence(userId: string): Promise<void> {
    await this.redis.del(`presence:${userId}`);
  }

  // Rate limiting
  async checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const current = await this.redis.incr(`ratelimit:${key}`);
    if (current === 1) {
      await this.redis.expire(`ratelimit:${key}`, windowSeconds);
    }
    return current <= limit;
  }

  async getRateLimitRemaining(key: string, limit: number): Promise<number> {
    const current = await this.redis.get(`ratelimit:${key}`);
    return limit - (parseInt(current || '0'));
  }

  // Message delivery tracking
  async markMessageDelivered(messageId: string, userId: string): Promise<void> {
    await this.redis.sadd(`msg:delivered:${messageId}`, userId);
    await this.redis.expire(`msg:delivered:${messageId}`, 86400 * 7); // 7 days
  }

  async markMessageRead(messageId: string, userId: string): Promise<void> {
    await this.redis.sadd(`msg:read:${messageId}`, userId);
    await this.redis.expire(`msg:read:${messageId}`, 86400 * 7);
  }

  async isMessageDelivered(messageId: string, userId: string): Promise<boolean> {
    const result = await this.redis.sismember(`msg:delivered:${messageId}`, userId);
    return result === 1;
  }

  async isMessageRead(messageId: string, userId: string): Promise<boolean> {
    const result = await this.redis.sismember(`msg:read:${messageId}`, userId);
    return result === 1;
  }

  // Typing indicators
  async setTyping(userId: string, chatId: string): Promise<void> {
    await this.redis.setex(`typing:${chatId}:${userId}`, 5, Date.now().toString());
  }

  async clearTyping(userId: string, chatId: string): Promise<void> {
    await this.redis.del(`typing:${chatId}:${userId}`);
  }

  async getTypingUsers(chatId: string): Promise<string[]> {
    const pattern = `typing:${chatId}:*`;
    const keys = await this.redis.keys(pattern);
    return keys.map(key => key.split(':').pop()!);
  }

  // Pub/Sub for multi-instance relay
  async publish(channel: string, message: unknown): Promise<void> {
    await this.redis.publish(channel, JSON.stringify(message));
  }

  async subscribe(channel: string, handler: (message: unknown) => void): Promise<void> {
    await this.subRedis.subscribe(channel);
    this.subRedis.on('message', (receivedChannel, message) => {
      if (receivedChannel === channel) {
        handler(JSON.parse(message));
      }
    });
  }

  async unsubscribe(channel: string): Promise<void> {
    await this.subRedis.unsubscribe(channel);
  }

  // General cache operations
  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    if (ttlSeconds) {
      await this.redis.setex(key, ttlSeconds, serialized);
    } else {
      await this.redis.set(key, serialized);
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const data = await this.redis.get(key);
    return data ? JSON.parse(data) : null;
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }
}
