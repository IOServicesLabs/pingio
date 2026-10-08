import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

// Local store for channel AES keys (plaintext key material — never leaves the
// device) and cached per-channel encryption flags. File mode 0600.

export interface StoredChannelKey {
  keyId: string;
  key: string; // base64 32-byte AES-256 key
  createdAt: string;
}

interface ChannelFlag {
  encryptionEnabled: boolean;
  checkedAt: number;
}

interface KeyStoreData {
  keys: Record<string, StoredChannelKey[]>;
  flags: Record<string, ChannelFlag>;
}

const DEFAULT_STORE_PATH = join(homedir(), '.pingio', 'channel-keys.json');
const FLAG_TTL_MS = 5 * 60 * 1000;

export class ChannelKeyStore {
  private data: KeyStoreData = { keys: {}, flags: {} };
  private loaded = false;

  constructor(private readonly path: string = DEFAULT_STORE_PATH) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (existsSync(this.path)) {
        const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<KeyStoreData>;
        this.data = { keys: parsed.keys ?? {}, flags: parsed.flags ?? {} };
      }
    } catch (error) {
      console.error('Failed to load channel keys:', error);
    }
  }

  private save(): void {
    try {
      if (!existsSync(dirname(this.path))) {
        mkdirSync(dirname(this.path), { recursive: true });
      }
      writeFileSync(this.path, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      try {
        chmodSync(this.path, 0o600);
      } catch {
        // ignore — Windows ACLs differ
      }
    } catch (error) {
      console.error('Failed to save channel keys:', error);
    }
  }

  storeChannelKey(channelId: string, keyId: string, keyB64: string): void {
    this.load();
    const list = (this.data.keys[channelId] ??= []);
    const existing = list.find(k => k.keyId === keyId);
    if (existing) {
      existing.key = keyB64;
      existing.createdAt = new Date().toISOString();
    } else {
      list.push({ keyId, key: keyB64, createdAt: new Date().toISOString() });
    }
    this.setFlag(channelId, true);
  }

  getChannelKey(channelId: string, keyId: string): Buffer | null {
    this.load();
    const record = this.data.keys[channelId]?.find(k => k.keyId === keyId);
    return record ? Buffer.from(record.key, 'base64') : null;
  }

  // Newest stored key for the channel (rotation keeps older keys for history).
  getLatestChannelKey(channelId: string): { keyId: string; key: Buffer } | null {
    this.load();
    const list = this.data.keys[channelId];
    if (!list || list.length === 0) return null;
    const latest = list[list.length - 1];
    return { keyId: latest.keyId, key: Buffer.from(latest.key, 'base64') };
  }

  listChannelIdsWithKeys(): string[] {
    this.load();
    return Object.keys(this.data.keys);
  }

  // null = unknown / stale
  getFlag(channelId: string): boolean | null {
    this.load();
    const flag = this.data.flags[channelId];
    if (!flag || Date.now() - flag.checkedAt > FLAG_TTL_MS) return null;
    return flag.encryptionEnabled;
  }

  setFlag(channelId: string, encryptionEnabled: boolean): void {
    this.data.flags[channelId] = { encryptionEnabled, checkedAt: Date.now() };
    this.save();
  }
}

export const channelKeyStore = new ChannelKeyStore();
