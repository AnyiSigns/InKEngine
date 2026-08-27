"""运行结果契约与执行选项（纯数据形态，引擎执行语义在 executor）。

本模块承载单次 run 的**配置面**（:class:`RunOptions`：存储/传输/预算/
schema/计划/推演/调配全部注入式，引擎不持有产品实现）与**结果面**
（:class:`RunResult`：最终状态 + 终止原因 + 中断点 + 事件统计）——
两类纯数据契约独立成模块，executor 与其消费方共用同一形态。

依赖方向：本模块只依赖其他 core 契约模块（plan/simulation/storage/
state/budget/events/registry/assembly/tuning/interrupt），不依赖
executor 执行语义——供 engine 重建装配（runtime.py）、测试与宿主
导入而不必携带执行实现。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from .assembly import AssemblyConfig
from .budget import BudgetManager
from .events import EngineTransport
from .interrupt import InterruptState
from .plan import DEFAULT_MAX_PLAN_STEPS
from .registry import GraphRegistries
from .simulation import DEFAULT_MAX_SIMULATIONS, BranchMixer, Evaluator
from .state import StateSchema
from .storage import Storage
from .tuning import TurnMetrics

if TYPE_CHECKING:
    from .settle import SettleHooks


@dataclass(slots=True)
class RunOptions:
    """单次 run 的引擎配置（DI：存储/传输/预算/状态 schema 均注入）。

    Attributes:
        storage: 存储服务（None = 纯内存执行，不持久化）。
        schema: 状态通道 schema（None = 全部裸通道覆盖语义）。
        budget: 预算管理器（None = 不检查）。
        transports: 事件传输列表（None = 仅执行不消费）。
        max_node_retries: 节点异常重试次数（0 = 不重试，直接终止）。
        error_on_exception: True = 节点异常终止本轮（reason=error）；
            False = 跳过异常节点继续（reason=stop 语义由业务边决定）。
        max_spawns: 单次展开的子任务清单数量上限（成本护栏：清单
            超限即节点失败，防拆解爆炸）。
        spawn_concurrency: spawn 实例并发上限（fan_out 限流）。
        checkpoint_keep: 版本链每叶路径保留行数（链级 rebase 窗口；
            0 = 禁用压缩，历史逐节点全量保留，链长随执行线性增长）。
    """

    storage: Storage | None = None
    schema: StateSchema | None = None
    budget: BudgetManager | None = None
    transports: list[EngineTransport] = field(default_factory=list)
    max_node_retries: int = 0
    error_on_exception: bool = True
    max_spawns: int = 16
    spawn_concurrency: int = 4
    # 子链嵌套深度上限（成本护栏：子图/实例/分支外再展开子单元时校验，
    # 超限即节点失败——fail-closed，防递归嵌套成本爆炸）。0 = 允许任意深度。
    spawn_max_depth: int = 2
    # 子链执行步数上限（成本护栏：推演分支/多径支流/spawn 实例执行步数
    # 超限 = 该子单元失败（剔除，不静默提交）——fail-closed）。0 = 不校验。
    simulate_max_branch_steps: int = 16
    # 执行回路护栏（成本护栏：纯静态边回路无可达出口时 compile 不拒绝，
    # 执行器按单节点访问次数兜底截止——不依赖预算钩子注入，0 = 不校验）。
    # 条件边驱动的合法循环（回指自身直至条件满足）不受影响：护栏只拦
    # 节点访问次数超限的失控回路。
    max_cycle: int = 64
    # 当前子链深度（内部传播字段：子图/实例/分支执行引擎经构造继承，
    # 作为嵌套校验的基准；非用户配置，由装配默认 0 = 根图）。
    spawn_depth: int = 0
    # 链级 rebase 窗口：链长超出后压缩历史前缀（窗口外行删除、窗口最旧
    # 行改链头、事件日志连带裁剪）——恢复/巡检从 O(链长) 降为 O(窗口)。
    # 编辑重放（parent_checkpoint 分叉）期间跳过：分叉锚点可能落在窗口外。
    checkpoint_keep: int = 256
    # 系统信号事件集合（宿主协议注入）：命中的事件类型强制 step_id=None、
    # 不入回合步骤序列（机制层默认空——不预置任何领域事件名）
    system_events: frozenset[str] = frozenset()
    # 运行时重规划（__plan__）配置
    plan_policy: str = "loose"  # loose = 计划落在约束域内任意节点；strict = 计划须满足约束域边序
    max_plan_steps: int = DEFAULT_MAX_PLAN_STEPS  # 计划步数上限（成本护栏，0 = 禁用计划）
    plan_workflow: Any = None  # 工作流约束域（WorkflowSpec：计划节点/边须落在其内；None = 按图校验）
    parallel_concurrency: int = 4  # 并行节点组并发上限
    # 建图注册表（spawn 子图数据/计划条件的解析来源；None = 不启用数据形态）
    registries: GraphRegistries | None = None
    # 决策点推演（__simulate__）配置
    evaluator: Evaluator | None = None  # 分支评估器（None = 节点返回 __simulate__ 时拒绝）
    branch_mixer: BranchMixer | None = None  # 分支调配策略（None = BestBranchMixer 单选）
    max_simulations: int = DEFAULT_MAX_SIMULATIONS  # 推演分支数上限（成本护栏，0 = 禁用）
    simulate_concurrency: int = 2  # 推演分支并发上限
    # 换选分支序号（None = 正常择优）：回溯换选时强制改选指定分支——
    # 经 Engine.swap_branch 设置，重放期间决策点按该分支提交主线
    branch_pick: int | None = None
    # 输入调配管线（执行语义：每次 LLM 调用/节点执行前多源统一调配）
    assembly: AssemblyConfig | None = None  # 装配配置（None = 未启用，调用点走旧路径）
    # 装配源提供者（None = 引擎不自动装配，节点自行经 ctx.assemble 提供
    # 源）：节点执行前引擎自动调用一次取源并统一调配，节点内 assemble
    # 复用预装配结果（不重复装配/不重复留痕）
    assembly_sources: Any = None
    # 回合指标聚合（引擎自承载的观测件）：注入后顶层 run 收尾时自动
    # 记录回合成败与错误摘要（评审分/收敛轮数/挡位调用由使用方按事件
    # 语义填报——引擎只采集自身可见的执行事实）；None = 不采集
    metrics: TurnMetrics | None = None
    # 上下文域（证据归因的聚合键：边证据永远按域分组，不做跨域平均；
    # None = 登记到缺省域）
    domain: str | None = None
    # 沉淀钩子注册体（run 收尾触发；None = 关闭沉淀，运行侧零影响）
    settle: SettleHooks | None = None


@dataclass(slots=True)
class RunResult:
    """run 执行结果（最终状态 + 终止原因 + 中断点 + 事件统计）。"""

    state: dict
    reason: str
    checkpoint_id: int | None = None
    interrupt: InterruptState | None = None
    events_emitted: int = 0
    error: str | None = None

    def to_dict(self) -> dict:
        return {
            "state": self.state,
            "reason": self.reason,
            "checkpoint_id": self.checkpoint_id,
            "interrupt": self.interrupt.to_dict() if self.interrupt else None,
            "events_emitted": self.events_emitted,
            "error": self.error,
        }


__all__ = ["RunOptions", "RunResult"]
