import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PresenceService } from './presence.js';

const makeRedis = () => ({
  setPresence: vi.fn(),
  getPresence: vi.fn(),
  removePresence: vi.fn(),
  getMultiplePresence: vi.fn(),
  setTyping: vi.fn(),
  clearTyping: vi.fn(),
  getTypingUsers: vi.fn(),
});

const makeSession = () => ({
  isUserOnline: vi.fn(),
  getSocketId: vi.fn(),
  getSessionsByUser: vi.fn(),
  getSession: vi.fn(),
});

describe('PresenceService', () => {
  let redis: ReturnType<typeof makeRedis>;
  let session: ReturnType<typeof makeSession>;
  let presence: PresenceService;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = makeRedis();
    session = makeSession();
    presence = new PresenceService(redis as any, session as any);
  });

  describe('updatePresence', () => {
    it('writes to Redis key', async () => {
      redis.setPresence.mockResolvedValue(undefined);

      const result = await presence.updatePresence('user-1', 'alice', 'online');

      expect(redis.setPresence).toHaveBeenCalledWith('user-1', expect.objectContaining({ status: 'online' }));
      expect(result.status).toBe('online');
    });
  });

  describe('getPresence', () => {
    it('reads from Redis key when present', async () => {
      const stored = { status: 'busy', lastSeen: new Date() };
      redis.getPresence.mockResolvedValue(stored);

      const result = await presence.getPresence('user-1');

      expect(redis.getPresence).toHaveBeenCalledWith('user-1');
      expect(result?.status).toBe('busy');
    });

    it('returns null when user has no session and no Redis entry', async () => {
      redis.getPresence.mockResolvedValue(null);
      session.isUserOnline.mockResolvedValue(false);

      const result = await presence.getPresence('user-1');

      expect(result).toBeNull();
    });

    it('returns online status when user has active session but no Redis entry', async () => {
      redis.getPresence.mockResolvedValue(null);
      session.isUserOnline.mockResolvedValue(true);

      const result = await presence.getPresence('user-1');

      expect(result?.status).toBe('online');
    });
  });

  describe('setOffline', () => {
    it('removes presence from Redis', async () => {
      redis.removePresence.mockResolvedValue(undefined);

      await presence.setOffline('user-1');

      expect(redis.removePresence).toHaveBeenCalledWith('user-1');
    });
  });

  describe('setTyping', () => {
    it('sets typing indicator in Redis', async () => {
      redis.setTyping.mockResolvedValue(undefined);

      await presence.setTyping('user-1', 'chat-1', true);

      expect(redis.setTyping).toHaveBeenCalledWith('user-1', 'chat-1');
    });

    it('clears typing indicator in Redis when isTyping=false', async () => {
      redis.clearTyping.mockResolvedValue(undefined);

      await presence.setTyping('user-1', 'chat-1', false);

      expect(redis.clearTyping).toHaveBeenCalledWith('user-1', 'chat-1');
    });
  });
});
