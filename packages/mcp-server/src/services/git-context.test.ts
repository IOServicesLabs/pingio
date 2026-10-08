import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'child_process';
import { captureGitContext } from './git-context.js';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

const mockedExecFile = vi.mocked(execFile);

// Keyed by `args.join(' ')`; null means the command fails (non-zero exit,
// timeout, git not installed — all indistinguishable to the caller).
function mockGit(responses: Record<string, string | null>) {
  mockedExecFile.mockImplementation(((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
    const out = responses[args.join(' ')];
    if (out == null) {
      cb(new Error('git failed'), '');
    } else {
      cb(null, out);
    }
  }) as any);
}

describe('captureGitContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when not inside a git repo', async () => {
    mockGit({});

    const result = await captureGitContext('/tmp/nowhere');

    expect(result).toBeNull();
    // Only the branch probe runs — status/diff are skipped once it fails
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
    expect(mockedExecFile.mock.calls[0][1]).toEqual(['rev-parse', '--abbrev-ref', 'HEAD']);
  });

  it('captures branch, dirty files and diff stat', async () => {
    mockGit({
      'rev-parse --abbrev-ref HEAD': 'main\n',
      'status --porcelain': ' M src/a.ts\n?? src/new.ts\n',
      'diff --shortstat HEAD': ' 2 files changed, 10 insertions(+)\n',
    });

    const result = await captureGitContext('/repo');

    expect(result).toEqual({
      branch: 'main',
      dirty: true,
      changedFiles: ['src/a.ts', 'src/new.ts'],
      diffStat: '2 files changed, 10 insertions(+)',
    });
  });

  it('keeps the new path of renames and strips quoting', async () => {
    mockGit({
      'rev-parse --abbrev-ref HEAD': 'feature/x',
      'status --porcelain': 'R  old.ts -> new.ts\nR  "old dir/a.ts" -> "new dir/b.ts"\n',
      'diff --shortstat HEAD': null,
    });

    const result = await captureGitContext('/repo');

    expect(result?.branch).toBe('feature/x');
    expect(result?.changedFiles).toEqual(['new.ts', 'new dir/b.ts']);
  });

  it('caps the changed file list at 20 entries', async () => {
    const lines = Array.from({ length: 25 }, (_, i) => ` M file${i}.ts`).join('\n');
    mockGit({
      'rev-parse --abbrev-ref HEAD': 'main',
      'status --porcelain': lines,
      'diff --shortstat HEAD': ' 25 files changed',
    });

    const result = await captureGitContext('/repo');

    expect(result?.changedFiles).toHaveLength(20);
    expect(result?.changedFiles?.[19]).toBe('file19.ts');
  });

  it('reports a clean tree with no optional fields set', async () => {
    mockGit({
      'rev-parse --abbrev-ref HEAD': 'main\n',
      'status --porcelain': '\n',
      'diff --shortstat HEAD': '\n',
    });

    const result = await captureGitContext('/repo');

    expect(result).toEqual({ branch: 'main', dirty: false, changedFiles: undefined, diffStat: undefined });
  });

  it('still captures status when diff fails (repo with no commits)', async () => {
    mockGit({
      'rev-parse --abbrev-ref HEAD': 'main',
      'status --porcelain': '?? first.ts\n',
      'diff --shortstat HEAD': null,
    });

    const result = await captureGitContext('/repo');

    expect(result).toEqual({ branch: 'main', dirty: true, changedFiles: ['first.ts'], diffStat: undefined });
  });

  it('returns null when git is not installed (spawn error)', async () => {
    mockedExecFile.mockImplementation((() => {
      throw new Error('spawn git ENOENT');
    }) as any);

    // A synchronous spawn failure must degrade to "no git info", never crash
    // the share.
    expect(await captureGitContext('/repo')).toBeNull();
  });
});
