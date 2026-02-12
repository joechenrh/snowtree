import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { getShellPath } from '../../infrastructure/command/shellPath';
import { escapeShellArg } from '../../infrastructure/security/shellEscape';
import type { SessionManager } from '../../features/session/SessionManager';
import type { TimelineEvent } from '../../infrastructure/database/models';
import type { Project } from '../../infrastructure/database/models';

export type GitCommandKind = 'git.command' | 'worktree.command';

export type GitOperationType = 'read' | 'write';

export type GitRunOptions = {
  sessionId?: string | null;
  cwd: string;
  argv: string[];
  timeoutMs?: number;
  kind?: GitCommandKind;
  op?: GitOperationType;
  recordTimeline?: boolean;
  treatAsSuccessIfOutputIncludes?: string[];
  throwOnError?: boolean;
  meta?: Record<string, unknown>;
};

export type GitRunResult = {
  commandDisplay: string;
  commandCopy: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  operationId: string;
};

const isSimpleToken = (token: string) => /^[A-Za-z0-9_./:@%+=,-]+$/.test(token);

const formatCommandForDisplay = (argv: string[]): string =>
  argv.map((t) => (isSimpleToken(t) ? t : escapeShellArg(t))).join(' ');

const formatCommandForCopy = (argv: string[]): string => argv.map(escapeShellArg).join(' ');

type RemoteProjectContext = {
  host: string;
  user: string | null;
  port: number | null;
  authType: 'ssh-agent' | 'keyfile' | null;
  keyPath: string | null;
};

export class GitExecutor {
  constructor(private sessionManager: SessionManager) {}

  private resolveProjectForRun(options: GitRunOptions): Project | undefined {
    if (options.sessionId) {
      return this.sessionManager.getProjectForSession(options.sessionId);
    }
    return this.sessionManager.getProjectForPath(options.cwd);
  }

  private getRemoteProjectContext(project: Project | undefined): RemoteProjectContext | null {
    if (!project || project.location_type !== 'remote') return null;

    const host = String(project.remote_host || '').trim();
    if (!host) {
      throw new Error('Remote project is missing host configuration');
    }

    const port = typeof project.remote_port === 'number' && Number.isFinite(project.remote_port)
      ? project.remote_port
      : null;
    const authType = project.remote_auth_type || null;
    const keyPath = typeof project.remote_key_path === 'string' && project.remote_key_path.trim()
      ? project.remote_key_path.trim()
      : null;
    const user = typeof project.remote_user === 'string' && project.remote_user.trim()
      ? project.remote_user.trim()
      : null;

    return { host, user, port, authType, keyPath };
  }

  private buildSshSpawn(remote: RemoteProjectContext, cwd: string, argv: string[]): { cmd: string; args: string[]; cwd: string } {
    const sshArgs: string[] = ['-o', 'BatchMode=yes'];

    if (typeof remote.port === 'number' && remote.port > 0) {
      sshArgs.push('-p', String(remote.port));
    }
    if (remote.authType === 'keyfile' && remote.keyPath) {
      sshArgs.push('-i', remote.keyPath);
    }

    const target = remote.user ? `${remote.user}@${remote.host}` : remote.host;
    const remoteCommand = `cd ${escapeShellArg(cwd)} && ${formatCommandForCopy(argv)}`;
    sshArgs.push(target, 'sh', '-lc', remoteCommand);

    return {
      cmd: 'ssh',
      args: sshArgs,
      cwd: process.cwd(),
    };
  }

  async run(options: GitRunOptions): Promise<GitRunResult> {
    const argv = options.argv || [];
    if (argv.length === 0) throw new Error('GitExecutor.run requires argv');

    const commandDisplay = formatCommandForDisplay(argv);
    const commandCopy = formatCommandForCopy(argv);
    const operationId = randomUUID();
    const startMs = Date.now();
    const kind: GitCommandKind = options.kind || 'git.command';
    // Default: only record git/worktree commands that mutate state (user-visible actions).
    // This keeps Conversations focused on explicit operations (e.g. create/rename/remove worktree),
    // and avoids spamming the timeline with background reads (status/diff/log for UI refresh).
    const recordTimeline = Boolean(options.sessionId) && (options.recordTimeline ?? options.op === 'write');
    const project = this.resolveProjectForRun(options);
    const remote = this.getRemoteProjectContext(project);
    const meta = {
      ...(options.meta || {}),
      operationId,
      argv,
      op: options.op,
      commandCopy,
      treatAsSuccessIfOutputIncludes: options.treatAsSuccessIfOutputIncludes,
      transport: remote ? 'ssh' : 'local',
      remoteHost: remote?.host,
      remotePort: remote?.port,
      remoteUser: remote?.user,
    };

    let startEvent: TimelineEvent | null = null;
    if (recordTimeline && options.sessionId) {
      startEvent = this.sessionManager.addTimelineEvent({
        session_id: options.sessionId,
        kind,
        status: 'started',
        command: commandDisplay,
        cwd: options.cwd,
        meta,
      });
      void startEvent;
    }

    const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : 120_000;
    const throwOnError = options.throwOnError ?? true;

    const env = {
      ...process.env,
      PATH: getShellPath(),
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    } as Record<string, string>;

    const localCmd = argv[0];
    const localArgs = argv.slice(1);
    const spawnConfig = remote
      ? this.buildSshSpawn(remote, options.cwd, argv)
      : { cmd: localCmd, args: localArgs, cwd: options.cwd };

    return await new Promise<GitRunResult>((resolve, reject) => {
      const proc = spawn(spawnConfig.cmd, spawnConfig.args, { cwd: spawnConfig.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const timeout = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, timeoutMs);

      const finalize = (
        result: { stdout: string; stderr: string; exitCode: number; error?: string; treatedAsSuccess?: boolean; originalExitCode?: number },
        status: 'finished' | 'failed',
        shouldThrow: boolean
      ) => {
        clearTimeout(timeout);
        const durationMs = Date.now() - startMs;

        if (recordTimeline && options.sessionId) {
          this.sessionManager.addTimelineEvent({
            session_id: options.sessionId,
            kind,
            status,
            command: commandDisplay,
            cwd: options.cwd,
            duration_ms: durationMs,
            exit_code: result.exitCode,
            meta: {
              ...meta,
              stdout: result.stdout,
              stderr: result.stderr,
              error: result.error,
              treatedAsSuccess: result.treatedAsSuccess,
              originalExitCode: result.originalExitCode,
            },
          });
        }

        const out: GitRunResult = {
          commandDisplay,
          commandCopy,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          durationMs,
          operationId,
        };

        if (status === 'failed' && shouldThrow) {
          const err = new Error(result.error || `Command failed: ${commandDisplay}`);
          (err as Error & { result?: GitRunResult }).result = out;
          reject(err);
        } else {
          resolve(out);
        }
      };

      proc.stdout.on('data', (d) => stdoutChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))));
      proc.stderr.on('data', (d) => stderrChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))));

      proc.on('error', (e) => {
        finalize(
          {
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
            exitCode: 1,
            error: e instanceof Error ? e.message : String(e),
          },
          'failed',
          throwOnError
        );
      });

      proc.on('close', (code) => {
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        const exitCode = typeof code === 'number' ? code : 0;
        if (exitCode === 0) {
          finalize({ stdout, stderr, exitCode }, 'finished', throwOnError);
        } else {
          const treat = (options.treatAsSuccessIfOutputIncludes || []).some((snippet) =>
            (stderr || '').includes(snippet) || (stdout || '').includes(snippet)
          );
          if (treat) {
            finalize({ stdout, stderr, exitCode: 0, treatedAsSuccess: true, originalExitCode: exitCode }, 'finished', throwOnError);
          } else {
            finalize({ stdout, stderr, exitCode, error: stderr || stdout || `Exit code ${exitCode}` }, 'failed', throwOnError);
          }
        }
      });
    });
  }
}

export default GitExecutor;
