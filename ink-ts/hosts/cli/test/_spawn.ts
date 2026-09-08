/**
 * cli e2e spawn 助手（vitest 运行于 cli 根；子进程以 node --import tsx 冷启）。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const CLI_ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
/** cli 包根（子进程 cwd 缺省；保证 node --import tsx 可解析到 workspace node_modules）。 */
const CLI_ROOT = fileURLToPath(new URL('..', import.meta.url));

export interface CliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export function cliEntry(): string {
  return CLI_ENTRY;
}

/** 一次性跑完 cli 命令并回收 stdout/stderr/exit code。 */
export function runCli(args: readonly string[], options: SpawnOptions = {}): Promise<CliRunResult> {
  const cwd = options.cwd ?? CLI_ROOT;
  const timeoutMs = options.timeoutMs ?? 90_000;
  return new Promise<CliRunResult>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI_ENTRY, ...args], {
      cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`cli 子进程超时(${timeoutMs}ms): ${args.join(' ')}`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        exitCode: code,
      });
    });
  });
}

/** 解析 stdout 的 JSON 信封（run 形态信封为多行 pretty JSON；非 JSON 返回 null）。 */
export function parseEnvelope(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim();
  if (text === '' || !text.startsWith('{')) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface CliChild {
  proc: ChildProcessWithoutNullStreams;
  kill(): void;
  /** 等待子进程退出，回收输出与退出码。 */
  waitClose(timeoutMs?: number): Promise<CliRunResult>;
}

/** spawn 长驻形态（serve / stdio 交互），stdout 逐行可用。 */
export function spawnCli(args: readonly string[], options: SpawnOptions = {}): CliChild {
  const cwd = options.cwd ?? CLI_ROOT;
  const proc = spawn(process.execPath, ['--import', 'tsx', CLI_ENTRY, ...args], {
    cwd,
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return {
    proc,
    kill: () => {
      proc.kill();
    },
    waitClose: (timeoutMs = 30_000) =>
      new Promise<CliRunResult>((resolve, reject) => {
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        proc.stdout.on('data', (chunk: Buffer) => out.push(chunk));
        proc.stderr.on('data', (chunk: Buffer) => err.push(chunk));
        const timer = setTimeout(() => {
          proc.kill();
          reject(new Error('cli 子进程关闭超时'));
        }, timeoutMs);
        proc.on('close', (code) => {
          clearTimeout(timer);
          resolve({
            stdout: Buffer.concat(out).toString('utf8'),
            stderr: Buffer.concat(err).toString('utf8'),
            exitCode: code,
          });
        });
        proc.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      }),
  };
}

/** 逐行读 stdout，直到拿到第一个 JSON 行（serve listen 行等）。 */
export function firstJsonLine(child: CliChild, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const rl = createInterface({ input: child.proc.stdout });
    const timer = setTimeout(() => {
      rl.close();
      reject(new Error('等待子进程 stdout JSON 行超时'));
    }, timeoutMs);
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed === '') return;
      if (!trimmed.startsWith('{')) return;
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
