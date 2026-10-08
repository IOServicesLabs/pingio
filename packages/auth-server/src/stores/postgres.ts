import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// NOTE: pg's default BOOL parser (val === 't') is load-bearing — an identity
// parser here returns 't'/'f' strings, and 'f' is truthy, which silently
// turns `if (!device.isVerified)` checks into verification bypasses.

export interface User {
  id: string;
  username: string;
  displayName?: string;
  createdAt: Date;
  lastSeenAt?: Date;
}

export interface Device {
  id: string;
  userId: string;
  deviceName?: string;
  deviceFingerprint: string;
  lastIp?: string;
  lastSeen?: Date;
  isVerified: boolean;
  createdAt: Date;
}

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  deviceId: string;
  expiresAt: Date;
}

export interface SigningKey {
  id: string;
  kid: string;
  publicKey: string;
  privateKey: string;
  algorithm: string;
  createdAt: Date;
  revokedAt?: Date;
}

export interface SsoIdentity {
  id: string;
  userId: string;
  issuer: string;
  subject: string;
  email?: string;
  emailVerified: boolean;
  displayName?: string;
  createdAt: Date;
  lastLoginAt?: Date;
}

export interface SsoLoginState {
  id: string;
  nonce: string;
  pkceVerifier: string;
  providerSlug: string;
  expiresAt: Date;
}

export class PostgresStore {
  private pool: Pool;

  constructor(connectionString?: string) {
    this.pool = new Pool({
      connectionString: connectionString || process.env.DATABASE_URL,
    });
  }

  async init(): Promise<void> {
    const migrationsDir = resolve(__dirname, '../migrations');
    const files = readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const sql = readFileSync(resolve(migrationsDir, file), 'utf-8');
      await this.pool.query(sql);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private mapUser(row: Record<string, unknown>): User {
    return {
      id: row.id as string,
      username: row.username as string,
      displayName: row.display_name as string | undefined,
      createdAt: row.created_at as Date,
      lastSeenAt: row.last_seen_at as Date | undefined,
    };
  }

  private mapDevice(row: Record<string, unknown>): Device {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      deviceName: row.device_name as string | undefined,
      deviceFingerprint: row.device_fingerprint as string,
      lastIp: row.last_ip as string | undefined,
      lastSeen: row.last_seen as Date | undefined,
      isVerified: row.is_verified as boolean,
      createdAt: row.created_at as Date,
    };
  }

  private mapSigningKey(row: Record<string, unknown>): SigningKey {
    return {
      id: row.id as string,
      kid: row.kid as string,
      publicKey: row.public_key as string,
      privateKey: row.private_key as string,
      algorithm: row.algorithm as string,
      createdAt: row.created_at as Date,
      revokedAt: row.revoked_at as Date | undefined,
    };
  }

  async createUser(
    username: string,
    passwordHash: string,
    displayName?: string
  ): Promise<User | null> {
    try {
      const result = await this.pool.query(
        `INSERT INTO users (id, username, display_name, password_hash, created_at, last_seen_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         RETURNING *`,
        [uuidv4(), username, displayName || null, passwordHash]
      );
      return this.mapUser(result.rows[0]);
    } catch (error) {
      const dbError = error as { code?: string };
      if (dbError.code === '23505') {
        return null;
      }
      throw error;
    }
  }

  async getUserById(userId: string): Promise<User | null> {
    const result = await this.pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (!result.rows[0]) return null;
    return this.mapUser(result.rows[0]);
  }

  async getUserByUsername(username: string): Promise<User | null> {
    const result = await this.pool.query('SELECT * FROM users WHERE username = $1', [
      username,
    ]);
    if (!result.rows[0]) return null;
    return this.mapUser(result.rows[0]);
  }

  async getUserWithPassword(username: string): Promise<(User & { passwordHash: string }) | null> {
    const result = await this.pool.query(
      'SELECT id, username, display_name, password_hash, created_at, last_seen_at FROM users WHERE username = $1',
      [username]
    );
    if (!result.rows[0]) return null;
    return {
      ...this.mapUser(result.rows[0]),
      passwordHash: result.rows[0].password_hash as string,
    };
  }

  async updateLastSeen(userId: string): Promise<void> {
    await this.pool.query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [userId]);
  }

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

  async getDeviceById(deviceId: string): Promise<Device | null> {
    const result = await this.pool.query('SELECT * FROM user_devices WHERE id = $1', [deviceId]);
    if (!result.rows[0]) return null;
    return this.mapDevice(result.rows[0]);
  }

  async getDeviceByFingerprint(
    userId: string,
    deviceFingerprint: string
  ): Promise<Device | null> {
    const result = await this.pool.query(
      'SELECT * FROM user_devices WHERE user_id = $1 AND device_fingerprint = $2',
      [userId, deviceFingerprint]
    );
    if (!result.rows[0]) return null;
    return this.mapDevice(result.rows[0]);
  }

  async getUserDevices(userId: string): Promise<Device[]> {
    const result = await this.pool.query(
      'SELECT * FROM user_devices WHERE user_id = $1 ORDER BY last_seen DESC NULLS LAST',
      [userId]
    );
    return result.rows.map(row => this.mapDevice(row));
  }

  async getDeviceCount(userId: string): Promise<number> {
    const result = await this.pool.query(
      'SELECT COUNT(*) as count FROM user_devices WHERE user_id = $1',
      [userId]
    );
    return parseInt(result.rows[0].count as string, 10);
  }

  async updateDeviceLastSeen(deviceId: string, lastIp?: string): Promise<void> {
    await this.pool.query(
      'UPDATE user_devices SET last_seen = NOW(), last_ip = COALESCE($2, last_ip) WHERE id = $1',
      [deviceId, lastIp || null]
    );
  }

  async verifyDevice(deviceId: string): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE user_devices SET is_verified = TRUE WHERE id = $1 RETURNING id',
      [deviceId]
    );
    return result.rows.length > 0;
  }

  async revokeDevice(deviceId: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM user_devices WHERE id = $1 AND user_id = $2 RETURNING id',
      [deviceId, userId]
    );
    return result.rows.length > 0;
  }

  async createRefreshToken(
    userId: string,
    deviceId: string,
    tokenHash: string,
    expiresAt: Date
  ): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING id`,
      [uuidv4(), userId, deviceId, tokenHash, expiresAt]
    );
    return result.rows[0].id;
  }

  async getRefreshTokenByHash(
    tokenHash: string
  ): Promise<RefreshTokenRecord | null> {
    const result = await this.pool.query(
      `SELECT id, user_id, device_id, expires_at FROM refresh_tokens
       WHERE token_hash = $1 AND expires_at > NOW() AND revoked_at IS NULL`,
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

  async revokeRefreshToken(tokenHash: string): Promise<void> {
    await this.pool.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1',
      [tokenHash]
    );
  }

  async revokeAllRefreshTokensForDevice(deviceId: string): Promise<void> {
    await this.pool.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE device_id = $1',
      [deviceId]
    );
  }

  async createSigningKey(
    kid: string,
    publicKey: string,
    privateKey: string,
    algorithm: string = 'RS256'
  ): Promise<SigningKey> {
    const result = await this.pool.query(
      `INSERT INTO signing_keys (id, kid, public_key, private_key, algorithm, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [uuidv4(), kid, publicKey, privateKey, algorithm]
    );
    return this.mapSigningKey(result.rows[0]);
  }

  async getActiveSigningKeys(): Promise<SigningKey[]> {
    const result = await this.pool.query(
      `SELECT * FROM signing_keys WHERE revoked_at IS NULL ORDER BY created_at DESC`
    );
    return result.rows.map(row => this.mapSigningKey(row));
  }

  async getSigningKeyByKid(kid: string): Promise<SigningKey | null> {
    const result = await this.pool.query(
      'SELECT * FROM signing_keys WHERE kid = $1 AND revoked_at IS NULL',
      [kid]
    );
    if (!result.rows[0]) return null;
    return this.mapSigningKey(result.rows[0]);
  }

  private mapSsoIdentity(row: Record<string, unknown>): SsoIdentity {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      issuer: row.issuer as string,
      subject: row.subject as string,
      email: row.email as string | undefined,
      emailVerified: row.email_verified as boolean,
      displayName: row.display_name as string | undefined,
      createdAt: row.created_at as Date,
      lastLoginAt: row.last_login_at as Date | undefined,
    };
  }

  async createSsoIdentity(
    userId: string,
    issuer: string,
    subject: string,
    email?: string,
    emailVerified: boolean = false,
    displayName?: string
  ): Promise<SsoIdentity> {
    const result = await this.pool.query(
      `INSERT INTO sso_identities (id, user_id, issuer, subject, email, email_verified, display_name, created_at, last_login_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       RETURNING *`,
      [uuidv4(), userId, issuer, subject, email || null, emailVerified, displayName || null]
    );
    return this.mapSsoIdentity(result.rows[0]);
  }

  async getSsoIdentity(issuer: string, subject: string): Promise<SsoIdentity | null> {
    const result = await this.pool.query(
      'SELECT * FROM sso_identities WHERE issuer = $1 AND subject = $2',
      [issuer, subject]
    );
    if (!result.rows[0]) return null;
    return this.mapSsoIdentity(result.rows[0]);
  }

  // For account linking across providers: only identities whose email was
  // verified by the upstream IdP are eligible.
  async findVerifiedSsoIdentityByEmail(email: string): Promise<SsoIdentity | null> {
    const result = await this.pool.query(
      `SELECT * FROM sso_identities
       WHERE email_verified = TRUE AND lower(email) = lower($1)
       ORDER BY created_at ASC
       LIMIT 1`,
      [email]
    );
    if (!result.rows[0]) return null;
    return this.mapSsoIdentity(result.rows[0]);
  }

  async touchSsoIdentity(id: string): Promise<void> {
    await this.pool.query(
      'UPDATE sso_identities SET last_login_at = NOW() WHERE id = $1',
      [id]
    );
  }

  async createSsoLoginState(
    stateHash: string,
    nonce: string,
    pkceVerifier: string,
    providerSlug: string,
    expiresAt: Date
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO sso_login_states (id, state_hash, nonce, pkce_verifier, provider_slug, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6)`,
      [uuidv4(), stateHash, nonce, pkceVerifier, providerSlug, expiresAt]
    );
  }

  // DELETE ... RETURNING makes consumption atomic: two concurrent callbacks
  // with the same state cannot both succeed.
  async consumeSsoLoginState(stateHash: string): Promise<SsoLoginState | null> {
    const result = await this.pool.query(
      `DELETE FROM sso_login_states
       WHERE state_hash = $1 AND expires_at > NOW()
       RETURNING id, nonce, pkce_verifier, provider_slug, expires_at`,
      [stateHash]
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return {
      id: row.id as string,
      nonce: row.nonce as string,
      pkceVerifier: row.pkce_verifier as string,
      providerSlug: row.provider_slug as string,
      expiresAt: row.expires_at as Date,
    };
  }

  async createSsoLoginCode(codeHash: string, userId: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO sso_login_codes (id, code_hash, user_id, created_at, expires_at)
       VALUES ($1, $2, $3, NOW(), $4)`,
      [uuidv4(), codeHash, userId, expiresAt]
    );
  }

  // Atomic single-use: only the first concurrent consume marks used_at.
  async consumeSsoLoginCode(codeHash: string): Promise<{ userId: string } | null> {
    const result = await this.pool.query(
      `UPDATE sso_login_codes
       SET used_at = NOW()
       WHERE code_hash = $1 AND used_at IS NULL AND expires_at > NOW()
       RETURNING user_id`,
      [codeHash]
    );
    if (!result.rows[0]) return null;
    return { userId: result.rows[0].user_id as string };
  }

  async deleteExpiredSsoArtifacts(): Promise<void> {
    await this.pool.query('DELETE FROM sso_login_states WHERE expires_at <= NOW()');
    await this.pool.query(
      'DELETE FROM sso_login_codes WHERE expires_at <= NOW() OR used_at IS NOT NULL'
    );
  }
}
