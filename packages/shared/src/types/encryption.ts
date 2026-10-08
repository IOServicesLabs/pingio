import { z } from 'zod';

// Channel end-to-end encryption (server-blind): the relay only ever sees
// ciphertext envelopes inside the existing message `content` field, plus
// opaque wrapped key shares. Channel keys never leave client devices.
//
// Wire format: a channel message encrypted under the channel's AES-256-GCM
// key is serialized as a compact JSON envelope string and sent as ordinary
// message content, so no messages-table or WS-protocol change is needed.
//
// Key distribution: each user publishes an X25519 identity public key. A
// member wrapping the channel key for another member does ephemeral-static
// ECDH (fresh ephemeral X25519 pair per share), derives a wrap key via
// HKDF-SHA256 salted with both public keys, and AES-256-GCM-encrypts the
// channel key with AAD binding the share to (keyId, userId).

export const ENCRYPTION_PROTOCOL_VERSION = 1 as const;
export const ENVELOPE_ALGORITHM = 'A256GCM' as const;

// HKDF info string binding wrapped channel keys to this protocol purpose.
export const KEY_WRAP_INFO = 'pingio-channel-key-wrap';

// Envelopes travel inside message content, capped at 4096 chars on the wire
// (ChannelMessagePayloadSchema). Base64 inflation plus the JSON header must
// fit under that, so plaintext is capped conservatively below it.
export const ENVELOPE_MAX_WIRE_CHARS = 4096;
export const ENCRYPTED_PLAINTEXT_MAX_CHARS = 2800;

export const EncryptedMessageEnvelopeSchema = z.object({
  v: z.literal(ENCRYPTION_PROTOCOL_VERSION),
  alg: z.literal(ENVELOPE_ALGORITHM),
  keyId: z.string().length(16).regex(/^[0-9a-f]+$/),
  nonce: z.string().min(1).max(64), // base64 12-byte GCM nonce
  ct: z.string().min(1), // base64 ciphertext || GCM tag
});

export type EncryptedMessageEnvelope = z.infer<typeof EncryptedMessageEnvelopeSchema>;

// A channel key wrapped for one member. The relay stores these verbatim and
// can read nothing from them.
export const ChannelKeyShareSchema = z.object({
  keyId: z.string().length(16).regex(/^[0-9a-f]+$/),
  userId: z.string().uuid(),
  ephemeralPublicKey: z.string().min(1).max(128), // base64 raw 32-byte X25519 key
  wrappedKey: z.string().min(1).max(128), // base64 wrapped channel key + GCM tag
  nonce: z.string().min(1).max(64), // base64 12-byte GCM nonce
});

export type ChannelKeyShare = z.infer<typeof ChannelKeyShareSchema>;

// Compact envelopes always start with this exact prefix — cheap check before
// attempting a JSON parse on arbitrary message content.
const ENVELOPE_PREFIX = '{"v":1';

export function parseEncryptedEnvelope(content: string): EncryptedMessageEnvelope | null {
  if (!content.startsWith(ENVELOPE_PREFIX)) return null;
  try {
    const result = EncryptedMessageEnvelopeSchema.safeParse(JSON.parse(content));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
