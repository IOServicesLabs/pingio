import { execFile } from 'child_process';
import {
  MAX_CONTEXT_GIT_FILES,
  MAX_CONTEXT_GIT_BRANCH_LENGTH,
  MAX_CONTEXT_GIT_STAT_LENGTH,
} from '@pingio/shared';
import type { ContextGitInfo } from '@pingio/shared';

const GIT_TIMEOUT_MS = 3000;

// Run a git command and return stdout with trailing whitespace stripped, or
// null on any failure (git not installed, not a repo, timeout). execFile (no
// shell) — args can't inject. Leading whitespace is kept: the first line of
// `git status --porcelain` begins with a significant status column.
function runGit(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) return resolve(null);
        resolve(stdout.trimEnd());
      });
    } catch {
      resolve(null);
    }
  });
}

// `git status --porcelain` lines look like ` M src/a.ts`, `?? new.ts`,
// `R  old.ts -> new.ts`. Keep the new path of renames; unquote quoted paths.
function parsePorcelain(status: string): string[] {
  const files: string[] = [];
  for (const line of status.split('\n')) {
    if (line.length < 4) continue;
    let file = line.slice(3);
    const renameIdx = file.indexOf(' -> ');
    if (renameIdx !== -1) file = file.slice(renameIdx + 4);
    if (file.startsWith('"') && file.endsWith('"')) file = file.slice(1, -1);
    files.push(file);
    if (files.length >= MAX_CONTEXT_GIT_FILES) break;
  }
  return files;
}

// Capture the local working-tree state for a context share: branch, dirty
// flag, changed file paths (capped), and a shortstat diff summary. Returns
// null when git info is unavailable — the share proceeds without it.
export async function captureGitContext(cwd: string = process.cwd()): Promise<ContextGitInfo | null> {
  const branchRaw = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const branch = branchRaw?.trim();
  if (!branch) return null;

  const [status, diffStatRaw] = await Promise.all([
    runGit(['status', '--porcelain'], cwd),
    // Staged + unstaged vs HEAD. Fails (→ null) on a repo with no commits.
    runGit(['diff', '--shortstat', 'HEAD'], cwd),
  ]);

  const changedFiles = status ? parsePorcelain(status) : [];
  const diffStat = diffStatRaw?.trim();

  return {
    branch: branch.slice(0, MAX_CONTEXT_GIT_BRANCH_LENGTH),
    dirty: changedFiles.length > 0,
    changedFiles: changedFiles.length > 0 ? changedFiles : undefined,
    diffStat: diffStat ? diffStat.slice(0, MAX_CONTEXT_GIT_STAT_LENGTH) : undefined,
  };
}
