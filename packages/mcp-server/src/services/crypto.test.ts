import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createIdentity,
  loadIdentity,
  saveIdentity,
  getOrCreateIdentity,
  publicKeyToBase64,
  identityFingerprint,
  generateChannelKey,
  keyIdForKey,
  encryptChannelMessage,
  decryptChannelMessage,
  wrapChannelKey,
  unwrapChannelKey,
  deriveDmKey,
  dmPairContext,
  encryptDmMessage,
  decryptDmMessage,
} from './crypto.js';
import { parseEncryptedEnvelope, ENCRYPTED_PLAINTEXT_MAX_CHARS } from '@pingio/shared';

function tmpIdentityPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'e2e-')), 'e2e-identity.json');
}

describe('crypto service', () => {
  describe('identity', () => {
    it('creates, persists and reloads an X25519 identity', () => {
      const path = tmpIdentityPath();
      const identity = getOrCreateIdentity(path);

      expect(identity.privateKey.crv).toBe('X25519');
      expect(identity.privateKey.d).toBeTruthy();
      expect(existsSync(path)).toBe(true);

      const loaded = loadIdentity(path);
      expect(loaded?.privateKey.x).toBe(identity.privateKey.x);
      expect(loaded?.privateKey.d).toBe(identity.privateKey.d);
    });

    it('getOrCreateIdentity reuses the existing file', () => {
      const path = tmpIdentityPath();
      const first = getOrCreateIdentity(path);
      const second = getOrCreateIdentity(path);
      expect(second.privateKey.d).toBe(first.privateKey.d);
    });

    it('loadIdentity rejects malformed files', () => {
      const path = tmpIdentityPath();
      saveIdentity({ publicKey: { crv: 'X25519' }, privateKey: { crv: 'X25519' }, createdAt: '' } as any, path);
      expect(loadIdentity(path)).toBeNull();
      expect(loadIdentity(join(tmpdir(), 'does-not-exist-e2e.json'))).toBeNull();
    });

    it('publicKeyToBase64 yields the raw 32-byte key and a stable fingerprint', () => {
      const identity = createIdentity();
      const raw = Buffer.from(publicKeyToBase64(identity), 'base64');
      expect(raw.length).toBe(32);
      expect(identityFingerprint(identity)).toMatch(/^[0-9a-f]{12}$/);
      expect(identityFingerprint(identity)).toBe(identityFingerprint(identity));
    });
  });

  describe('channel keys', () => {
    it('generateChannelKey returns 32 bytes with a 16-hex-char keyId', () => {
      const { key, keyId } = generateChannelKey();
      expect(key.length).toBe(32);
      expect(keyId).toMatch(/^[0-9a-f]{16}$/);
      expect(keyIdForKey(key)).toBe(keyId);
    });
  });

  describe('message envelopes', () => {
    const channelId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

    it('encrypts and decrypts a message round-trip', () => {
      const { key, keyId } = generateChannelKey();
      const envelope = encryptChannelMessage(key, keyId, channelId, 'hello encrypted world');

      expect(envelope.startsWith('{"v":1')).toBe(true);
      expect(parseEncryptedEnvelope(envelope)).not.toBeNull();
      expect(envelope).not.toContain('hello');

      expect(decryptChannelMessage(key, channelId, envelope)).toBe('hello encrypted world');
    });

    it('handles unicode content', () => {
      const { key, keyId } = generateChannelKey();
      const text = 'Grüße 日本語 🔐🎉';
      expect(decryptChannelMessage(key, channelId, encryptChannelMessage(key, keyId, channelId, text))).toBe(text);
    });

    it('rejects decryption under a different channel (AAD binding)', () => {
      const { key, keyId } = generateChannelKey();
      const envelope = encryptChannelMessage(key, keyId, channelId, 'secret');
      expect(decryptChannelMessage(key, 'aaaaaaaa-0000-0000-0000-000000000000', envelope)).toBeNull();
    });

    it('rejects decryption with the wrong key', () => {
      const { key, keyId } = generateChannelKey();
      const wrong = generateChannelKey();
      const envelope = encryptChannelMessage(key, keyId, channelId, 'secret');
      expect(decryptChannelMessage(wrong.key, channelId, envelope)).toBeNull();
    });

    it('rejects tampered ciphertext', () => {
      const { key, keyId } = generateChannelKey();
      const envelope = JSON.parse(encryptChannelMessage(key, keyId, channelId, 'secret'));
      const ct = Buffer.from(envelope.ct, 'base64');
      ct[0] ^= 0xff;
      envelope.ct = ct.toString('base64');
      expect(decryptChannelMessage(key, channelId, JSON.stringify(envelope))).toBeNull();
    });

    it('returns null for non-envelope content', () => {
      const { key } = generateChannelKey();
      expect(decryptChannelMessage(key, channelId, 'plain chat message')).toBeNull();
      expect(decryptChannelMessage(key, channelId, '{"v":2,"alg":"A256GCM"}')).toBeNull();
    });

    it('refuses plaintext over the encrypted-message cap', () => {
      const { key, keyId } = generateChannelKey();
      expect(() => encryptChannelMessage(key, keyId, channelId, 'x'.repeat(ENCRYPTED_PLAINTEXT_MAX_CHARS + 1))).toThrow(
        /too long/
      );
    });

    it('envelope for max-length ASCII plaintext fits the wire limit', () => {
      const { key, keyId } = generateChannelKey();
      const envelope = encryptChannelMessage(key, keyId, channelId, 'x'.repeat(ENCRYPTED_PLAINTEXT_MAX_CHARS));
      expect(envelope.length).toBeLessThanOrEqual(4096);
    });
  });

  describe('key wrapping', () => {
    const userId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

    it('wraps and unwraps a channel key round-trip', () => {
      const recipient = createIdentity();
      const { key, keyId } = generateChannelKey();

      const share = wrapChannelKey(key, keyId, userId, publicKeyToBase64(recipient));
      expect(share.ephemeralPublicKey).toBeTruthy();
      expect(share.wrappedKey).not.toBe(key.toString('base64'));

      const unwrapped = unwrapChannelKey(share, recipient);
      expect(unwrapped).not.toBeNull();
      expect(unwrapped!.equals(key)).toBe(true);
    });

    it('uses a fresh ephemeral key per share (no nonce/key reuse)', () => {
      const recipient = createIdentity();
      const { key, keyId } = generateChannelKey();
      const a = wrapChannelKey(key, keyId, userId, publicKeyToBase64(recipient));
      const b = wrapChannelKey(key, keyId, userId, publicKeyToBase64(recipient));
      expect(a.ephemeralPublicKey).not.toBe(b.ephemeralPublicKey);
      expect(a.nonce).not.toBe(b.nonce);
      expect(a.wrappedKey).not.toBe(b.wrappedKey);
    });

    it('cannot be unwrapped by a different identity', () => {
      const recipient = createIdentity();
      const stranger = createIdentity();
      const { key, keyId } = generateChannelKey();
      const share = wrapChannelKey(key, keyId, userId, publicKeyToBase64(recipient));
      expect(unwrapChannelKey(share, stranger)).toBeNull();
    });

    it('rejects a share rebound to a different userId (AAD binding)', () => {
      const recipient = createIdentity();
      const { key, keyId } = generateChannelKey();
      const share = wrapChannelKey(key, keyId, userId, publicKeyToBase64(recipient));
      const rebound = { ...share, userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
      expect(unwrapChannelKey(rebound, recipient)).toBeNull();
    });

    it('rejects a share rebound to a different keyId (AAD binding)', () => {
      const recipient = createIdentity();
      const { key, keyId } = generateChannelKey();
      const share = wrapChannelKey(key, keyId, userId, publicKeyToBase64(recipient));
      expect(unwrapChannelKey({ ...share, keyId: '0000000000000000' }, recipient)).toBeNull();
    });
  });

  describe('DM pairwise keys', () => {
    const alice = '11111111-1111-1111-1111-111111111111';
    const bob = '22222222-2222-2222-2222-222222222222';

    it('both parties derive the same key and keyId from their own perspective', () => {
      const aliceId = createIdentity();
      const bobId = createIdentity();

      const aliceSide = deriveDmKey(aliceId, publicKeyToBase64(bobId), alice, bob);
      const bobSide = deriveDmKey(bobId, publicKeyToBase64(aliceId), bob, alice);

      expect(aliceSide).not.toBeNull();
      expect(bobSide).not.toBeNull();
      expect(aliceSide!.key.equals(bobSide!.key)).toBe(true);
      expect(aliceSide!.keyId).toBe(bobSide!.keyId);
    });

    it('the pair context is order-independent', () => {
      expect(dmPairContext(alice, bob)).toBe(dmPairContext(bob, alice));
      expect(dmPairContext(alice, bob)).toContain(alice);
      expect(dmPairContext(alice, bob)).toContain(bob);
    });

    it('different pairs derive different keys (HKDF pair binding)', () => {
      const aliceId = createIdentity();
      const bobId = createIdentity();
      const carol = '33333333-3333-3333-3333-333333333333';

      const withBob = deriveDmKey(aliceId, publicKeyToBase64(bobId), alice, bob);
      const withCarol = deriveDmKey(aliceId, publicKeyToBase64(bobId), alice, carol);

      expect(withBob!.key.equals(withCarol!.key)).toBe(false);
      expect(withBob!.keyId).not.toBe(withCarol!.keyId);
    });

    it('returns null for a malformed peer public key', () => {
      const aliceId = createIdentity();
      expect(deriveDmKey(aliceId, 'not-base64!!!', alice, bob)).toBeNull();
      expect(deriveDmKey(aliceId, Buffer.alloc(16).toString('base64'), alice, bob)).toBeNull();
    });

    it('encrypts and decrypts a DM round-trip from both directions', () => {
      const aliceId = createIdentity();
      const bobId = createIdentity();
      const aliceSide = deriveDmKey(aliceId, publicKeyToBase64(bobId), alice, bob)!;
      const bobSide = deriveDmKey(bobId, publicKeyToBase64(aliceId), bob, alice)!;

      const wire = encryptDmMessage(aliceSide.key, aliceSide.keyId, alice, bob, 'pair programming at 3?');
      expect(wire).not.toContain('pair programming');
      expect(decryptDmMessage(bobSide.key, bob, alice, wire)).toBe('pair programming at 3?');

      // Bob's reply decrypts identically for Alice.
      const reply = encryptDmMessage(bobSide.key, bobSide.keyId, bob, alice, 'yes 🔐');
      expect(decryptDmMessage(aliceSide.key, alice, bob, reply)).toBe('yes 🔐');
    });

    it('rejects decryption under a different pair (AAD binding)', () => {
      const aliceId = createIdentity();
      const bobId = createIdentity();
      const { key, keyId } = deriveDmKey(aliceId, publicKeyToBase64(bobId), alice, bob)!;
      const carol = '33333333-3333-3333-3333-333333333333';

      const wire = encryptDmMessage(key, keyId, alice, bob, 'secret');
      expect(decryptDmMessage(key, alice, carol, wire)).toBeNull();
    });
  });
});
