/**
 * 子进程执行助手（自检编排用）：带超时跑外部命令、回收输出与退出码；
 * 以及按行读取长驻进程 stdout 的 JSON 首行（serve listen 行等）。
 */

import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface RunOutcome {
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface SpawnOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** 带超时的外部命令：输出按 utf8 回收，超时按进程树强杀。 */
export function runCommand(argv: readonly string[], opts: SpawnOpts = {}): Promise<RunOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = opts.cwd;
  return new Promise<RunOutcome>((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    let settled = false;
    const finish = (result: RunOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish({ code: null, timedOut: true, stdout: decode(out), stderr: decode(err) });
    }, timeoutMs);
    child.on('error', () => {
      finish({ code: null, timedOut: false, stdout: decode(out), stderr: decode(err) });
    });
    child.on('close', (code) => {
      finish({ code, timedOut: false, stdout: decode(out), stderr: decode(err) });
    });
  });
}

function decode(parts: Buffer[]): string {
  return Buffer.concat(parts).toString('utf8');
}

/** 结束子进程并连后代一起清理（Windows 用 taskkill /T）。 */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  try {
    child.kill();
  } catch {
    // 进程已退出
  }
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } catch {
      // 已退出则忽略
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // 已退出则忽略
    }
  }
}

export interface LongChild {
  proc: ChildProcessWithoutNullStreams;
  waitClose(timeoutMs?: number): Promise<RunOutcome>;
}

/** spawn 长驻子进程（serve 等），stdout 逐行可读。 */
export function spawnLong(argv: readonly string[], opts: SpawnOpts = {}): LongChild {
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }) as unknown as ChildProcessWithoutNullStreams;
  return {
    proc: child,
    waitClose: (timeoutMs = 30_000) =>
      new Promise<RunOutcome>((resolve) => {
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
        let settled = false;
        const finish = (result: RunOutcome): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          killTree(child);
          finish({ code: null, timedOut: true, stdout: decode(out), stderr: decode(err) });
        }, timeoutMs);
        child.on('error', () => finish({ code: null, timedOut: false, stdout: decode(out), stderr: decode(err) }));
        child.on('close', (code) => finish({ code, timedOut: false, stdout: decode(out), stderr: decode(err) }));
      }),
  };
}

/** 逐行读 stdout，取第一个 JSON 首行（serve listen 行）。 */
export function firstJsonLine(child: LongChild, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const rl = createInterface({ input: child.proc.stdout });
    const timer = setTimeout(() => {
      rl.close();
      reject(new Error('等待子进程 stdout JSON 行超时'));
    }, timeoutMs);
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed === '' || !trimmed.startsWith('{')) return;
      clearTimeout(timer);
      rl.close();
      try {
        resolve(JSON.parse(trimmed) as Record<string, unknown>);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    rl.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
