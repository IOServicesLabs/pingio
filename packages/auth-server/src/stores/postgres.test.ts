import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostgresStore } from './postgres.js';

const mockQuery = vi.fn();
const mockPoolEnd = vi.fn();

vi.mock('pg', () => {
  const Pool = vi.fn(() => ({
    query: mockQuery,
    end: mockPoolEnd,
  }));
  return {
    default: { Pool },
    Pool,
  };
});

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid'),
}));

describe('auth-server PostgresStore (SSO)', () => {
  let store: PostgresStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new PostgresStore('postgresql://test');
  });

  describe('sso identities', () => {
    const identityRow = {
      id: 'ident-1',
      user_id: 'user-1',
      issuer: 'https://idp.acme.example',
      subject: 'sub-123',
      email: 'alice@acme.com',
      email_verified: true,
      display_name: 'Alice',
      created_at: new Date('2026-01-01'),
      last_login_at: new Date('2026-01-02'),
    };

    it('createSsoIdentity inserts and maps the row', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [identityRow] });

      const identity = await store.createSsoIdentity(
        'user-1',
        'https://idp.acme.example',
        'sub-123',
        'alice@acme.com',
        true,
        'Alice'
      );

      expect(identity.userId).toBe('user-1');
      expect(identity.issuer).toBe('https://idp.acme.example');
      expect(identity.emailVerified).toBe(true);
      expect(mockQuery.mock.calls[0][1]).toEqual([
        'test-uuid',
        'user-1',
        'https://idp.acme.example',
        'sub-123',
        'alice@acme.com',
        true,
        'Alice',
      ]);
    });

    it('getSsoIdentity looks up by issuer + subject', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [identityRow] });

      const identity = await store.getSsoIdentity('https://idp.acme.example', 'sub-123');

      expect(identity?.id).toBe('ident-1');
      expect(mockQuery.mock.calls[0][1]).toEqual(['https://idp.acme.example', 'sub-123']);
    });

    it('getSsoIdentity returns null when missing', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      expect(await store.getSsoIdentity('iss', 'sub')).toBeNull();
    });

    it('findVerifiedSsoIdentityByEmail matches case-insensitively and requires verified email', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [identityRow] });

      const identity = await store.findVerifiedSsoIdentityByEmail('Alice@Acme.COM');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('email_verified = TRUE');
      expect(sql).toContain('lower(email) = lower($1)');
      expect(params).toEqual(['Alice@Acme.COM']);
      expect(identity?.userId).toBe('user-1');
    });
  });

  describe('sso login states', () => {
    it('createSsoLoginState stores the hash, nonce, verifier, slug, and expiry', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const expiresAt = new Date(Date.now() + 600_000);

      await store.createSsoLoginState('hash-1', 'nonce-1', 'verifier-1', 'acme', expiresAt);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('INSERT INTO sso_login_states');
      expect(params).toEqual(['test-uuid', 'hash-1', 'nonce-1', 'verifier-1', 'acme', expiresAt]);
    });

    it('consumeSsoLoginState deletes atomically and maps the row', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 's1',
          nonce: 'nonce-1',
          pkce_verifier: 'verifier-1',
          provider_slug: 'acme',
          expires_at: new Date(),
        }],
      });

      const state = await store.consumeSsoLoginState('hash-1');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('DELETE FROM sso_login_states');
      expect(sql).toContain('expires_at > NOW()');
      expect(sql).toContain('RETURNING');
      expect(params).toEqual(['hash-1']);
      expect(state).toEqual({
        id: 's1',
        nonce: 'nonce-1',
        pkceVerifier: 'verifier-1',
        providerSlug: 'acme',
        expiresAt: expect.any(Date),
      });
    });

    it('consumeSsoLoginState returns null when nothing matched', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      expect(await store.consumeSsoLoginState('missing')).toBeNull();
    });
  });

  describe('sso login codes', () => {
    it('consumeSsoLoginCode is atomic single-use and rejects expired codes', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ user_id: 'user-1' }] });

      const result = await store.consumeSsoLoginCode('code-hash-1');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('UPDATE sso_login_codes');
      expect(sql).toContain('used_at IS NULL');
      expect(sql).toContain('expires_at > NOW()');
      expect(sql).toContain('RETURNING user_id');
      expect(params).toEqual(['code-hash-1']);
      expect(result).toEqual({ userId: 'user-1' });
    });

    it('consumeSsoLoginCode returns null for unknown/used/expired codes', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      expect(await store.consumeSsoLoginCode('nope')).toBeNull();
    });
  });

  describe('deleteExpiredSsoArtifacts', () => {
    it('sweeps expired states and expired-or-used codes', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await store.deleteExpiredSsoArtifacts();

      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(mockQuery.mock.calls[0][0]).toContain('DELETE FROM sso_login_states');
      expect(mockQuery.mock.calls[1][0]).toContain('DELETE FROM sso_login_codes');
      expect(mockQuery.mock.calls[1][0]).toContain('used_at IS NOT NULL');
    });
  });
});
