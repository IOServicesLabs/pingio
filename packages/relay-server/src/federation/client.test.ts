import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import http from 'http';
import { SignJWT, exportJWK } from 'jose';
import { AddressInfo } from 'net';
import { RelayFederationClient } from './client.js';
import { UPDATE_EXIT_CODE } from './updater.js';

const makePostgres = () => ({
  getRelayNodeState: vi.fn(),
  saveRelayNodeState: vi.fn(),
  clearRelayNodeState: vi.fn(),
});

// Local HTTP server for JWKS + artifact (auto-update path uses jose's own
// fetch for JWKS, so it needs a real URL).
let server: http.Server;
let baseUrl: string;
let privateKey: crypto.KeyObject;
let artifactBytes: Buffer;
let artifactSha256: string;

beforeAll(async () => {
  const pair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  privateKey = crypto.createPrivateKey(pair.privateKey);
  const publicJwk = {
    ...(await exportJWK(crypto.createPublicKey(pair.publicKey))),
    kid: 'test-kid',
    alg: 'RS256',
    use: 'sig',
  };
  artifactBytes = Buffer.from('relay tarball');
  artifactSha256 = crypto.createHash('sha256').update(artifactBytes).digest('hex');

  server = http.createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [publicJwk] }));
    } else if (req.url === '/artifacts/relay-1.2.0.tgz') {
      res.end(artifactBytes);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

async function signManifest(issuer: string): Promise<string> {
  return await new SignJWT({
    component: 'relay-server',
    version: '1.2.0',
    artifact_url: `${baseUrl}/artifacts/relay-1.2.0.tgz`,
    artifact_sha256: artifactSha256,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience('pingio-federation-manifest')
    .setIssuedAt()
    .sign(privateKey);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function mockFetch(routes: Record<string, (init?: RequestInit) => object>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    for (const [prefix, handler] of Object.entries(routes)) {
      if (u.startsWith(prefix)) {
        const body = handler(init) as { _status?: number };
        const { _status, ...rest } = body;
        return new Response(JSON.stringify(rest), {
          status: _status || 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    // Unmocked URLs (JWKS, artifact downloads) hit the real local server.
    return fetch(url as string, init);
  }) as unknown as typeof fetch;
}

function makeClient(
  postgres: ReturnType<typeof makePostgres>,
  fetchFn: typeof fetch,
  overrides: Record<string, unknown> = {}
) {
  const logs: string[] = [];
  const exits: number[] = [];
  const client = new RelayFederationClient(postgres as any, {
    authEndpoint: baseUrl,
    nodeName: 'relay-test',
    baseUrl: 'https://relay.example.com',
    wsUrl: 'wss://relay.example.com/ws',
    bootstrapToken: 'boot-secret',
    version: '1.1.0',
    heartbeatSeconds: 3600, // loop never fires during a test
    autoUpdate: false,
    logger: (msg: string) => logs.push(msg),
    fetchFn,
    exitFn: (code: number) => exits.push(code),
    ...overrides,
  });
  return { client, logs, exits };
}

describe('RelayFederationClient', () => {
  let postgres: ReturnType<typeof makePostgres>;

  beforeEach(() => {
    vi.clearAllMocks();
    postgres = makePostgres();
    postgres.saveRelayNodeState.mockResolvedValue(undefined);
  });

  it('registers on first start and persists the credential', async () => {
    postgres.getRelayNodeState.mockResolvedValue(null);
    const fetchFn = mockFetch({
      [`${baseUrl}/api/federation/register`]: () => ({
        success: true,
        nodeId: 'node-1',
        credential: 'cred-1',
        status: 'active',
      }),
      [`${baseUrl}/api/federation/heartbeat`]: () => ({ success: true, status: 'active' }),
    });
    const { client, logs } = makeClient(postgres, fetchFn);

    await client.start();
    client.stop();

    const registerCall = (fetchFn as any).mock.calls.find((c: unknown[]) =>
      String(c[0]).includes('/register')
    );
    expect(registerCall).toBeDefined();
    const body = JSON.parse(registerCall[1].body as string);
    expect(body).toMatchObject({
      name: 'relay-test',
      baseUrl: 'https://relay.example.com',
      bootstrapToken: 'boot-secret',
      version: '1.1.0',
    });
    expect(postgres.saveRelayNodeState).toHaveBeenCalledWith('node-1', 'cred-1');
    expect(logs.some(l => l.includes('registered with federation'))).toBe(true);
  });

  it('skips registration when state already exists and heartbeats with the credential', async () => {
    postgres.getRelayNodeState.mockResolvedValue({ nodeId: 'node-9', credential: 'cred-9' });
    const fetchFn = mockFetch({
      [`${baseUrl}/api/federation/heartbeat`]: () => ({ success: true, status: 'active' }),
    });
    const { client } = makeClient(postgres, fetchFn);

    await client.start();
    client.stop();

    expect((fetchFn as any).mock.calls.some((c: unknown[]) => String(c[0]).includes('/register'))).toBe(false);
    const hb = (fetchFn as any).mock.calls.find((c: unknown[]) => String(c[0]).includes('/heartbeat'));
    expect(hb[1].headers.authorization).toBe('Bearer cred-9');
    expect(JSON.parse(hb[1].body as string).version).toBe('1.1.0');
  });

  it('warns loudly when the node enters grace', async () => {
    postgres.getRelayNodeState.mockResolvedValue({ nodeId: 'node-1', credential: 'cred-1' });
    const fetchFn = mockFetch({
      [`${baseUrl}/api/federation/heartbeat`]: () => ({
        success: true,
        status: 'grace',
        statusReason: 'Version 1.1.0 is below minimum 1.2.0',
      }),
    });
    const { client, logs } = makeClient(postgres, fetchFn);

    await client.start();
    client.stop();

    expect(client.isDecommissioned()).toBe(false);
    expect(logs.some(l => l.includes('WARNING') && l.includes('below minimum'))).toBe(true);
  });

  it('refuses new connections when decommissioned', async () => {
    postgres.getRelayNodeState.mockResolvedValue({ nodeId: 'node-1', credential: 'cred-1' });
    const fetchFn = mockFetch({
      [`${baseUrl}/api/federation/heartbeat`]: () => ({
        success: true,
        status: 'decommissioned',
        statusReason: 'grace period expired',
      }),
    });
    const { client, logs } = makeClient(postgres, fetchFn);

    await client.start();
    client.stop();

    expect(client.isDecommissioned()).toBe(true);
    expect(client.getStatus().status).toBe('decommissioned');
    expect(logs.some(l => l.includes('DECOMMISSIONED'))).toBe(true);
  });

  it('treats a 403 heartbeat as deactivation by the control plane', async () => {
    postgres.getRelayNodeState.mockResolvedValue({ nodeId: 'node-1', credential: 'stale-cred' });
    const fetchFn = mockFetch({
      [`${baseUrl}/api/federation/heartbeat`]: () => ({
        _status: 403,
        success: false,
        error: 'Unknown node credential',
      }),
    });
    const { client } = makeClient(postgres, fetchFn);

    await client.start();
    client.stop();

    expect(client.isDecommissioned()).toBe(true);
  });

  it('logs but does not apply updates when autoUpdate is off', async () => {
    postgres.getRelayNodeState.mockResolvedValue({ nodeId: 'node-1', credential: 'cred-1' });
    const manifest = await signManifest(baseUrl);
    const fetchFn = mockFetch({
      [`${baseUrl}/api/federation/heartbeat`]: () => ({
        success: true,
        status: 'active',
        policy: { currentVersion: '1.2.0' },
        update: {
          targetVersion: '1.2.0',
          direction: 'upgrade',
          manifest,
          artifactUrl: `${baseUrl}/artifacts/relay-1.2.0.tgz`,
          artifactSha256: artifactSha256,
        },
      }),
    });
    const { client, logs, exits } = makeClient(postgres, fetchFn);

    await client.start();
    client.stop();
    await sleep(700);

    expect(logs.some(l => l.includes('upgrade available') && l.includes('FEDERATION_AUTO_UPDATE'))).toBe(true);
    expect(exits).toHaveLength(0);
  });

  it('stages a valid signed update and exits for the supervisor', async () => {
    postgres.getRelayNodeState.mockResolvedValue({ nodeId: 'node-1', credential: 'cred-1' });
    const manifest = await signManifest(baseUrl);
    const fetchFn = mockFetch({
      [`${baseUrl}/api/federation/heartbeat`]: () => ({
        success: true,
        status: 'active',
        update: {
          targetVersion: '1.2.0',
          direction: 'upgrade',
          manifest,
          artifactUrl: `${baseUrl}/artifacts/relay-1.2.0.tgz`,
          artifactSha256: artifactSha256,
        },
      }),
    });
    const { client, logs, exits } = makeClient(postgres, fetchFn, { autoUpdate: true });

    await client.start();
    client.stop();
    await sleep(700);

    expect(exits, JSON.stringify(logs, null, 2)).toEqual([UPDATE_EXIT_CODE]);
  });

  it('rejects a badly-signed update and keeps running', async () => {
    postgres.getRelayNodeState.mockResolvedValue({ nodeId: 'node-1', credential: 'cred-1' });
    const other = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const evilManifest = await new SignJWT({
      component: 'relay-server',
      version: '1.2.0',
      artifact_url: `${baseUrl}/artifacts/relay-1.2.0.tgz`,
      artifact_sha256: artifactSha256,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' })
      .setIssuer(baseUrl)
      .setAudience('pingio-federation-manifest')
      .sign(crypto.createPrivateKey(other.privateKey));
    const fetchFn = mockFetch({
      [`${baseUrl}/api/federation/heartbeat`]: () => ({
        success: true,
        status: 'active',
        update: {
          targetVersion: '1.2.0',
          direction: 'upgrade',
          manifest: evilManifest,
          artifactUrl: `${baseUrl}/artifacts/relay-1.2.0.tgz`,
          artifactSha256: artifactSha256,
        },
      }),
    });
    const { client, logs, exits } = makeClient(postgres, fetchFn, { autoUpdate: true });

    await client.start();
    client.stop();
    await sleep(700);

    expect(exits).toHaveLength(0);
    expect(logs.some(l => l.includes('update rejected'))).toBe(true);
    expect(client.isDecommissioned()).toBe(false);
  });
});
