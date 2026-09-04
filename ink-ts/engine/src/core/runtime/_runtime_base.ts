/**
 * Runtime 字段基座（runtime.py ``Runtime.__init__`` 移植）。
 *
 * 运行时 = 装配产物持有者 + 生命周期状态机（进程级）。本文件只承载实例
 * 字段与构造；生命周期/回合登记/工具清单/引擎重建/装配沿分层链逐文件
 * 实现（分层依据 = Python 类内机制边界，成员公开且带 ``_`` 前缀——
 * 与 executor 分层链同纪律）。
 *
 * 确定性 seam：在途 run 凭证 id 走自增确定十六进制（等价 uuid4().hex 的
 * 形状，core 零随机零 IO 可复现）；thread 标签时间戳经模块时钟注入面。
 */

import type { Engine } from '../executor/index.js';
import type { GraphRegistries } from '../registry/registry.js';
import type { KnowledgeSet } from '../knowledge_set/index.js';
import type {
  HarnessRegistry,
  HarnessRepository,
} from '../harness/index.js';
import type { EventTypeRegistry } from '../event_types/registry.js';
import type { EntityRegistry } from '../entities/entities.js';
import type { ProposalValidator } from '../self_proposal/index.js';
import type { ToolVetting } from '../tool_vetting/tool_vetting.js';
import type { IntrospectionService } from '../introspection/index.js';
import type { ToolPipeline } from '../tool_pipeline/tool_pipeline.js';
import type { SelfApplicationPipeline } from '../self_application/index.js';
import type { RetrieverRegistry } from '../retrieval/index.js';
import type { PoolGovernance } from '../pool_governance/pool_governance.js';
import type { MetaTuner, TurnMetrics } from '../tuning/index.js';
import type { ToolVectorIndex } from '../tool_index/tool_index.js';
import type { ToolSelector } from '../tool_orchestrator/tool_orchestrator.js';
import type { ToolSpec } from '../llm/tools.js';
import type { AsyncLLM } from '../llm/_guard_types.js';
import type { GrowthPipeline } from '../growth/index.js';
import type { EntityEvolutionPipeline } from '../entity_evolution/index.js';
import type { AssemblyRecipe, Host } from './_types.js';
import { BASELINE_TOOL_NAMES, TAG_IMMUTABLE } from './_constants.js';

/** 确定性在途 run 凭证 id 源（自增 32 位十六进制）。 */
let _ticket_seq = 0;
function _uuid_hex(): string {
  _ticket_seq += 1;
  return _ticket_seq.toString(16).padStart(32, '0');
}

/** 时间 seam（thread 标签 TTL 判定用；测试可经 set_runtime_clock 注入）。 */
let _runtime_clock: () => number = () => Date.now() / 1000;
export function set_runtime_clock(fn: (() => number) | null): void {
  _runtime_clock = fn ?? (() => Date.now() / 1000);
}
export function _time_now(): number {
  return _runtime_clock();
}

/** Runtime 抽象基座：字段/构造 + 状态观察 + 在途落库收口。 */
export abstract class RuntimeBase {
  _state: string = 'uninitialized';
  _host: Host | null = null;
  _recipe: AssemblyRecipe | null = null;
  // 宿主审批策略（Host 五件套之一）：boot 时取用一次，经自指工具上下文
  // 供宿主级审批卡消费
  _host_policy: unknown = null;
  // 在途 run 登记表 + 排空信号（stop 据此等待自然完成）
  _active_runs: Record<string, { id: string }> = {};
  _drained: { done: boolean; waiters: Array<() => void> } = {
    done: true,
    waiters: [],
  };
  _active_ticket_id: string | null = null;
  _active_run_task: { done(): boolean; cancel(): void; then(...a: unknown[]): unknown } | null = null;
  _active_run_thread: string | null = null;
  // 引擎重建缓存身份（配置/工具表变更才重建；is 比较 + 工具表名集合）
  _engine_storage: Storage | null = null;
  _engine_spec_key: readonly string[] | null = null;
  // 在途知识落库任务集合 + 变更钩子
  _persist_tasks: Set<Promise<unknown>> = new Set();
  _knowledge_mutation_hook: (() => void) | null = null;

  /** MCP 会话管理器 seam（宿主适配器；未注入 = 不启用，stop 跳过）。
   *  Python 侧 McpClientManager 属引擎 adapters/宿主装配面，未迁入 core。 */
  mcp_manager: { close_all(): Promise<unknown> } | null = null;

  // ── 装配产物（boot 后齐备；null = 未装配）──
  storage: import('../self_application/guarded_storage.js').GuardedStorage | null = null;
  guard_token: string | null = null;
  graph_registries: GraphRegistries | null = null;
  knowledge_set: KnowledgeSet | null = null;
  harness_registry: HarnessRegistry | null = null;
  harness_repository: HarnessRepository | null = null;
  event_type_registry: EventTypeRegistry | null = null;
  entity_registry: EntityRegistry | null = null;
  entity_evolution_pipeline: EntityEvolutionPipeline | null = null;
  growth_pipeline: GrowthPipeline | null = null;
  validator: ProposalValidator | null = null;
  vetting: ToolVetting | null = null;
  introspection_service: IntrospectionService | null = null;
  introspection_specs: readonly ToolSpec[] = [];
  introspection_pipeline: ToolPipeline | null = null;
  self_pipeline: SelfApplicationPipeline | null = null;
  self_specs: readonly ToolSpec[] = [];
  self_pipeline_runner: ToolPipeline | null = null;
  retriever_registry: RetrieverRegistry | null = null;
  tool_pipeline: ToolPipeline | null = null;
  meta_tuner: MetaTuner | null = null;
  turn_metrics: TurnMetrics | null = null;
  // 宿主动态工具表（挂载/从链恢复的工具定义；统一分发第三路）
  tool_registry: Record<string, ToolSpec> = {};
  // 工具标签表（immutable/baseline/thread:<id>）
  _tool_tags: Record<string, Set<string>> = {};
  _thread_tag_created: Record<string, number> = {};
  _tags_lock = false;
  pool_governance: PoolGovernance | null = null;
  _round_knowledge_hits: Set<string> = new Set();
  tool_index: ToolVectorIndex | null = null;
  tool_selector: ToolSelector | null = null;
  _baseline_names: ReadonlySet<string> = BASELINE_TOOL_NAMES;
  _ui_factory_components: ReadonlySet<string> = new Set();
  _ui_components_disabled: ReadonlySet<string> = new Set();
  engine: Engine | null = null;
  engine_llm: AsyncLLM | null = null;

  // 生命周期状态（观察侧；转换只能经 pause/resume/stop）
  get state(): string {
    return this._state;
  }

  /** 等待在途知识落库任务完成（异常已在任务内记录，此处只收口）。 */
  async _drain_persist_tasks(): Promise<void> {
    const pending = [...this._persist_tasks];
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
    this._persist_tasks = new Set();
  }

  // 在途登记（begin_run 发放 id；排空信号原语）
  _signal_drained(): void {
    const waiters = this._drained.waiters;
    this._drained.done = true;
    this._drained.waiters = [];
    for (const waiter of waiters) waiter();
  }
}

export { _uuid_hex, TAG_IMMUTABLE };
