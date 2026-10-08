import type { ToolResult } from '../types/index.js';
import { configManager } from '../config.js';
import axios from 'axios';
import { createHash } from 'crypto';
import {
  getOrCreateIdentity,
  publicKeyToBase64,
  identityFingerprint,
  generateChannelKey,
  wrapChannelKey,
  unwrapChannelKey,
} from '../services/crypto.js';
import { channelKeyStore } from '../services/channel-keys.js';
import { dmKeyService } from '../services/dm-keys.js';
import { resolveUserId } from './collab.js';
import type { ChannelKeyShare } from '@pingio/shared';

function text(value: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}

function errorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) return error.response?.data?.error || error.message;
  return error instanceof Error ? error.message : fallback;
}

function requireAuth(): { authToken: string; userId: string } | null {
  const config = configManager.getConfig();
  return config.identity.authToken ? (config.identity as { authToken: string; userId: string }) : null;
}

// Publish my X25519 identity public key so other members can wrap channel keys for me.
export async function publishEncryptionKey(): Promise<ToolResult> {
  const identity = requireAuth();
  if (!identity) return text('Error: Not logged in', true);

  const e2e = getOrCreateIdentity();
  const relayUrl = configManager.getRestBaseUrl();
  try {
    await axios.put(
      `${relayUrl}/api/encryption/keys`,
      { publicKey: publicKeyToBase64(e2e) },
      { headers: { Authorization: `Bearer ${identity.authToken}` } }
    );
    return text(`✓ encryption identity published (fingerprint ${identityFingerprint(e2e)})`);
  } catch (error) {
    return text(`Failed to publish encryption key: ${errorMessage(error, 'unknown error')}`, true);
  }
}

interface MemberKey {
  userId: string;
  username: string;
  publicKey: string | null;
}

// Wrap `channelKey` for every member with a published identity key and post the
// shares. Returns a status line listing members who still need to publish.
async function distributeKey(
  channelId: string,
  channelName: string,
  keyId: string,
  channelKey: Buffer,
  authToken: string
): Promise<ToolResult> {
  const relayUrl = configManager.getRestBaseUrl();
  const e2e = getOrCreateIdentity();

  const keysResponse = await axios.get(
    `${relayUrl}/api/channels/${channelId}/encryption/keys`,
    { headers: { Authorization: `Bearer ${authToken}` } }
  );
  const members = (keysResponse.data.keys ?? []) as MemberKey[];
  const myPublicKey = publicKeyToBase64(e2e);

  const shares: ChannelKeyShare[] = [];
  const missing: string[] = [];
  for (const member of members) {
    // The relay may still hold an older copy of our own key; wrap to the local one.
    const publicKey = member.userId === configManager.getConfig().identity.userId ? myPublicKey : member.publicKey;
    if (!publicKey) {
      missing.push(member.username);
      continue;
    }
    shares.push(wrapChannelKey(channelKey, keyId, member.userId, publicKey));
  }

  try {
    await axios.post(
      `${relayUrl}/api/channels/${channelId}/encryption/shares`,
      { keyId, shares },
      { headers: { Authorization: `Bearer ${authToken}` } }
    );
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 409) {
      return text(
        `Key ${keyId} is managed by another member — refusing to overwrite their shares. ` +
          `Use rotate_channel_key to distribute a fresh key instead.`,
        true
      );
    }
    throw error;
  }

  const missingNote =
    missing.length > 0
      ? `\n⚠ no published key for: ${missing.join(', ')} — they must run publish_encryption_key, then you re-run this`
      : '';
  return text(`✓ key ${keyId} shared with ${shares.length}/${members.length} members of #${channelName}${missingNote}`);
}

// Enable encryption on a channel (admin), or re-share the key to members who
// joined since it was last distributed (any member who holds the key).
export async function enableChannelEncryption(channelId: string): Promise<ToolResult> {
  const identity = requireAuth();
  if (!identity) return text('Error: Not logged in', true);

  const relayUrl = configManager.getRestBaseUrl();
  const headers = { headers: { Authorization: `Bearer ${identity.authToken}` } };

  try {
    const { data } = await axios.get(`${relayUrl}/api/channels/${channelId}`, headers);
    const channel = data.channel as { id: string; name: string; encryptionEnabled?: boolean };

    // Publish our own identity first so we can receive (and produce) shares.
    await axios.put(`${relayUrl}/api/encryption/keys`, { publicKey: publicKeyToBase64(getOrCreateIdentity()) }, headers);

    if (!channel.encryptionEnabled) {
      try {
        await axios.post(`${relayUrl}/api/channels/${channelId}/encryption`, {}, headers);
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 409) {
          // Enabled concurrently — fall through to key distribution.
        } else {
          throw error;
        }
      }
      channelKeyStore.setFlag(channelId, true);
    }

    const existing = channelKeyStore.getLatestChannelKey(channelId);
    if (!existing && channel.encryptionEnabled) {
      return text(
        `#${channel.name} is already encrypted but you hold no key for it. ` +
          `Run sync_channel_keys — if no share is waiting, ask a member to run enable_channel_encryption to share it with you.`,
        true
      );
    }

    let keyId: string;
    let channelKey: Buffer;
    if (existing) {
      ({ keyId, key: channelKey } = existing);
    } else {
      const generated = generateChannelKey();
      keyId = generated.keyId;
      channelKey = generated.key;
      channelKeyStore.storeChannelKey(channelId, keyId, channelKey.toString('base64'));
    }

    return await distributeKey(channelId, channel.name, keyId, channelKey, identity.authToken);
  } catch (error) {
    return text(`Failed to enable encryption: ${errorMessage(error, 'unknown error')}`, true);
  }
}

// Rotate: distribute a brand-new key. Old messages stay readable via the old key.
export async function rotateChannelKey(channelId: string): Promise<ToolResult> {
  const identity = requireAuth();
  if (!identity) return text('Error: Not logged in', true);

  const relayUrl = configManager.getRestBaseUrl();
  const headers = { headers: { Authorization: `Bearer ${identity.authToken}` } };

  try {
    const { data } = await axios.get(`${relayUrl}/api/channels/${channelId}`, headers);
    const channel = data.channel as { id: string; name: string; encryptionEnabled?: boolean };

    if (!channel.encryptionEnabled) {
      return text(`#${channel.name} is not encrypted — run enable_channel_encryption first`, true);
    }
    if (!channelKeyStore.getLatestChannelKey(channelId)) {
      return text(`You hold no key for #${channel.name} — run sync_channel_keys first`, true);
    }

    const { key, keyId } = generateChannelKey();
    channelKeyStore.storeChannelKey(channelId, keyId, key.toString('base64'));
    const result = await distributeKey(channelId, channel.name, keyId, key, identity.authToken);
    return result;
  } catch (error) {
    return text(`Failed to rotate channel key: ${errorMessage(error, 'unknown error')}`, true);
  }
}

// Fetch and unwrap my pending key shares — for one channel or every encrypted channel.
export async function syncChannelKeys(channelId?: string): Promise<ToolResult> {
  const identity = requireAuth();
  if (!identity) return text('Error: Not logged in', true);

  const relayUrl = configManager.getRestBaseUrl();
  const headers = { headers: { Authorization: `Bearer ${identity.authToken}` } };
  const e2e = getOrCreateIdentity();

  try {
    let channelIds: string[] = [];
    if (channelId) {
      channelIds = [channelId];
    } else {
      const { data } = await axios.get(`${relayUrl}/api/channels`, headers);
      channelIds = (data.channels ?? [])
        .filter((c: { encryptionEnabled?: boolean }) => c.encryptionEnabled)
        .map((c: { id: string }) => c.id);
      if (channelIds.length === 0) return text('No encrypted channels to sync');
    }

    const lines: string[] = [];
    let totalNew = 0;
    let totalFailed = 0;

    for (const id of channelIds) {
      const { data } = await axios.get(`${relayUrl}/api/channels/${id}/encryption/shares/mine`, headers);
      channelKeyStore.setFlag(id, data.encryptionEnabled === true);
      const shares = (data.shares ?? []) as ChannelKeyShare[];

      let added = 0;
      let failed = 0;
      for (const share of shares) {
        if (channelKeyStore.getChannelKey(id, share.keyId)) continue;
        const key = unwrapChannelKey(share, e2e);
        if (key) {
          channelKeyStore.storeChannelKey(id, share.keyId, key.toString('base64'));
          added++;
        } else {
          failed++;
        }
      }
      totalNew += added;
      totalFailed += failed;
      lines.push(`#${id}: ${added} new key${added === 1 ? '' : 's'}${failed ? `, ${failed} could not be unwrapped` : ''}`);
    }

    const failureNote =
      totalFailed > 0
        ? `\n⚠ ${totalFailed} share(s) failed to unwrap — your published identity key may have changed since they were created. Ask a member to re-run enable_channel_encryption.`
        : '';
    return text(`✓ synced ${totalNew} new key(s)\n${lines.join('\n')}${failureNote}`);
  } catch (error) {
    return text(`Failed to sync channel keys: ${errorMessage(error, 'unknown error')}`, true);
  }
}

// DM encryption status for a peer: whether they have a published identity key,
// both identity fingerprints, and the pairwise safety number (the derived
// keyId). Comparing the safety number with your peer out-of-band detects a
// relay serving a substituted key.
export async function dmEncryptionStatus(username: string): Promise<ToolResult> {
  const identity = requireAuth();
  if (!identity) return text('Error: Not logged in', true);

  const resolved = await resolveUserId(username, identity.authToken);
  if ('error' in resolved) return text(`Error: ${resolved.error}`, true);

  const e2e = getOrCreateIdentity();
  const myFingerprint = identityFingerprint(e2e);

  let entry;
  try {
    entry = await dmKeyService.refreshPeerKey(resolved.id);
  } catch (error) {
    return text(`Failed to fetch @${username}'s encryption key: ${errorMessage(error, 'unknown error')}`, true);
  }

  if (!entry) {
    return text(
      `@${username} has not published an encryption key — DMs are sent in plaintext.\n` +
      `Your fingerprint: ${myFingerprint}\n` +
      `DMs become end-to-end encrypted automatically once they run publish_encryption_key.`
    );
  }

  const peerFingerprint = createHash('sha256')
    .update(Buffer.from(entry.peerPublicKey, 'base64'))
    .digest('hex')
    .slice(0, 12);

  return text(
    `🔒 DMs with @${username} are end-to-end encrypted (AES-256-GCM, pairwise X25519 key).\n` +
    `Your fingerprint:   ${myFingerprint}\n` +
    `Their fingerprint:  ${peerFingerprint}\n` +
    `Safety number:      ${entry.keyId}\n` +
    `Compare the safety number with @${username} out-of-band to verify no server-side key substitution.`
  );
}
