import axios from 'axios';
import { configManager } from '../config.js';
import { getOrCreateIdentity, deriveDmKey } from './crypto.js';

// Session-scoped cache of DM pairwise keys. A DM key is derived locally from
// our identity private key + the peer's published public key, so the only
// state to cache is the peer's public key (not secret) and the derived key
// (process memory only — never written to disk). A peer rotating their
// identity key invalidates old DM history for both sides; we detect that on
// decrypt failure and refetch once.

export interface DmKeyEntry {
  peerUserId: string;
  peerPublicKey: string; // base64 raw 32-byte X25519 public key
  peerKeyUpdatedAt?: string;
  key: Buffer;
  keyId: string; // deterministic per identity pair — doubles as the safety number
  fetchedAt: number;
}

class DmKeyService {
  private cache = new Map<string, DmKeyEntry>(); // keyed by peer userId
  private noKey = new Set<string>(); // peers known to have no key published

  // Fetch the peer's published key and derive the pairwise key. Returns null
  // when logged out, the peer has no key published, or derivation fails.
  private async fetchAndDerive(peerUserId: string): Promise<DmKeyEntry | null> {
    const config = configManager.getConfig();
    const myId = config.identity.userId;
    if (!config.identity.authToken || !myId) return null;

    const relayUrl = configManager.getRestBaseUrl();
    let publicKey: string;
    let updatedAt: string | undefined;
    try {
      const response = await axios.get(`${relayUrl}/api/users/${peerUserId}/encryption-key`, {
        headers: { Authorization: `Bearer ${config.identity.authToken}` },
      });
      publicKey = response.data.publicKey;
      updatedAt = response.data.updatedAt;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        this.noKey.add(peerUserId);
        return null;
      }
      throw error; // transient/server errors propagate to the caller
    }

    const identity = getOrCreateIdentity();
    const derived = deriveDmKey(identity, publicKey, myId, peerUserId);
    if (!derived) return null;

    const entry: DmKeyEntry = {
      peerUserId,
      peerPublicKey: publicKey,
      peerKeyUpdatedAt: updatedAt,
      key: derived.key,
      keyId: derived.keyId,
      fetchedAt: Date.now(),
    };
    this.cache.set(peerUserId, entry);
    return entry;
  }

  // The pairwise key for a DM peer, or null when they have no key published
  // (plaintext DM). Cached for the session.
  async getDmKey(peerUserId: string): Promise<DmKeyEntry | null> {
    const cached = this.cache.get(peerUserId);
    if (cached) return cached;
    if (this.noKey.has(peerUserId)) return null;
    return this.fetchAndDerive(peerUserId);
  }

  // Drop the cached entry and refetch — used when an envelope's keyId doesn't
  // match our derived key (peer may have rotated their identity key).
  async refreshPeerKey(peerUserId: string): Promise<DmKeyEntry | null> {
    this.cache.delete(peerUserId);
    this.noKey.delete(peerUserId);
    return this.fetchAndDerive(peerUserId);
  }

  clear(): void {
    this.cache.clear();
    this.noKey.clear();
  }
}

export const dmKeyService = new DmKeyService();
