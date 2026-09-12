/**
 * 引擎内置节点的运行时 seams 盒（工厂闭包绑定面）。
 *
 * 基础节点类型（llm_decider/tool_pipeline/router_judge）在装配期注册一次
 * （注册表拒绝重复登记），但 llm/工具流水线/工具表/boot 提示词在引擎重建时
 * 重新解析——工厂不能捕获装配期快照（registry 生命周期契约）。本模块以
 * 「seams 盒」承载每次引擎重建刷新的实时 seams：工厂闭包持盒，节点执行时
 * 现取盒内当前值，重建后新装配源对既有节点立即可见。
 *
 * boot_system_prompt = 装配端注入的只读基线系统提示词（缺省 '' = 未注入零
 * 漂移）：llm 类结点（llm_decider/router_judge）执行时与自定义 system_prompt
 * 经 compose_llm_system 拼成一份 system 消息。core 只持有 seam 字符串，
 * 提示词文本由宿主/adapters 装配注入（core 不 import adapters/boot）。
 *
 * agent 展开 seam（批4 agent 子图型执行体 + 作用域模型接线）：
 * - resolve_entity：按实体 id 查实体目录（数据真源 = 实体注册表；null =
 *   目录未装配或实体不存在——agent 结点显式失败不猜测）；
 * - resolve_scope_llm：按实体 model 引用（provider/model_id）取该作用域的
 *   AsyncLLM（null = 无该 seam = 无 model override 能力）。落点 = agent
 *   展开器对子作用域做 per-scope llm override；模型解析由装配注入
 *   （engine 不持有厂商适配，见 _runtime_engine._bind_engine_seams）。
 */

import type { EntitySpec } from '../../core/entities/entities.js';
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
  /** llm 类结点 system 合成基线（装配注入只读 boot 提示词；缺省 '' = 无基线）。 */
  boot_system_prompt: string;
  /** 实体目录解析 seam（agent 展开器按 entity_id 取 EntitySpec；null/缺省 = 目录不可用）。 */
  resolve_entity?: ((entity_id: string) => EntitySpec | null) | null;
  /** 按 model 引用取作用域 llm seam（null/缺省 = 无 per-scope model override 能力）。 */
  resolve_scope_llm?:
    | ((
        model: Record<string, string>,
      ) => AsyncLLM | null | Promise<AsyncLLM | null>)
    | null;
}

/** 空 seams（未绑定装配源时的确定性缺省：无模型/无流水线/空工具表/空 boot）。 */
export function empty_engine_node_seams(): EngineNodeSeams {
  return {
    llm: null,
    tool_pipeline: null,
    tool_specs: [],
    all_tool_specs: [],
    collect_specs: null,
    boot_system_prompt: '',
    resolve_entity: null,
    resolve_scope_llm: null,
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
