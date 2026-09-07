/**
 * CLI 进程入口（四形态）：解析参数 → stdio（JSON-RPC）/ run（一次性驱动）/
 * serve（本地 http+ws）/ tui（终端交互）。宿主层允许 node 内置 IO；审批放行仅
 * 来自 --approve 显式声明，从不默认放行。未知启动参数即拒绝：stdio exit 1、
 * run/serve/tui exit 2（headless 语义）；help exit 0。
 *
 * 直接执行 = 进程入口（cli/src/index.ts）；bootstrap/ 为收敛后的唯一进程入口
 * （读 hosts/<surface>.spec.json 校验后委托本 runCliMain）。
 *
 * stdio：冷启一次装配 host（createHost，见 host.ts）→ buildHandlers 并入
 * bridge 方法表 → serve；输入关闭后 dispose host 再退出。
 */

import { pathToFileURL } from 'node:url';

import { parseArgs, HELP_TEXT, type ParseArgsResult } from './argv.js';
import { buildHandlers } from './handlers.js';
import { assembleCliHost } from './host.js';
import { runOnce } from './run.js';
import { serve } from './server.js';
import { runServe } from './serve.js';
import { runTui } from './tui/tui.js';

type ParseFailure = Extract<ParseArgsResult, { ok: false }>;

function failExit(result: ParseFailure): number {
  process.stderr.write(`${result.error}\n\n${HELP_TEXT}\n`);
  return result.mode === 'stdio' ? 1 : 2;
}

async function runStdio(options: Parameters<typeof assembleCliHost>[0]): Promise<void> {
  const handle = await assembleCliHost(options);
  try {
    const handlers = buildHandlers({ bridge: handle.bridge });
    await serve({ autoApprove: options.approve, handlers });
  } finally {
    await handle.dispose();
  }
}

async function runMain(argv: readonly string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    process.exitCode = failExit(parsed);
    return;
  }
  const options = parsed.options;
  if (options.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }
  try {
    if (options.mode === 'run') {
      process.exitCode = await runOnce(options);
    } else if (options.mode === 'serve') {
      await runServe(options, { stdout: process.stdout, stderr: process.stderr });
    } else if (options.mode === 'tui') {
      process.exitCode = await runTui(options);
    } else {
      await runStdio(options);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[cli] 致命错误: ${message}\n`);
    if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 1;
  }
}

/** CLI 进程运行主体（bootstrap 单一入口与直接执行共用）。 */
export async function runCliMain(argv: readonly string[]): Promise<number> {
  await runMain(argv);
  return typeof process.exitCode === 'number' ? process.exitCode : 0;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  await runMain(process.argv.slice(2));
}

