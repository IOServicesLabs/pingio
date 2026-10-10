import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import http from 'http';
import { SignJWT, exportJWK } from 'jose';
import { AddressInfo } from 'net';
import {
  verifyManifest,
  assertDirectiveMatchesManifest,
  downloadAndVerifyArtifact,
  stageUpdate,
  UpdateVerificationError,
  UpdateDirective,
} from './updater.js';

const ISSUER = 'https://auth.example.com';
const COMPONENT = 'relay-server';

// Real local HTTP server: createRemoteJWKSet fetches over HTTP, and so does
// the artifact download — this exercises the full verification path.
let server: http.Server;
let baseUrl: string;
let artifactBytes: Buffer;
let artifactSha256: string;
let publicJwk: object;
let privateKey: crypto.KeyObject;

async function signManifest(claims: Record<string, unknown>, kid = 'test-kid'): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience('pingio-federation-manifest')
    .setIssuedAt()
    .sign(privateKey);
}

function makeDirective(overrides: Partial<UpdateDirective> = {}): UpdateDirective {
  return {
    targetVersion: '1.2.0',
    direction: 'upgrade',
    manifest: '',
    artifactUrl: `${baseUrl}/artifacts/relay-1.2.0.tgz`,
    artifactSha256: artifactSha256,
    ...overrides,
  };
}

const validClaims = () => ({
  component: COMPONENT,
  version: '1.2.0',
  artifact_url: `${baseUrl}/artifacts/relay-1.2.0.tgz`,
  artifact_sha256: artifactSha256,
});

beforeAll(async () => {
  const pair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  privateKey = crypto.createPrivateKey(pair.privateKey);
  publicJwk = {
    ...(await exportJWK(crypto.createPublicKey(pair.publicKey))),
    kid: 'test-kid',
    alg: 'RS256',
    use: 'sig',
  };

  artifactBytes = Buffer.from('fake relay-server tarball contents');
  artifactSha256 = crypto.createHash('sha256').update(artifactBytes).digest('hex');

  server = http.createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [publicJwk] }));
    } else if (req.url === '/artifacts/relay-1.2.0.tgz') {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(artifactBytes);
    } else {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

describe('verifyManifest', () => {
  it('verifies a properly signed manifest', async () => {
    const manifest = await signManifest(validClaims());
    const verified = await verifyManifest(manifest, {
      jwksUrl: `${baseUrl}/.well-known/jwks.json`,
      issuer: ISSUER,
      component: COMPONENT,
    });
    expect(verified.version).toBe('1.2.0');
    expect(verified.artifact_sha256).toBe(artifactSha256);
  });

  it('rejects a tampered manifest (bad signature)', async () => {
    const manifest = await signManifest(validClaims());
    const tampered = manifest.slice(0, -8) + 'AAAAAAA=';
    await expect(
      verifyManifest(tampered, {
        jwksUrl: `${baseUrl}/.well-known/jwks.json`,
        issuer: ISSUER,
        component: COMPONENT,
      })
    ).rejects.toMatchObject({ code: 'bad_signature' });
  });

  it('rejects a manifest signed by a different key', async () => {
    const other = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const evil = await new SignJWT(validClaims())
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience('pingio-federation-manifest')
      .sign(crypto.createPrivateKey(other.privateKey));
    await expect(
      verifyManifest(evil, {
        jwksUrl: `${baseUrl}/.well-known/jwks.json`,
        issuer: ISSUER,
        component: COMPONENT,
      })
    ).rejects.toMatchObject({ code: 'bad_signature' });
  });

  it('rejects a manifest for the wrong component', async () => {
    const manifest = await signManifest({ ...validClaims(), component: 'auth-server' });
    await expect(
      verifyManifest(manifest, {
        jwksUrl: `${baseUrl}/.well-known/jwks.json`,
        issuer: ISSUER,
        component: COMPONENT,
      })
    ).rejects.toMatchObject({ code: 'claims_mismatch' });
  });
});

describe('assertDirectiveMatchesManifest', () => {
  it('accepts a directive matching the manifest', async () => {
    const verified = await verifyManifest(await signManifest(validClaims()), {
      jwksUrl: `${baseUrl}/.well-known/jwks.json`,
      issuer: ISSUER,
      component: COMPONENT,
    });
    expect(() => assertDirectiveMatchesManifest(makeDirective(), verified)).not.toThrow();
  });

  it('rejects a directive whose URL was swapped post-signature', async () => {
    const verified = await verifyManifest(await signManifest(validClaims()), {
      jwksUrl: `${baseUrl}/.well-known/jwks.json`,
      issuer: ISSUER,
      component: COMPONENT,
    });
    const evil = makeDirective({ artifactUrl: 'https://evil.example.com/backdoor.tgz' });
    expect(() => assertDirectiveMatchesManifest(evil, verified)).toThrowError(UpdateVerificationError);
  });
});

describe('downloadAndVerifyArtifact', () => {
  it('downloads, verifies the hash, and stages the file', async () => {
    const destDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pingio-update-test-'));
    const staged = await downloadAndVerifyArtifact(
      `${baseUrl}/artifacts/relay-1.2.0.tgz`,
      artifactSha256,
      destDir
    );
    const contents = await fs.readFile(staged);
    expect(contents.equals(artifactBytes)).toBe(true);
    await fs.rm(destDir, { recursive: true, force: true });
  });

  it('rejects an artifact whose hash does not match', async () => {
    const destDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pingio-update-test-'));
    await expect(
      downloadAndVerifyArtifact(`${baseUrl}/artifacts/relay-1.2.0.tgz`, 'f'.repeat(64), destDir)
    ).rejects.toMatchObject({ code: 'hash_mismatch' });
    await fs.rm(destDir, { recursive: true, force: true });
  });

  it('rejects a failed download', async () => {
    const destDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pingio-update-test-'));
    await expect(
      downloadAndVerifyArtifact(`${baseUrl}/artifacts/missing.tgz`, artifactSha256, destDir)
    ).rejects.toMatchObject({ code: 'download_failed' });
    await fs.rm(destDir, { recursive: true, force: true });
  });
});

describe('stageUpdate (full pipeline)', () => {
  it('verifies signature + directive + artifact end to end', async () => {
    const directive = makeDirective({ manifest: await signManifest(validClaims()) });
    const destDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pingio-update-test-'));
    const staged = await stageUpdate(directive, {
      jwksUrl: `${baseUrl}/.well-known/jwks.json`,
      issuer: ISSUER,
      component: COMPONENT,
      destDir,
    });
    expect(await fs.readFile(staged)).toEqual(artifactBytes);
    await fs.rm(destDir, { recursive: true, force: true });
  });

  it('never stages when the signature is invalid, even with a valid artifact', async () => {
    const other = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const evilManifest = await new SignJWT(validClaims())
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience('pingio-federation-manifest')
      .sign(crypto.createPrivateKey(other.privateKey));
    const directive = makeDirective({ manifest: evilManifest });
    const destDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pingio-update-test-'));
    await expect(
      stageUpdate(directive, {
        jwksUrl: `${baseUrl}/.well-known/jwks.json`,
        issuer: ISSUER,
        component: COMPONENT,
        destDir,
      })
    ).rejects.toMatchObject({ code: 'bad_signature' });
    // Nothing staged
    expect(await fs.readdir(destDir)).toHaveLength(0);
    await fs.rm(destDir, { recursive: true, force: true });
  });
});
