import crypto from 'crypto';
import { PostgresStore, RelayNode, RelayNodeStatus, NetworkVersionPolicy } from '../stores/postgres.js';
import { AuthService } from './auth.js';

/**
 * Federation control plane.
 *
 * The auth server is the single source of truth for the relay network: which
 * nodes are members, what version the network runs, and when a stale node
 * gets decommissioned. Relays register once (opaque credential, stored
 * hashed), then heartbeat their version; the service computes their status
 * against the network version policy:
 *
 *   version >= min_supported                        -> active
 *   version <  min_supported, within grace window   -> grace   (still pooled)
 *   version <  min_supported, grace expired         -> decommissioned (dropped)
 *
 * Update AND downgrade are the same mechanism: when a node's reported version
 * differs from the policy's current_version, the heartbeat response carries
 * the signed manifest (RS256 JWT, verifiable against JWKS) pinning the target
 * artifact. Nodes apply it only after signature + hash verification.
 */

export class FederationError extends Error {
  constructor(
    public code:
      | 'bootstrap_required'
      | 'invalid_bootstrap_token'
      | 'invalid_params'
      | 'duplicate_base_url'
      | 'unknown_node'
      | 'unknown_component',
    message: string
  ) {
    super(message);
    this.name = 'FederationError';
  }
}

/** Numeric x.y.z comparison; pre-release suffixes are ignored (documented). */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function computeNodeStatus(
  version: string | undefined,
  policy: NetworkVersionPolicy | null,
  now: Date = new Date()
): { status: RelayNodeStatus; reason?: string } {
  // No policy published yet, or the node didn't report a version: stay
  // active — you can't be out of compliance with a rule that doesn't exist.
  if (!policy || !version) {
    return { status: 'active' };
  }
  if (compareSemver(version, policy.minSupportedVersion) >= 0) {
    return { status: 'active' };
  }
  if (policy.graceEndsAt && now < policy.graceEndsAt) {
    return {
      status: 'grace',
      reason: `Version ${version} is below minimum ${policy.minSupportedVersion}; ` +
        `update by ${policy.graceEndsAt.toISOString()} or be decommissioned`,
    };
  }
  return {
    status: 'decommissioned',
    reason: `Version ${version} is below minimum ${policy.minSupportedVersion} and the grace period has expired`,
  };
}

export interface RegisterNodeParams {
  name: string;
  baseUrl: string;
  wsUrl: string;
  operator?: string;
  version?: string;
  bootstrapToken?: string;
}

export interface UpdateDirective {
  targetVersion: string;
  direction: 'upgrade' | 'downgrade';
  manifest: string;
  artifactUrl: string;
  artifactSha256: string;
}

export interface HeartbeatResult {
  nodeId: string;
  status: RelayNodeStatus;
  statusReason?: string;
  policy?: {
    component: string;
    currentVersion: string;
    minSupportedVersion: string;
    graceEndsAt?: string;
  };
  update?: UpdateDirective;
}

export interface PublicRelayEntry {
  name: string;
  baseUrl: string;
  wsUrl: string;
  version?: string;
  status: RelayNodeStatus;
}

const RELAY_COMPONENT = 'relay-server';

export class FederationService {
  constructor(
    private postgres: PostgresStore,
    private authService: AuthService,
    private opts: { bootstrapToken?: string; adminToken?: string } = {}
  ) {}

  private hashCredential(credential: string): string {
    return crypto.createHash('sha256').update(credential).digest('hex');
  }

  private validateUrl(raw: string, protocols: string[], field: string): string {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new FederationError('invalid_params', `${field} is not a valid URL`);
    }
    if (!protocols.includes(url.protocol)) {
      throw new FederationError(
        'invalid_params',
        `${field} must use ${protocols.join(' or ')}`
      );
    }
    return url.toString();
  }

  private validateVersion(version: string, field: string = 'version'): void {
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new FederationError('invalid_params', `${field} must be a semver x.y.z`);
    }
  }

  private async buildHeartbeatResult(node: RelayNode): Promise<HeartbeatResult> {
    const policy = await this.postgres.getNetworkPolicy(RELAY_COMPONENT);
    const { status, reason } = computeNodeStatus(node.reportedVersion, policy);

    if (node.status !== status || (reason || undefined) !== node.statusReason) {
      await this.postgres.setRelayNodeStatus(node.id, status, reason);
      node.status = status;
      node.statusReason = reason;
    }

    const result: HeartbeatResult = { nodeId: node.id, status, statusReason: reason };
    if (policy) {
      result.policy = {
        component: policy.component,
        currentVersion: policy.currentVersion,
        minSupportedVersion: policy.minSupportedVersion,
        graceEndsAt: policy.graceEndsAt?.toISOString(),
      };

      // Same mechanism for upgrade and rollback: any drift from the target
      // version produces a signed directive. Downgrades are how the network
      // recovers from a bad release.
      const version = node.reportedVersion;
      if (
        version &&
        compareSemver(version, policy.currentVersion) !== 0 &&
        policy.manifest &&
        policy.artifactUrl &&
        policy.artifactSha256
      ) {
        result.update = {
          targetVersion: policy.currentVersion,
          direction: compareSemver(version, policy.currentVersion) < 0 ? 'upgrade' : 'downgrade',
          manifest: policy.manifest,
          artifactUrl: policy.artifactUrl,
          artifactSha256: policy.artifactSha256,
        };
      }
    }
    return result;
  }

  async register(params: RegisterNodeParams): Promise<HeartbeatResult & { credential: string }> {
    if (this.opts.bootstrapToken) {
      if (!params.bootstrapToken) {
        throw new FederationError(
          'bootstrap_required',
          'This network requires a bootstrap token to register a relay node'
        );
      }
      // Constant-time compare: bootstrap tokens gate network membership.
      const expected = Buffer.from(this.opts.bootstrapToken);
      const provided = Buffer.from(params.bootstrapToken);
      if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
        throw new FederationError('invalid_bootstrap_token', 'Invalid bootstrap token');
      }
    }

    const name = params.name?.trim();
    if (!name || name.length > 64) {
      throw new FederationError('invalid_params', 'name is required (max 64 chars)');
    }
    const baseUrl = this.validateUrl(params.baseUrl, ['https:', 'http:'], 'baseUrl');
    const wsUrl = this.validateUrl(params.wsUrl, ['wss:', 'ws:'], 'wsUrl');
    if (params.version) {
      this.validateVersion(params.version);
    }

    const credential = crypto.randomBytes(32).toString('hex');
    const credentialHash = this.hashCredential(credential);

    // Initial status is computed against the current policy immediately, so a
    // node registering with an already-banned version starts decommissioned
    // instead of getting a free pass until its first heartbeat.
    const policy = await this.postgres.getNetworkPolicy(RELAY_COMPONENT);
    const { status, reason } = computeNodeStatus(params.version, policy);

    const node = await this.postgres.createRelayNode(
      name,
      baseUrl,
      wsUrl,
      params.operator?.trim() || undefined,
      credentialHash,
      params.version,
      status
    );
    if (!node) {
      throw new FederationError(
        'duplicate_base_url',
        'A relay node with this baseUrl is already registered'
      );
    }
    if (reason) {
      await this.postgres.setRelayNodeStatus(node.id, status, reason);
      node.statusReason = reason;
    }

    return { ...(await this.buildHeartbeatResult(node)), credential };
  }

  async heartbeat(credential: string, version?: string): Promise<HeartbeatResult> {
    const node = await this.postgres.getRelayNodeByCredentialHash(
      this.hashCredential(credential)
    );
    if (!node) {
      throw new FederationError('unknown_node', 'Unknown node credential');
    }
    if (version) {
      this.validateVersion(version);
    }
    await this.postgres.updateRelayNodeHeartbeat(node.id, version);
    if (version) {
      node.reportedVersion = version;
    }
    return this.buildHeartbeatResult(node);
  }

  /** Pool entries for clients: only nodes allowed to serve traffic. */
  async listPublicNodes(): Promise<PublicRelayEntry[]> {
    const nodes = await this.postgres.listRelayNodes(['active', 'grace']);
    return nodes.map(n => ({
      name: n.name,
      baseUrl: n.baseUrl,
      wsUrl: n.wsUrl,
      version: n.reportedVersion,
      status: n.status,
    }));
  }

  async listAllNodes(): Promise<Omit<RelayNode, 'credentialHash'>[]> {
    const nodes = await this.postgres.listRelayNodes();
    // Never expose the credential hash, even to the admin channel.
    return nodes.map(({ credentialHash: _credentialHash, ...rest }) => rest);
  }

  /**
   * Publish a new version policy. This is THE network operation: bumping
   * min_supported_version starts the grace clock (default 72h), after which
   * non-compliant nodes are decommissioned. The manifest is re-minted and
   * every node's status is recomputed immediately.
   */
  async setPolicy(params: {
    component?: string;
    currentVersion: string;
    minSupportedVersion: string;
    graceHours?: number;
    artifactUrl: string;
    artifactSha256: string;
  }): Promise<NetworkVersionPolicy> {
    const component = params.component || RELAY_COMPONENT;
    this.validateVersion(params.currentVersion, 'currentVersion');
    this.validateVersion(params.minSupportedVersion, 'minSupportedVersion');
    const artifactUrl = this.validateUrl(params.artifactUrl, ['https:'], 'artifactUrl');
    if (!/^[0-9a-f]{64}$/i.test(params.artifactSha256)) {
      throw new FederationError('invalid_params', 'artifactSha256 must be a hex SHA-256');
    }
    const graceHours = params.graceHours ?? 72;
    if (!(graceHours > 0 && graceHours <= 24 * 90)) {
      throw new FederationError('invalid_params', 'graceHours must be between 0 and 2160');
    }

    const manifest = await this.authService.signFederationManifest({
      component,
      version: params.currentVersion,
      artifact_url: artifactUrl,
      artifact_sha256: params.artifactSha256.toLowerCase(),
    });

    const policy = await this.postgres.upsertNetworkPolicy({
      component,
      currentVersion: params.currentVersion,
      minSupportedVersion: params.minSupportedVersion,
      graceEndsAt: new Date(Date.now() + graceHours * 3600_000),
      artifactUrl,
      artifactSha256: params.artifactSha256.toLowerCase(),
      manifest,
    });

    // Recompute all node statuses against the new policy right away — a node
    // that just became non-compliant shouldn't coast until its next heartbeat
    // unaware, and a node that came back into compliance should be restored.
    const nodes = await this.postgres.listRelayNodes();
    for (const node of nodes) {
      const { status, reason } = computeNodeStatus(node.reportedVersion, policy);
      if (status !== node.status || (reason || undefined) !== node.statusReason) {
        await this.postgres.setRelayNodeStatus(node.id, status, reason);
      }
    }

    return policy;
  }

  async getPolicy(component: string = RELAY_COMPONENT): Promise<NetworkVersionPolicy | null> {
    return this.postgres.getNetworkPolicy(component);
  }

  async decommissionNode(id: string, reason?: string): Promise<void> {
    const ok = await this.postgres.setRelayNodeStatus(
      id,
      'decommissioned',
      reason || 'Manually decommissioned by network operator'
    );
    if (!ok) {
      throw new FederationError('unknown_node', 'No relay node with this id');
    }
  }

  async reactivateNode(id: string): Promise<void> {
    const node = await this.postgres.getRelayNodeById(id);
    if (!node) {
      throw new FederationError('unknown_node', 'No relay node with this id');
    }
    // Reactivation is still subject to policy compliance.
    const policy = await this.postgres.getNetworkPolicy(RELAY_COMPONENT);
    const { status, reason } = computeNodeStatus(node.reportedVersion, policy);
    await this.postgres.setRelayNodeStatus(id, status, reason);
  }

  assertAdmin(token: string | undefined): void {
    if (!this.opts.adminToken) {
      throw new FederationError(
        'invalid_params',
        'Federation admin API is disabled (FEDERATION_ADMIN_TOKEN unset)'
      );
    }
    const expected = Buffer.from(this.opts.adminToken);
    const provided = Buffer.from(token || '');
    if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
      throw new FederationError('invalid_bootstrap_token', 'Invalid admin token');
    }
  }
}
