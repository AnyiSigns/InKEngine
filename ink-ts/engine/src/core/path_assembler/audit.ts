/**
 * 组装审计记录构建（path_assembler.py assembly_audit_record 移植）。
 *
 * 纯函数：指令入口（assemble_plan）与只读组装（assemble）共用同一形态；
 * 记录 = 请求/结果快照（历史图定义随候选落库），落库归 audit_sink 回调。
 */

import type { AssemblyRequest, PathAssemblyResult } from './types.js';

/** 组装审计记录构建（纯函数；指令入口与只读组装共用同一形态）。 */
export function assembly_audit_record(
  request: AssemblyRequest,
  goal: readonly string[],
  result: PathAssemblyResult,
  opts: { ts: number },
): Record<string, unknown> {
  return {
    ts: opts.ts,
    domain: request.domain,
    fingerprint: result.fingerprint,
    goal_fields: [...goal],
    entry_fields: [...request.entry_fields],
    candidates: result.candidates.map((c) => c.to_dict()),
    llm_attempts: result.llm_attempts,
    fallback_reason: result.fallback_reason,
    stats: { ...result.stats },
  };
}
