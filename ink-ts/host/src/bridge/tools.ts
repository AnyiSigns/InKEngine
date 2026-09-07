/**
 * tools command surface (full) - full tool view of the engine tool registry.
 * Data source = runtime.tool_index (ToolVectorIndex with per-endpoint/tier/
 * vector state) plus merged_specs (all registered tools); host only proxies,
 * never mirrors shell-side tool declarations. Vector availability is reported
 * per view (observable degrade: keyword baseline -> uses_vectors=false).
 * full = settings tools tab data source; on each merged_specs row it adds
 * three consumption flags - baseline (resident required set, engine runtime
 * single source), approved (capability record auto_approve_tools hit),
 * enabled (inside the engine injected set = default session window);
 * capability auto-approve reads the capability record, other flags read the
 * engine runtime.
 */

import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';

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

export function buildToolsHandlers(deps: HostBridgeDeps): ReadonlyMap<string, BridgeHandler> {
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

  return new Map<string, BridgeHandler>([
    ['tools.full', full],
  ]);
}
