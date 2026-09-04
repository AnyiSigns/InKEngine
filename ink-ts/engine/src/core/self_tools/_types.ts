/**
 * 自指元工具执行上下文与钩子 seam 面（core/self_tools.py SelfToolContext
 * / ConvergenceHook 移植）。
 *
 * 上下文由宿主装配注入（self_pipeline/harness_registry/knowledge_set 为
 * 内核组件；convergence 为可选前置闸门协议钩子，宿主实现 assess 语义；
 * tool_index/tool_tagger/endpoint_probe 为 search_tools/request_tool 的
 * 检索与绑定侧缝）。host 扩展（如种子沉淀）经本类可选钩子与执行器组合
 * 接入，不改模块：引擎能力随机制层走补丁链演化、不随宿主壳漂移。
 */

import type { ApprovalInterruptContext } from '../approval/approval.js';
import type { HarnessRegistry } from '../harness/index.js';
import type { KnowledgeSet } from '../knowledge_set/index.js';
import type { ToolSpec } from '../llm/tools.js';
import type { SelfApplicationPipeline } from '../self_application/index.js';
import type { ToolVectorIndex } from '../tool_index/tool_index.js';

/** 收敛管制评估结果（Assessment：allowed/state/target/reason，鸭子协议）。 */
export interface ConvergenceAssessment {
  /** 是否放行提案（false = 冷却/冻结期显式拒绝）。 */
  allowed: boolean;
  /** 拒绝状态（cooldown/frozen 等，随响应回传供调用方换策略）。 */
  state: string;
  /** 管制目标（如 ``theme:theme`` 形态的演化对象定位）。 */
  target: string;
  /** 拒绝原因（用户可读）。 */
  reason: string;
}

/**
 * 演化收敛管制钩子（可选前置闸门，依赖倒置）。
 *
 * 宿主实现 ``assess(records, kind, payload) -> Assessment`` 语义——
 * 冷却/冻结期显式拒绝提案，AI 据此换方向而非反复撞闸。
 */
export interface ConvergenceHook {
  assess(
    records: readonly Record<string, unknown>[],
    kind: string,
    payload: Record<string, unknown>,
  ): ConvergenceAssessment | Promise<ConvergenceAssessment>;
}

/** 工具标签写引用（绑定 = 给当前会话 thread 打标签；返回可为 Promise）。 */
export type ToolTagger = (name: string, tag: string) => unknown;

/** 端点探活回调（``name -> dict | null``）：返回工具端点是否可用。 */
export type EndpointProbe = (name: string) => Record<string, unknown> | null;

/**
 * 执行器节点上下文 seam 子集（鸭子类型，graph 引擎节点 ctx 满足）：
 * interrupt/挂起重入 + 自指工具读取的 round_id/thread_id。
 */
export interface SelfToolNodeContext extends ApprovalInterruptContext {
  /** 回合标识（审计/提案 meta 留痕用；缺省 null）。 */
  round_id?: string | null;
  /** 会话 thread id（request_tool 绑定打标用；缺省 = 不落标签）。 */
  thread_id?: string | null;
}

/** SelfToolContext 构造选项（对应 Python dataclass 字段）。 */
export interface SelfToolContextInit {
  /** 自指应用管线（校验/审批/落链/回退/审计入口）。 */
  self_pipeline: SelfApplicationPipeline;
  /** 集内 harness 注册表（领域生成器的重名判定）。 */
  harness_registry?: HarnessRegistry | null;
  /** 知识集（领域生成器的相关经验检索源）。 */
  knowledge_set?: KnowledgeSet | null;
  /** 演化收敛管制钩子（None = 不启用前置闸门）。 */
  convergence?: ConvergenceHook | null;
  /** 宿主级审批策略（种子沉淀等宿主扩展卡；None = 宿主扩展自带默认策略）。 */
  interrupt_policy?: unknown;
  /** 工具向量索引（search_tools/request_tool 的检索后端；None = 关键词基线降级）。 */
  tool_index?: ToolVectorIndex | null;
  /** 工具标签写引用（单源 + 标签：绑定 = 给当前会话 thread 打标签，会话
   *  窗口恒注入；None = 绑定不落标签——离线/单测形态退化为纯校验）。 */
  tool_tagger?: ToolTagger | null;
  /** 端点探活回调（None = 不探活——绑定/检索响应不带端点状态）。 */
  endpoint_probe?: EndpointProbe | null;
}

/** 自指工具的执行上下文（宿主装配注入，运行期取用）。 */
export class SelfToolContext {
  readonly self_pipeline: SelfApplicationPipeline;
  readonly harness_registry: HarnessRegistry | null;
  readonly knowledge_set: KnowledgeSet | null;
  readonly convergence: ConvergenceHook | null;
  readonly interrupt_policy: unknown;
  readonly tool_index: ToolVectorIndex | null;
  readonly tool_tagger: ToolTagger | null;
  readonly endpoint_probe: EndpointProbe | null;

  constructor(init: SelfToolContextInit) {
    this.self_pipeline = init.self_pipeline;
    this.harness_registry = init.harness_registry ?? null;
    this.knowledge_set = init.knowledge_set ?? null;
    this.convergence = init.convergence ?? null;
    this.interrupt_policy = init.interrupt_policy ?? null;
    this.tool_index = init.tool_index ?? null;
    this.tool_tagger = init.tool_tagger ?? null;
    this.endpoint_probe = init.endpoint_probe ?? null;
  }
}

/** 契约自指工具执行器签名（ctx/spec/args/approval → JSON 文本）。 */
export type SelfToolExecutor = (
  ctx: SelfToolNodeContext,
  spec: ToolSpec,
  args: Record<string, unknown>,
  approval: unknown,
) => Promise<string>;
