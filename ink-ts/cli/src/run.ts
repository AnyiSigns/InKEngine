/**
 * run 形态：一次性驱动面（镜像 inkling/cli headless 语义，仅取语义）。
 *
 * --round / --op / --os-op / --audit 互斥；JSON 信封走 stdout（不泄漏半成品），
 * 诊断走 stderr `[run]` 通道；成功 exit 0、运行失败 exit 1、用法错误 exit 2。
 * 审批：仅 --approve 显式放行，缺省 fail-closed——gate 挂卡回合在无
 * --approve 下以 approval 错误信封退出。
 *
 * 装配复用 host 冷启一次（assembleCliHost），用毕 dispose。round 模式把
 * 回合事件实时打 stderr（reply_token 原样输出，其余事件摘要），stdout 仍
 * 只出最终信封。
 */

import { randomUUID } from 'node:crypto';

import type { HostHandle } from '@ink-ts/host';
import type { EngineEvent, EngineTransport } from '@ink-ts/engine';

import type { CliOptions, RunFlags } from './argv.js';
import { attachEngineTransport } from './engine_attach.js';
import { buildHandlers } from './handlers.js';
import { assembleCliHost } from './host.js';
import type { HandlerContext } from './rpc.js';

export interface StreamLike {
  write(text: string): unknown;
}

export interface RunIo {
  stdout: StreamLike;
  stderr: StreamLike;
}

export interface RunEnvelope {
  ok: boolean;
  trace_id: string;
  command: string;
  data: unknown | null;
  error: { kind: string; message: string } | null;
}

export type RunOutcome = { exitCode: number; envelope: RunEnvelope | null };

/** 回合事件实时进度（走 stderr；stdout 信封形态不变，镜像 headless live）。 */
class RoundProgressPrinter implements EngineTransport {
  constructor(private readonly out: (text: string) => void) {}

  async send(event: EngineEvent): Promise<void> {
    const token = event.payload['token'];
    if (event.type === 'reply_token') {
      if (typeof token === 'string' && token !== '') this.out(token);
      return;
    }
    const summary = JSON.stringify(event.payload);
    this.out(`\n[round] ${event.type} ${summary.length > 150 ? `${summary.slice(0, 150)}…` : summary}\n`);
  }
}

function envelope(
  trace_id: string,
  command: string,
  data: unknown,
): RunEnvelope {
  return { ok: true, trace_id, command, data, error: null };
}

function errorEnvelope(
  trace_id: string,
  command: string,
  kind: string,
  message: string,
): RunEnvelope {
  return { ok: false, trace_id, command, data: null, error: { kind, message } };
}

function writeEnvelope(io: RunIo, env: RunEnvelope): void {
  io.stdout.write(`${JSON.stringify(env, null, 2)}\n`);
}

function uuidHex(): string {
  return randomUUID().replace(/-/g, '');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** op 参数 JSON 解析（用法错误 → null + 错误文案）。 */
function parseArgsJson(args: string | undefined): { ok: true; value: unknown } | { ok: false; error: string } {
  const text = (args ?? '{}').trim();
  if (text === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, error: `--args JSON 解析失败: ${errorMessage(error)}` };
  }
}

/** host.ping/host.info + host bridge 的 run 可调方法表（--op 面）。 */
async function dispatchCommand(
  handle: HostHandle,
  method: string,
  params: unknown,
  ctx: HandlerContext,
): Promise<unknown> {
  const handlers = buildHandlers({ bridge: handle.bridge });
  if (method === 'host.ping') return handlers.get('host.ping')!(params, ctx);
  if (method === 'host.info') return handlers.get('host.info')!(params, ctx);
  const bridgeHandler = handle.bridge.get(method);
  if (bridgeHandler === undefined) {
    throw new Error(
      `未知方法: ${method}（可用: ${[...handle.bridge.keys()].join(', ')}）`,
    );
  }
  return bridgeHandler(params, ctx);
}

/** round 命令：bridge rounds.send；无 --approve 的挂起 = fail-closed。 */
async function runRound(
  handle: HostHandle,
  run: RunFlags,
  approve: boolean,
  trace_id: string,
  io: RunIo,
): Promise<RunOutcome> {
  const detach = attachEngineTransport(handle.runtime, new RoundProgressPrinter((t) => io.stderr.write(t)));
  try {
    const send = handle.bridge.get('rounds.send');
    if (send === undefined) throw new Error('rounds.send 不可用（bridge 未装配）');
    const result = (await send(
      {
        input: run.arg,
        thread_id: run.thread_id ?? `hl-${trace_id}`,
        round_id: run.round_id ?? `hlr-${trace_id}`,
        trace_id,
      },
      { autoApprove: approve },
    )) as { reason: string; reply: unknown };
    if (result.reason === 'interrupted' && !approve) {
      return {
        exitCode: 1,
        envelope: errorEnvelope(
          trace_id,
          'round',
          'approval',
          '回合于审批卡挂起（fail-closed）：需 --approve 显式放行（仅限可信自动化）'
            + '，或经 stdio/serve 的 approval.list + approval.resolve 注入裁决',
        ),
      };
    }
    return { exitCode: 0, envelope: envelope(trace_id, 'round', result) };
  } finally {
    detach();
  }
}

/** op 命令：调 bridge 方法（参数经 --args）。 */
async function runOp(
  handle: HostHandle,
  run: RunFlags,
  approve: boolean,
  trace_id: string,
): Promise<RunOutcome> {
  const parsed = parseArgsJson(run.args);
  if (!parsed.ok) {
    return { exitCode: 2, envelope: errorEnvelope(trace_id, 'op', 'usage', parsed.error) };
  }
  try {
    const data = await dispatchCommand(handle, run.arg, parsed.value, { autoApprove: approve });
    return { exitCode: 0, envelope: envelope(trace_id, 'op', data) };
  } catch (error) {
    return {
      exitCode: 1,
      envelope: errorEnvelope(trace_id, 'op', 'op', errorMessage(error)),
    };
  }
}

/** audit 命令：仅 export（语义镜像 headless run_audit）。 */
async function runAudit(
  handle: HostHandle,
  approve: boolean,
  trace_id: string,
): Promise<RunOutcome> {
  try {
    const exportHandler = handle.bridge.get('audit.export');
    if (exportHandler === undefined) throw new Error('audit.export 不可用（bridge 未装配）');
    const records = await exportHandler(null, { autoApprove: approve });
    return { exitCode: 0, envelope: envelope(trace_id, 'audit', records) };
  } catch (error) {
    return {
      exitCode: 1,
      envelope: errorEnvelope(trace_id, 'audit', 'op', errorMessage(error)),
    };
  }
}

/** os_op 命令：exec 原生件执行路径未接线，命令面 fail-closed 占位拒绝。 */
function runOsOp(
  run: RunFlags,
  trace_id: string,
): RunOutcome {
  const parsed = parseArgsJson(run.args);
  if (!parsed.ok) {
    return { exitCode: 2, envelope: errorEnvelope(trace_id, 'os_op', 'usage', parsed.error) };
  }
  return {
    exitCode: 1,
    envelope: errorEnvelope(
      trace_id,
      'os_op',
      'os_op',
      `OS 执行器未装配：--os-op 需 ink-ts/exec 原生件接线；`
        + `当前 fail-closed 拒绝。tool=${run.arg}（--approve 显式放行语义保留，`
        + `执行路径就绪后仅显式 --approve 放行）`,
    ),
  };
}

/** run 形态主流程：一次性装配 + 驱动 + 输出信封。返回 exit code。 */
export async function runOnce(options: CliOptions, io: RunIo = defaultIo()): Promise<number> {
  const run = options.run as RunFlags;
  const trace_id = run.trace_id ?? uuidHex();
  const command = run.command;
  let handle: HostHandle | null = null;
  let outcome: RunOutcome;
  try {
    if (command === 'os_op') {
      outcome = runOsOp(run, trace_id);
    } else {
      handle = await assembleCliHost(options);
      outcome =
        command === 'round'
          ? await runRound(handle, run, options.approve, trace_id, io)
          : command === 'op'
            ? await runOp(handle, run, options.approve, trace_id)
            : await runAudit(handle, options.approve, trace_id);
    }
  } catch (error) {
    outcome = {
      exitCode: 1,
      envelope: errorEnvelope(trace_id, command, 'boot', errorMessage(error)),
    };
  } finally {
    if (handle !== null) {
      try {
        await handle.dispose();
      } catch {
        // dispose 失败不覆盖主结果
      }
    }
  }
  const env = outcome.envelope;
  if (env !== null) writeEnvelope(io, env);
  io.stderr.write(`[run] trace_id=${trace_id} command=${command} status=${env?.ok ? 'ok' : 'error'} exit=${outcome.exitCode}\n`);
  return outcome.exitCode;
}

function defaultIo(): RunIo {
  return { stdout: process.stdout, stderr: process.stderr };
}
