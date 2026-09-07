/**
 * 引擎内置节点的运行时 seams 盒（工厂闭包绑定面）。
 *
 * 基础节点类型（llm_decider/tool_pipeline）在装配期注册一次（注册表拒绝
 * 重复登记），但 llm/工具流水线/工具表在引擎重建时重新解析——工厂不能
 * 捕获装配期快照（registry 生命周期契约）。本模块以「seams 盒」承载每次
 * 引擎重建刷新的实时 seams：工厂闭包持盒，节点执行时现取盒内当前值，
 * 重建后新装配源对既有节点立即可见。
 */

import type { NodeTypeRegistry } from '../registry/registry.js';
import type { AsyncLLM } from '../../kernel/llm/_guard_types.js';
import type { ToolPipeline } from '../../kernel/tool_pipeline/tool_pipeline.js';
import type { ToolSpec } from '../../kernel/llm/tools.js';

/** 引擎内置节点执行期实时 seams（每引擎重建绑定一次；执行时现取）。 */
export interface EngineNodeSeams {
  /** 当前回合 resolve 的模型守卫链（null = 未装配 → 确定性 stub）。 */
  llm: AsyncLLM | null;
  /** 统一工具执行流水线（守卫/审批/沙箱全机制；null = 未装配）。 */
  tool_pipeline: ToolPipeline | null;
  /** 缺省注入工具表（模型 tools 参数面）。 */
  tool_specs: readonly ToolSpec[];
  /** 全量工具表（含动态/常驻；工具分发解析面）。 */
  all_tool_specs: readonly ToolSpec[];
  /** 线程化注入工具表读取器（可空；空 = 回落 tool_specs）。 */
  collect_specs: ((thread_id?: string | null) => readonly ToolSpec[]) | null;
}

/** 空 seams（未绑定装配源时的确定性缺省：无模型/无流水线/空工具表）。 */
export function empty_engine_node_seams(): EngineNodeSeams {
  return {
    llm: null,
    tool_pipeline: null,
    tool_specs: [],
    all_tool_specs: [],
    collect_specs: null,
  };
}

/** seams 盒（工厂闭包持盒；bind 刷新盒内容）。 */
export class _EngineNodeSeamsBox {
  current: EngineNodeSeams = empty_engine_node_seams();

  constructor(initial?: EngineNodeSeams | null) {
    if (initial !== null && initial !== undefined) this.current = initial;
  }
}

const _boxes = new WeakMap<NodeTypeRegistry, _EngineNodeSeamsBox>();

/** 取（或建）注册表实例的 seams 盒（注册函数登记时写入映射）。 */
export function _seams_box_for(registry: NodeTypeRegistry, initial?: EngineNodeSeams | null): _EngineNodeSeamsBox {
  let box = _boxes.get(registry);
  if (box === undefined) {
    box = new _EngineNodeSeamsBox(initial);
    _boxes.set(registry, box);
  }
  return box;
}

/** 刷新注册表实例绑定的实时 seams（引擎重建处调用；无盒 = 已注册类型缺失，
 *  静默跳过——装配顺序错误的防御面）。 */
export function _bind_engine_node_seams(registry: NodeTypeRegistry, seams: EngineNodeSeams): void {
  const box = _boxes.get(registry);
  if (box !== undefined) box.current = seams;
}
