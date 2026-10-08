import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RateLimitService } from './rate-limit.js';

const makeRedis = () => ({
  checkRateLimit: vi.fn(),
  getRateLimitRemaining: vi.fn(),
});

describe('RateLimitService', () => {
  let redis: ReturnType<typeof makeRedis>;
  let rateLimitService: RateLimitService;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = makeRedis();
    rateLimitService = new RateLimitService(redis as any);
  });

  describe('checkMessageRateLimit', () => {
    it('allows first message (returns true)', async () => {
      redis.checkRateLimit.mockResolvedValue(true);

      const allowed = await rateLimitService.checkMessageRateLimit('user-1');

      expect(allowed).toBe(true);
      expect(redis.checkRateLimit).toHaveBeenCalledWith('msg:user-1', expect.any(Number), 60);
    });

    it('blocks after limit exceeded (returns false)', async () => {
      redis.checkRateLimit.mockResolvedValue(false);

      const allowed = await rateLimitService.checkMessageRateLimit('user-1');

      expect(allowed).toBe(false);
    });
  });

  describe('checkLoginRateLimit', () => {
    it('allows login attempts within limit', async () => {
      redis.checkRateLimit.mockResolvedValue(true);

      const allowed = await rateLimitService.checkLoginRateLimit('192.168.1.1');

      expect(allowed).toBe(true);
      expect(redis.checkRateLimit).toHaveBeenCalledWith('login:192.168.1.1', expect.any(Number), 60);
    });

    it('blocks login attempts after limit exceeded', async () => {
      redis.checkRateLimit.mockResolvedValue(false);

      const allowed = await rateLimitService.checkLoginRateLimit('192.168.1.1');

      expect(allowed).toBe(false);
    });
  });

  describe('checkCustomRateLimit', () => {
    it('delegates to Redis checkRateLimit with given params', async () => {
      redis.checkRateLimit.mockResolvedValue(true);

      const allowed = await rateLimitService.checkCustomRateLimit('custom:key', 5, 30);

      expect(redis.checkRateLimit).toHaveBeenCalledWith('custom:key', 5, 30);
      expect(allowed).toBe(true);
    });
  });

  describe('getMessageRateLimitRemaining', () => {
    it('returns remaining count from Redis', async () => {
      redis.getRateLimitRemaining.mockResolvedValue(10);

      const remaining = await rateLimitService.getMessageRateLimitRemaining('user-1');

      expect(remaining).toBe(10);
    });
  });
});
