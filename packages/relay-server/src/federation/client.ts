import os from 'os';
import path from 'path';
import { PostgresStore } from '../stores/postgres.js';
import { stageUpdate, UPDATE_EXIT_CODE, UpdateDirective } from './updater.js';

/**
 * Relay-side federation client.
 *
 * When FEDERATION_ENABLED=true, the relay joins the network's control plane:
 * it registers with the central auth server once (credential persisted in the
 * relay_node_state table), then heartbeats its running version. The heartbeat
 * response drives three behaviors:
 *
 *   - status 'grace'          -> loud warning logs; still serving
 *   - status 'decommissioned' -> isDecommissioned() goes true; server.ts
 *                                refuses NEW WebSocket connections (existing
 *                                sessions drain naturally)
 *   - update directive        -> FEDERATION_AUTO_UPDATE=true stages the signed
 *                                artifact and exits with code 75 so the
 *                                supervisor restarts into it; otherwise logs
 *                                that a manual update is required
 *
 * Upgrade and downgrade are the same path — the auth server's manifest is the
 * source of truth for what this node should run.
 */

const RELAY_COMPONENT = 'relay-server';

export interface FederationClientOptions {
  authEndpoint: string; // e.g. https://auth.pingio.io
  nodeName: string;
  baseUrl: string; // public https base URL of this relay
  wsUrl: string; // public wss URL of this relay
  operator?: string;
  bootstrapToken?: string;
  version: string;
  heartbeatSeconds: number;
  autoUpdate: boolean;
  logger?: (msg: string) => void;
  fetchFn?: typeof fetch;
  exitFn?: (code: number) => void; // injectable for tests
}

export interface FederationStatus {
  enabled: boolean;
  nodeId?: string;
  status?: 'active' | 'grace' | 'decommissioned';
  statusReason?: string;
  targetVersion?: string;
}

export class RelayFederationClient {
  private nodeId?: string;
  private credential?: string;
  private timer?: NodeJS.Timeout;
  private currentStatus: FederationStatus['status'];
  private statusReason?: string;
  private targetVersion?: string;
  private updateInFlight = false;
  private log: (msg: string) => void;

  constructor(
    private postgres: PostgresStore,
    private opts: FederationClientOptions
  ) {
    this.log = opts.logger || ((msg: string) => console.log(`[federation] ${msg}`));
  }

  static fromEnv(postgres: PostgresStore, version: string): RelayFederationClient | null {
    if (process.env.FEDERATION_ENABLED !== 'true') return null;
    const authEndpoint = process.env.CENTRAL_AUTH_ISSUER;
    if (!authEndpoint) {
      console.log('[federation] FEDERATION_ENABLED=true but CENTRAL_AUTH_ISSUER unset — disabled');
      return null;
    }
    const port = process.env.PORT || '3000';
    const host = process.env.RELAY_HOST || 'localhost';
    return new RelayFederationClient(postgres, {
      authEndpoint,
      nodeName: process.env.FEDERATION_NODE_NAME || os.hostname(),
      baseUrl: process.env.PUBLIC_BASE_URL || `http://${host}:${port}`,
      wsUrl: process.env.PUBLIC_WS_URL || `ws://${host}:${port}/ws`,
      operator: process.env.FEDERATION_OPERATOR,
      bootstrapToken: process.env.FEDERATION_BOOTSTRAP_TOKEN,
      version: process.env.RELAY_VERSION || version,
      heartbeatSeconds: parseInt(process.env.FEDERATION_HEARTBEAT_SECONDS || '300', 10),
      autoUpdate: process.env.FEDERATION_AUTO_UPDATE === 'true',
    });
  }

  isDecommissioned(): boolean {
    return this.currentStatus === 'decommissioned';
  }

  getStatus(): FederationStatus {
    return {
      enabled: true,
      nodeId: this.nodeId,
      status: this.currentStatus,
      statusReason: this.statusReason,
      targetVersion: this.targetVersion,
    };
  }

  async start(): Promise<void> {
    const state = await this.postgres.getRelayNodeState();
    if (state) {
      this.nodeId = state.nodeId;
      this.credential = state.credential;
      this.log(`registered as node ${this.nodeId} (${this.opts.nodeName})`);
    } else {
      await this.register();
    }
    await this.heartbeat(); // immediate first heartbeat — learns policy at boot
    this.timer = setInterval(() => {
      this.heartbeat().catch(err => this.log(`heartbeat failed: ${(err as Error).message}`));
    }, this.opts.heartbeatSeconds * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async register(): Promise<void> {
    const fetchFn = this.opts.fetchFn || fetch;
    const response = await fetchFn(`${this.opts.authEndpoint}/api/federation/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: this.opts.nodeName,
        baseUrl: this.opts.baseUrl,
        wsUrl: this.opts.wsUrl,
        operator: this.opts.operator,
        version: this.opts.version,
        bootstrapToken: this.opts.bootstrapToken,
      }),
    });
    const body = (await response.json()) as {
      success: boolean;
      nodeId?: string;
      credential?: string;
      status?: FederationStatus['status'];
      statusReason?: string;
      error?: string;
      update?: UpdateDirective;
    };
    if (!response.ok || !body.success || !body.nodeId || !body.credential) {
      throw new Error(
        `federation registration failed (HTTP ${response.status}): ${body.error || 'unknown error'}`
      );
    }
    this.nodeId = body.nodeId;
    this.credential = body.credential;
    await this.postgres.saveRelayNodeState(body.nodeId, body.credential);
    this.applyStatus(body.status, body.statusReason);
    this.log(`registered with federation as node ${this.nodeId} (status: ${this.currentStatus})`);
    if (body.update) await this.handleUpdateDirective(body.update);
  }

  private async heartbeat(): Promise<void> {
    if (!this.credential) return;
    const fetchFn = this.opts.fetchFn || fetch;
    const response = await fetchFn(`${this.opts.authEndpoint}/api/federation/heartbeat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.credential}`,
      },
      body: JSON.stringify({ version: this.opts.version }),
    });
    const body = (await response.json()) as {
      success: boolean;
      status?: FederationStatus['status'];
      statusReason?: string;
      policy?: { currentVersion: string };
      update?: UpdateDirective;
      error?: string;
    };
    if (response.status === 403) {
      // Credential rejected — node was removed from the registry. Refuse new
      // connections until an operator re-registers (deletes relay_node_state).
      this.applyStatus('decommissioned', body.error || 'node credential rejected by auth server');
      this.log(`DEACTIVATED by control plane: ${this.statusReason}`);
      return;
    }
    if (!response.ok || !body.success) {
      this.log(`heartbeat error (HTTP ${response.status}): ${body.error || 'unknown'}`);
      return;
    }
    this.applyStatus(body.status, body.statusReason);
    this.targetVersion = body.policy?.currentVersion;
    if (body.update) await this.handleUpdateDirective(body.update);
  }

  private applyStatus(
    status: FederationStatus['status'],
    reason?: string
  ): void {
    if (status !== this.currentStatus) {
      this.log(`status: ${this.currentStatus || 'unknown'} -> ${status}${reason ? ` (${reason})` : ''}`);
    }
    this.currentStatus = status;
    this.statusReason = reason;
    if (status === 'grace') {
      this.log(`WARNING: ${reason}`);
    } else if (status === 'decommissioned') {
      this.log(`DECOMMISSIONED: ${reason} — refusing new WebSocket connections`);
    }
  }

  private async handleUpdateDirective(directive: UpdateDirective): Promise<void> {
    if (this.updateInFlight) return;
    if (!this.opts.autoUpdate) {
      this.log(
        `${directive.direction} available: ${this.opts.version} -> ${directive.targetVersion} ` +
          `(set FEDERATION_AUTO_UPDATE=true to apply automatically)`
      );
      return;
    }
    this.updateInFlight = true;
    try {
      this.log(`applying ${directive.direction} to ${directive.targetVersion}…`);
      const staged = await stageUpdate(
        directive,
        {
          jwksUrl: `${this.opts.authEndpoint}/.well-known/jwks.json`,
          issuer: this.opts.authEndpoint,
          component: RELAY_COMPONENT,
          destDir: path.join(os.tmpdir(), 'pingio-update'),
        },
        this.opts.fetchFn
      );
      this.log(`update staged at ${staged} — exiting for supervisor restart`);
      // Give in-flight logs a moment to flush, then exit so the supervisor
      // (Docker restart policy / systemd / wrapper script) swaps us into the
      // staged artifact.
      const exitFn = this.opts.exitFn || process.exit;
      setTimeout(() => exitFn(UPDATE_EXIT_CODE), 500).unref();
    } catch (err) {
      // Fail closed and KEEP RUNNING the current version: a bad update must
      // never take a healthy node down.
      this.updateInFlight = false;
      this.log(`update rejected: ${(err as Error).message}`);
    }
  }
}
