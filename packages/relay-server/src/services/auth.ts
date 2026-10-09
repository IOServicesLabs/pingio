import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import {
  ERROR_MESSAGES,
  ACCESS_TOKEN_EXPIRY_MINUTES,
  REFRESH_TOKEN_EXPIRY_DAYS,
  MAX_DEVICES_PER_USER,
} from '@pingio/shared';
import type { User } from '@pingio/shared';
import { PostgresStore } from '../stores/postgres.js';
import { LocalAuthStrategy, CentralAuthStrategy, type AuthStrategy } from './auth-strategy.js';

export const ACCESS_TOKEN_EXPIRES_IN = `${ACCESS_TOKEN_EXPIRY_MINUTES}m`;
export const REFRESH_TOKEN_EXPIRES_IN_DAYS = REFRESH_TOKEN_EXPIRY_DAYS;
export const SALT_ROUNDS = 10;
export const DEFAULT_INSECURE_JWT_SECRET = 'your-secret-key-change-in-production';
// Every placeholder string that has shipped in repo files — the production
// guard below refuses all of them, not just the constant above.
export const KNOWN_INSECURE_JWT_SECRETS: readonly string[] = [
  DEFAULT_INSECURE_JWT_SECRET,
  'change-this-secret-in-production',
  'your-super-secret-jwt-key-change-this-in-production',
];
export const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_INSECURE_JWT_SECRET;

export interface AuthConfig {
  mode: 'local' | 'central';
  issuer?: string;
  audience?: string;
}

export class AuthService {
  private strategy: AuthStrategy;

  constructor(
    private postgres: PostgresStore,
    config?: AuthConfig
  ) {
    const mode = config?.mode || (process.env.AUTH_MODE as 'local' | 'central') || 'local';
    if (mode === 'central') {
      const issuer = config?.issuer || process.env.CENTRAL_AUTH_ISSUER;
      const audience = config?.audience || process.env.CENTRAL_AUTH_AUDIENCE || 'pingio-relay';
      if (!issuer) {
        throw new Error('CENTRAL_AUTH_ISSUER is required when AUTH_MODE=central');
      }
      this.strategy = new CentralAuthStrategy(issuer, audience, postgres);
    } else {
      const effectiveSecret = config?.mode ? JWT_SECRET : process.env.JWT_SECRET || JWT_SECRET;
      // Fail fast in production rather than signing tokens with a repo-public placeholder.
      if (process.env.NODE_ENV === 'production' && KNOWN_INSECURE_JWT_SECRETS.includes(effectiveSecret)) {
        throw new Error(
          'Refusing to start: JWT_SECRET is unset or still a known placeholder. ' +
          'Set a strong JWT_SECRET (e.g. openssl rand -base64 32) when running AUTH_MODE=local in production.'
        );
      }
      this.strategy = new LocalAuthStrategy(effectiveSecret);
    }
  }

  getMode(): 'local' | 'central' {
    return this.strategy instanceof CentralAuthStrategy ? 'central' : 'local';
  }

  async verifyToken(token: string): Promise<{ userId: string; username: string; deviceId?: string } | null> {
    return this.strategy.verifyToken(token);
  }

  // The following methods are only valid in local auth mode.
  // In central mode they should not be called; callers should use the auth service instead.

  async register(
    username: string,
    password: string,
    displayName?: string,
    deviceFingerprint?: string,
    deviceName?: string
  ): Promise<{
    success: boolean;
    user?: User;
    token?: string;
    refreshToken?: string;
    deviceId?: string;
    error?: string;
  }> {
    const existing = await this.postgres.getUserByUsername(username);
    if (existing) {
      return { success: false, error: ERROR_MESSAGES.USERNAME_TAKEN };
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await this.postgres.createUser(username, passwordHash, displayName);
    if (!user) {
      return { success: false, error: ERROR_MESSAGES.CONFLICT };
    }

    let deviceId: string | undefined;
    if (deviceFingerprint) {
      const device = await this.postgres.createDevice(user.id, deviceFingerprint, deviceName, undefined, true);
      if (device) {
        deviceId = device.id;
      }
    }

    const token = this.generateAccessToken(user.id, user.username);
    const refreshToken = await this.generateRefreshToken(user.id, deviceId);

    return {
      success: true,
      user,
      token,
      refreshToken,
      deviceId,
    };
  }

  async login(
    username: string,
    password: string,
    deviceFingerprint?: string,
    deviceName?: string,
    ipAddress?: string
  ): Promise<{
    success: boolean;
    token?: string;
    refreshToken?: string;
    deviceId?: string;
    user?: User;
    error?: string;
    verificationRequired?: boolean;
  }> {
    const userWithPassword = await this.postgres.getUserWithPassword(username);
    if (!userWithPassword) {
      return { success: false, error: ERROR_MESSAGES.INVALID_CREDENTIALS };
    }

    const valid = await bcrypt.compare(password, userWithPassword.passwordHash);
    if (!valid) {
      return { success: false, error: ERROR_MESSAGES.INVALID_CREDENTIALS };
    }

    const userId = userWithPassword.id;
    const { passwordHash: _, ...user } = userWithPassword;

    let deviceId: string | undefined;
    let verificationRequired = false;

    if (process.env.DEVICE_VERIFICATION_REQUIRED === 'true' && deviceFingerprint) {
      const existingDevice = await this.postgres.getDeviceByFingerprint(userId, deviceFingerprint);

      if (existingDevice) {
        if (existingDevice.isVerified) {
          deviceId = existingDevice.id;
          await this.postgres.updateDeviceLastSeen(deviceId, ipAddress);
        } else {
          verificationRequired = true;
          deviceId = existingDevice.id;
        }
      } else {
        const deviceCount = await this.postgres.getDeviceCount(userId);
        if (deviceCount >= MAX_DEVICES_PER_USER) {
          return { success: false, error: ERROR_MESSAGES.MAX_DEVICES_REACHED };
        }

        const newDevice = await this.postgres.createDevice(userId, deviceFingerprint, deviceName, ipAddress, false);
        if (newDevice) {
          deviceId = newDevice.id;
          verificationRequired = true;
        }
      }
    } else {
      if (deviceFingerprint) {
        const device = await this.postgres.getDeviceByFingerprint(userId, deviceFingerprint);
        if (device) {
          deviceId = device.id;
          await this.postgres.updateDeviceLastSeen(deviceId, ipAddress);
        } else {
          const newDevice = await this.postgres.createDevice(userId, deviceFingerprint, deviceName, ipAddress, true);
          if (newDevice) {
            deviceId = newDevice.id;
          }
        }
      }
    }

    if (verificationRequired) {
      return {
        success: false,
        verificationRequired: true,
        deviceId,
        error: ERROR_MESSAGES.DEVICE_VERIFICATION_REQUIRED,
      };
    }

    const token = this.generateAccessToken(userId, user.username);
    const refreshToken = await this.generateRefreshToken(userId, deviceId);
    await this.postgres.updateLastSeen(userId);

    return {
      success: true,
      token,
      refreshToken,
      deviceId,
      user,
    };
  }

  async verifyDevice(userId: string, deviceId: string): Promise<{ success: boolean; error?: string }> {
    const device = await this.postgres.getDeviceById(deviceId);
    if (!device) {
      return { success: false, error: ERROR_MESSAGES.DEVICE_NOT_FOUND };
    }
    if (device.userId !== userId) {
      return { success: false, error: ERROR_MESSAGES.FORBIDDEN };
    }
    const verified = await this.postgres.verifyDevice(deviceId);
    return { success: verified };
  }

  async refreshToken(refreshToken: string, deviceFingerprint: string): Promise<{
    success: boolean;
    token?: string;
    refreshToken?: string;
    deviceId?: string;
    user?: User;
    error?: string;
  }> {
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const tokenRecord = await this.postgres.getRefreshTokenByHash(tokenHash);
    if (!tokenRecord) {
      return { success: false, error: ERROR_MESSAGES.UNAUTHORIZED };
    }

    const device = await this.postgres.getDeviceById(tokenRecord.deviceId);
    if (!device || device.deviceFingerprint !== deviceFingerprint) {
      await this.postgres.revokeRefreshToken(tokenHash);
      return { success: false, error: ERROR_MESSAGES.DEVICE_REVOKED };
    }

    const user = await this.postgres.getUserById(tokenRecord.userId);
    if (!user) {
      return { success: false, error: ERROR_MESSAGES.USER_NOT_FOUND };
    }

    await this.postgres.revokeRefreshToken(tokenHash);
    const newRefreshToken = await this.generateRefreshToken(user.id, tokenRecord.deviceId);
    const accessToken = this.generateAccessToken(user.id, user.username);
    await this.postgres.updateDeviceLastSeen(tokenRecord.deviceId);

    return {
      success: true,
      token: accessToken,
      refreshToken: newRefreshToken,
      deviceId: tokenRecord.deviceId,
      user,
    };
  }

  async getUser(userId: string): Promise<User | null> {
    return await this.postgres.getUserById(userId);
  }

  async getUserByUsername(username: string): Promise<User | null> {
    return await this.postgres.getUserByUsername(username);
  }

  async listDevices(userId: string, currentDeviceId?: string): Promise<Array<{
    id: string;
    deviceName?: string;
    lastSeen?: Date;
    isVerified: boolean;
    isCurrent: boolean;
  }>> {
    const devices = await this.postgres.getUserDevices(userId);
    return devices.map(d => ({
      ...d,
      isCurrent: d.id === currentDeviceId,
    }));
  }

  async revokeDevice(userId: string, deviceId: string): Promise<{ success: boolean; error?: string }> {
    const device = await this.postgres.getDeviceById(deviceId);
    if (!device) {
      return { success: false, error: ERROR_MESSAGES.DEVICE_NOT_FOUND };
    }
    if (device.userId !== userId) {
      return { success: false, error: ERROR_MESSAGES.FORBIDDEN };
    }

    await this.postgres.revokeAllRefreshTokensForDevice(deviceId);
    const revoked = await this.postgres.revokeDevice(deviceId, userId);
    return { success: revoked };
  }

  private generateAccessToken(userId: string, username: string): string {
    return jwt.sign(
      { userId, username, type: 'access', jti: crypto.randomUUID() },
      JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_EXPIRY_MINUTES * 60 }
    );
  }

  private async generateRefreshToken(userId: string, deviceId?: string): Promise<string | undefined> {
    if (!deviceId) return undefined;

    const tokenBytes = crypto.randomBytes(32);
    const token = tokenBytes.toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRES_IN_DAYS);

    await this.postgres.createRefreshToken(userId, deviceId, tokenHash, expiresAt);
    return token;
  }
}
