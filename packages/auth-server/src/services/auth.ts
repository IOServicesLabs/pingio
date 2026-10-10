import crypto, { generateKeyPairSync } from 'crypto';
import bcrypt from 'bcrypt';
import { SignJWT, importPKCS8, JWK, KeyLike } from 'jose';
import {
  ERROR_MESSAGES,
  ACCESS_TOKEN_EXPIRY_MINUTES,
  REFRESH_TOKEN_EXPIRY_DAYS,
  MAX_DEVICES_PER_USER,
} from '@pingio/shared';
import type { User } from '@pingio/shared';
import { PostgresStore } from '../stores/postgres.js';
import { suggestUsernames } from './username.js';

const SALT_ROUNDS = 10;

export interface AuthResult {
  success: boolean;
  user?: User;
  token?: string;
  refreshToken?: string;
  deviceId?: string;
  error?: string;
  verificationRequired?: boolean;
  suggestions?: string[];
}

export interface TokenClaims {
  sub: string;
  preferred_username: string;
  device_id?: string;
  iss: string;
  aud: string;
  type: 'access';
  relay_id?: string;
}

export class AuthService {
  private activeKey?: { kid: string; privateKey: KeyLike; publicKeyJwk: JWK };
  private keyInitPromise?: Promise<void>;

  constructor(
    private postgres: PostgresStore,
    private issuer: string,
    private audience: string,
    private relayId?: string
  ) {}

  async init(): Promise<void> {
    if (this.keyInitPromise) return this.keyInitPromise;
    this.keyInitPromise = this.ensureSigningKey();
    return this.keyInitPromise;
  }

  private async ensureSigningKey(): Promise<void> {
    const keys = await this.postgres.getActiveSigningKeys();
    if (keys.length === 0) {
      await this.generateAndStoreKey();
    } else {
      await this.loadKey(keys[0]);
    }
  }

  private async generateAndStoreKey(): Promise<void> {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const kid = crypto.randomUUID();
    const keyRecord = await this.postgres.createSigningKey(
      kid,
      publicKey,
      privateKey,
      'RS256'
    );
    await this.loadKey(keyRecord);
  }

  private async loadKey(keyRecord: {
    kid: string;
    privateKey: string;
    publicKey: string;
  }): Promise<void> {
    const privateKey = await importPKCS8(keyRecord.privateKey, 'RS256');
    const publicKeyJwk = crypto
      .createPublicKey(keyRecord.publicKey)
      .export({ format: 'jwk' }) as JWK;
    publicKeyJwk.kid = keyRecord.kid;
    publicKeyJwk.alg = 'RS256';
    publicKeyJwk.use = 'sig';
    this.activeKey = { kid: keyRecord.kid, privateKey, publicKeyJwk };
  }

  async getJwks(): Promise<{ keys: JWK[] }> {
    const keys = await this.postgres.getActiveSigningKeys();
    const jwks: JWK[] = keys.map(key => {
      const jwk = crypto.createPublicKey(key.publicKey).export({ format: 'jwk' }) as JWK;
      jwk.kid = key.kid;
      jwk.alg = key.algorithm;
      jwk.use = 'sig';
      return jwk;
    });
    return { keys: jwks };
  }

  /**
   * Mint a federation update manifest: an RS256 JWT whose claims pin a
   * component's target version + artifact location + SHA-256. Relay nodes
   * verify it against the JWKS endpoint (audience
   * 'pingio-federation-manifest') before applying any auto update/downgrade.
   * No expiry — the network_version_policy row is the source of truth and
   * the manifest is re-minted on every policy change.
   */
  async signFederationManifest(claims: {
    component: string;
    version: string;
    artifact_url: string;
    artifact_sha256: string;
  }): Promise<string> {
    await this.ensureSigningKey();
    if (!this.activeKey) {
      throw new Error('No active signing key available');
    }

    const jwt = new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: this.activeKey.kid, typ: 'JWT' })
      .setIssuer(this.issuer)
      .setAudience('pingio-federation-manifest')
      .setIssuedAt();

    return await jwt.sign(this.activeKey.privateKey);
  }

  async register(
    username: string,
    password: string,
    displayName?: string,
    deviceFingerprint?: string,
    deviceName?: string
  ): Promise<AuthResult> {
    // Check if username is taken
    const existing = await this.postgres.getUserByUsername(username);
    if (existing) {
      return {
        success: false,
        error: ERROR_MESSAGES.USERNAME_TAKEN,
        suggestions: suggestUsernames(username),
      };
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await this.postgres.createUser(username, passwordHash, displayName);
    if (!user) {
      return {
        success: false,
        error: ERROR_MESSAGES.USERNAME_TAKEN,
        suggestions: suggestUsernames(username),
      };
    }

    let deviceId: string | undefined;
    if (deviceFingerprint) {
      const device = await this.postgres.createDevice(
        user.id,
        deviceFingerprint,
        deviceName,
        undefined,
        true
      );
      if (device) {
        deviceId = device.id;
      }
    }

    const token = await this.generateAccessToken(user.id, user.username, deviceId);
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
  ): Promise<AuthResult> {
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

    const requireVerification = process.env.DEVICE_VERIFICATION_REQUIRED === 'true';

    if (requireVerification && deviceFingerprint) {
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

        const newDevice = await this.postgres.createDevice(
          userId,
          deviceFingerprint,
          deviceName,
          ipAddress,
          false
        );
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
          const newDevice = await this.postgres.createDevice(
            userId,
            deviceFingerprint,
            deviceName,
            ipAddress,
            true
          );
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

    const token = await this.generateAccessToken(userId, user.username, deviceId);
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

  async refreshToken(refreshToken: string, deviceFingerprint: string): Promise<AuthResult> {
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
      await this.postgres.revokeRefreshToken(tokenHash);
      return { success: false, error: ERROR_MESSAGES.USER_NOT_FOUND };
    }

    await this.postgres.revokeRefreshToken(tokenHash);
    const newRefreshToken = await this.generateRefreshToken(user.id, tokenRecord.deviceId);
    const accessToken = await this.generateAccessToken(user.id, user.username, tokenRecord.deviceId);
    await this.postgres.updateDeviceLastSeen(tokenRecord.deviceId);

    return {
      success: true,
      token: accessToken,
      refreshToken: newRefreshToken,
      deviceId: tokenRecord.deviceId,
      user,
    };
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

  async listDevices(userId: string, currentDeviceId?: string) {
    const devices = await this.postgres.getUserDevices(userId);
    return devices.map(d => ({
      id: d.id,
      deviceName: d.deviceName,
      lastSeen: d.lastSeen,
      isVerified: d.isVerified,
      isCurrent: d.id === currentDeviceId,
    }));
  }

  async introspectToken(token: string): Promise<{
    active: boolean;
    sub?: string;
    username?: string;
    device_id?: string;
    aud?: string;
    iss?: string;
    exp?: number;
    error?: string;
  }> {
    try {
      const { jwtVerify, createLocalJWKSet } = await import('jose');
      const jwks = await this.getJwks();
      const localJWKSet = createLocalJWKSet(jwks);
      const { payload } = await jwtVerify(token, localJWKSet, {
        issuer: this.issuer,
        audience: this.audience,
      });

      if (payload.type !== 'access') {
        return { active: false, error: 'Invalid token type' };
      }

      return {
        active: true,
        sub: payload.sub as string,
        username: payload.preferred_username as string,
        device_id: payload.device_id as string | undefined,
        aud: payload.aud as string,
        iss: payload.iss as string,
        exp: payload.exp,
      };
    } catch {
      return { active: false, error: 'Invalid token' };
    }
  }

  /**
   * Issue a fresh token pair for an already-authenticated user.
   * Used by flows that authenticate out-of-band (e.g. enterprise SSO).
   */
  async issueTokens(
    userId: string,
    username: string,
    deviceId?: string
  ): Promise<{ token: string; refreshToken?: string }> {
    const token = await this.generateAccessToken(userId, username, deviceId);
    const refreshToken = await this.generateRefreshToken(userId, deviceId);
    return { token, refreshToken };
  }

  private async generateAccessToken(
    userId: string,
    username: string,
    deviceId?: string
  ): Promise<string> {
    await this.ensureSigningKey();
    if (!this.activeKey) {
      throw new Error('No active signing key available');
    }

    const jwt = new SignJWT({
      sub: userId,
      preferred_username: username,
      type: 'access',
      ...(deviceId ? { device_id: deviceId } : {}),
      ...(this.relayId ? { relay_id: this.relayId } : {}),
    })
      .setProtectedHeader({ alg: 'RS256', kid: this.activeKey.kid, typ: 'JWT' })
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_EXPIRY_MINUTES}m`);

    return await jwt.sign(this.activeKey.privateKey);
  }

  private async generateRefreshToken(userId: string, deviceId?: string): Promise<string | undefined> {
    if (!deviceId) return undefined;

    const tokenBytes = crypto.randomBytes(32);
    const token = tokenBytes.toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);

    await this.postgres.createRefreshToken(userId, deviceId, tokenHash, expiresAt);
    return token;
  }
}
