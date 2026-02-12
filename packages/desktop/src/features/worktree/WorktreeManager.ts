import { join, posix } from 'path';
import { mkdir, stat } from 'fs/promises';
import { withLock } from '../../infrastructure/utils/mutex';
import type { GitExecutor, GitOperationType } from '../../executors/git';

type WorktreeListEntry = {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
};

export class WorktreeManager {
  private projectsCache: Map<string, { baseDir: string }> = new Map();

  constructor(private gitExecutor: GitExecutor) {}

  private async runGit(args: {
    sessionId?: string;
    cwd: string;
    argv: string[];
    op: GitOperationType;
    treatAsSuccessIfOutputIncludes?: string[];
    throwOnError?: boolean;
    meta?: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const kind =
      args.argv[0] === 'git' && args.argv[1] === 'worktree'
        ? 'worktree.command'
        : 'git.command';
    const res = await this.gitExecutor.run({
      sessionId: args.sessionId,
      cwd: args.cwd,
      argv: args.argv,
      timeoutMs: args.timeoutMs,
      kind,
      op: args.op,
      treatAsSuccessIfOutputIncludes: args.treatAsSuccessIfOutputIncludes,
      throwOnError: args.throwOnError,
      meta: args.meta,
    });
    return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode };
  }

  private getProjectPaths(projectPath: string, worktreeFolder?: string) {
    const cacheKey = `${projectPath}:${worktreeFolder || 'worktrees'}`;
    if (!this.projectsCache.has(cacheKey)) {
      const folderName = worktreeFolder || 'worktrees';
      const isAbsolute = Boolean(worktreeFolder && (worktreeFolder.startsWith('/') || worktreeFolder.includes(':')));
      const joinFn = projectPath.startsWith('/') ? posix.join : join;
      const baseDir = isAbsolute ? folderName : joinFn(projectPath, folderName);
      this.projectsCache.set(cacheKey, { baseDir });
    }
    return this.projectsCache.get(cacheKey)!;
  }

  async initializeProject(projectPath: string, worktreeFolder?: string): Promise<void> {
    const { baseDir } = this.getProjectPaths(projectPath, worktreeFolder);
    await this.ensureBaseDir(projectPath, baseDir);
  }

  private async ensureBaseDir(projectPath: string, baseDir: string, sessionId?: string): Promise<void> {
    try {
      await mkdir(baseDir, { recursive: true });
      return;
    } catch {
      // The path may be remote or unavailable locally. Try creating it via command execution.
    }

    try {
      await this.runGit({
        sessionId,
        cwd: projectPath,
        argv: ['mkdir', '-p', baseDir],
        op: 'write',
        throwOnError: false,
        meta: { source: 'worktree', operation: 'mkdir-base-dir', baseDir },
      });
    } catch {
      // Best effort: subsequent git commands will provide clearer errors if creation truly failed.
    }
  }

  async createWorktree(
    projectPath: string,
    name: string,
    branch?: string,
    baseBranch?: string,
    worktreeFolder?: string,
    sessionId?: string
  ): Promise<{ worktreePath: string; baseCommit: string; baseBranch: string; branchName: string }> {
    return await withLock(`worktree-create-${projectPath}-${name}`, async () => {
      const { baseDir } = this.getProjectPaths(projectPath, worktreeFolder);
      await this.ensureBaseDir(projectPath, baseDir, sessionId);

      const joinFn = baseDir.startsWith('/') ? posix.join : join;
      const worktreePath = joinFn(baseDir, name);
      const branchName = branch || name;

      // Ensure we have a git repo. If not, initialize and create an initial commit.
      try {
        await this.runGit({
          sessionId,
          cwd: projectPath,
          argv: ['git', 'rev-parse', '--is-inside-work-tree'],
          op: 'read',
          meta: { source: 'worktree', worktreeName: name, phase: 'probe' },
        });
      } catch {
        await this.runGit({
          sessionId,
          cwd: projectPath,
          argv: ['git', 'init'],
          op: 'write',
          meta: { source: 'worktree', worktreeName: name, phase: 'init' },
        });
      }

      // Best-effort cleanup (in case a previous worktree exists at this path)
      try {
        await this.runGit({
          sessionId,
          cwd: projectPath,
          argv: ['git', 'worktree', 'remove', worktreePath, '--force'],
          op: 'write',
          treatAsSuccessIfOutputIncludes: ['is not a working tree'],
          meta: { source: 'worktree', worktreeName: name, phase: 'cleanup' },
        });
      } catch {
        // ignore
      }

      // Ensure repo has at least one commit (needed for worktree add on some setups).
      try {
        await this.runGit({
          sessionId,
          cwd: projectPath,
          argv: ['git', 'rev-parse', 'HEAD'],
          op: 'read',
          meta: { source: 'worktree', worktreeName: name, phase: 'has-commits' },
        });
      } catch {
        try {
          await this.runGit({
            sessionId,
            cwd: projectPath,
            argv: ['git', 'add', '-A'],
            op: 'write',
            meta: { source: 'worktree', worktreeName: name, phase: 'initial-commit' },
          });
        } catch {
          // ignore
        }
        await this.runGit({
          sessionId,
          cwd: projectPath,
          argv: ['git', 'commit', '-m', 'Initial commit', '--allow-empty'],
          op: 'write',
          meta: { source: 'worktree', worktreeName: name, phase: 'initial-commit' },
        });
      }

      // Always base new workspaces on the latest remote default branch when origin exists.
      let originExists = false;
      try {
        await this.runGit({ cwd: projectPath, argv: ['git', 'remote', 'get-url', 'origin'], op: 'read' });
        originExists = true;
      } catch {
        originExists = false;
      }

      if (originExists) {
        await this.runGit({
          sessionId,
          cwd: projectPath,
          argv: ['git', 'fetch', 'origin'],
          op: 'write',
          meta: { source: 'worktree', worktreeName: name, phase: 'fetch' },
        });
      }

      // Determine base branch (prefer origin/HEAD, then origin/main|master, then local HEAD).
      let mainBranchName = baseBranch;
      if (!mainBranchName) {
        if (originExists) {
          try {
            const remoteHead = (
              await this.runGit({ cwd: projectPath, argv: ['git', 'symbolic-ref', 'refs/remotes/origin/HEAD'], op: 'read' })
            ).stdout.trim();
            mainBranchName = remoteHead.replace('refs/remotes/origin/', '').trim();
          } catch {
            // ignore
          }
          if (!mainBranchName) {
            for (const candidate of ['main', 'master']) {
              try {
                await this.runGit({
                  cwd: projectPath,
                  argv: ['git', 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${candidate}`],
                  op: 'read',
                });
                mainBranchName = candidate;
                break;
              } catch {
                // Try next candidate
              }
            }
          }
        }

        if (!mainBranchName) {
          try {
            mainBranchName = (await this.runGit({ cwd: projectPath, argv: ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], op: 'read' })).stdout
              .trim();
          } catch {
            mainBranchName = 'main';
          }
        }
      }

      const actualBaseBranch = mainBranchName;
      let baseRef = originExists ? `origin/${mainBranchName}` : mainBranchName;

      if (originExists) {
        await this.runGit({
          cwd: projectPath,
          argv: ['git', 'rev-parse', '--verify', `${baseRef}^{commit}`],
          op: 'read',
        });
      } else {
        try {
          await this.runGit({
            cwd: projectPath,
            argv: ['git', 'show-ref', '--verify', '--quiet', `refs/heads/${mainBranchName}`],
            op: 'read',
          });
        } catch {
          baseRef = 'HEAD';
        }
      }

      // Ensure we create a fresh branch for this workspace.
      const branchCheckResult = await this.runGit({
        cwd: projectPath,
        argv: ['git', 'show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
        op: 'read',
        throwOnError: false,
      });
      if (branchCheckResult.exitCode === 0) {
        throw new Error(`Branch already exists: ${branchName}`);
      }

      const baseCommit = (await this.runGit({ cwd: projectPath, argv: ['git', 'rev-parse', baseRef], op: 'read' })).stdout.trim();

      await this.runGit({
        sessionId,
        cwd: projectPath,
        argv: ['git', 'worktree', 'add', '-b', branchName, worktreePath, baseRef],
        op: 'write',
        meta: { source: 'worktree', worktreeName: name, phase: 'worktree-add', branch: branchName, base: baseRef },
      });

      return { worktreePath, baseCommit, baseBranch: actualBaseBranch, branchName };
    });
  }

  async removeWorktreePath(projectPath: string, worktreePath: string, sessionId?: string): Promise<void> {
    await withLock(`worktree-remove-${worktreePath}`, async () => {
      await this.runGit({
        sessionId,
        cwd: projectPath,
        argv: ['git', 'worktree', 'remove', worktreePath, '--force'],
        op: 'write',
        treatAsSuccessIfOutputIncludes: ['is not a working tree'],
        meta: { source: 'worktree', operation: 'remove', worktreePath },
      });
    });
  }

  private async listWorktrees(projectPath: string, sessionId?: string): Promise<WorktreeListEntry[]> {
    const { stdout } = await this.runGit({
      sessionId,
      cwd: projectPath,
      argv: ['git', 'worktree', 'list', '--porcelain'],
      op: 'read',
      meta: { source: 'worktree', operation: 'list' },
    });

    const out: WorktreeListEntry[] = [];
    let current: WorktreeListEntry | null = null;

    const flush = () => {
      if (current?.path) out.push(current);
      current = null;
    };

    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.trimEnd();
      if (!line) continue;
      if (line.startsWith('worktree ')) {
        flush();
        current = {
          path: line.slice('worktree '.length).trim(),
          head: '',
          branch: null,
          detached: false,
          locked: false,
          prunable: false,
        };
        continue;
      }
      if (!current) continue;
      if (line.startsWith('HEAD ')) {
        current.head = line.slice('HEAD '.length).trim();
        continue;
      }
      if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim();
        current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
        continue;
      }
      if (line === 'detached') {
        current.detached = true;
        continue;
      }
      if (line.startsWith('locked')) {
        current.locked = true;
        continue;
      }
      if (line.startsWith('prunable')) {
        current.prunable = true;
        continue;
      }
    }
    flush();

    return out;
  }

  async listWorktreesDetailed(projectPath: string, sessionId?: string): Promise<
    Array<
      WorktreeListEntry & {
        isMain: boolean;
        hasChanges: boolean;
        createdAt: string | null;
        lastCommitAt: string | null;
        additions: number;
        deletions: number;
        filesChanged: number;
      }
    >
  > {
    const list = await this.listWorktrees(projectPath, sessionId);
    const normalizedProjectPath = projectPath.replace(/\/+$/, '');

    const detailed: Array<
      WorktreeListEntry & {
        isMain: boolean;
        hasChanges: boolean;
        createdAt: string | null;
        lastCommitAt: string | null;
        additions: number;
        deletions: number;
        filesChanged: number;
      }
    > = [];

    for (const entry of list) {
      const isMain = entry.path.replace(/\/+$/, '') === normalizedProjectPath;
      let createdAt: string | null = null;

      try {
        const gitMetaPath = join(entry.path, '.git');
        const st = await stat(gitMetaPath);
        const ms = st.birthtimeMs && st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs || st.mtimeMs;
        createdAt = ms ? new Date(ms).toISOString() : null;
      } catch {
        createdAt = null;
      }

      let hasChanges = false;
      try {
        const { stdout: statusOut } = await this.runGit({
          sessionId,
          cwd: entry.path,
          argv: ['git', 'status', '--porcelain'],
          op: 'read',
          meta: { source: 'worktree', operation: 'status', worktreePath: entry.path },
        });
        hasChanges = statusOut.trim().length > 0;
      } catch {
        hasChanges = false;
      }

      let filesChanged = 0;
      let additions = 0;
      let deletions = 0;
      try {
        const { stdout: shortstatOut } = await this.runGit({
          sessionId,
          cwd: entry.path,
          argv: ['git', 'diff', '--shortstat'],
          op: 'read',
          meta: { source: 'worktree', operation: 'diff-shortstat', worktreePath: entry.path },
        });
        const s = shortstatOut.trim();
        if (s) {
          const files = s.match(/(\d+)\s+files?\s+changed/);
          const ins = s.match(/(\d+)\s+insertions?\(\+\)/);
          const del = s.match(/(\d+)\s+deletions?\(-\)/);
          filesChanged = files ? Number(files[1]) : 0;
          additions = ins ? Number(ins[1]) : 0;
          deletions = del ? Number(del[1]) : 0;
        }
      } catch {
        filesChanged = 0;
        additions = 0;
        deletions = 0;
      }

      let lastCommitAt: string | null = null;
      try {
        const { stdout: lastCommit } = await this.runGit({
          sessionId,
          cwd: entry.path,
          argv: ['git', 'log', '-1', '--format=%ci'],
          op: 'read',
          meta: { source: 'worktree', operation: 'last-commit', worktreePath: entry.path },
        });
        const value = lastCommit.trim();
        lastCommitAt = value ? value : null;
      } catch {
        lastCommitAt = null;
      }

      detailed.push({
        ...entry,
        isMain,
        hasChanges,
        createdAt,
        lastCommitAt,
        additions,
        deletions,
        filesChanged,
      });
    }

    return detailed;
  }

  async getProjectMainBranch(projectPath: string, sessionId?: string): Promise<string> {
    const currentBranchResult = await this.runGit({
      sessionId,
      cwd: projectPath,
      argv: ['git', 'branch', '--show-current'],
      op: 'read',
      meta: { source: 'worktree', operation: 'main-branch' },
    });
    const currentBranch = currentBranchResult.stdout.trim();
    if (currentBranch) return currentBranch;
    throw new Error(`Cannot determine main branch: repository at ${projectPath} is in detached HEAD state`);
  }
}
