/**
 * os 命令面（os.run）——受控 OS 执行器出口。
 *
 * headless 显式放行语义：ctx.autoApprove=true（cli --approve）才签发授权
 * 信封；否则 fail-closed 拒绝（approval_required）。约束随请求现取（roots/
 * allowlist/allow_domains），host 裁决面门在 envelope.ts 拦截越权/越根，
 * exec 只收复核通过的信封。审计留痕写 set_audit（os_tool_exec）。
 */

import type { GuardedStorage } from '@ink-ts/engine';

import { OsError, HostOsRunner } from '../os/runner.js';
import type { OsToolRequest } from '../os/runner.js';
import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';

function asOsRequest(raw: unknown): { request: OsToolRequest; trace_id: string | null } {
  const params = raw as Record<string, unknown> | null;
  if (typeof params !== 'object' || params === null) {
    throw new BridgeError('os.run 需参数对象', 'invalid_params');
  }
  const op = params['op'];
  if (op !== 'process' && op !== 'file' && op !== 'http') {
    throw new BridgeError('os.run 需 op（process/file/http）', 'invalid_params');
  }
  const request: OsToolRequest = {
    tool: String(params['tool'] ?? ''),
    op,
    args: (params['args'] as Record<string, unknown> | null | undefined) ?? {},
    roots: asStringArray(params['roots'], 'roots'),
    allowlist: asStringArray(params['allowlist'], 'allowlist'),
    allow_domains: asStringArray(params['allow_domains'], 'allow_domains'),
  };
  const timeout = params['timeout_secs'];
  if (timeout !== undefined && timeout !== null && Number.isFinite(Number(timeout))) {
    request.timeout_secs = Math.trunc(Number(timeout));
  }
  const maxChars = params['max_chars'];
  if (maxChars !== undefined && maxChars !== null && Number.isFinite(Number(maxChars))) {
    request.max_chars = Math.trunc(Number(maxChars));
  }
  if (typeof params['cwd'] === 'string' && params['cwd'] !== '') {
    request.cwd = params['cwd'];
  }
  if (typeof params['env'] === 'object' && params['env'] !== null && !Array.isArray(params['env'])) {
    request.env = params['env'] as Record<string, string>;
  }
  const trace_id = typeof params['trace_id'] === 'string' && params['trace_id'] !== '' ? params['trace_id'] : null;
  return { request, trace_id };
}

function asStringArray(raw: unknown, field: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || !raw.every((entry) => typeof entry === 'string' && entry !== '')) {
    throw new BridgeError(`os.run ${field} 须为非空字符串数组`, 'invalid_params');
  }
  return [...raw];
}

export function buildOsHandlers(deps: HostBridgeDeps): ReadonlyMap<string, BridgeHandler> {
  const runner = new HostOsRunner(
    () => deps.runtime.storage as unknown as GuardedStorage | null,
  );

  const run: BridgeHandler = async (raw, ctx): Promise<unknown> => {
    if (ctx.autoApprove !== true) {
      throw new BridgeError(
        'os.run 需要显式放行（headless 仅 --approve 显式放行；fail-closed 缺省）',
        'approval_required',
      );
    }
    const { request, trace_id } = asOsRequest(raw);
    try {
      const outcome = await runner.run(request, {
        approved: true,
        by: 'os.run',
        trace_id,
      });
      return {
        tool: outcome.tool,
        op: outcome.op,
        endpoint: outcome.endpoint,
        output: outcome.output,
      };
    } catch (error) {
      if (error instanceof OsError) {
        throw new BridgeError(error.message, error.code);
      }
      throw new BridgeError(
        error instanceof Error ? error.message : String(error),
        'os_error',
      );
    }
  };

  return new Map<string, BridgeHandler>([['os.run', run]]);
}
