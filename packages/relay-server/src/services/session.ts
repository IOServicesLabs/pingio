import { v4 as uuidv4 } from 'uuid';
import type { RedisStore } from '../stores/redis.js';
import type { PostgresStore } from '../stores/postgres.js';
import type { User } from '@pingio/shared';

export interface Session {
  id: string;
  userId: string;
  username: string;
  socketId: string;
  deviceId?: string;
  connectedAt: Date;
  lastActivity: Date;
}

export class SessionService {
  private sessions: Map<string, Session> = new Map(); // socketId -> Session
  private userSockets: Map<string, Set<string>> = new Map(); // userId -> Set of socketIds

  constructor(
    private redis: RedisStore,
    private postgres: PostgresStore
  ) {}

  async createSession(userId: string, username: string, socketId: string, deviceId?: string): Promise<Session> {
    const session: Session = {
      id: uuidv4(),
      userId,
      username,
      socketId,
      deviceId,
      connectedAt: new Date(),
      lastActivity: new Date(),
    };

    // Store in memory
    this.sessions.set(socketId, session);

    // Track user's sockets
    if (!this.userSockets.has(userId)) {
      this.userSockets.set(userId, new Set());
    }
    this.userSockets.get(userId)!.add(socketId);

    // Store in Redis for multi-instance support
    await this.redis.setSession(userId, session.id, socketId);

    // Update last seen in database
    await this.postgres.updateLastSeen(userId);

    return session;
  }

  async destroySession(socketId: string): Promise<Session | null> {
    const session = this.sessions.get(socketId);
    if (!session) return null;

    // Remove from memory
    this.sessions.delete(socketId);

    // Remove from user sockets
    const userSockets = this.userSockets.get(session.userId);
    if (userSockets) {
      userSockets.delete(socketId);
      if (userSockets.size === 0) {
        this.userSockets.delete(session.userId);
      }
    }

    // Remove from Redis
    await this.redis.removeSession(session.userId, session.id);

    // If no more sessions for this user, remove presence
    const remainingSessions = await this.redis.getSessions(session.userId);
    if (Object.keys(remainingSessions).length === 0) {
      await this.redis.removePresence(session.userId);
    }

    return session;
  }

  getSession(socketId: string): Session | undefined {
    return this.sessions.get(socketId);
  }

  getSessionsByUser(userId: string): Session[] {
    const socketIds = this.userSockets.get(userId);
    if (!socketIds) return [];

    return Array.from(socketIds)
      .map(socketId => this.sessions.get(socketId))
      .filter((session): session is Session => session !== undefined);
  }

  getAllUserSessions(): Map<string, Set<string>> {
    return new Map(this.userSockets);
  }

  async updateActivity(socketId: string): Promise<void> {
    const session = this.sessions.get(socketId);
    if (session) {
      session.lastActivity = new Date();
    }
  }

  async isUserOnline(userId: string): Promise<boolean> {
    // Check memory first
    const localSockets = this.userSockets.get(userId);
    if (localSockets && localSockets.size > 0) {
      return true;
    }

    // Check Redis for other instances
    const sessions = await this.redis.getSessions(userId);
    return Object.keys(sessions).length > 0;
  }

  async getOnlineUserCount(): Promise<number> {
    return this.userSockets.size;
  }
}
