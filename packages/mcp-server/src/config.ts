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
}

export class ConfigManager {
  private config: UserConfig;

  constructor() {
    this.config = this.loadConfig();
  }

  private loadConfig(): UserConfig {
    try {
      if (existsSync(CONFIG_PATH)) {
        const data = readFileSync(CONFIG_PATH, 'utf-8');
        const parsed = JSON.parse(data);
        return UserConfigSchema.parse({ ...DEFAULT_CONFIG, ...parsed });
      }
    } catch (error) {
      console.error('Failed to load config:', error);
    }

    return UserConfigSchema.parse(DEFAULT_CONFIG);
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
      return (
        this.config.selfHosted.authUrl ||
        this.getEffectiveRelayUrl().replace(/\/ws$/, '')
      );
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
      return data.relay_url;
    } catch (error) {
      console.error('Failed to discover relay URL:', error);
      return undefined;
    }
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
      return url.toString();
    } catch {
      return relayUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
    }
  }

  isAuthenticated(): boolean {
    return !!(this.config.identity.username && this.config.identity.authToken);
  }
}

export const configManager = new ConfigManager();
