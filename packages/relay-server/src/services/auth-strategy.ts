import jwt from 'jsonwebtoken';
import { createLocalJWKSet, jwtVerify, JWK } from 'jose';
import type { User } from '@pingio/shared';
import type { PostgresStore } from '../stores/postgres.js';

export interface VerifiedToken {
  userId: string;
  username: string;
  deviceId?: string;
}

export interface AuthStrategy {
  verifyToken(token: string): Promise<VerifiedToken | null>;
}

export class LocalAuthStrategy implements AuthStrategy {
  constructor(private jwtSecret: string) {}

  async verifyToken(token: string): Promise<VerifiedToken | null> {
    try {
      const decoded = jwt.verify(token, this.jwtSecret) as {
        userId: string;
        username: string;
        type?: string;
      };
      if (decoded.type && decoded.type !== 'access') {
        return null;
      }
      return { userId: decoded.userId, username: decoded.username };
    } catch {
      return null;
    }
  }
}

export class CentralAuthStrategy implements AuthStrategy {
  private jwksCache?: { jwks: { keys: JWK[] }; localJWKSet: ReturnType<typeof createLocalJWKSet> };
  private jwksLastFetched = 0;
  private jwksCacheTtl = 5 * 60 * 1000; // 5 minutes
  private tokenCache = new Map<string, { verified: VerifiedToken; exp: number }>();

  constructor(
    private issuer: string,
    private audience: string,
    private postgres: PostgresStore
  ) {}

  async verifyToken(token: string): Promise<VerifiedToken | null> {
    // Check token cache
    const cached = this.tokenCache.get(token);
    const now = Math.floor(Date.now() / 1000);
    if (cached && cached.exp > now + 60) {
      return cached.verified;
    }

    try {
      const localJWKSet = await this.getLocalJWKSet();
      const { payload } = await jwtVerify(token, localJWKSet, {
        issuer: this.issuer,
        audience: this.audience,
      });

      if (payload.type !== 'access') {
        return null;
      }

      const userId = payload.sub as string;
      const username = payload.preferred_username as string;
      const deviceId = payload.device_id as string | undefined;

      if (!userId || !username) {
        return null;
      }

      // Ensure user exists in relay DB (for local data and federation hooks)
      let user = await this.postgres.getUserById(userId);
      if (!user) {
        // Provisional user: create a local shadow record for this centrally-authenticated user
        user = await this.postgres.createUser(username, '', undefined, userId);
      }

      const verified: VerifiedToken = {
        userId: user?.id || userId,
        username: user?.username || username,
        deviceId,
      };

      if (payload.exp) {
        this.tokenCache.set(token, { verified, exp: payload.exp });
      }

      return verified;
    } catch {
      return null;
    }
  }

  private async getLocalJWKSet(): Promise<ReturnType<typeof createLocalJWKSet>> {
    const now = Date.now();
    if (this.jwksCache && now - this.jwksLastFetched < this.jwksCacheTtl) {
      return this.jwksCache.localJWKSet;
    }

    const jwksUri = `${this.issuer.replace(/\/$/, '')}/.well-known/jwks.json`;
    const response = await fetch(jwksUri);
    if (!response.ok) {
      throw new Error(`Failed to fetch JWKS: ${response.status}`);
    }
    const jwks = (await response.json()) as { keys: JWK[] };
    this.jwksCache = { jwks, localJWKSet: createLocalJWKSet(jwks) };
    this.jwksLastFetched = now;
    return this.jwksCache.localJWKSet;
  }
}
