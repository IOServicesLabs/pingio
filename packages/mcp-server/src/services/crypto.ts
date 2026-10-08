import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
  type JsonWebKey,
} from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import {
  ENCRYPTION_PROTOCOL_VERSION,
  ENVELOPE_ALGORITHM,
  KEY_WRAP_INFO,
  ENVELOPE_MAX_WIRE_CHARS,
  ENCRYPTED_PLAINTEXT_MAX_CHARS,
  parseEncryptedEnvelope,
  type ChannelKeyShare,
} from '@pingio/shared';

// Client-side E2E crypto for channel messages. The X25519 identity private
// key lives only in ~/.pingio/e2e-identity.json (mode 0600); channel
// keys live in channel-keys.json via the channelKeyStore service.

export interface E2eIdentity {
  publicKey: JsonWebKey; // OKP X25519: { kty: 'OKP', crv: 'X25519', x }
  privateKey: JsonWebKey; // same + d
  createdAt: string;
}

const DEFAULT_IDENTITY_PATH = join(homedir(), '.pingio', 'e2e-identity.json');

function writeFilePrivate(path: string, data: string): void {
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  writeFileSync(path, data, { mode: 0o600 });
  // Best-effort on platforms that ignore write mode (Windows ACLs differ).
  try {
    chmodSync(path, 0o600);
  } catch {
    // ignore
  }
}

export function loadIdentity(path: string = DEFAULT_IDENTITY_PATH): E2eIdentity | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as E2eIdentity;
    if (parsed?.privateKey?.crv !== 'X25519' || !parsed.privateKey.d || !parsed.publicKey?.x) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveIdentity(identity: E2eIdentity, path: string = DEFAULT_IDENTITY_PATH): void {
  writeFilePrivate(path, JSON.stringify(identity, null, 2));
}

export function createIdentity(): E2eIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: publicKey.export({ format: "jwk" }),
    privateKey: privateKey.export({ format: "jwk" }),
    createdAt: new Date().toISOString(),
  };
}

let cachedIdentity: E2eIdentity | null = null;

export function getOrCreateIdentity(path: string = DEFAULT_IDENTITY_PATH): E2eIdentity {
  if (cachedIdentity && path === DEFAULT_IDENTITY_PATH) return cachedIdentity;
  const existing = loadIdentity(path);
  if (existing) {
    if (path === DEFAULT_IDENTITY_PATH) cachedIdentity = existing;
    return existing;
  }
  const identity = createIdentity();
  saveIdentity(identity, path);
  if (path === DEFAULT_IDENTITY_PATH) cachedIdentity = identity;
  return identity;
}

// Base64 of the raw 32-byte X25519 public key (the wire format the relay stores).
export function publicKeyToBase64(identity: E2eIdentity): string {
  return Buffer.from(identity.publicKey.x as string, 'base64url').toString('base64');
}

export function identityFingerprint(identity: E2eIdentity): string {
  return createHash('sha256')
    .update(Buffer.from(identity.publicKey.x as string, 'base64url'))
    .digest('hex')
    .slice(0, 12);
}

function publicKeyFromBase64(publicKeyB64: string) {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(publicKeyB64, 'base64').toString('base64url') },
    format: 'jwk',
  });
}

// --- Channel keys ----------------------------------------------------------

export function generateChannelKey(): { key: Buffer; keyId: string } {
  const key = randomBytes(32);
  return { key, keyId: keyIdForKey(key) };
}

export function keyIdForKey(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

// --- Message envelopes ------------------------------------------------------

export function encryptChannelMessage(
  key: Buffer,
  keyId: string,
  channelId: string,
  plaintext: string
): string {
  if (plaintext.length > ENCRYPTED_PLAINTEXT_MAX_CHARS) {
    throw new Error(
      `Message too long to encrypt (max ${ENCRYPTED_PLAINTEXT_MAX_CHARS} chars for encrypted channels)`
    );
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(channelId, 'utf-8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final(), cipher.getAuthTag()]);
  const envelope = JSON.stringify({
    v: ENCRYPTION_PROTOCOL_VERSION,
    alg: ENVELOPE_ALGORITHM,
    keyId,
    nonce: nonce.toString('base64'),
    ct: ct.toString('base64'),
  });
  // Multi-byte UTF-8 plaintext inflates more than the char-count cap predicts.
  if (envelope.length > ENVELOPE_MAX_WIRE_CHARS) {
    throw new Error('Encrypted message exceeds the wire size limit — shorten it');
  }
  return envelope;
}

// Returns null when content is not an envelope or fails authentication.
export function decryptChannelMessage(key: Buffer, channelId: string, content: string): string | null {
  const envelope = parseEncryptedEnvelope(content);
  if (!envelope) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'));
    decipher.setAAD(Buffer.from(channelId, 'utf-8'));
    const ct = Buffer.from(envelope.ct, 'base64');
    decipher.setAuthTag(ct.subarray(ct.length - 16));
    return Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]).toString('utf-8');
  } catch {
    return null;
  }
}

// --- DM pairwise keys --------------------------------------------------------
//
// A DM key is derived deterministically from static-static X25519 ECDH between
// the two parties' identity keys — no key exchange protocol or server round
// trip beyond fetching the peer's published public key. Both sides compute the
// same 32-byte key, so sent and received history decrypt identically.
// HKDF binds the key to the sorted user-id pair, so a key derived for one
// conversation can never authenticate messages in another. Same trust model as
// channel keys: an identity-key compromise exposes that pair's DM history.

// HKDF info + message AAD for a DM pair (order-independent).
export function dmPairContext(userIdA: string, userIdB: string): string {
  const [lo, hi] = [userIdA, userIdB].sort();
  return `pingio-dm:${lo}:${hi}`;
}

const DM_KEY_SALT = 'pingio-dm-v1';

// Derive the pairwise DM key + its deterministic keyId. Returns null when the
// peer's public key is malformed.
export function deriveDmKey(
  identity: E2eIdentity,
  peerPublicKeyB64: string,
  myUserId: string,
  peerUserId: string
): { key: Buffer; keyId: string } | null {
  try {
    if (Buffer.from(peerPublicKeyB64, 'base64').length !== 32) return null;
    const privateKey = createPrivateKey({ key: identity.privateKey, format: 'jwk' });
    const shared = diffieHellman({ privateKey, publicKey: publicKeyFromBase64(peerPublicKeyB64) });
    const context = dmPairContext(myUserId, peerUserId);
    const key = Buffer.from(hkdfSync('sha256', shared, DM_KEY_SALT, context, 32));
    return { key, keyId: keyIdForKey(key) };
  } catch {
    return null;
  }
}

export function encryptDmMessage(
  key: Buffer,
  keyId: string,
  myUserId: string,
  peerUserId: string,
  plaintext: string
): string {
  return encryptChannelMessage(key, keyId, dmPairContext(myUserId, peerUserId), plaintext);
}

// Returns null when content is not an envelope or fails authentication.
export function decryptDmMessage(
  key: Buffer,
  myUserId: string,
  peerUserId: string,
  content: string
): string | null {
  return decryptChannelMessage(key, dmPairContext(myUserId, peerUserId), content);
}

// The keyId IS the pairwise fingerprint (sha256 of the shared key): both
// parties derive the same value, so comparing keyIds out-of-band detects a
// relay serving a substituted public key.
export function dmKeyFingerprint(keyId: string): string {
  return keyId;
}

// --- Key wrapping (ephemeral-static X25519 + HKDF + AES-GCM) ----------------

function deriveWrapKey(sharedSecret: Buffer, ephemeralRaw: Buffer, memberRaw: Buffer): Buffer {
  const salt = Buffer.concat([ephemeralRaw, memberRaw]);
  return Buffer.from(hkdfSync('sha256', sharedSecret, salt, KEY_WRAP_INFO, 32));
}

export function wrapChannelKey(
  channelKey: Buffer,
  keyId: string,
  userId: string,
  memberPublicKeyB64: string
): Omit<ChannelKeyShare, 'keyId' | 'userId'> & { keyId: string; userId: string } {
  const { publicKey: ephPub, privateKey: ephPriv } = generateKeyPairSync('x25519');
  const memberRaw = Buffer.from(memberPublicKeyB64, 'base64');
  const shared = diffieHellman({ privateKey: ephPriv, publicKey: publicKeyFromBase64(memberPublicKeyB64) });
  const ephRaw = Buffer.from(
    ephPub.export({ format: "jwk" }).x as string,
    'base64url'
  );
  const wrapKey = deriveWrapKey(shared, ephRaw, memberRaw);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', wrapKey, nonce);
  // Bind the share to this key and recipient so it cannot be replayed elsewhere.
  cipher.setAAD(Buffer.from(`${keyId}:${userId}`, 'utf-8'));
  const wrapped = Buffer.concat([cipher.update(channelKey), cipher.final(), cipher.getAuthTag()]);
  return {
    keyId,
    userId,
    ephemeralPublicKey: ephRaw.toString('base64'),
    wrappedKey: wrapped.toString('base64'),
    nonce: nonce.toString('base64'),
  };
}

// Returns the 32-byte channel key, or null when authentication fails (wrong
// identity, tampered share, share issued for a different key/user).
export function unwrapChannelKey(share: ChannelKeyShare, identity: E2eIdentity): Buffer | null {
  try {
    const privateKey = createPrivateKey({ key: identity.privateKey, format: 'jwk' });
    const ephemeralPublicKey = publicKeyFromBase64(share.ephemeralPublicKey);
    const shared = diffieHellman({ privateKey, publicKey: ephemeralPublicKey });
    const ephRaw = Buffer.from(share.ephemeralPublicKey, 'base64');
    const myRaw = Buffer.from(identity.publicKey.x as string, 'base64url');
    const wrapKey = deriveWrapKey(shared, ephRaw, myRaw);
    const wrapped = Buffer.from(share.wrappedKey, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', wrapKey, Buffer.from(share.nonce, 'base64'));
    decipher.setAAD(Buffer.from(`${share.keyId}:${share.userId}`, 'utf-8'));
    decipher.setAuthTag(wrapped.subarray(wrapped.length - 16));
    const key = Buffer.concat([decipher.update(wrapped.subarray(0, wrapped.length - 16)), decipher.final()]);
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}
