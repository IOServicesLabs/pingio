import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import type {
  User,
  Contact,
  Message,
  Channel,
  ChannelMember,
  ChannelRole,
  ChannelAuditAction,
  ChannelAuditEvent,
  ChatSettings,
  BuildTask,
  MemberSessionStatus,
  ContextShare,
  ContextShareStatus,
  ContextGitInfo,
} from '@pingio/shared';
import { DEFAULT_CONTEXT_SHARE_TTL_MINUTES } from '@pingio/shared';

const { Pool } = pg;

export class PostgresStore {
  private pool: pg.Pool;

  constructor(connectionString?: string) {
    this.pool = new Pool({
      connectionString: connectionString || process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
  }

  async init(): Promise<void> {
    await this.createTables();
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async createTables(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          username VARCHAR(32) UNIQUE NOT NULL,
          display_name VARCHAR(64),
          password_hash VARCHAR(255),
          created_at TIMESTAMP DEFAULT NOW(),
          last_seen_at TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
        CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen_at);
      `);

      await client.query(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS relay_id UUID;
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS contacts (
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          contact_id UUID REFERENCES users(id) ON DELETE CASCADE,
          custom_name VARCHAR(64),
          is_blocked BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT NOW(),
          PRIMARY KEY (user_id, contact_id)
        );

        CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);
      `);

      await client.query(`
        ALTER TABLE contacts ADD COLUMN IF NOT EXISTS relay_id UUID;
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS channels (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(64) NOT NULL,
          display_name VARCHAR(64) NOT NULL,
          is_public BOOLEAN DEFAULT FALSE,
          created_by UUID REFERENCES users(id),
          created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_channels_name ON channels(name);
        CREATE INDEX IF NOT EXISTS idx_channels_public ON channels(is_public);
      `);

      await client.query(`
        ALTER TABLE channels ADD COLUMN IF NOT EXISTS relay_id UUID;
      `);

      await client.query(`
        ALTER TABLE channels
        ADD COLUMN IF NOT EXISTS channel_type VARCHAR(16) DEFAULT 'social',
        ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id),
        ADD COLUMN IF NOT EXISTS build_prompt TEXT,
        ADD COLUMN IF NOT EXISTS max_members INT DEFAULT 50;
      `);

      await client.query(`
        ALTER TABLE channels
        ADD COLUMN IF NOT EXISTS encryption_enabled BOOLEAN DEFAULT FALSE;
      `);

      // Message retention: per-channel TTL override (minutes). NULL = inherit
      // the server-wide MESSAGE_RETENTION_MINUTES default (0 = keep forever).
      await client.query(`
        ALTER TABLE channels ADD COLUMN IF NOT EXISTS retention_minutes INT;
      `);

      // E2E encryption: per-user X25519 identity public keys and per-channel
      // wrapped key shares. The relay stores only public keys and opaque
      // wrapped blobs — plaintext channel keys never touch the server.
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_encryption_keys (
          user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          x25519_public_key TEXT NOT NULL,
          updated_at TIMESTAMP DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS channel_key_shares (
          channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          key_id VARCHAR(32) NOT NULL,
          ephemeral_public_key TEXT NOT NULL,
          wrapped_key TEXT NOT NULL,
          nonce TEXT NOT NULL,
          created_by UUID REFERENCES users(id),
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          PRIMARY KEY (channel_id, user_id, key_id)
        );

        CREATE INDEX IF NOT EXISTS idx_channel_key_shares_user ON channel_key_shares(user_id);
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS channel_invites (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
          invite_code VARCHAR(64) UNIQUE NOT NULL,
          created_by UUID REFERENCES users(id),
          max_uses INT,
          uses_count INT DEFAULT 0,
          expires_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_channel_invites_code ON channel_invites(invite_code);
        CREATE INDEX IF NOT EXISTS idx_channel_invites_channel ON channel_invites(channel_id);
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS build_tasks (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
          owner_id UUID REFERENCES users(id),
          title VARCHAR(255) NOT NULL,
          description TEXT,
          status VARCHAR(16) DEFAULT 'pending',
          assigned_to UUID REFERENCES users(id),
          artifact_filename VARCHAR(255),
          artifact_size INT,
          created_at TIMESTAMP DEFAULT NOW(),
          assigned_at TIMESTAMP,
          completed_at TIMESTAMP,
          context_cleared_at TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_build_tasks_channel ON build_tasks(channel_id);
        CREATE INDEX IF NOT EXISTS idx_build_tasks_status ON build_tasks(status);
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS member_session_status (
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
          reported_at TIMESTAMP DEFAULT NOW(),
          remaining_requests INT,
          context_window_used REAL,
          selected_model VARCHAR(64),
          PRIMARY KEY (user_id, channel_id)
        );

        CREATE INDEX IF NOT EXISTS idx_member_session_status_channel ON member_session_status(channel_id);
      `);

      // Migrate existing tables from INT to REAL so fractional context window values can be stored
      await client.query(`
        ALTER TABLE member_session_status
        ALTER COLUMN context_window_used TYPE REAL
        USING context_window_used::REAL
      `).catch(() => { /* column may already be REAL or table may not exist */ });

      // Context shares: ephemeral snapshots of what a user is working on.
      // Scoped to exactly one conversation (channel XOR DM peer) and
      // self-expiring via expires_at. Partial unique indexes enforce one live
      // share per user per scope, so re-sharing replaces the previous snapshot.
      await client.query(`
        CREATE TABLE IF NOT EXISTS context_shares (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
          recipient_id UUID REFERENCES users(id) ON DELETE CASCADE,
          summary VARCHAR(512) NOT NULL,
          details TEXT,
          files TEXT[],
          status VARCHAR(16) DEFAULT 'working',
          project VARCHAR(128),
          git JSONB,
          task_id UUID,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          expires_at TIMESTAMP NOT NULL,
          CONSTRAINT context_shares_scope_check CHECK (
            (channel_id IS NOT NULL AND recipient_id IS NULL) OR
            (channel_id IS NULL AND recipient_id IS NOT NULL)
          )
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_context_shares_channel_scope
          ON context_shares(user_id, channel_id) WHERE channel_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_context_shares_dm_scope
          ON context_shares(user_id, recipient_id) WHERE recipient_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_context_shares_expires ON context_shares(expires_at);
      `);

      // Idempotent migration for databases created before the git column existed.
      await client.query('ALTER TABLE context_shares ADD COLUMN IF NOT EXISTS git JSONB');

      await client.query(`
        CREATE TABLE IF NOT EXISTS channel_members (
          channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          joined_at TIMESTAMP DEFAULT NOW(),
          is_admin BOOLEAN DEFAULT FALSE,
          PRIMARY KEY (channel_id, user_id)
        );

        CREATE INDEX IF NOT EXISTS idx_channel_members_channel ON channel_members(channel_id);
        CREATE INDEX IF NOT EXISTS idx_channel_members_user ON channel_members(user_id);
      `);

      // Member roles: 'owner' (channel creator, exactly one), 'admin', 'member'.
      // is_admin is kept in sync (true for owner and admin) so existing
      // is_admin checks keep working.
      await client.query(`
        ALTER TABLE channel_members
        ADD COLUMN IF NOT EXISTS role VARCHAR(16) DEFAULT 'member';
      `);
      await client.query(`
        UPDATE channel_members SET role = 'admin' WHERE is_admin = TRUE AND role = 'member';
      `);
      await client.query(`
        UPDATE channel_members cm SET role = 'owner'
        FROM channels c
        WHERE cm.channel_id = c.id AND cm.user_id = c.created_by;
      `);
      await client.query(`
        UPDATE channel_members SET is_admin = TRUE WHERE role IN ('owner', 'admin') AND is_admin = FALSE;
      `);

      // Channel audit log: security-relevant membership/administration events.
      // Metadata only — never message content or key material.
      await client.query(`
        CREATE TABLE IF NOT EXISTS channel_audit_events (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
          actor_id UUID REFERENCES users(id),
          action VARCHAR(32) NOT NULL,
          target_id UUID REFERENCES users(id),
          metadata JSONB,
          created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_channel_audit_channel ON channel_audit_events(channel_id, created_at);
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS messages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          sender_id UUID REFERENCES users(id),
          recipient_id UUID REFERENCES users(id),
          channel_id UUID REFERENCES channels(id),
          content TEXT NOT NULL,
          is_ephemeral BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT NOW(),
          edited_at TIMESTAMP,
          deleted_at TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
        CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id);
        CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
        CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
      `);

      await client.query(`
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS relay_id UUID;
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS chat_settings (
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          chat_id VARCHAR(64) NOT NULL,
          is_ephemeral BOOLEAN DEFAULT FALSE,
          mute_notifications BOOLEAN DEFAULT FALSE,
          updated_at TIMESTAMP DEFAULT NOW(),
          PRIMARY KEY (user_id, chat_id)
        );
      `);

      // Device management tables for enhanced security
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_devices (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          device_fingerprint VARCHAR(255) NOT NULL,
          device_name VARCHAR(128),
          last_ip INET,
          last_seen TIMESTAMP,
          is_verified BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(user_id, device_fingerprint)
        );

        CREATE INDEX IF NOT EXISTS idx_user_devices_user ON user_devices(user_id);
        CREATE INDEX IF NOT EXISTS idx_user_devices_fingerprint ON user_devices(device_fingerprint);
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS refresh_tokens (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          device_id UUID REFERENCES user_devices(id) ON DELETE CASCADE,
          token_hash VARCHAR(255) NOT NULL,
          expires_at TIMESTAMP NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
        CREATE INDEX IF NOT EXISTS idx_refresh_tokens_device ON refresh_tokens(device_id);
        CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
      `);
    } finally {
      client.release();
    }
  }

  // User operations
  async createUser(
    username: string,
    passwordHash: string,
    displayName?: string,
    id?: string
  ): Promise<User | null> {
    try {
      const result = await this.pool.query(
        `INSERT INTO users (id, username, display_name, password_hash, created_at, last_seen_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         RETURNING *`,
        [id || uuidv4(), username, displayName || null, passwordHash]
      );
      return this.mapUser(result.rows[0]);
    } catch (error) {
      if ((error as pg.DatabaseError).code === '23505') {
        return null; // Duplicate username
      }
      throw error;
    }
  }

  async getUserById(id: string): Promise<User | null> {
    const result = await this.pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return result.rows[0] ? this.mapUser(result.rows[0]) : null;
  }

  async getUserByUsername(username: string): Promise<User | null> {
    const result = await this.pool.query('SELECT * FROM users WHERE username = $1', [username]);
    return result.rows[0] ? this.mapUser(result.rows[0]) : null;
  }

  async getUserWithPassword(username: string): Promise<(User & { passwordHash: string }) | null> {
    const result = await this.pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (!result.rows[0]) return null;
    return {
      ...this.mapUser(result.rows[0])!,
      passwordHash: result.rows[0].password_hash,
    };
  }

  async updateLastSeen(userId: string): Promise<void> {
    await this.pool.query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [userId]);
  }

  async searchUsers(query: string, limit: number = 10): Promise<User[]> {
    const result = await this.pool.query(
      `SELECT * FROM users
       WHERE username ILIKE $1 OR display_name ILIKE $1
       LIMIT $2`,
      [`%${query}%`, limit]
    );
    return result.rows.map(row => this.mapUser(row)!);
  }

  // Contact operations
  async addContact(userId: string, contactId: string, customName?: string): Promise<Contact | null> {
    try {
      const result = await this.pool.query(
        `WITH inserted AS (
           INSERT INTO contacts (user_id, contact_id, custom_name, created_at)
           VALUES ($1, $2, $3, NOW())
           RETURNING *
         )
         SELECT i.*, u.username, u.display_name
         FROM inserted i
         JOIN users u ON i.contact_id = u.id`,
        [userId, contactId, customName || null]
      );
      return this.mapContact(result.rows[0]);
    } catch (error) {
      if ((error as pg.DatabaseError).code === '23505') {
        return null;
      }
      throw error;
    }
  }

  async removeContact(userId: string, contactId: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM contacts WHERE user_id = $1 AND contact_id = $2',
      [userId, contactId]
    );
    return result.rowCount! > 0;
  }

  async getContacts(userId: string): Promise<Contact[]> {
    const result = await this.pool.query(
      `SELECT c.*, u.username, u.display_name
       FROM contacts c
       JOIN users u ON c.contact_id = u.id
       WHERE c.user_id = $1`,
      [userId]
    );
    return result.rows.map(row => this.mapContact(row)).filter(Boolean) as Contact[];
  }

  async blockContact(userId: string, contactId: string, blocked: boolean): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE contacts SET is_blocked = $3 WHERE user_id = $1 AND contact_id = $2',
      [userId, contactId, blocked]
    );
    return result.rowCount! > 0;
  }

  async checkMutualContact(userId: string, contactId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT EXISTS (
        SELECT 1 FROM contacts c1
        JOIN contacts c2 ON c1.contact_id = c2.user_id AND c1.user_id = c2.contact_id
        WHERE c1.user_id = $1 AND c1.contact_id = $2
        AND c1.is_blocked = FALSE AND c2.is_blocked = FALSE
      ) as is_mutual`,
      [userId, contactId]
    );
    return result.rows[0]?.is_mutual || false;
  }

  async isBlocked(userId: string, contactId: string): Promise<{ blockedBy: boolean; blockedTarget: boolean }> {
    const result = await this.pool.query(
      `SELECT
        EXISTS (SELECT 1 FROM contacts WHERE user_id = $1 AND contact_id = $2 AND is_blocked = TRUE) as blocked_target,
        EXISTS (SELECT 1 FROM contacts WHERE user_id = $2 AND contact_id = $1 AND is_blocked = TRUE) as blocked_by`,
      [userId, contactId]
    );
    return {
      blockedBy: result.rows[0]?.blocked_by || false,
      blockedTarget: result.rows[0]?.blocked_target || false,
    };
  }

  // Device operations
  async createDevice(
    userId: string,
    deviceFingerprint: string,
    deviceName?: string,
    lastIp?: string,
    isVerified: boolean = false
  ): Promise<{ id: string; isNew: boolean } | null> {
    try {
      const result = await this.pool.query(
        `INSERT INTO user_devices (id, user_id, device_fingerprint, device_name, last_ip, is_verified, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (user_id, device_fingerprint)
         DO UPDATE SET last_seen = NOW(), last_ip = $5
         RETURNING id, (xmax = 0) as is_new`,
        [uuidv4(), userId, deviceFingerprint, deviceName || null, lastIp || null, isVerified]
      );
      return {
        id: result.rows[0].id,
        isNew: result.rows[0].is_new,
      };
    } catch (error) {
      console.error('Failed to create device:', error);
      return null;
    }
  }

  async getDeviceById(deviceId: string): Promise<{ id: string; userId: string; deviceName?: string; deviceFingerprint: string; isVerified: boolean } | null> {
    const result = await this.pool.query(
      'SELECT id, user_id, device_name, device_fingerprint, is_verified FROM user_devices WHERE id = $1',
      [deviceId]
    );
    if (!result.rows[0]) return null;
    return {
      id: result.rows[0].id,
      userId: result.rows[0].user_id,
      deviceName: result.rows[0].device_name,
      deviceFingerprint: result.rows[0].device_fingerprint,
      isVerified: result.rows[0].is_verified,
    };
  }

  async getDeviceByFingerprint(userId: string, deviceFingerprint: string): Promise<{ id: string; isVerified: boolean } | null> {
    const result = await this.pool.query(
      'SELECT id, is_verified FROM user_devices WHERE user_id = $1 AND device_fingerprint = $2',
      [userId, deviceFingerprint]
    );
    if (!result.rows[0]) return null;
    return {
      id: result.rows[0].id,
      isVerified: result.rows[0].is_verified,
    };
  }

  async getUserDevices(userId: string): Promise<Array<{ id: string; deviceName?: string; lastSeen?: Date; isVerified: boolean }>> {
    const result = await this.pool.query(
      'SELECT id, device_name, last_seen, is_verified FROM user_devices WHERE user_id = $1 ORDER BY last_seen DESC',
      [userId]
    );
    return result.rows.map(row => ({
      id: row.id,
      deviceName: row.device_name,
      lastSeen: row.last_seen,
      isVerified: row.is_verified,
    }));
  }

  async verifyDevice(deviceId: string): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE user_devices SET is_verified = TRUE, last_seen = NOW() WHERE id = $1',
      [deviceId]
    );
    return result.rowCount! > 0;
  }

  async revokeDevice(deviceId: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM user_devices WHERE id = $1 AND user_id = $2',
      [deviceId, userId]
    );
    return result.rowCount! > 0;
  }

  async getDeviceCount(userId: string): Promise<number> {
    const result = await this.pool.query(
      'SELECT COUNT(*) as count FROM user_devices WHERE user_id = $1',
      [userId]
    );
    return parseInt(result.rows[0]?.count || '0', 10);
  }

  async updateDeviceLastSeen(deviceId: string, lastIp?: string): Promise<void> {
    await this.pool.query(
      'UPDATE user_devices SET last_seen = NOW(), last_ip = $2 WHERE id = $1',
      [deviceId, lastIp || null]
    );
  }

  // Refresh token operations
  async createRefreshToken(userId: string, deviceId: string, tokenHash: string, expiresAt: Date): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING id`,
      [uuidv4(), userId, deviceId, tokenHash, expiresAt]
    );
    return result.rows[0].id;
  }

  async getRefreshTokenByHash(tokenHash: string): Promise<{ id: string; userId: string; deviceId: string; expiresAt: Date } | null> {
    const result = await this.pool.query(
      'SELECT id, user_id, device_id, expires_at FROM refresh_tokens WHERE token_hash = $1 AND expires_at > NOW()',
      [tokenHash]
    );
    if (!result.rows[0]) return null;
    return {
      id: result.rows[0].id,
      userId: result.rows[0].user_id,
      deviceId: result.rows[0].device_id,
      expiresAt: result.rows[0].expires_at,
    };
  }

  async revokeRefreshToken(tokenHash: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM refresh_tokens WHERE token_hash = $1',
      [tokenHash]
    );
    return result.rowCount! > 0;
  }

  async revokeAllRefreshTokensForDevice(deviceId: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM refresh_tokens WHERE device_id = $1',
      [deviceId]
    );
  }

  // Message operations
  async createMessage(
    senderId: string,
    content: string,
    recipientId?: string,
    channelId?: string,
    isEphemeral: boolean = false
  ): Promise<Message> {
    const result = await this.pool.query(
      `INSERT INTO messages (id, sender_id, recipient_id, channel_id, content, is_ephemeral, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`,
      [uuidv4(), senderId, recipientId || null, channelId || null, content, isEphemeral]
    );
    return this.mapMessage(result.rows[0]);
  }

  async getMessage(messageId: string): Promise<Message | null> {
    const result = await this.pool.query(
      `SELECT m.*, u.username as sender_username
       FROM messages m
       JOIN users u ON m.sender_id = u.id
       WHERE m.id = $1 AND m.deleted_at IS NULL`,
      [messageId]
    );
    return result.rows[0] ? this.mapMessage(result.rows[0]) : null;
  }

  async getDMHistory(
    userId1: string,
    userId2: string,
    before?: Date,
    limit: number = 50
  ): Promise<Message[]> {
    const result = await this.pool.query(
      `SELECT m.*, u.username as sender_username
       FROM messages m
       JOIN users u ON m.sender_id = u.id
       WHERE ((m.sender_id = $1 AND m.recipient_id = $2) OR (m.sender_id = $2 AND m.recipient_id = $1))
         AND m.deleted_at IS NULL
         AND ($3::timestamp IS NULL OR m.created_at < $3)
       ORDER BY m.created_at DESC
       LIMIT $4`,
      [userId1, userId2, before || null, limit]
    );
    return result.rows.map(row => this.mapMessage(row));
  }

  async getChannelHistory(
    channelId: string,
    before?: Date,
    limit: number = 50
  ): Promise<Message[]> {
    const result = await this.pool.query(
      `SELECT m.*, u.username as sender_username
       FROM messages m
       JOIN users u ON m.sender_id = u.id
       WHERE m.channel_id = $1 AND m.deleted_at IS NULL
         AND ($2::timestamp IS NULL OR m.created_at < $2)
       ORDER BY m.created_at DESC
       LIMIT $3`,
      [channelId, before || null, limit]
    );
    return result.rows.map(row => this.mapMessage(row));
  }

  async editMessage(messageId: string, content: string): Promise<Message | null> {
    const result = await this.pool.query(
      `UPDATE messages SET content = $2, edited_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING *`,
      [messageId, content]
    );
    return result.rows[0] ? this.mapMessage(result.rows[0]) : null;
  }

  async deleteMessage(messageId: string, forEveryone: boolean): Promise<boolean> {
    if (forEveryone) {
      const result = await this.pool.query(
        'UPDATE messages SET deleted_at = NOW() WHERE id = $1',
        [messageId]
      );
      return result.rowCount! > 0;
    }
    // If not for everyone, we would need a separate table for per-user deletion
    // For simplicity, we'll just mark it deleted
    return true;
  }

  // Channel operations
  async createChannel(
    name: string,
    displayName: string,
    createdBy: string,
    isPublic: boolean = false,
    channelType: 'social' | 'build' = 'social',
    buildPrompt?: string,
    maxMembers: number = 50,
    encryptionEnabled: boolean = false
  ): Promise<Channel> {
    const ownerId = channelType === 'build' ? createdBy : undefined;
    const result = await this.pool.query(
      `INSERT INTO channels (id, name, display_name, is_public, channel_type, created_by, owner_id, build_prompt, max_members, encryption_enabled, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       RETURNING *`,
      [uuidv4(), name, displayName, isPublic, channelType, createdBy, ownerId || null, buildPrompt || null, maxMembers, encryptionEnabled]
    );
    return this.mapChannel(result.rows[0]);
  }

  async getChannel(channelId: string): Promise<Channel | null> {
    const result = await this.pool.query(
      `SELECT c.*, COUNT(cm.user_id) as member_count
       FROM channels c
       LEFT JOIN channel_members cm ON c.id = cm.channel_id
       WHERE c.id = $1
       GROUP BY c.id`,
      [channelId]
    );
    return result.rows[0] ? this.mapChannel(result.rows[0]) : null;
  }

  async getChannelByName(name: string): Promise<Channel | null> {
    const result = await this.pool.query('SELECT * FROM channels WHERE name = $1', [name]);
    return result.rows[0] ? this.mapChannel(result.rows[0]) : null;
  }

  async getPublicChannels(limit: number = 50): Promise<Channel[]> {
    const result = await this.pool.query(
      `SELECT c.*, COUNT(cm.user_id) as member_count
       FROM channels c
       LEFT JOIN channel_members cm ON c.id = cm.channel_id
       WHERE c.is_public = TRUE
       GROUP BY c.id
       LIMIT $1`,
      [limit]
    );
    return result.rows.map(row => this.mapChannel(row));
  }

  async joinChannel(channelId: string, userId: string, isAdmin: boolean = false): Promise<boolean> {
    try {
      await this.pool.query(
        `INSERT INTO channel_members (channel_id, user_id, joined_at, is_admin, role)
         VALUES ($1, $2, NOW(), $3, $4)`,
        [channelId, userId, isAdmin, isAdmin ? 'admin' : 'member']
      );
      return true;
    } catch (error) {
      if ((error as pg.DatabaseError).code === '23505') {
        return false; // Already a member
      }
      throw error;
    }
  }

  async leaveChannel(channelId: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2',
      [channelId, userId]
    );
    return result.rowCount! > 0;
  }

  async getChannelMembers(channelId: string): Promise<ChannelMember[]> {
    const result = await this.pool.query(
      `SELECT cm.*, u.username
       FROM channel_members cm
       JOIN users u ON cm.user_id = u.id
       WHERE cm.channel_id = $1`,
      [channelId]
    );
    return result.rows.map(row => this.mapChannelMember(row)).filter(Boolean) as ChannelMember[];
  }

  async getChannelMember(channelId: string, userId: string): Promise<ChannelMember | null> {
    const result = await this.pool.query(
      `SELECT cm.*, u.username
       FROM channel_members cm
       JOIN users u ON cm.user_id = u.id
       WHERE cm.channel_id = $1 AND cm.user_id = $2`,
      [channelId, userId]
    );
    return result.rows[0] ? this.mapChannelMember(result.rows[0]) : null;
  }

  async setChannelMemberRole(channelId: string, userId: string, role: ChannelRole): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE channel_members
       SET role = $3, is_admin = $4
       WHERE channel_id = $1 AND user_id = $2`,
      [channelId, userId, role, role === 'owner' || role === 'admin']
    );
    return result.rowCount! > 0;
  }

  // Channel audit log — see ChannelAuditEventSchema in shared. Metadata only.
  async addAuditEvent(
    channelId: string,
    actorId: string | null,
    action: ChannelAuditAction,
    targetId?: string | null,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO channel_audit_events (channel_id, actor_id, action, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [channelId, actorId, action, targetId ?? null, metadata ? JSON.stringify(metadata) : null]
    );
  }

  async getAuditEvents(channelId: string, limit: number = 100): Promise<ChannelAuditEvent[]> {
    const result = await this.pool.query(
      `SELECT e.*, actor.username AS actor_username, target.username AS target_username
       FROM channel_audit_events e
       LEFT JOIN users actor ON e.actor_id = actor.id
       LEFT JOIN users target ON e.target_id = target.id
       WHERE e.channel_id = $1
       ORDER BY e.created_at DESC
       LIMIT $2`,
      [channelId, limit]
    );
    return result.rows.map(row => ({
      id: row.id,
      channelId: row.channel_id,
      actorId: row.actor_id ?? undefined,
      actorUsername: row.actor_username ?? undefined,
      action: row.action,
      targetId: row.target_id ?? undefined,
      targetUsername: row.target_username ?? undefined,
      metadata: row.metadata ?? undefined,
      createdAt: row.created_at,
    }));
  }

  async getUserChannels(userId: string): Promise<Channel[]> {
    const result = await this.pool.query(
      `SELECT c.*, COUNT(cm2.user_id) as member_count
       FROM channels c
       JOIN channel_members cm ON c.id = cm.channel_id
       LEFT JOIN channel_members cm2 ON c.id = cm2.channel_id
       WHERE cm.user_id = $1
       GROUP BY c.id`,
      [userId]
    );
    return result.rows.map(row => this.mapChannel(row)).filter(Boolean) as Channel[];
  }

  // E2E encryption operations. The store only ever handles public identity
  // keys and opaque wrapped key blobs — plaintext channel keys are client-side only.
  async upsertEncryptionKey(userId: string, publicKey: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO user_encryption_keys (user_id, x25519_public_key, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET x25519_public_key = $2, updated_at = NOW()`,
      [userId, publicKey]
    );
  }

  async getChannelEncryptionKeys(
    channelId: string
  ): Promise<Array<{ userId: string; username: string; publicKey: string | null }>> {
    const result = await this.pool.query(
      `SELECT cm.user_id, u.username, ek.x25519_public_key
       FROM channel_members cm
       JOIN users u ON u.id = cm.user_id
       LEFT JOIN user_encryption_keys ek ON ek.user_id = cm.user_id
       WHERE cm.channel_id = $1`,
      [channelId]
    );
    return result.rows.map(row => ({
      userId: row.user_id,
      username: row.username,
      publicKey: row.x25519_public_key ?? null,
    }));
  }

  // One user's published identity public key (for DM pairwise encryption).
  // Returns null when the user doesn't exist or has never published a key.
  async getEncryptionKey(
    userId: string
  ): Promise<{ userId: string; username: string; publicKey: string; updatedAt: Date } | null> {
    const result = await this.pool.query(
      `SELECT ek.user_id, u.username, ek.x25519_public_key, ek.updated_at
       FROM user_encryption_keys ek
       JOIN users u ON u.id = ek.user_id
       WHERE ek.user_id = $1`,
      [userId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      username: row.username,
      publicKey: row.x25519_public_key,
      updatedAt: row.updated_at,
    };
  }

  // Enable-only: returns false when the channel was already enabled (or missing).
  async setChannelEncryptionEnabled(channelId: string): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE channels SET encryption_enabled = TRUE WHERE id = $1 AND encryption_enabled = FALSE',
      [channelId]
    );
    return result.rowCount! > 0;
  }

  // Upsert wrapped key shares for one key. Shares originally created by a
  // different member are never replaced — those user ids come back in
  // `conflict` so the caller can surface a 409.
  async upsertChannelKeyShares(
    channelId: string,
    keyId: string,
    createdBy: string,
    shares: Array<{ userId: string; ephemeralPublicKey: string; wrappedKey: string; nonce: string }>
  ): Promise<{ conflict: string[] }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const existing = await client.query(
        'SELECT user_id, created_by FROM channel_key_shares WHERE channel_id = $1 AND key_id = $2',
        [channelId, keyId]
      );
      const foreignOwners = new Set(
        existing.rows.filter(r => r.created_by !== createdBy).map(r => r.user_id)
      );
      const conflict = shares.filter(s => foreignOwners.has(s.userId)).map(s => s.userId);
      if (conflict.length > 0) {
        await client.query('ROLLBACK');
        return { conflict };
      }

      for (const share of shares) {
        await client.query(
          `INSERT INTO channel_key_shares
             (channel_id, user_id, key_id, ephemeral_public_key, wrapped_key, nonce, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
           ON CONFLICT (channel_id, user_id, key_id)
           DO UPDATE SET ephemeral_public_key = $4, wrapped_key = $5, nonce = $6, updated_at = NOW()`,
          [channelId, share.userId, keyId, share.ephemeralPublicKey, share.wrappedKey, share.nonce, createdBy]
        );
      }

      await client.query('COMMIT');
      return { conflict: [] };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getChannelKeySharesForUser(
    channelId: string,
    userId: string
  ): Promise<Array<{
    keyId: string;
    ephemeralPublicKey: string;
    wrappedKey: string;
    nonce: string;
    createdBy: string | null;
    updatedAt: Date;
  }>> {
    const result = await this.pool.query(
      `SELECT * FROM channel_key_shares
       WHERE channel_id = $1 AND user_id = $2
       ORDER BY updated_at DESC`,
      [channelId, userId]
    );
    return result.rows.map(row => ({
      keyId: row.key_id,
      ephemeralPublicKey: row.ephemeral_public_key,
      wrappedKey: row.wrapped_key,
      nonce: row.nonce,
      createdBy: row.created_by,
      updatedAt: row.updated_at,
    }));
  }

  // Chat settings
  async getChatSettings(userId: string, chatId: string): Promise<ChatSettings | null> {
    const result = await this.pool.query(
      'SELECT * FROM chat_settings WHERE user_id = $1 AND chat_id = $2',
      [userId, chatId]
    );
    if (!result.rows[0]) return null;
    return {
      chatId: result.rows[0].chat_id,
      isEphemeral: result.rows[0].is_ephemeral,
      muteNotifications: result.rows[0].mute_notifications,
      updatedAt: result.rows[0].updated_at,
    };
  }

  async setChatSettings(userId: string, settings: Omit<ChatSettings, 'updatedAt'>): Promise<ChatSettings> {
    const result = await this.pool.query(
      `INSERT INTO chat_settings (user_id, chat_id, is_ephemeral, mute_notifications, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, chat_id)
       DO UPDATE SET is_ephemeral = $3, mute_notifications = $4, updated_at = NOW()
       RETURNING *`,
      [userId, settings.chatId, settings.isEphemeral, settings.muteNotifications]
    );
    return {
      chatId: result.rows[0].chat_id,
      isEphemeral: result.rows[0].is_ephemeral,
      muteNotifications: result.rows[0].mute_notifications,
      updatedAt: result.rows[0].updated_at,
    };
  }

  // Mappers
  private mapUser(row: pg.QueryResultRow): User | null {
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  private mapContact(row: pg.QueryResultRow): Contact | null {
    if (!row) return null;
    return {
      userId: row.user_id,
      contactId: row.contact_id,
      username: row.username || row.contact_id,
      displayName: row.display_name,
      customName: row.custom_name,
      isBlocked: row.is_blocked,
      createdAt: row.created_at,
    };
  }

  private mapMessage(row: pg.QueryResultRow): Message {
    return {
      id: row.id,
      senderId: row.sender_id,
      senderUsername: row.sender_username,
      recipientId: row.recipient_id,
      channelId: row.channel_id,
      content: row.content,
      isEphemeral: row.is_ephemeral,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      deletedAt: row.deleted_at,
    };
  }

  // Build task operations
  async createBuildTask(
    channelId: string,
    ownerId: string,
    title: string,
    description?: string
  ): Promise<BuildTask> {
    const result = await this.pool.query(
      `INSERT INTO build_tasks (id, channel_id, owner_id, title, description, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
       RETURNING *`,
      [uuidv4(), channelId, ownerId, title, description || null]
    );
    return this.mapBuildTask(result.rows[0]);
  }

  async getBuildTasks(
    channelId: string,
    status?: string,
    assignedTo?: string
  ): Promise<BuildTask[]> {
    const conditions = ['channel_id = $1'];
    const params: any[] = [channelId];
    let paramIndex = 2;

    if (status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(status);
    }

    if (assignedTo) {
      conditions.push(`assigned_to = $${paramIndex++}`);
      params.push(assignedTo);
    }

    const result = await this.pool.query(
      `SELECT * FROM build_tasks
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC`,
      params
    );
    return result.rows.map(row => this.mapBuildTask(row));
  }

  async getBuildTaskById(taskId: string): Promise<BuildTask | null> {
    const result = await this.pool.query('SELECT * FROM build_tasks WHERE id = $1', [taskId]);
    return result.rows[0] ? this.mapBuildTask(result.rows[0]) : null;
  }

  async assignBuildTask(taskId: string, userId: string): Promise<BuildTask | null> {
    const result = await this.pool.query(
      `UPDATE build_tasks
       SET status = 'assigned', assigned_to = $2, assigned_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [taskId, userId]
    );
    return result.rows[0] ? this.mapBuildTask(result.rows[0]) : null;
  }

  async completeBuildTask(
    taskId: string,
    artifactFilename?: string,
    artifactSize?: number
  ): Promise<BuildTask | null> {
    const result = await this.pool.query(
      `UPDATE build_tasks
       SET status = 'completed', artifact_filename = $2, artifact_size = $3, completed_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [taskId, artifactFilename || null, artifactSize || null]
    );
    return result.rows[0] ? this.mapBuildTask(result.rows[0]) : null;
  }

  async failBuildTask(taskId: string): Promise<BuildTask | null> {
    const result = await this.pool.query(
      `UPDATE build_tasks SET status = 'failed' WHERE id = $1 RETURNING *`,
      [taskId]
    );
    return result.rows[0] ? this.mapBuildTask(result.rows[0]) : null;
  }

  async updateBuildTask(
    taskId: string,
    updates: Partial<Pick<BuildTask, 'title' | 'description' | 'status'>>
  ): Promise<BuildTask | null> {
    const sets: string[] = [];
    const params: any[] = [taskId];
    let paramIndex = 2;

    if (updates.title !== undefined) {
      sets.push(`title = $${paramIndex++}`);
      params.push(updates.title);
    }
    if (updates.description !== undefined) {
      sets.push(`description = $${paramIndex++}`);
      params.push(updates.description);
    }
    if (updates.status !== undefined) {
      sets.push(`status = $${paramIndex++}`);
      params.push(updates.status);
    }

    if (sets.length === 0) {
      return this.getBuildTaskById(taskId);
    }

    const result = await this.pool.query(
      `UPDATE build_tasks SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    return result.rows[0] ? this.mapBuildTask(result.rows[0]) : null;
  }

  async updateBuildTaskContextCleared(taskId: string): Promise<BuildTask | null> {
    const result = await this.pool.query(
      `UPDATE build_tasks SET context_cleared_at = NOW() WHERE id = $1 RETURNING *`,
      [taskId]
    );
    return result.rows[0] ? this.mapBuildTask(result.rows[0]) : null;
  }

  async updateMemberSessionStatus(
    userId: string,
    channelId: string,
    status: Omit<MemberSessionStatus, 'userId' | 'channelId' | 'reportedAt'>
  ): Promise<MemberSessionStatus> {
    const result = await this.pool.query(
      `INSERT INTO member_session_status (user_id, channel_id, reported_at, remaining_requests, context_window_used, selected_model)
       VALUES ($1, $2, NOW(), $3, $4, $5)
       ON CONFLICT (user_id, channel_id)
       DO UPDATE SET reported_at = NOW(), remaining_requests = $3, context_window_used = $4, selected_model = $5
       RETURNING *`,
      [
        userId,
        channelId,
        status.remainingRequests ?? null,
        status.contextWindowUsed ?? null,
        status.selectedModel ?? null,
      ]
    );
    return this.mapMemberSessionStatus(result.rows[0]);
  }

  async getMemberSessionStatuses(channelId: string): Promise<MemberSessionStatus[]> {
    const result = await this.pool.query(
      `SELECT * FROM member_session_status WHERE channel_id = $1 ORDER BY reported_at DESC`,
      [channelId]
    );
    return result.rows.map(row => this.mapMemberSessionStatus(row));
  }

  // Context share operations
  async upsertContextShare(
    userId: string,
    scope: { channelId?: string; recipientId?: string },
    share: {
      summary: string;
      details?: string;
      files?: string[];
      status?: ContextShareStatus;
      project?: string;
      git?: ContextGitInfo;
      taskId?: string;
      ttlMinutes?: number;
    }
  ): Promise<ContextShare> {
    const ttlMinutes = share.ttlMinutes ?? DEFAULT_CONTEXT_SHARE_TTL_MINUTES;
    // Each scope has its own partial unique index, so the conflict target must
    // repeat the index predicate for Postgres to infer it.
    const conflictTarget = scope.channelId
      ? '(user_id, channel_id) WHERE channel_id IS NOT NULL'
      : '(user_id, recipient_id) WHERE recipient_id IS NOT NULL';
    const result = await this.pool.query(
      `INSERT INTO context_shares
         (id, user_id, channel_id, recipient_id, summary, details, files, status, project, git, task_id, created_at, updated_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW(), NOW() + make_interval(mins => $12))
       ON CONFLICT ${conflictTarget}
       DO UPDATE SET summary = $5, details = $6, files = $7, status = $8, project = $9, git = $10, task_id = $11,
                     updated_at = NOW(), expires_at = NOW() + make_interval(mins => $12)
       RETURNING *`,
      [
        uuidv4(),
        userId,
        scope.channelId || null,
        scope.recipientId || null,
        share.summary,
        share.details || null,
        share.files || null,
        share.status || 'working',
        share.project || null,
        share.git ? JSON.stringify(share.git) : null,
        share.taskId || null,
        ttlMinutes,
      ]
    );
    return this.mapContextShare(result.rows[0]);
  }

  async revokeContextShare(
    userId: string,
    scope: { channelId?: string; recipientId?: string }
  ): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM context_shares
       WHERE user_id = $1
         AND ((channel_id IS NOT NULL AND channel_id = $2) OR (recipient_id IS NOT NULL AND recipient_id = $3))`,
      [userId, scope.channelId || null, scope.recipientId || null]
    );
    return result.rowCount! > 0;
  }

  async getContextSharesForChannel(channelId: string): Promise<ContextShare[]> {
    const result = await this.pool.query(
      `SELECT cs.*, u.username
       FROM context_shares cs
       JOIN users u ON cs.user_id = u.id
       WHERE cs.channel_id = $1 AND cs.expires_at > NOW()
       ORDER BY cs.updated_at DESC`,
      [channelId]
    );
    return result.rows.map(row => this.mapContextShare(row));
  }

  // Both directions of the DM, so each participant sees the other's snapshot
  // alongside their own.
  async getContextSharesForDM(userId: string, peerId: string): Promise<ContextShare[]> {
    const result = await this.pool.query(
      `SELECT cs.*, u.username
       FROM context_shares cs
       JOIN users u ON cs.user_id = u.id
       WHERE cs.expires_at > NOW()
         AND ((cs.user_id = $1 AND cs.recipient_id = $2) OR (cs.user_id = $2 AND cs.recipient_id = $1))
       ORDER BY cs.updated_at DESC`,
      [userId, peerId]
    );
    return result.rows.map(row => this.mapContextShare(row));
  }

  async deleteExpiredContextShares(): Promise<number> {
    const result = await this.pool.query(
      'DELETE FROM context_shares WHERE expires_at <= NOW()'
    );
    return result.rowCount ?? 0;
  }

  // Set (or clear, with null) a channel's message retention override.
  async setChannelRetention(channelId: string, retentionMinutes: number | null): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE channels SET retention_minutes = $2 WHERE id = $1',
      [channelId, retentionMinutes]
    );
    return result.rowCount! > 0;
  }

  // Retention sweep. Channel messages obey COALESCE(channel override, server
  // default); DMs only fall under the server-wide default. A retention of 0
  // (or unset default) means keep forever. Hard-deletes: retention exists for
  // compliance, so purged rows must actually be gone. Returns per-scope counts.
  async deleteExpiredMessages(defaultRetentionMinutes: number): Promise<{ channelDeleted: number; dmDeleted: number }> {
    const channelResult = await this.pool.query(
      `DELETE FROM messages m
       USING channels c
       WHERE m.channel_id = c.id
         AND COALESCE(c.retention_minutes, $1) > 0
         AND m.created_at < NOW() - make_interval(mins => COALESCE(c.retention_minutes, $1))`,
      [defaultRetentionMinutes]
    );
    const dmResult = await this.pool.query(
      `DELETE FROM messages
       WHERE channel_id IS NULL
         AND $1 > 0
         AND created_at < NOW() - make_interval(mins => $1)`,
      [defaultRetentionMinutes]
    );
    return { channelDeleted: channelResult.rowCount ?? 0, dmDeleted: dmResult.rowCount ?? 0 };
  }

  private mapContextShare(row: pg.QueryResultRow): ContextShare {
    return {
      id: row.id,
      userId: row.user_id,
      username: row.username,
      channelId: row.channel_id ?? undefined,
      recipientId: row.recipient_id ?? undefined,
      summary: row.summary,
      details: row.details ?? undefined,
      files: row.files ?? undefined,
      status: row.status || 'working',
      project: row.project ?? undefined,
      git: row.git ?? undefined,
      taskId: row.task_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    };
  }

  private mapBuildTask(row: pg.QueryResultRow): BuildTask {
    return {
      id: row.id,
      channelId: row.channel_id,
      ownerId: row.owner_id,
      title: row.title,
      description: row.description,
      status: row.status,
      assignedTo: row.assigned_to,
      artifactFilename: row.artifact_filename,
      artifactSize: row.artifact_size,
      createdAt: row.created_at,
      assignedAt: row.assigned_at,
      completedAt: row.completed_at,
      contextClearedAt: row.context_cleared_at,
    };
  }

  private mapMemberSessionStatus(row: pg.QueryResultRow): MemberSessionStatus {
    return {
      userId: row.user_id,
      channelId: row.channel_id,
      reportedAt: row.reported_at,
      remainingRequests: row.remaining_requests,
      contextWindowUsed: row.context_window_used,
      selectedModel: row.selected_model,
    };
  }

  private mapChannel(row: pg.QueryResultRow): Channel {
    return {
      id: row.id,
      name: row.name,
      displayName: row.display_name,
      isPublic: row.is_public,
      channelType: row.channel_type || 'social',
      createdBy: row.created_by,
      ownerId: row.owner_id,
      buildPrompt: row.build_prompt,
      maxMembers: row.max_members ?? 50,
      encryptionEnabled: row.encryption_enabled ?? false,
      retentionMinutes: row.retention_minutes ?? null,
      createdAt: row.created_at,
      memberCount: parseInt(row.member_count) || 0,
    };
  }

  async createChannelInvite(
    channelId: string,
    createdBy: string,
    maxUses?: number,
    expiresAt?: Date
  ): Promise<{ id: string; inviteCode: string }> {
    const inviteCode = uuidv4().replace(/-/g, '').slice(0, 16);
    const result = await this.pool.query(
      `INSERT INTO channel_invites (id, channel_id, invite_code, created_by, max_uses, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING id, invite_code`,
      [uuidv4(), channelId, inviteCode, createdBy, maxUses || null, expiresAt || null]
    );
    return { id: result.rows[0].id, inviteCode: result.rows[0].invite_code };
  }

  async getChannelByInviteCode(inviteCode: string): Promise<Channel | null> {
    const result = await this.pool.query(
      `SELECT c.*, COUNT(cm.user_id) as member_count
       FROM channels c
       JOIN channel_invites ci ON c.id = ci.channel_id
       LEFT JOIN channel_members cm ON c.id = cm.channel_id
       WHERE ci.invite_code = $1
       AND (ci.expires_at IS NULL OR ci.expires_at > NOW())
       AND (ci.max_uses IS NULL OR ci.uses_count < ci.max_uses)
       GROUP BY c.id`,
      [inviteCode]
    );
    return result.rows[0] ? this.mapChannel(result.rows[0]) : null;
  }

  async useInviteCode(inviteCode: string, userId: string): Promise<Channel | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const inviteResult = await client.query(
        `SELECT * FROM channel_invites
         WHERE invite_code = $1
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (max_uses IS NULL OR uses_count < max_uses)
         FOR UPDATE`,
        [inviteCode]
      );

      if (!inviteResult.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }

      const channelId = inviteResult.rows[0].channel_id;

      await client.query(
        'UPDATE channel_invites SET uses_count = uses_count + 1 WHERE id = $1',
        [inviteResult.rows[0].id]
      );

      await client.query(
        `INSERT INTO channel_members (channel_id, user_id, joined_at, is_admin, role)
         VALUES ($1, $2, NOW(), FALSE, 'member')
         ON CONFLICT DO NOTHING`,
        [channelId, userId]
      );

      await client.query('COMMIT');
      return this.getChannel(channelId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private mapChannelMember(row: pg.QueryResultRow): ChannelMember | null {
    if (!row) return null;
    return {
      channelId: row.channel_id,
      userId: row.user_id,
      username: row.username,
      isAdmin: row.is_admin,
      role: row.role ?? (row.is_admin ? 'admin' : 'member'),
      joinedAt: row.joined_at,
    };
  }
}
