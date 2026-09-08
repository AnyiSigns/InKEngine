/**
 * path 命令面（state）——path_assembler 装配状态只读投影。
 *
 * 数据源 = runtime.assembly_runtime（组装运行期挂载产物：开关位 +
 * canary 门 + 最近请求指纹）+ runtime.assembly_flags（机制开关位）+
 * set_audit 组装/候选审计记录（EVENT_AUDIT_ASSEMBLY = 最近一次组装的
 * 候选数；EVENT_ASSEMBLY_CANDIDATE = 人工选择/清空候选留痕）。只读
 * 投影；无挂载 = available:false 结构化空态。thread_id 非本方法消费
 * （装配为全局态；参数保留兼容调用面）。
 */

import type { PathCommand } from './commands.generated.js';
export { PATH_COMMANDS, type PathCommand } from './commands.generated.js';
import { EVENT_ASSEMBLY_CANDIDATE, EVENT_AUDIT_ASSEMBLY, SET_AUDIT_COLLECTION } from '@ink-ts/engine';

import { type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 审计记录行（kind = emit_audit 落库的 type 归并键）。 */
function recordKind(record: Record<string, unknown>): string {
  const kind = record['kind'];
  if (typeof kind === 'string' && kind !== '') return kind;
  const type = record['type'];
  return typeof type === 'string' ? type : '';
}

/** 最近一条匹配 kind 的审计（按 ts 倒序；无 = null）。 */
function latestOfKind(
  records: readonly Record<string, unknown>[],
  kind: string,
): Record<string, unknown> | null {
  let best: Record<string, unknown> | null = null;
  let bestTs = Number.NEGATIVE_INFINITY;
  for (const record of records) {
    if (recordKind(record) !== kind) continue;
    const ts = typeof record['ts'] === 'number' ? record['ts'] : 0;
    if (ts >= bestTs) {
      bestTs = ts;
      best = record;
    }
  }
  return best;
}


export function buildPathCommands(deps: HostBridgeDeps): Readonly<Record<PathCommand, BridgeHandler>> {
  /** path.state：path_assembler 装配状态 + 最近组装候选摘要。 */
  const state: BridgeHandler = async (): Promise<Record<string, unknown>> => {
    const runtime = deps.runtime;
    const flags = runtime.assembly_flags;
    const assembled = runtime.assembly_runtime;
    const runtimeLike = assembled === null
      ? null
      : (assembled as unknown as {
          config: { enabled: boolean } | null;
          canary: boolean;
          contract_enabled: boolean;
        });
    const assemblerEnabled = runtimeLike?.config?.enabled ?? flags?.assembler_enabled ?? false;
    const lastRequest = assembled === null
      ? null
      : (assembled as unknown as { last_request_fingerprint: string }).last_request_fingerprint;
    let candidates: number | null = null;
    let chosen: Record<string, unknown> | null = null;
    if (runtime.storage !== null) {
      const records = await runtime.storage
        .list_records(SET_AUDIT_COLLECTION)
        .catch(() => []) as Record<string, unknown>[];
      const assembly = latestOfKind(records, EVENT_AUDIT_ASSEMBLY);
      if (assembly !== null) {
        const rawCandidates = assembly['candidates'];
        candidates = Array.isArray(rawCandidates) ? rawCandidates.length : 0;
      }
      const candidateAudit = latestOfKind(records, EVENT_ASSEMBLY_CANDIDATE);
      if (candidateAudit !== null) {
        chosen = {
          domain: typeof candidateAudit['domain'] === 'string' ? candidateAudit['domain'] : null,
          candidate_id:
            typeof candidateAudit['candidate_id'] === 'string' ? candidateAudit['candidate_id'] : null,
          chosen: candidateAudit['chosen'] === true,
          ts: typeof candidateAudit['ts'] === 'number' ? candidateAudit['ts'] : null,
        };
      }
    }
    return {
      available: assembled !== null,
      runtime_mounted: assembled !== null,
      enabled: {
        assembler: assemblerEnabled,
        contract: runtimeLike?.contract_enabled ?? flags?.contract_enabled ?? false,
        settle_hooks: flags?.settle_hooks_enabled ?? false,
        pool_governance: flags?.pool_governance_enabled ?? false,
        edge_evidence: flags?.edge_evidence_enabled ?? false,
        fingerprint_cache: flags?.fingerprint_cache_enabled ?? false,
        multipath: flags?.multipath_enabled ?? false,
      },
      canary_gate: runtimeLike?.canary ?? false,
      last_request_fingerprint: lastRequest === '' ? null : lastRequest,
      candidates: {
        last_assembly_count: candidates,
        chosen_candidate: chosen,
      },
    };
  };

  return { 'path.state': state };
}

export { isRecord };
