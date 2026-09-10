/**
 * 隔离试跑基座的真实执行（TrialRunner seam 实现：演化采纳前的验证闸执行器）。
 *
 * 执行模型（§四-②/§六 采纳前验证）：高影响资产变更在落地主执行**之前**先隔离
 * 试跑——试跑胜负不进主执行证据/组织档案（归因保险），过闸才进审批/补丁链。
 * Wave-3 的 adoption_gate 只定义了 seam 与 fail-closed 闸线，本模块给真实实现：
 *
 * - **隔离**：试跑在独立 ExecutionRuntime（archive 置空 = 零 ingest）上执行；
 *   run_id 走 `trial:` 命名空间；事件不带入宿主/主执行事件面——试跑痕迹自成
 *   一体，随本次调用丢弃；
 * - **判定**：probe 探针（默认 = 从 TrialSpec 载荷取被变更作用域作入口）跑一轮
 *   执行 → verdict：成功且有产物 = pass；执行失败 = fail；阻断/降级/证据不足 =
 *   inconclusive（与 verdict_blocks 一致：非 pass 即阻断）。
 *
 * 复用关系：TrialRunner 跑的就是 ExecutionRuntime（同一隔离执行基座），与
 * 执行期决策择优（best 契约）共用子执行+独立轨迹语义，唯一差异是作用域尺度
 * 与回传目标——本模块收敛在「组织提案级验证 + 仅回传 verdict」。
 */

import { ExecutionRuntime } from './execution_runtime.js';
import type { ExecutionRequest, ExecutionResult, ExecutionRuntimeDeps } from './runtime_types.js';
import type { TrialRunner, TrialSpec, TrialVerdict } from '../controlled_evolution/adoption_gate.js';

/** 试跑探针：把 TrialSpec（提案变更意图）翻译成隔离执行请求。 */
export type TrialProbe = (spec: TrialSpec) => ExecutionRequest | null;

function _scope_id(spec: TrialSpec): string | null {
  const payload = spec.payload as Record<string, unknown>;
  const asset = payload['asset'];
  if (asset !== null && typeof asset === 'object' && !Array.isArray(asset)) {
    const id = (asset as Record<string, unknown>)['id'];
    if (typeof id === 'string' && id !== '') return id;
  }
  const scope = payload['scope'];
  if (typeof scope === 'string' && scope !== '') return scope;
  const channel = payload['channel'];
  if (typeof channel === 'string' && channel !== '') return channel;
  return null;
}

/** 缺省探针：以提案中被变更/新增的目录 id 作为隔离试跑的入口作用域。 */
export function default_trial_probe(spec: TrialSpec): ExecutionRequest | null {
  const scopeId = _scope_id(spec);
  if (scopeId === null) return null;
  return {
    task: `隔离试跑验证: ${spec.kind}（${spec.rationale || '未说明理由'}）`,
    trigger: null,
    entry_scope: scopeId,
    seed_payload: { evidence: spec.evidence },
  };
}

/** 执行结果 → 试跑 verdict（成功+产物 = pass；失败 = fail；阻断/降级/证据不足
 *  = inconclusive——无法证明安全即不过闸）。 */
export function trial_verdict(result: ExecutionResult): TrialVerdict {
  if (result.blocked) return 'inconclusive';
  if (result.root.outcome === 'failure') return 'fail';
  if (result.root.outcome === 'degraded') return 'inconclusive';
  const finalKeys = Object.keys(result.final_product).filter((key) => key !== 'degraded');
  if (finalKeys.length === 0) return 'inconclusive';
  return 'pass';
}

/** 隔离试跑执行器装配选项。 */
export interface TrialRunnerOptions {
  /** 试跑基座依赖（archive/事件会被强制隔离；load_scope 目录须含被测资产）。 */
  deps: ExecutionRuntimeDeps;
  /** 探针（缺省 = 从载荷取被变更作用域作入口）。 */
  probe?: TrialProbe | null;
}

/** 试跑 id 命名空间（事件/轨迹与主执行隔离的标识前缀）。 */
export const TRIAL_RUN_PREFIX = 'trial';

/** 构造隔离试跑执行器（真实实现；archive 置空 + 独立运行时实例）。 */
export function make_trial_runner(options: TrialRunnerOptions): TrialRunner {
  const runtime = new ExecutionRuntime({
    ...options.deps,
    archive: null,
    on_event: undefined,
    load_scope: options.deps.load_scope,
    channels: options.deps.channels,
    turn: options.deps.turn,
  });
  const probe = options.probe ?? default_trial_probe;
  let counter = 0;
  return {
    async run_trial(spec: TrialSpec): Promise<TrialVerdict> {
      const request = probe(spec);
      if (request === null) return 'inconclusive';
      counter += 1;
      const result = await runtime.run({ ...request, run_id: `${TRIAL_RUN_PREFIX}:${counter}` });
      return trial_verdict(result);
    },
  };
}

export type { TrialRunner, TrialSpec, TrialVerdict };
