import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { ConfigManager } from './config.js';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);

describe('ConfigManager env overrides', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedExistsSync.mockReturnValue(false); // default: no config file
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses defaults when no config file and no env vars', () => {
    const config = new ConfigManager().getConfig();
    expect(config.mode).toBe('auto');
    expect(config.cloudEndpoint).toBe('https://pingio.ioservices.io');
    expect(config.selfHosted.relayUrl).toBe('ws://localhost:5000/ws');
  });

  it('applies PINGIO_* env vars over the defaults', () => {
    vi.stubEnv('PINGIO_MODE', 'self-hosted');
    vi.stubEnv('PINGIO_SELF_HOSTED_RELAY_URL', 'ws://example:9000');
    vi.stubEnv('PINGIO_ENABLE_LOCAL_P2P', 'false');

    const manager = new ConfigManager();
    const config = manager.getConfig();
    expect(config.mode).toBe('self-hosted');
    expect(config.selfHosted.enableLocalP2P).toBe(false);
    // http->ws coercion + /ws path enforcement still apply
    expect(manager.getEffectiveRelayUrl()).toBe('ws://example:9000/ws');
  });

  it('env vars win over the config file', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ mode: 'cloud', cloudEndpoint: 'https://auth.example.com' })
    );
    vi.stubEnv('PINGIO_MODE', 'self-hosted');
    vi.stubEnv('PINGIO_SELF_HOSTED_RELAY_URL', 'wss://relay.internal/ws');

    const config = new ConfigManager().getConfig();
    expect(config.mode).toBe('self-hosted');
    // Untouched file values are preserved
    expect(config.cloudEndpoint).toBe('https://auth.example.com');
  });

  it('uses the config file when no env vars are set', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ mode: 'cloud', cloudEndpoint: 'https://auth.example.com' })
    );

    const config = new ConfigManager().getConfig();
    expect(config.mode).toBe('cloud');
    expect(config.cloudEndpoint).toBe('https://auth.example.com');
  });

  it('self-hosted env overrides merge with file selfHosted values', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ mode: 'self-hosted', selfHosted: { relayUrl: 'ws://file-host:5000/ws' } })
    );
    vi.stubEnv('PINGIO_ENABLE_LOCAL_P2P', '0');

    const config = new ConfigManager().getConfig();
    expect(config.selfHosted.relayUrl).toBe('ws://file-host:5000/ws');
    expect(config.selfHosted.enableLocalP2P).toBe(false);
  });

  it('PINGIO_CLOUD_RELAY_URL feeds getEffectiveRelayUrl in cloud mode', () => {
    vi.stubEnv('PINGIO_MODE', 'cloud');
    vi.stubEnv('PINGIO_CLOUD_RELAY_URL', 'wss://relay.example.com/ws');

    const manager = new ConfigManager();
    expect(manager.getEffectiveRelayUrl()).toBe('wss://relay.example.com/ws');
  });

  it('applies PINGIO_NOTIFY and PINGIO_NOTIFY_CHANNELS over the defaults', () => {
    vi.stubEnv('PINGIO_NOTIFY', 'both');
    vi.stubEnv('PINGIO_NOTIFY_CHANNELS', 'true');

    const config = new ConfigManager().getConfig();
    expect(config.preferences.notify.mode).toBe('both');
    expect(config.preferences.notify.channels).toBe(true);
  });

  it('PINGIO_NOTIFY_CHANNELS accepts negative spellings', () => {
    vi.stubEnv('PINGIO_NOTIFY_CHANNELS', 'no');

    const config = new ConfigManager().getConfig();
    expect(config.preferences.notify.channels).toBe(false);
    // mode stays at its default
    expect(config.preferences.notify.mode).toBe('off');
  });

  it('falls back to defaults with a clear error when an env var is invalid', () => {
    vi.stubEnv('PINGIO_MODE', 'not-a-mode');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const config = new ConfigManager().getConfig();
    expect(config.mode).toBe('auto');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('PINGIO_*'),
      expect.anything()
    );

    errorSpy.mockRestore();
  });
});

describe('ConfigManager federation relay pool', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedExistsSync.mockReturnValue(false);
    vi.stubEnv('PINGIO_MODE', 'cloud');
    vi.stubEnv('PINGIO_CLOUD_ENDPOINT', 'https://auth.example.com');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function stubDiscovery(doc: object) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(doc), { status: 200 }))
    );
  }

  it('caches the relay pool from discovery, primary first', async () => {
    stubDiscovery({
      relay_url: 'wss://relay-a.example.com/ws',
      auth_issuer: 'https://auth.example.com',
      federation_enabled: true,
      relays: [
        { name: 'a', baseUrl: 'https://relay-a.example.com', wsUrl: 'wss://relay-a.example.com/ws', status: 'active' },
        { name: 'b', baseUrl: 'https://relay-b.example.com', wsUrl: 'wss://relay-b.example.com/ws', status: 'active' },
      ],
    });

    const manager = new ConfigManager();
    await manager.discoverRelayUrl();

    expect(manager.getRelayPool()).toEqual([
      'wss://relay-a.example.com/ws',
      'wss://relay-b.example.com/ws',
    ]);
  });

  it('normalizes pool entries (https→wss, /ws path) and dedupes', async () => {
    stubDiscovery({
      relay_url: 'https://relay-a.example.com', // non-ws primary gets coerced
      auth_issuer: 'https://auth.example.com',
      federation_enabled: true,
      relays: [
        { name: 'a', baseUrl: 'https://relay-a.example.com', wsUrl: 'https://relay-a.example.com', status: 'active' },
        { name: 'b', baseUrl: 'https://relay-b.example.com', wsUrl: 'wss://relay-b.example.com', status: 'grace' },
      ],
    });

    const manager = new ConfigManager();
    await manager.discoverRelayUrl();

    expect(manager.getRelayPool()).toEqual([
      'wss://relay-a.example.com/ws',
      'wss://relay-b.example.com/ws',
    ]);
  });

  it('pool falls back to just the effective relay before discovery runs', () => {
    vi.stubEnv('PINGIO_CLOUD_RELAY_URL', 'wss://relay-static.example.com/ws');
    const manager = new ConfigManager();
    expect(manager.getRelayPool()).toEqual(['wss://relay-static.example.com/ws']);
  });

  it('keeps working with no relays array (single-relay auth server)', async () => {
    stubDiscovery({
      relay_url: 'wss://relay-a.example.com/ws',
      auth_issuer: 'https://auth.example.com',
      federation_enabled: false,
    });

    const manager = new ConfigManager();
    await manager.discoverRelayUrl();

    expect(manager.getRelayPool()).toEqual(['wss://relay-a.example.com/ws']);
  });
});
