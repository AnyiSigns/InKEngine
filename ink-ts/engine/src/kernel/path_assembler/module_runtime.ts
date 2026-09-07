/**
 * 模块级默认运行期与组装产物执行入口（path_assembler.py「模块级默认运行期」段移植）。
 *
 * 模块级默认运行期 = 装配入口 set_default_assembly_runtime 挂载；未挂载 =
 * 未装配 = 默认全关零生效。assemble_plan 为壳侧 op/策略层入口——未挂载时返回
 * 空结果（零运行影响），挂载后转 runtime.assemble_plan。
 */

import { AssemblyRequest, AssemblyEnvelope, PathAssemblyResult } from './types.js';
import { PathAssemblyRuntime } from './runtime.js';

type AuditSink = ((record: Record<string, unknown>) => void) | null;

let _default_assembly_runtime: PathAssemblyRuntime | null = null;

/** 挂载/替换默认组装运行期（boot 装配处调用；None = 卸载）。 */
export function set_default_assembly_runtime(runtime: PathAssemblyRuntime | null): void {
  _default_assembly_runtime = runtime;
}

/** 取默认组装运行期（未挂载 = None）。 */
export function get_default_assembly_runtime(): PathAssemblyRuntime | null {
  return _default_assembly_runtime;
}

/** 组装产物执行入口（默认运行期挂载后可用；壳侧 op 与策略层调用）。
 *  未挂载默认运行期 = 机制未装配（默认全关）：返回空结果，无候选、无审计。 */
export async function assemble_plan(
  request: AssemblyRequest,
  opts: { envelope?: AssemblyEnvelope | null; audit_sink?: AuditSink } = {},
): Promise<PathAssemblyResult> {
  const runtime = _default_assembly_runtime;
  if (runtime === null) {
    return new PathAssemblyResult({ fallback_reason: '组装运行期未装配（默认关闭）' });
  }
  return await runtime.assemble_plan(request, {
    envelope: opts.envelope ?? null,
    audit_sink: opts.audit_sink ?? null,
  });
}
