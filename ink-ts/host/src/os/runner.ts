/**
 * 受控 OS 执行器域（headless/operator 显式放行路径 → exec 原生件）。
 *
 * 语义：operator（cli/stdio/serve 控制面）显式请求执行一个 OS 工具——
 * 授权信封的裁决面门（envelope.gateCoverage：越权命令/越根路径/域名白名单）
 * 在 host 拦截，exec 只收已批准且复核通过的信封。审计留痕写 set_audit
 * （受控集合，经 allow_mechanism 作用域）。声明不在此层：约束（roots/
 * allowlist/allow_domains）随请求现取，与 exec 零声明表纪律一致。
 */

import { ExecClient } from '../exec/client.js';
import type { ExecOutcome } from '../exec/_types.js';
import { locateNativeBinary } from '../exec/binary.js';
import type { GuardedStorage } from '@ink-ts/engine';
import { SET_AUDIT_COLLECTION } from '@ink-ts/engine';

/** 受控 OS 工具调用请求（信封约束随请求现取；进程不触达 = host 面门拒绝）。 */
export interface OsToolRequest {
  tool: string;
  op: 'process' | 'file' | 'http';
  args: Record<string, unknown>;
  roots: string[];
  allowlist?: string[];
  allow_domains?: string[];
  timeout_secs?: number;
  max_chars?: number;
  cwd?: string | null;
  env?: Record<string, string> | null;
}

/** 裁决元信息（显式放行来源；exec 只要求 approved=true，不判定）。 */
export interface OsApproval {
  approved: boolean;
  by: string;
  trace_id?: string | null;
}

/** OS 域错误（message 可回请求方；code 供归类）。 */
export class OsError extends Error {
  readonly code: string;
  constructor(message: string, code = 'os_error') {
    super(message);
    this.name = 'OsError';
    this.code = code;
  }
}

function validate(request: OsToolRequest): void {
  if (!request.tool || typeof request.tool !== 'string' || request.tool === '') {
    throw new OsError('os 请求缺 tool', 'invalid_params');
  }
  if (!['process', 'file', 'http'].includes(request.op)) {
    throw new OsError(`os 请求 op 非法: ${request.op}`, 'invalid_params');
  }
  if (typeof request.args !== 'object' || request.args === null || Array.isArray(request.args)) {
    throw new OsError('os 请求 args 须为对象', 'invalid_params');
  }
  if (!Array.isArray(request.roots) || request.roots.length === 0) {
    throw new OsError(`${request.op} 需要路径根（roots 非空；进程不触达 = host 拒绝）`, 'invalid_params');
  }
}

/** 写 OS 执行审计留痕（append-only 集合；失败不阻断执行主流程）。 */
export async function writeOsAudit(
  storage: GuardedStorage | null,
  record: Record<string, unknown>,
): Promise<void> {
  if (storage === null) return;
  const scope = storage.allow_mechanism(SET_AUDIT_COLLECTION);
  scope.enter();
  try {
    await storage.put_record(SET_AUDIT_COLLECTION, `op-${Math.random().toString(36).slice(2, 12)}`, {
      ts: Date.now() / 1000,
      ...record,
    });
  } finally {
    scope.exit();
  }
}

/** 受控 OS 执行器（每次调用现拉起受监督 exec 会话，用毕即关）。 */
export class HostOsRunner {
  constructor(
    private readonly storage: () => GuardedStorage | null,
    private readonly binary: string | null = locateNativeBinary('exec'),
  ) {}

  /** exec 原生二进制可用性（未装配即抛 exec_unavailable；调用前先查）。 */
  assertExecAvailable(): void {
    if (this.binary === null || this.binary === '') {
      throw new OsError(
        'OS 执行器未装配：未定位 exec 原生二进制（先 cargo build ink-ts/exec）',
        'exec_unavailable',
      );
    }
  }

  private client(): ExecClient {
    this.assertExecAvailable();
    return new ExecClient({ binary: this.binary! });
  }

  /** 执行一次受控 OS 工具调用（host 裁决 → exec 信封；审计留痕）。 */
  async run(request: OsToolRequest, approval: OsApproval): Promise<ExecOutcome> {
    if (!approval.approved) {
      throw new OsError(
        `OS 执行未获显式放行（by=${approval.by ?? 'unknown'}）；headless 仅 --approve 显式放行`,
        'approval_required',
      );
    }
    this.assertExecAvailable();
    validate(request);
    const client = this.client();
    try {
      const outcome = await client.call(
        {
          tool: request.tool,
          op: request.op,
          args: request.args,
        },
        {
          approved: true,
          by: approval.by,
          trace_id: approval.trace_id ?? null,
          endpoint: 'os',
          roots: request.roots,
          allowlist: request.allowlist ?? [],
          allow_domains: request.allow_domains ?? [],
          cwd: request.cwd ?? null,
          env: request.env ?? null,
          timeout_secs: request.timeout_secs ?? 120,
          max_chars: request.max_chars ?? 65536,
        },
      );
      const summary: Record<string, unknown> = {
        type: 'os_tool_exec',
        tool: request.tool,
        op: request.op,
        by: approval.by,
        trace_id: approval.trace_id ?? null,
        exit_code: outcome.output['exit_code'] ?? null,
        ...(typeof outcome.output['bytes'] === 'number' ? { bytes: outcome.output['bytes'] } : {}),
      };
      await writeOsAudit(this.storage(), summary);
      return outcome;
    } finally {
      await client.close();
    }
  }
}
