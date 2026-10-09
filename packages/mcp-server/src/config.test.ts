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
    expect(config.cloudEndpoint).toBe('https://auth.pingio.io');
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
