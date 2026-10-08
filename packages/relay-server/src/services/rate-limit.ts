import type { RedisStore } from '../stores/redis.js';
import { MESSAGES_PER_MINUTE, LOGIN_ATTEMPTS_PER_MINUTE } from '@pingio/shared';

export class RateLimitService {
  constructor(private redis: RedisStore) {}

  async checkMessageRateLimit(userId: string): Promise<boolean> {
    const key = `msg:${userId}`;
    return await this.redis.checkRateLimit(key, MESSAGES_PER_MINUTE, 60);
  }

  async getMessageRateLimitRemaining(userId: string): Promise<number> {
    const key = `msg:${userId}`;
    return await this.redis.getRateLimitRemaining(key, MESSAGES_PER_MINUTE);
  }

  async checkLoginRateLimit(identifier: string): Promise<boolean> {
    const key = `login:${identifier}`;
    return await this.redis.checkRateLimit(key, LOGIN_ATTEMPTS_PER_MINUTE, 60);
  }

  async getLoginRateLimitRemaining(identifier: string): Promise<number> {
    const key = `login:${identifier}`;
    return await this.redis.getRateLimitRemaining(key, LOGIN_ATTEMPTS_PER_MINUTE);
  }

  async checkCustomRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    return await this.redis.checkRateLimit(key, limit, windowSeconds);
  }
}
