import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { cleanupArtifacts } from './artifact-cleanup.js';

const TEST_ARTIFACT_DIR = path.join(os.tmpdir(), `pingio-cleanup-test-${Date.now()}`);

describe('artifact cleanup', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_ARTIFACT_DIR)) {
      fs.rmSync(TEST_ARTIFACT_DIR, { recursive: true, force: true });
    }
    process.env.LOCAL_ARTIFACT_DIR = TEST_ARTIFACT_DIR;
    process.env.ARTIFACT_MAX_AGE_HOURS = '0.001'; // ~3.6 seconds for tests
  });

  afterEach(() => {
    if (fs.existsSync(TEST_ARTIFACT_DIR)) {
      fs.rmSync(TEST_ARTIFACT_DIR, { recursive: true, force: true });
    }
    delete process.env.LOCAL_ARTIFACT_DIR;
    delete process.env.ARTIFACT_MAX_AGE_HOURS;
  });

  it('removes old artifact directories', () => {
    const oldDir = path.join(TEST_ARTIFACT_DIR, 'ch-1', 'task-old');
    const newDir = path.join(TEST_ARTIFACT_DIR, 'ch-1', 'task-new');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(newDir, { recursive: true });

    fs.writeFileSync(path.join(oldDir, 'result.md'), 'old');
    fs.writeFileSync(path.join(newDir, 'result.md'), 'new');

    // Age the old file so it is older than the 3.6s test threshold
    const oldTime = new Date(Date.now() - 10000);
    fs.utimesSync(path.join(oldDir, 'result.md'), oldTime, oldTime);

    cleanupArtifacts();

    expect(fs.existsSync(oldDir)).toBe(false);
    expect(fs.existsSync(newDir)).toBe(true);
  });

  it('removes empty channel directories after cleanup', () => {
    const oldDir = path.join(TEST_ARTIFACT_DIR, 'ch-empty', 'task-old');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'result.md'), 'old');

    const oldTime = new Date(Date.now() - 10000);
    fs.utimesSync(path.join(oldDir, 'result.md'), oldTime, oldTime);

    cleanupArtifacts();

    expect(fs.existsSync(path.join(TEST_ARTIFACT_DIR, 'ch-empty'))).toBe(false);
  });
});
