import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ChannelKeyStore } from './channel-keys.js';

describe('ChannelKeyStore', () => {
  let store: ChannelKeyStore;

  beforeEach(() => {
    store = new ChannelKeyStore(join(mkdtempSync(join(tmpdir(), 'keys-')), 'channel-keys.json'));
  });

  it('stores and retrieves keys by channel and keyId', () => {
    store.storeChannelKey('ch-1', 'k1', Buffer.from('a'.repeat(32)).toString('base64'));
    store.storeChannelKey('ch-1', 'k2', Buffer.from('b'.repeat(32)).toString('base64'));
    store.storeChannelKey('ch-2', 'k9', Buffer.from('c'.repeat(32)).toString('base64'));

    expect(store.getChannelKey('ch-1', 'k1')?.toString()).toBe('a'.repeat(32));
    expect(store.getChannelKey('ch-1', 'k2')?.toString()).toBe('b'.repeat(32));
    expect(store.getChannelKey('ch-2', 'k9')?.toString()).toBe('c'.repeat(32));
    expect(store.getChannelKey('ch-1', 'k9')).toBeNull();
    expect(store.getChannelKey('nope', 'k1')).toBeNull();
  });

  it('getLatestChannelKey returns the most recently stored key', () => {
    expect(store.getLatestChannelKey('ch-1')).toBeNull();
    store.storeChannelKey('ch-1', 'old', Buffer.alloc(32, 1).toString('base64'));
    store.storeChannelKey('ch-1', 'new', Buffer.alloc(32, 2).toString('base64'));
    expect(store.getLatestChannelKey('ch-1')?.keyId).toBe('new');
  });

  it('persists across instances (survives restart)', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'keys-')), 'channel-keys.json');
    const first = new ChannelKeyStore(path);
    first.storeChannelKey('ch-1', 'k1', Buffer.alloc(32, 9).toString('base64'));

    const second = new ChannelKeyStore(path);
    expect(second.getChannelKey('ch-1', 'k1')?.equals(Buffer.alloc(32, 9))).toBe(true);
    expect(second.getLatestChannelKey('ch-1')?.keyId).toBe('k1');
  });

  it('marks the channel encrypted when a key is stored', () => {
    expect(store.getFlag('ch-1')).toBeNull();
    store.storeChannelKey('ch-1', 'k1', Buffer.alloc(32).toString('base64'));
    expect(store.getFlag('ch-1')).toBe(true);
  });

  it('caches explicit flags and expires them', () => {
    store.setFlag('ch-1', false);
    expect(store.getFlag('ch-1')).toBe(false);

    // Stale flags are treated as unknown.
    (store as any).data.flags['ch-1'].checkedAt = Date.now() - 10 * 60 * 1000;
    expect(store.getFlag('ch-1')).toBeNull();
  });

  it('lists channel ids with keys', () => {
    store.storeChannelKey('ch-1', 'k1', Buffer.alloc(32).toString('base64'));
    store.storeChannelKey('ch-2', 'k2', Buffer.alloc(32).toString('base64'));
    expect(store.listChannelIdsWithKeys().sort()).toEqual(['ch-1', 'ch-2']);
  });

  it('survives a corrupt file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'keys-')), 'channel-keys.json');
    writeFileSync(path, 'not json{{{');
    const corrupt = new ChannelKeyStore(path);
    expect(corrupt.getLatestChannelKey('ch-1')).toBeNull();
  });
});
