import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { createRemoteJWKSet, jwtVerify } from 'jose';

/**
 * Federation auto-updater (relay side).
 *
 * The auth server pins the network's target version in a signed manifest
 * (RS256 JWT, audience 'pingio-federation-manifest'). A relay that receives
 * an update directive in its heartbeat MUST verify:
 *
 *   1. the manifest signature against the auth server's JWKS (and that the
 *      manifest's version/url/hash claims match the directive), then
 *   2. the downloaded artifact's SHA-256 against the manifest claim.
 *
 * Only then is the artifact staged to disk. The actual swap is performed by
 * the process supervisor: the relay exits with UPDATE_EXIT_CODE (75) and the
 * supervisor (wrapper script, Docker restart policy, systemd) restarts it
 * into the staged artifact. The relay never replaces its own running code.
 */

export const UPDATE_EXIT_CODE = 75;

export interface UpdateDirective {
  targetVersion: string;
  direction: 'upgrade' | 'downgrade';
  manifest: string;
  artifactUrl: string;
  artifactSha256: string;
}

export interface VerifiedManifest {
  component: string;
  version: string;
  artifact_url: string;
  artifact_sha256: string;
}

export class UpdateVerificationError extends Error {
  constructor(
    public code:
      | 'bad_signature'
      | 'claims_mismatch'
      | 'download_failed'
      | 'hash_mismatch',
    message: string
  ) {
    super(message);
    this.name = 'UpdateVerificationError';
  }
}

/**
 * Verify a manifest JWT against the auth server's JWKS. Fails closed: any
 * signature, issuer, or audience problem rejects the directive.
 */
export async function verifyManifest(
  manifest: string,
  opts: { jwksUrl: string; issuer: string; component: string }
): Promise<VerifiedManifest> {
  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
  try {
    const jwks = createRemoteJWKSet(new URL(opts.jwksUrl));
    ({ payload } = await jwtVerify(manifest, jwks, {
      issuer: opts.issuer,
      audience: 'pingio-federation-manifest',
    }));
  } catch (err) {
    throw new UpdateVerificationError(
      'bad_signature',
      `Manifest signature verification failed: ${(err as Error).message}`
    );
  }

  const verified: VerifiedManifest = {
    component: payload.component as string,
    version: payload.version as string,
    artifact_url: payload.artifact_url as string,
    artifact_sha256: payload.artifact_sha256 as string,
  };
  if (
    verified.component !== opts.component ||
    typeof verified.version !== 'string' ||
    typeof verified.artifact_url !== 'string' ||
    !/^[0-9a-f]{64}$/.test(verified.artifact_sha256 || '')
  ) {
    throw new UpdateVerificationError(
      'claims_mismatch',
      'Manifest claims are malformed or for a different component'
    );
  }
  return verified;
}

/**
 * Cross-check a heartbeat's update directive against its verified manifest —
 * the manifest is authoritative, the directive fields are hints.
 */
export function assertDirectiveMatchesManifest(
  directive: UpdateDirective,
  manifest: VerifiedManifest
): void {
  if (
    directive.targetVersion !== manifest.version ||
    directive.artifactUrl !== manifest.artifact_url ||
    directive.artifactSha256.toLowerCase() !== manifest.artifact_sha256
  ) {
    throw new UpdateVerificationError(
      'claims_mismatch',
      'Update directive does not match its signed manifest'
    );
  }
}

/**
 * Download the artifact and verify its SHA-256. Returns the staged file path.
 * `fetchFn`/`destDir` are injectable for tests.
 */
export async function downloadAndVerifyArtifact(
  artifactUrl: string,
  expectedSha256: string,
  destDir: string,
  fetchFn: typeof fetch = fetch
): Promise<string> {
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetchFn(artifactUrl);
  } catch (err) {
    throw new UpdateVerificationError(
      'download_failed',
      `Artifact download failed: ${(err as Error).message}`
    );
  }
  if (!response.ok || !response.body) {
    throw new UpdateVerificationError(
      'download_failed',
      `Artifact download returned HTTP ${response.status}`
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const actual = crypto.createHash('sha256').update(buffer).digest('hex');
  if (actual !== expectedSha256.toLowerCase()) {
    throw new UpdateVerificationError(
      'hash_mismatch',
      `Artifact SHA-256 mismatch: expected ${expectedSha256}, got ${actual}`
    );
  }

  await fs.mkdir(destDir, { recursive: true });
  const filename = path.basename(new URL(artifactUrl).pathname) || 'artifact.bin';
  const stagedPath = path.join(destDir, filename);
  await fs.writeFile(stagedPath, buffer);
  return stagedPath;
}

/**
 * Full verification pipeline for one directive. Returns the staged artifact
 * path; the caller decides when to exit into the supervisor for the swap.
 */
export async function stageUpdate(
  directive: UpdateDirective,
  opts: { jwksUrl: string; issuer: string; component: string; destDir: string },
  fetchFn?: typeof fetch
): Promise<string> {
  const manifest = await verifyManifest(directive.manifest, opts);
  assertDirectiveMatchesManifest(directive, manifest);
  return await downloadAndVerifyArtifact(
    manifest.artifact_url,
    manifest.artifact_sha256,
    opts.destDir,
    fetchFn
  );
}
