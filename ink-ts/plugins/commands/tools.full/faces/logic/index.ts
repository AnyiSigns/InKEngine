/**
 * tools.full 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/tools.ts 原样迁入，
 * 语义零改；域工厂 → 命令工厂 + 入口默认导出）。
 *
 * 语义：full = 引擎工具注册表全量工具视图（settings tools tab 数据源）。数据源 =
 * runtime.tool_index（ToolVectorIndex with per-endpoint/tier/vector state）plus
 * merged_specs（all registered tools）；host only proxies, never mirrors
 * shell-side tool declarations。Vector availability is reported per view
 * （observable degrade: keyword baseline -> uses_vectors=false）。每 merged_specs
 * 行附三个消费标志 - baseline（runtime resident set，引擎 runtime 单一真源）、
 * approved（capability record auto_approve_tools hit）、enabled（引擎注入集 =
 * 默认会话窗口）；capability auto-approve 读 capability record，其余读 runtime。
 */

import { BridgeError, type BridgeHandler, type HostBridgeDeps } from '@ink-ts/host';

/** Full tool view row (flags: baseline/approved/enabled; vector state). */
export interface ToolFullRow {
  name: string;
  uses_vectors: boolean;
  vector: boolean;
  baseline: boolean;
  approved: boolean;
  enabled: boolean;
}

/** Full tool view result. */
export interface ToolFullView {
  uses_vectors: boolean;
  degraded_reason?: string | null;
  tools: ToolFullRow[];
}

/** 装配注入入口：默认导出 = 统一工厂 (deps: HostBridgeDeps) => BridgeHandler
 *  （S0 faces.logic 装载契约；loader 只装载不解析）。 */
export default function createToolsFull(deps: HostBridgeDeps): BridgeHandler {
  /**
   * Full tool view: merged_specs rows carry uses_vectors/vector plus three
   * consumption flags. baseline = runtime resident set; approved = capability
   * auto_approve_tools hit; enabled = runtime injected set (default session
   * window = immutable preview set). Missing runtime assembly (not booted /
   * stopped) -> runtime_unavailable (fail-closed). Data lives on the runtime
   * tool registry regardless of static graph (rounds assemble per-turn graphs).
   */
  const full: BridgeHandler = (): ToolFullView => {
    const runtime = deps.runtime;
    if (runtime.storage === null) {
      throw new BridgeError('runtime is not assembled (not booted or stopped)', 'runtime_unavailable');
    }
    const index = runtime.tool_index;
    const usesVectors = index?.uses_vectors() ?? false;
    const degraded = index?.degraded_reason ?? null;
    const baseline = new Set(runtime.baseline_names);
    const approved = new Set(
      deps.capability !== undefined
        ? deps.capability.get().auto_approve_tools
        : [],
    );
    const enabled = new Set(runtime.collect_specs().map((spec) => spec.name));
    const specs = runtime.merged_specs();
    const rows: ToolFullRow[] = specs.map((spec) => {
      const entry = index !== null ? index.entries.get(spec.name) : undefined;
      return {
        name: spec.name,
        uses_vectors: usesVectors,
        vector: usesVectors && entry?.vector !== null && entry?.vector !== undefined,
        baseline: baseline.has(spec.name),
        approved: approved.has(spec.name),
        enabled: enabled.has(spec.name),
      };
    });
    rows.sort((a, b) => a.name.localeCompare(b.name));
    const view: ToolFullView = {
      uses_vectors: usesVectors,
      ...(degraded !== null ? { degraded_reason: degraded } : {}),
      tools: rows,
    };
    return view;
  };

  return full;
}
