import fs from 'fs';
import path from 'path';
import os from 'os';

const DEFAULT_ARTIFACT_DIR = path.join(os.homedir(), '.pingio', 'artifacts');

function getArtifactDir(): string {
  return process.env.LOCAL_ARTIFACT_DIR || DEFAULT_ARTIFACT_DIR;
}

function getMaxAgeMs(): number {
  const hours = parseFloat(process.env.ARTIFACT_MAX_AGE_HOURS || '24');
  return hours * 60 * 60 * 1000;
}

function getIntervalMs(): number {
  const hours = parseFloat(process.env.ARTIFACT_CLEANUP_INTERVAL_HOURS || '1');
  return hours * 60 * 60 * 1000;
}

function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    console.error(`Failed to remove artifact directory ${dir}:`, (error as Error).message);
  }
}

export function cleanupArtifacts(): void {
  const artifactDir = getArtifactDir();
  const maxAge = getMaxAgeMs();
  const now = Date.now();

  if (!fs.existsSync(artifactDir)) return;

  const channelEntries = fs.readdirSync(artifactDir, { withFileTypes: true });
  for (const channelEntry of channelEntries) {
    if (!channelEntry.isDirectory()) continue;

    const channelDir = path.join(artifactDir, channelEntry.name);
    const taskEntries = fs.readdirSync(channelDir, { withFileTypes: true });

    for (const taskEntry of taskEntries) {
      if (!taskEntry.isDirectory()) continue;

      const taskDir = path.join(channelDir, taskEntry.name);
      try {
        const oldestMtime = getOldestFileMtime(taskDir);
        if (oldestMtime !== null && now - oldestMtime > maxAge) {
          removeDir(taskDir);
        }
      } catch (error) {
        console.error(`Failed to inspect artifact directory ${taskDir}:`, (error as Error).message);
      }
    }

    // Remove empty channel directories
    try {
      const remaining = fs.readdirSync(channelDir);
      if (remaining.length === 0) {
        removeDir(channelDir);
      }
    } catch (error) {
      // Channel dir may have already been removed
    }
  }
}

function getOldestFileMtime(dir: string): number | null {
  let oldest: number | null = null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const childOldest = getOldestFileMtime(entryPath);
      if (childOldest !== null && (oldest === null || childOldest < oldest)) {
        oldest = childOldest;
      }
    } else {
      const stats = fs.statSync(entryPath);
      if (oldest === null || stats.mtime.getTime() < oldest) {
        oldest = stats.mtime.getTime();
      }
    }
  }
  return oldest;
}

export function startArtifactCleanup(): void {
  const intervalMs = getIntervalMs();
  if (intervalMs <= 0) return;

  // Run once shortly after startup, then on interval
  setTimeout(() => {
    cleanupArtifacts();
    setInterval(cleanupArtifacts, intervalMs);
  }, 5000);
}
