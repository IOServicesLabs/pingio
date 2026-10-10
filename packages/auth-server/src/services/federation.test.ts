import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import { jwtVerify } from 'jose';
import { FederationService, FederationError, compareSemver, computeNodeStatus } from './federation.js';
import { AuthService } from './auth.js';

const makePostgres = () => ({
  createRelayNode: vi.fn(),
  getRelayNodeByCredentialHash: vi.fn(),
  getRelayNodeById: vi.fn(),
  updateRelayNodeHeartbeat: vi.fn(),
  setRelayNodeStatus: vi.fn(),
  listRelayNodes: vi.fn(),
  upsertNetworkPolicy: vi.fn(),
  getNetworkPolicy: vi.fn(),
  listNetworkPolicies: vi.fn(),
});

function generateTestKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { id: 'key-1', kid: 'test-kid', publicKey, privateKey, algorithm: 'RS256', createdAt: new Date() };
}

const POLICY = {
  component: 'relay-server',
  currentVersion: '1.2.0',
  minSupportedVersion: '1.1.0',
  graceEndsAt: new Date(Date.now() + 72 * 3600_000),
  artifactUrl: 'https://releases.example.com/relay-server-1.2.0.tgz',
  artifactSha256: 'a'.repeat(64),
  manifest: 'signed-manifest-jwt',
  updatedAt: new Date(),
};

const NODE = {
  id: 'node-1',
  name: 'relay-eu',
  baseUrl: 'https://relay-eu.example.com/',
  wsUrl: 'wss://relay-eu.example.com/ws',
  operator: 'op-eu',
  credentialHash: 'hash-1',
  reportedVersion: '1.2.0',
  status: 'active' as const,
  statusReason: undefined,
  registeredAt: new Date(),
  lastHeartbeatAt: new Date(),
};

describe('compareSemver', () => {
  it('orders versions numerically', () => {
    expect(compareSemver('1.2.0', '1.10.0')).toBe(-1);
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
  });

  it('ignores pre-release suffixes', () => {
    expect(compareSemver('1.2.0-rc.1', '1.2.0')).toBe(0);
  });
});

describe('computeNodeStatus', () => {
  it('is active when no policy exists', () => {
    expect(computeNodeStatus('0.0.1', null).status).toBe('active');
  });

  it('is active when node did not report a version', () => {
    expect(computeNodeStatus(undefined, POLICY).status).toBe('active');
  });

  it('is active at or above min_supported', () => {
    expect(computeNodeStatus('1.1.0', POLICY).status).toBe('active');
    expect(computeNodeStatus('1.2.0', POLICY).status).toBe('active');
  });

  it('is grace below min within the grace window', () => {
    const r = computeNodeStatus('1.0.0', POLICY);
    expect(r.status).toBe('grace');
    expect(r.reason).toContain('1.0.0');
  });

  it('is decommissioned below min after grace expiry', () => {
    const expired = { ...POLICY, graceEndsAt: new Date(Date.now() - 1000) };
    const r = computeNodeStatus('1.0.0', expired);
    expect(r.status).toBe('decommissioned');
  });
});

describe('FederationService', () => {
  let postgres: ReturnType<typeof makePostgres>;
  let authService: AuthService;
  let testKey: ReturnType<typeof generateTestKeyPair>;
  let service: FederationService;

  beforeEach(() => {
    vi.clearAllMocks();
    postgres = makePostgres();
    testKey = generateTestKeyPair();
    authService = new AuthService(postgres as any, 'test-issuer', 'test-audience');
    service = new FederationService(postgres as any, authService, {
      bootstrapToken: 'boot-secret',
      adminToken: 'admin-secret',
    });
  });

  describe('register', () => {
    const valid = {
      name: 'relay-eu',
      baseUrl: 'https://relay-eu.example.com',
      wsUrl: 'wss://relay-eu.example.com/ws',
      operator: 'op-eu',
      version: '1.2.0',
      bootstrapToken: 'boot-secret',
    };

    it('rejects missing bootstrap token when one is configured', async () => {
      await expect(service.register({ ...valid, bootstrapToken: undefined }))
        .rejects.toMatchObject({ code: 'bootstrap_required' });
    });

    it('rejects a wrong bootstrap token', async () => {
      await expect(service.register({ ...valid, bootstrapToken: 'nope' }))
        .rejects.toMatchObject({ code: 'invalid_bootstrap_token' });
    });

    it('allows registration without a token when none is configured (open network)', async () => {
      const open = new FederationService(postgres as any, authService, {});
      postgres.getNetworkPolicy.mockResolvedValue(null);
      postgres.createRelayNode.mockResolvedValue({ ...NODE });
      postgres.setRelayNodeStatus.mockResolvedValue(true);
      const result = await open.register({ ...valid, bootstrapToken: undefined });
      expect(result.credential).toMatch(/^[0-9a-f]{64}$/);
    });

    it('rejects non-https artifact-less invalid URLs', async () => {
      await expect(service.register({ ...valid, baseUrl: 'ftp://x' }))
        .rejects.toMatchObject({ code: 'invalid_params' });
      await expect(service.register({ ...valid, wsUrl: 'http://x' }))
        .rejects.toMatchObject({ code: 'invalid_params' });
      await expect(service.register({ ...valid, baseUrl: 'not-a-url' }))
        .rejects.toMatchObject({ code: 'invalid_params' });
    });

    it('rejects a malformed version', async () => {
      await expect(service.register({ ...valid, version: '1.2' }))
        .rejects.toMatchObject({ code: 'invalid_params' });
    });

    it('registers and returns an opaque credential + status', async () => {
      postgres.getNetworkPolicy.mockResolvedValue(POLICY);
      postgres.createRelayNode.mockResolvedValue({ ...NODE });
      postgres.setRelayNodeStatus.mockResolvedValue(true);

      const result = await service.register(valid);

      expect(result.credential).toMatch(/^[0-9a-f]{64}$/);
      expect(result.status).toBe('active');
      expect(result.nodeId).toBe('node-1');
      // Credential is stored hashed, never in plaintext.
      const storedHash = postgres.createRelayNode.mock.calls[0][4];
      expect(storedHash).not.toBe(result.credential);
      expect(storedHash).toBe(
        crypto.createHash('sha256').update(result.credential).digest('hex')
      );
    });

    it('registers an outdated node straight into decommissioned', async () => {
      const expiredPolicy = { ...POLICY, graceEndsAt: new Date(Date.now() - 1000) };
      postgres.getNetworkPolicy.mockResolvedValue(expiredPolicy);
      postgres.createRelayNode.mockResolvedValue({
        ...NODE,
        reportedVersion: '1.0.0',
        status: 'decommissioned',
      });
      postgres.setRelayNodeStatus.mockResolvedValue(true);

      const result = await service.register({ ...valid, version: '1.0.0' });

      expect(postgres.createRelayNode.mock.calls[0][6]).toBe('decommissioned');
      expect(result.status).toBe('decommissioned');
    });

    it('maps duplicate base_url to a 409-class error', async () => {
      postgres.getNetworkPolicy.mockResolvedValue(null);
      postgres.createRelayNode.mockResolvedValue(null);
      await expect(service.register(valid)).rejects.toMatchObject({ code: 'duplicate_base_url' });
    });
  });

  describe('heartbeat', () => {
    it('rejects an unknown credential', async () => {
      postgres.getRelayNodeByCredentialHash.mockResolvedValue(null);
      await expect(service.heartbeat('bad-cred', '1.2.0'))
        .rejects.toMatchObject({ code: 'unknown_node' });
    });

    it('updates heartbeat + version and returns policy without update when current', async () => {
      postgres.getRelayNodeByCredentialHash.mockResolvedValue({ ...NODE });
      postgres.getNetworkPolicy.mockResolvedValue(POLICY);
      postgres.setRelayNodeStatus.mockResolvedValue(true);

      const result = await service.heartbeat('cred', '1.2.0');

      expect(postgres.updateRelayNodeHeartbeat).toHaveBeenCalledWith('node-1', '1.2.0');
      expect(result.status).toBe('active');
      expect(result.policy?.currentVersion).toBe('1.2.0');
      expect(result.update).toBeUndefined();
    });

    it('issues an upgrade directive when the node is behind current', async () => {
      postgres.getRelayNodeByCredentialHash.mockResolvedValue({ ...NODE, reportedVersion: '1.1.0' });
      postgres.getNetworkPolicy.mockResolvedValue(POLICY);
      postgres.setRelayNodeStatus.mockResolvedValue(true);

      const result = await service.heartbeat('cred', '1.1.0');

      expect(result.status).toBe('active'); // 1.1.0 >= min 1.1.0
      expect(result.update).toBeDefined();
      expect(result.update?.direction).toBe('upgrade');
      expect(result.update?.targetVersion).toBe('1.2.0');
      expect(result.update?.manifest).toBe('signed-manifest-jwt');
    });

    it('issues a DOWNGRADE directive when the node is ahead of current (rollback)', async () => {
      postgres.getRelayNodeByCredentialHash.mockResolvedValue({ ...NODE, reportedVersion: '1.3.0' });
      postgres.getNetworkPolicy.mockResolvedValue(POLICY);
      postgres.setRelayNodeStatus.mockResolvedValue(true);

      const result = await service.heartbeat('cred', '1.3.0');

      expect(result.update?.direction).toBe('downgrade');
      expect(result.update?.targetVersion).toBe('1.2.0');
    });

    it('transitions a stale node to decommissioned when grace has expired', async () => {
      postgres.getRelayNodeByCredentialHash.mockResolvedValue({ ...NODE, reportedVersion: '1.0.9' });
      postgres.getNetworkPolicy.mockResolvedValue({
        ...POLICY,
        graceEndsAt: new Date(Date.now() - 1000),
      });
      postgres.setRelayNodeStatus.mockResolvedValue(true);

      const result = await service.heartbeat('cred', '1.0.9');

      expect(result.status).toBe('decommissioned');
      expect(postgres.setRelayNodeStatus).toHaveBeenCalledWith(
        'node-1',
        'decommissioned',
        expect.stringContaining('grace period has expired')
      );
    });
  });

  describe('listPublicNodes', () => {
    it('lists only active + grace nodes, never decommissioned', async () => {
      postgres.listRelayNodes.mockResolvedValue([
        { ...NODE },
        { ...NODE, id: 'node-2', name: 'relay-grace', status: 'grace' },
      ]);

      const pool = await service.listPublicNodes();

      expect(postgres.listRelayNodes).toHaveBeenCalledWith(['active', 'grace']);
      expect(pool).toHaveLength(2);
      expect(pool[0]).not.toHaveProperty('credentialHash');
    });
  });

  describe('setPolicy', () => {
    it('mints a signed manifest verifiable against the auth JWKS', async () => {
      (authService as any).postgres = {
        getActiveSigningKeys: vi.fn().mockResolvedValue([testKey]),
      };
      postgres.upsertNetworkPolicy.mockImplementation(async (p: unknown) => p);
      postgres.listRelayNodes.mockResolvedValue([]);

      await service.setPolicy({
        currentVersion: '1.2.0',
        minSupportedVersion: '1.1.0',
        graceHours: 48,
        artifactUrl: 'https://releases.example.com/relay-1.2.0.tgz',
        artifactSha256: 'b'.repeat(64),
      });

      const manifest = postgres.upsertNetworkPolicy.mock.calls[0][0].manifest;
      expect(manifest).toBeDefined();

      const publicKey = crypto.createPublicKey(testKey.publicKey);
      const { payload } = await jwtVerify(manifest, publicKey, {
        issuer: 'test-issuer',
        audience: 'pingio-federation-manifest',
      });
      expect(payload.component).toBe('relay-server');
      expect(payload.version).toBe('1.2.0');
      expect(payload.artifact_sha256).toBe('b'.repeat(64));
    });

    it('sets a grace deadline from graceHours', async () => {
      (authService as any).postgres = {
        getActiveSigningKeys: vi.fn().mockResolvedValue([testKey]),
      };
      postgres.upsertNetworkPolicy.mockImplementation(async (p: unknown) => p);
      postgres.listRelayNodes.mockResolvedValue([]);

      const before = Date.now();
      await service.setPolicy({
        currentVersion: '2.0.0',
        minSupportedVersion: '2.0.0',
        graceHours: 24,
        artifactUrl: 'https://releases.example.com/relay-2.0.0.tgz',
        artifactSha256: 'c'.repeat(64),
      });

      const grace: Date = postgres.upsertNetworkPolicy.mock.calls[0][0].graceEndsAt;
      expect(grace.getTime()).toBeGreaterThan(before + 23 * 3600_000);
      expect(grace.getTime()).toBeLessThan(Date.now() + 25 * 3600_000);
    });

    it('recomputes node statuses immediately (stale node enters grace)', async () => {
      (authService as any).postgres = {
        getActiveSigningKeys: vi.fn().mockResolvedValue([testKey]),
      };
      postgres.upsertNetworkPolicy.mockImplementation(async (p: unknown) => p);
      postgres.listRelayNodes.mockResolvedValue([
        { ...NODE, id: 'old-node', reportedVersion: '1.0.0', status: 'active' },
      ]);
      postgres.setRelayNodeStatus.mockResolvedValue(true);

      await service.setPolicy({
        currentVersion: '1.2.0',
        minSupportedVersion: '1.1.0',
        graceHours: 72,
        artifactUrl: 'https://releases.example.com/relay-1.2.0.tgz',
        artifactSha256: 'd'.repeat(64),
      });

      expect(postgres.setRelayNodeStatus).toHaveBeenCalledWith(
        'old-node',
        'grace',
        expect.stringContaining('below minimum')
      );
    });

    it('rejects invalid input', async () => {
      await expect(service.setPolicy({
        currentVersion: '1.2',
        minSupportedVersion: '1.1.0',
        artifactUrl: 'https://x/y.tgz',
        artifactSha256: 'e'.repeat(64),
      })).rejects.toMatchObject({ code: 'invalid_params' });

      await expect(service.setPolicy({
        currentVersion: '1.2.0',
        minSupportedVersion: '1.1.0',
        artifactUrl: 'http://insecure.example.com/y.tgz', // https only
        artifactSha256: 'e'.repeat(64),
      })).rejects.toMatchObject({ code: 'invalid_params' });

      await expect(service.setPolicy({
        currentVersion: '1.2.0',
        minSupportedVersion: '1.1.0',
        artifactUrl: 'https://x/y.tgz',
        artifactSha256: 'not-hex',
      })).rejects.toMatchObject({ code: 'invalid_params' });
    });
  });

  describe('admin auth', () => {
    it('rejects calls when admin token is unset', () => {
      const noAdmin = new FederationService(postgres as any, authService, {});
      expect(() => noAdmin.assertAdmin('anything')).toThrowError(/disabled/);
    });

    it('rejects a wrong admin token and accepts the right one', () => {
      expect(() => service.assertAdmin('wrong')).toThrowError(FederationError);
      expect(() => service.assertAdmin('admin-secret')).not.toThrow();
    });
  });

  describe('node lifecycle', () => {
    it('decommissionNode marks the node with a reason', async () => {
      postgres.setRelayNodeStatus.mockResolvedValue(true);
      await service.decommissionNode('node-1', 'compromised');
      expect(postgres.setRelayNodeStatus).toHaveBeenCalledWith('node-1', 'decommissioned', 'compromised');
    });

    it('decommissionNode 404s on unknown id', async () => {
      postgres.setRelayNodeStatus.mockResolvedValue(false);
      await expect(service.decommissionNode('nope')).rejects.toMatchObject({ code: 'unknown_node' });
    });

    it('reactivateNode re-derives status from policy compliance', async () => {
      postgres.getRelayNodeById.mockResolvedValue({ ...NODE, status: 'decommissioned', reportedVersion: '1.2.0' });
      postgres.getNetworkPolicy.mockResolvedValue(POLICY);
      postgres.setRelayNodeStatus.mockResolvedValue(true);

      await service.reactivateNode('node-1');

      expect(postgres.setRelayNodeStatus).toHaveBeenCalledWith('node-1', 'active', undefined);
    });
  });
});
