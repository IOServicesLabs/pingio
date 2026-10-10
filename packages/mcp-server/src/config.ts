import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { UserConfig } from '@pingio/shared';
import { UserConfigSchema, DEFAULT_CONFIG } from '@pingio/shared';

const CONFIG_DIR = join(homedir(), '.pingio');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

interface WellKnownPingio {
  relay_id?: string;
  relay_url: string;
  auth_issuer: string;
  federation_enabled: boolean;
  relays?: Array<{
    name: string;
    baseUrl: string;
    wsUrl: string;
    version?: string;
    status: string;
  }>;
}

/**
 * Environment overrides for the user config. These win over
 * ~/.pingio/config.json and the built-in defaults, which makes them handy for
 * containers and MCP-client configs (where editing the config file is awkward):
 *
 *   PINGIO_MODE                 cloud | self-hosted | auto
 *   PINGIO_CLOUD_ENDPOINT       e.g. https://auth.example.com
 *   PINGIO_CLOUD_RELAY_URL      e.g. wss://relay.example.com/ws
 *   PINGIO_SELF_HOSTED_RELAY_URL  e.g. ws://localhost:5000/ws
 *   PINGIO_SELF_HOSTED_AUTH_URL   e.g. https://relay.example.com
 *   PINGIO_ENABLE_LOCAL_P2P     1/true/yes enable; 0/false/no disable
 */
function applyEnvOverrides(config: Record<string, unknown>): Record<string, unknown> {
  const env = process.env;
  const out: Record<string, unknown> = { ...config };

  if (env.PINGIO_MODE) {
    // Validated by UserConfigSchema ('cloud' | 'self-hosted' | 'auto').
    out.mode = env.PINGIO_MODE;
  }
  if (env.PINGIO_CLOUD_ENDPOINT) {
    out.cloudEndpoint = env.PINGIO_CLOUD_ENDPOINT;
  }
  if (env.PINGIO_CLOUD_RELAY_URL) {
    out.cloudRelayUrl = env.PINGIO_CLOUD_RELAY_URL;
  }

  const selfHosted: Record<string, unknown> = {
    ...(config.selfHosted as Record<string, unknown> | undefined),
  };
  let selfHostedTouched = false;
  if (env.PINGIO_SELF_HOSTED_RELAY_URL) {
    selfHosted.relayUrl = env.PINGIO_SELF_HOSTED_RELAY_URL;
    selfHostedTouched = true;
  }
  if (env.PINGIO_SELF_HOSTED_AUTH_URL) {
    selfHosted.authUrl = env.PINGIO_SELF_HOSTED_AUTH_URL;
    selfHostedTouched = true;
  }
  if (env.PINGIO_ENABLE_LOCAL_P2P !== undefined) {
    selfHosted.enableLocalP2P = !['0', 'false', 'no'].includes(
      env.PINGIO_ENABLE_LOCAL_P2P.toLowerCase()
    );
    selfHostedTouched = true;
  }
  if (selfHostedTouched) {
    out.selfHosted = selfHosted;
  }

  return out;
}

export class ConfigManager {
  private config: UserConfig;
  // In-memory pool of federation relay WS URLs, learned from the auth
  // server's /.well-known/pingio discovery document. Primary first.
  private relayPool: string[] = [];

  constructor() {
    this.config = this.loadConfig();
  }

  private loadConfig(): UserConfig {
    let fileConfig: Record<string, unknown> = {};
    try {
      if (existsSync(CONFIG_PATH)) {
        const data = readFileSync(CONFIG_PATH, 'utf-8');
        fileConfig = JSON.parse(data);
      }
    } catch (error) {
      console.error('Failed to load config:', error);
    }

    // Precedence: PINGIO_* env vars > config file > built-in defaults.
    try {
      return UserConfigSchema.parse(applyEnvOverrides({ ...DEFAULT_CONFIG, ...fileConfig }));
    } catch (error) {
      console.error(
        'Invalid configuration (check ~/.pingio/config.json and PINGIO_* env vars):',
        error
      );
      return UserConfigSchema.parse(DEFAULT_CONFIG);
    }
  }

  saveConfig(): void {
    try {
      if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true });
      }
      writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2));
    } catch (error) {
      console.error('Failed to save config:', error);
    }
  }

  getConfig(): UserConfig {
    return this.config;
  }

  setIdentity(username: string, authToken: string, userId?: string, refreshToken?: string, deviceId?: string): void {
    this.config.identity = { username, authToken, userId, refreshToken, deviceId };
    this.saveConfig();
  }

  clearIdentity(): void {
    this.config.identity = {};
    this.saveConfig();
  }

  setMode(mode: UserConfig['mode']): void {
    this.config.mode = mode;
    this.saveConfig();
  }

  setCloudEndpoint(endpoint: string): void {
    this.config.cloudEndpoint = endpoint;
    this.saveConfig();
  }

  setCloudRelayUrl(url: string): void {
    this.config.cloudRelayUrl = url;
    this.saveConfig();
  }

  setSelfHostedConfig(config: Partial<UserConfig['selfHosted']>): void {
    this.config.selfHosted = { ...this.config.selfHosted, ...config };
    this.saveConfig();
  }

  getAuthBaseUrl(): string {
    if (this.config.mode === 'self-hosted') {
      // authUrl wins; otherwise derive the HTTP base from the relay WS URL
      // (getRestBaseUrl converts ws→http/wss→https and strips /ws).
      return this.config.selfHosted.authUrl || this.getRestBaseUrl();
    }
    return this.config.cloudEndpoint;
  }

  getEffectiveRelayUrl(): string {
    if (this.config.mode === 'cloud' || this.config.mode === 'auto') {
      if (this.config.cloudRelayUrl) {
        return this.config.cloudRelayUrl;
      }
      // Fallback default; caller should run discoverRelayUrl for accurate value
      return 'wss://relay.pingio.io/ws';
    }

    // Self-hosted mode
    const configured = this.config.selfHosted.relayUrl;
    try {
      const url = new URL(configured);
      // Convert http(s) to ws(s)
      if (url.protocol === 'http:') {
        url.protocol = 'ws:';
      } else if (url.protocol === 'https:') {
        url.protocol = 'wss:';
      }
      // Ensure /ws path if not present
      if (!url.pathname.endsWith('/ws')) {
        url.pathname = url.pathname.replace(/\/$/, '') + '/ws';
      }
      return url.toString();
    } catch {
      return configured;
    }
  }

  async discoverRelayUrl(): Promise<string | undefined> {
    if (this.config.mode === 'self-hosted') {
      return undefined;
    }

    try {
      const authUrl = this.config.cloudEndpoint.replace(/\/$/, '');
      const response = await fetch(`${authUrl}/.well-known/pingio`);
      if (!response.ok) {
        throw new Error(`Failed to discover relay: ${response.status}`);
      }
      const data = (await response.json()) as WellKnownPingio;
      this.setCloudRelayUrl(data.relay_url);
      // Cache the federation pool for failover: canonical primary first, then
      // every registered node the auth server currently allows to serve
      // traffic (it never lists decommissioned nodes).
      const pool = [data.relay_url, ...(data.relays || []).map(r => r.wsUrl)]
        .filter(Boolean)
        .map(u => this.normalizeWsUrl(u));
      this.relayPool = [...new Set(pool)];
      return data.relay_url;
    } catch (error) {
      console.error('Failed to discover relay URL:', error);
      return undefined;
    }
  }

  private normalizeWsUrl(raw: string): string {
    try {
      const url = new URL(raw);
      if (url.protocol === 'http:') url.protocol = 'ws:';
      else if (url.protocol === 'https:') url.protocol = 'wss:';
      if (!url.pathname.endsWith('/ws')) {
        url.pathname = url.pathname.replace(/\/$/, '') + '/ws';
      }
      return url.toString();
    } catch {
      return raw;
    }
  }

  /**
   * Ordered relay candidates for connection failover: the configured/effective
   * relay first, then the federation pool learned from discovery. Always at
   * least one entry.
   */
  getRelayPool(): string[] {
    const primary = this.normalizeWsUrl(this.getEffectiveRelayUrl());
    return [...new Set([primary, ...this.relayPool])];
  }

  getRestBaseUrl(): string {
    const relayUrl = this.getEffectiveRelayUrl();
    try {
      const url = new URL(relayUrl);
      if (url.protocol === 'ws:') {
        url.protocol = 'http:';
      } else if (url.protocol === 'wss:') {
        url.protocol = 'https:';
      }
      url.pathname = url.pathname.replace(/\/ws$/, '');
      // Strip the trailing slash URL serialization adds for an empty path,
      // otherwise callers building `${base}/api/...` get a double slash.
      return url.toString().replace(/\/$/, '');
    } catch {
      return relayUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
    }
  }

  isAuthenticated(): boolean {
    return !!(this.config.identity.username && this.config.identity.authToken);
  }
}

export const configManager = new ConfigManager();
