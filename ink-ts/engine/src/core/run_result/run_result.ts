/**
 * 运行结果契约与执行选项（纯数据形态，引擎执行语义在 executor）——run_result.py
 * 移植。
 *
 * 本模块承载单次 run 的**配置面**（RunOptions：存储/传输/预算/schema/计划/推演/
 * 调配全部注入式，引擎不持有产品实现）与**结果面**（RunResult：最终状态 +
 * 终止原因 + 中断点 + 事件统计）——两类纯数据契约独立成模块，executor 与其
 * 消费方共用同一形态。
 *
 * 依赖方向：本模块只依赖其他 core 契约模块（plan/simulation/storage/state/
 * budget/events/registry/assembly/tuning/interrupt），不依赖 executor 执行
 * 语义——供引擎重建装配（runtime）、测试与宿主导入而不必携带执行实现。
 *
 * Python 差异：
 * - ``system_events`` 的 frozenset 以 ReadonlySet 承载（构造传 Set/ReadonlySet）；
 * - ``settle``/``output_verifier``/``assembly_sources``/``plan_workflow`` 在
 *   Python 为 ``Any``/TYPE_CHECKING 前向引用（settle 模块未移植），此处以
 *   unknown 占位——契约模块移植后收敛为对应类型。
 */
import type { Storage } from '../storage/storage.js';
import type { StateSchema } from '../state/schema.js';
import type { BudgetManager } from '../budget/budget.js';
import type { EngineTransport } from '../events/events.js';
import type { InterruptState } from '../interrupt/interrupt_types.js';
import type { GraphRegistries } from '../registry/registry.js';
import type { BranchMixer, Evaluator } from '../simulation/simulation_types.js';
import type { AssemblyConfig } from '../assembly/assembly_config.js';
import type { ActivationAggregator } from '../assembly/activation_aggregator.js';
import type { TurnMetrics } from '../tuning/_turn_metrics.js';
import { DEFAULT_MAX_PLAN_STEPS } from '../plan/plan.js';
import { DEFAULT_MAX_SIMULATIONS } from '../simulation/simulation.js';

/**
 * RunOptions 构造选项（对齐 Python dataclass 关键字参：字段同名可选；
 * 缺省 = 类字段默认值，见 RunOptions 逐字段注释）。
 */
export type RunOptionsInit = Partial<RunOptions>;

/**
 * 单次 run 的引擎配置（DI：存储/传输/预算/状态 schema 均注入）。
 *
 * 字段默认值逐项对齐 Python dataclass（含 DEFAULT_MAX_PLAN_STEPS /
 * DEFAULT_MAX_SIMULATIONS 常量、transports/system_events 逐实例新建），
 * 实例可变——executor 运行时按 Python 语义就地改选分支（branch_pick）等。
 */
export class RunOptions {
  /** 存储服务（null = 纯内存执行，不持久化）。 */
  storage: Storage | null = null;

  /** 状态通道 schema（null = 全部裸通道覆盖语义）。 */
  schema: StateSchema | null = null;

  /** 预算管理器（null = 不检查）。 */
  budget: BudgetManager | null = null;

  /** 事件传输列表（None = 仅执行不消费；Python 默认空表，本移植逐实例新建）。 */
  transports: EngineTransport[] = [];

  /** 节点异常重试次数（0 = 不重试，直接终止）。 */
  max_node_retries: number = 0;

  /** True = 节点异常终止本轮（reason=error）；False = 跳过异常节点继续
   *  （reason=stop 语义由业务边决定）。 */
  error_on_exception: boolean = true;

  /** 单次展开的子任务清单数量上限（成本护栏：清单超限即节点失败，防拆解爆炸）。 */
  max_spawns: number = 16;

  /** spawn 实例并发上限（fan_out 限流）。 */
  spawn_concurrency: number = 4;

  /** 子链嵌套深度上限（成本护栏：子图/实例/分支外再展开子单元时校验，超限即
   *  节点失败——fail-closed，防递归嵌套成本爆炸）。0 = 允许任意深度。 */
  spawn_max_depth: number = 2;

  /** 子链执行步数上限（成本护栏：推演分支/多径支流/spawn 实例执行步数超限 =
   *  该子单元失败（剔除，不静默提交）——fail-closed）。0 = 不校验。 */
  simulate_max_branch_steps: number = 16;

  /** 执行回路护栏（成本护栏：纯静态边回路无可达出口时 compile 不拒绝，执行器
   *  按单节点访问次数兜底截止——不依赖预算钩子注入，0 = 不校验）。条件边驱动的
   *  合法循环（回指自身直至条件满足）不受影响：护栏只拦节点访问次数超限的失控
   *  回路。 */
  max_cycle: number = 64;

  /** 当前子链深度（内部传播字段：子图/实例/分支执行引擎经构造继承，作为嵌套
   *  校验的基准；非用户配置，由装配默认 0 = 根图）。 */
  spawn_depth: number = 0;

  /** 链级 rebase 窗口：链长超出后压缩历史前缀（窗口外行删除、窗口最旧行改链头、
   *  事件日志连带裁剪）——恢复/巡检从 O(链长) 降为 O(窗口)。编辑重放
   *  （parent_checkpoint 分叉）期间跳过：分叉锚点可能落在窗口外。 */
  checkpoint_keep: number = 256;

  /** 系统信号事件集合（宿主协议注入）：命中的事件类型强制 step_id=null、不入
   *  回合步骤序列（机制层默认空——不预置任何领域事件名）。 */
  system_events: ReadonlySet<string> = new Set<string>();

  /** 运行时重规划（__plan__）配置：loose = 计划落在约束域内任意节点；
   *  strict = 计划须满足约束域边序。 */
  plan_policy: string = 'loose';

  /** 计划步数上限（成本护栏，0 = 禁用计划）。 */
  max_plan_steps: number = DEFAULT_MAX_PLAN_STEPS;

  /** 工作流约束域（WorkflowSpec：计划节点/边须落在其内；null = 按图校验）。 */
  plan_workflow: unknown = null;

  /** 并行节点组并发上限。 */
  parallel_concurrency: number = 4;

  /** 建图注册表（spawn 子图数据/计划条件的解析来源；null = 不启用数据形态）。 */
  registries: GraphRegistries | null = null;

  /** 分支评估器（null = 节点返回 __simulate__ 时拒绝）。 */
  evaluator: Evaluator | null = null;

  /** 分支调配策略（null = BestBranchMixer 单选）。 */
  branch_mixer: BranchMixer | null = null;

  /** 推演分支数上限（成本护栏，0 = 禁用）。 */
  max_simulations: number = DEFAULT_MAX_SIMULATIONS;

  /** 推演分支并发上限。 */
  simulate_concurrency: number = 2;

  /** 换选分支序号（null = 正常择优）：回溯换选时强制改选指定分支——经
   *  Engine.swap_branch 设置，重放期间决策点按该分支提交主线。 */
  branch_pick: number | null = null;

  /** 输入调配管线（执行语义：每次 LLM 调用/节点执行前多源统一调配）；
   *  null = 未启用，调用点走旧路径。 */
  assembly: AssemblyConfig | null = null;

  /** 装配源提供者（null = 引擎不自动装配，节点自行经 ctx.assemble 提供源）：
   *  节点执行前引擎自动调用一次取源并统一调配，节点内 assemble 复用预装配
   *  结果（不重复装配/不重复留痕）。 */
  assembly_sources: unknown = null;

  /** 激活聚合器（ENG12 接线4：InputAssembler 挂载点）：随 InputAssembler 实例化
   *  时注入，每次装配留痕同步喂聚合器，衔接知识集归档/进化优先级；null = 不
   *  聚合（输入调配器按原语义运行）。 */
  assembly_aggregator: ActivationAggregator | null = null;

  /** 回合指标聚合（引擎自承载的观测件）：注入后顶层 run 收尾时自动记录回合成败
   *  与错误摘要（评审分/收敛轮数/挡位调用由使用方按事件语义填报——引擎只采集
   *  自身可见的执行事实）；null = 不采集。 */
  metrics: TurnMetrics | null = null;

  /** 上下文域（证据归因的聚合键：边证据永远按域分组，不做跨域平均；null = 登记
   *  到缺省域）。 */
  domain: string | null = null;

  /** 沉淀钩子注册体（run 收尾触发；null = 关闭沉淀，运行侧零影响）。settle
   *  模块未移植，类型以 unknown 占位（迁移后收敛为 SettleHooks）。 */
  settle: unknown = null;

  /** VTM 验证器门控：节点产出评审器（OutputVerifier 协议，async verify(...) ->
   *  {"pass", "violations"}）。null = 关闭（节点即使声明 __verify__ 也不评审，
   *  既有图零行为变化）。 */
  output_verifier: unknown = null;

  /** 评审失败后的违规驱动重做上限（0 = 失败即按节点失败收口；节点重跑时读
   *  state["__verify_feedback__"] 做定向修复）。 */
  verify_retry_limit: number = 0;

  /** 组装时间线事件开关（turn_started/assembly_started/assembly_done/
   *  execution_started，顶层图发射）：UX 指标（user_msg -> 组装 -> 真正执行
   *  用户任务的墙钟）。默认关闭 = 既有事件协议零变化，宿主按需开启。 */
  emit_timeline_events: boolean = false;

  constructor(init: RunOptionsInit = {}) {
    Object.assign(this, init);
  }
}

/** RunResult 构造选项（state/reason 必填；其余缺省 = 类字段默认值）。 */
export interface RunResultInit {
  state: Record<string, unknown>;
  reason: string;
  checkpoint_id?: number | null;
  interrupt?: InterruptState | null;
  events_emitted?: number;
  error?: string | null;
}

/**
 * run 执行结果（最终状态 + 终止原因 + 中断点 + 事件统计）。
 *
 * Python 为可变 dataclass（无 frozen）：executor 收尾阶段按语义原位补记
 * checkpoint_id/interrupt/events_emitted/error，实例可变以镜像同一行为。
 */
export class RunResult {
  state: Record<string, unknown>;
  reason: string;
  checkpoint_id: number | null = null;
  interrupt: InterruptState | null = null;
  events_emitted: number = 0;
  error: string | null = null;

  constructor(init: RunResultInit) {
    this.state = init.state;
    this.reason = init.reason;
    if (init.checkpoint_id !== undefined) this.checkpoint_id = init.checkpoint_id;
    if (init.interrupt !== undefined) this.interrupt = init.interrupt;
    if (init.events_emitted !== undefined) this.events_emitted = init.events_emitted;
    if (init.error !== undefined) this.error = init.error;
  }

  /** 序列化为数据形态（state 原样透传；interrupt 为 null 时输出 null）。 */
  to_dict(): Record<string, unknown> {
    return {
      state: this.state,
      reason: this.reason,
      checkpoint_id: this.checkpoint_id,
      interrupt: this.interrupt === null ? null : this.interrupt.to_dict(),
      events_emitted: this.events_emitted,
      error: this.error,
    };
  }
}

