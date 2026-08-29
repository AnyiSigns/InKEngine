"""运行时机壳：Host 嵌入契约 + 装配数据 + 生命周期（进程级装配与运行态）。

引擎 = 库之上、宿主之下的中间层：Runtime 把「怎么装配引擎」从宿主
装配配方（boot 样板）升级为引擎公开机制——装配决策全部数据化
（:class:`AssemblyRecipe`），宿主只提供五件套契约（存储工厂/模型解析/
审批策略/事件传输工厂/关停钩子）。web/CLI/桌面/stdio 皆为宿主之一，
换壳 = 换配方 + 换五件套，机制层不感知宿主形态。

与 :class:`~ink_engine.core.executor.Engine` 的分工：
- Engine = 单次 run 执行（图执行/checkpoint/interrupt/注入重入）；
- Runtime = 进程级装配产物与生命周期（boot/rebuild/pause/resume/stop
  + 在途 run 登记 + 审批决议重入样板）。

生命周期状态机：uninitialized → running → paused → stopped。pause 只
拒新 run、不强制打断在途 run（回合是短任务，自然完成）；stop 拒新 →
等在途完成 → 关 MCP 会话 → 关存储 → 宿主关停钩子（顺序保证，幂等）。

装配数据（:class:`AssemblyRecipe`）与宿主产品解耦：配方字段只允许核心
类型与鸭子协议（架构门禁白名单强制）——宿主类型进入配方 = 机制层开始
认识宿主，违反零绑定承诺。
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field, fields, is_dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any, Iterable, Protocol, runtime_checkable

from .approval import InterruptPolicy
from .assembly import SOURCE_EVIDENCE, AssemblyConfig
from .context import CompressionPolicy, ContextSource, ThresholdCompressionPolicy
from .declarative_tools import endpoint_operation, endpoint_operation_failure_reason
from .event_types import EventTypeRegistry, EventTypeSpec, event_types_collection
from .events import EngineTransport
from .executor import Engine, RunOptions
from .graph import Graph, TerminateReason
from .harness import (
    HarnessDefinition,
    HarnessRegistry,
    HarnessRepository,
    harness_collection,
)
from .introspection import (
    IntrospectionService,
    IntrospectionSources,
    build_introspection_pipeline,
    introspection_tool_specs,
    make_introspection_executor,
)
from .knowledge_set import (
    _SOURCE_CREDIBILITY,
    KnowledgeEntry,
    KnowledgeSet,
    build_knowledge_sources,
)
from .llm import AsyncLLM
from .llm.guard import CompressingLLM, UsageTrackingLLM
from .llm.tools import ToolSpec
from .logging import get_logger
from .mcp_client import McpClientManager, register_mcp_executor
from .perception import register_perception_nodes
from .permissions import PermissionGate
from .pool_governance import PoolGovernance
from .registry import GraphRegistries
from .retrieval import KnowledgeSetRetriever, Retriever, RetrieverRegistry
from .seeds import seed_general, seed_knowledge_set
from .self_application import (
    ApplyTarget,
    ApprovalLevel,
    GuardedStorage,
    SelfApplicationPipeline,
)
from .self_proposal import PatchKind, ProposalValidator
from .self_tools import ConvergenceHook, SelfToolContext
from .storage import CheckpointRecord, Storage
from .tool_index import ToolVectorIndex, build_default_embedder
from .tool_orchestrator import ToolSelector
from .tool_pipeline import ToolPipeline
from .tool_vetting import ToolVetting
from .tuning import MetaTuner, TuneResult, TurnMetrics
from .ui_schema import DEFAULT_BIND_CHANNELS, UISchemaValidator

logger = get_logger(__name__)

# 回合装配检索上限（ENG3-16：limit=8 魔法数字常量化——与检索原语
# DEFAULT_LIMIT 同值，钳制回合注入上下文体积；分级口径见 _assembly_sources）
_ASSEMBLY_SOURCE_LIMIT = 8

# 保底 8+2 常驻集合（collect_specs 只注入这些完整 schema 进 tools 参数）。
# 保底 8 = file_read/file_write/file_edit/grep/glob（声明式）
#         + propose_patch/propose_domain_manifest（自指）+ inspect_tools（内省）
# +2 自指 = search_tools/request_tool
BASELINE_TOOL_NAMES: frozenset[str] = frozenset({
    "file_read", "file_write", "file_edit", "grep", "glob",
    "propose_patch", "propose_domain_manifest",
    "inspect_tools",
    "search_tools", "request_tool",
})

# 常驻必带集持久化（records 通道；集合不在演化资产守卫表内 = 直写放行）。
# 与壳侧 workspace_auth/app_capabilities 同通道形态，重启后由
# _restore_baseline 装载。
BASELINE_RECORD_COLLECTION = "runtime_config"
BASELINE_RECORD_KEY = "tool_baseline"

# 动态注册机制工具（search_tools/request_tool）：语义检索绑定非必带工具
# 的入口，永远强制常驻，用户不可摘除。
BASELINE_IMMUTABLE_TOOLS: frozenset[str] = frozenset({"search_tools", "request_tool"})

# 出厂界面组件启停持久化（records 通道；与常驻必带集同形态，重启经
# _load_ui_components_disabled 装载）。禁用集 ⊆ 配方 ui_allowed_components
# 出厂白名单，装配期过滤喂校验器与初始界面校验（三层白名单同源）。
UI_COMPONENTS_RECORD_COLLECTION = "runtime_config"
UI_COMPONENTS_RECORD_KEY = "ui_components_disabled"


def _spec_identity(spec: Any) -> str:
    """工具 spec 的确定性结构身份（供引擎缓存键使用）。

    取 spec 的确定性 JSON 序列化（排序键），使同名但被补丁改写的
    工具（端点/参数/协议等）产生不同身份，从而触发引擎重建（节点
    类型只注册一次，旧缓存命中会让差异化重写无效）。

    序列化来源按序尝试：``to_dict()``（ToolSpec 的数据形态）→
    ``model_dump()``（pydantic 形态）→ dataclass 字段 → ``repr``。
    ToolSpec 是 ``slots=True`` 冻结 dataclass（无 ``__dict__``），
    故不可用 ``vars()``——任何一步失败都回落，不得让缓存键计算抛错
    击穿引擎重建。
    """
    body: Any = None
    for attr in ("to_dict", "model_dump"):
        method = getattr(spec, attr, None)
        if callable(method):
            try:
                candidate = method()
            except Exception:
                continue
            if isinstance(candidate, dict):
                body = candidate
                break
    if body is None and is_dataclass(spec) and not isinstance(spec, type):
        try:
            body = {f.name: getattr(spec, f.name, None) for f in fields(spec)}
        except Exception:
            body = None
    if body is None:
        return repr(spec)
    try:
        return json.dumps(body, sort_keys=True, ensure_ascii=True, default=str)
    except Exception:
        return repr(body)


class _KnowledgeUsageSettleHook:
    """知识使用归因（settle 钩子）：回合收尾按成败对注入知识记 fail。

    演化候选的数据源闭环：回合装配注入知识（provide 命中即
    ``record_usage`` 成功留痕）→ 回合收尾若失败（错误/预算超限/异常
    终止），对本回合注入的知识条目补记 ``record_usage(failed=True,
    log=...)``——失败日志 = 反思式变异的输入（EvolutionFactory 按近期
    失败定向修订）。随后清空回合命中集合（回合边界）。

    观测侧语义：归因失败只记日志不阻断 run 结果交付（settle 钩子
    通用纪律）。
    """

    def __init__(self, runtime: Runtime) -> None:
        self._runtime = runtime

    async def settle(self, ctx: SettleContext) -> None:
        hits = getattr(self._runtime, "_round_knowledge_hits", None)
        if hits is None or not hits:
            return
        failed = _round_failed(ctx)
        failed_reason = _round_failure_reason(ctx)
        ks = self._runtime.knowledge_set
        if ks is not None:
            for entry_id in list(hits):
                try:
                    if failed:
                        ks.record_usage(
                            entry_id,
                            failed=True,
                            log=failed_reason or "回合失败（知识归因）",
                        )
                except Exception as exc:
                    logger.warning("知识失败归因记录失败（忽略）: %s: %s", entry_id, exc)
        hits.clear()

    def __repr__(self) -> str:
        return "_KnowledgeUsageSettleHook"


def _round_failed(ctx: SettleContext) -> bool:
    """回合失败判定（与证据归因 run_verdict 同语义：有失败结点 /
    错误收尾 / 预算截断 = 失败；中断挂起中性不算失败但也不记成功）。"""
    if any(getattr(s, "status", None) == "failed" for s in ctx.steps):
        return True
    reason = getattr(ctx.result, "reason", None)
    return reason in ("error", "budget_exceeded")


def _round_failure_reason(ctx: SettleContext) -> str | None:
    """失败原因摘要（记入失败日志，供进化工厂反思）。"""
    for step in ctx.steps:
        if getattr(step, "status", None) == "failed":
            note = getattr(step, "error", None) or getattr(step, "note", None)
            if note:
                return str(note)
    error = getattr(ctx.result, "error", None)
    if error:
        return str(error)
    reason = getattr(ctx.result, "reason", None)
    return f"回合{reason}" if reason else None


class RuntimeState(StrEnum):
    """运行时生命周期状态（显式枚举 + 转换守卫，非法转换显式报错）。"""

    UNINITIALIZED = "uninitialized"
    RUNNING = "running"
    PAUSED = "paused"
    STOPPED = "stopped"


@dataclass(frozen=True, slots=True)
class RunTicket:
    """在途 run 登记凭证（begin_run 发放，end_run 注销）。

    stop 排空依赖登记表：end_run 在宿主 run 收尾处调用（finally 兜底），
    全部注销后 stop 的等待解除。
    """

    id: str


@runtime_checkable
class Host(Protocol):
    """宿主嵌入契约（五件套；决议回流通道不在此——那是宿主自己的请求入口）。

    Attributes 语义（均为宿主职责，机制层只定义契约）:
        create_storage: 存储工厂（后端/路径/进程锁归宿主）。
        resolve_llm: 模型解析（配置/密钥归宿主；None = 未配置，路由端引导）。
        interrupt_policy: 审批策略（直过白名单/超时窗口归宿主）。
        build_transport: 事件传输工厂（web 每次 SSE 请求新建队列桥；
            stdio 返回单一 JSON 行传输——同一签名覆盖两种形态）。
        close: 关停钩子（宿主资源回收；Runtime.stop 在存储关闭后调用）。
    """

    async def create_storage(self) -> Storage: ...

    async def resolve_llm(self) -> AsyncLLM | None: ...

    def interrupt_policy(self) -> InterruptPolicy: ...

    def build_transport(self) -> EngineTransport: ...

    async def close(self) -> None: ...


@dataclass(slots=True)
class GraphRecipeContext:
    """图配方的装配期上下文（Runtime 已装配组件注入，宿主配方按需取用）。

    配方归宿主（图 = 宿主产品语义），但装配动作归机制层——上下文把
    Runtime 的装配产物以轻量容器交给配方，宿主不反向触碰装配内部。

    节点工厂生命周期契约（跨引擎重建的实时性）：graph_recipe 在每次
    rebuild_engine 时重跑，但**节点类型只注册一次**（注册表防重复登记）
    ——节点工厂及其产出的节点执行函数可能跨引擎重建存活。因此节点
    工厂**禁止捕获装配期可变状态快照**（如把 ``ctx.tool_specs`` /
    ``ctx.tool_pipeline`` 的值闭包进工厂/节点）：工具表与流水线随挂载/
    补丁演化/安全层替换而变化，快照闭包会让重建后的节点读到过期装配
    源。正确形态 = 实时引用：以 registry 实例为键持有最新装配源（种子
    侧惯用法为 WeakKeyDictionary 实时持有者），节点执行时现取——重建
    后新装配源对既有节点立即可见。详见 registry.py 的 NodeFactory 契约。
    """

    llm: AsyncLLM | None = None
    tool_pipeline: ToolPipeline | None = None
    tool_specs: Sequence[ToolSpec] = ()
    storage: Storage | None = None
    registries: GraphRegistries | None = None
    system_events: frozenset[str] = frozenset()
    assembly: AssemblyConfig | None = None
    assembly_sources: Any = None


@dataclass(slots=True)
class ToolWiring:
    """统一工具分发的宿主差异声明（三路路由机制本身在 Runtime）。

    self_specs: 宿主自指工具清单工厂（内核 4 契约工具 + 宿主扩展）。
    self_executor_factory: 宿主自指执行器工厂 (pipeline, context_getter)，
        契约工具走内核行为、扩展工具走宿主实现。
    self_operation_of: 宿主合并后的自指操作判定（单一判定来源）。
    """

    self_specs: Callable[[], list[ToolSpec]]
    self_executor_factory: Callable[[SelfApplicationPipeline, Callable[[], Any]], Any]
    self_operation_of: Callable[[ToolSpec], tuple[str, str]]


@dataclass(slots=True)
class AssemblyRecipe:
    """装配数据：怎么装配引擎 = 数据（宿主换壳 = 换配方，机制层不感知）。

    字段类型只允许核心类型 + 鸭子协议（架构门禁文本级白名单强制）：
    宿主类型进入配方 = 机制层认识宿主，违反零绑定承诺。

    Attributes:
        set_id: 用户集 id（存储隔离键）。
        seeds: 种子注入清单 [(name, entries_provider)]（通用基线恒注）。
            种子条目为内存态启动注入基线（不在补丁链上），带补丁重启后
            由宿主重注入并与链段恢复条目按 id 去重——链只承载演化，
            种子是出厂数据不是演化。
        harness_definitions: 自举 harness 定义清单（注册 + 落库）。
        event_type_specs: 事件类型基线（装配期登记 + 集内演化类型加载）。
        ui_spec: 界面基线（装配期经三层白名单校验；损坏回落未定形）。
        ui_allowed_channels: 界面绑定通道白名单（默认仅回合状态通道
            "state"；产品需事件流/内省快照绑定通道时由装配数据放行，
            校验器与渲染器同源）。
        ui_allowed_components: 界面组件白名单（校验器与渲染器同源）。
        ui_allowed_theme_tokens: 主题 token 白名单。
        tool_wiring: 统一工具分发声明（三路 specs + 执行器/判定工厂）。
        vetting_static_hooks: 静态审查钩子清单（工具可信度闸门；None = 未
            启用，非 None 但清单为空 = 启用了但空清单——装配期 warn 提示
            可观测性，防「以为启用了实际零钩子生效」）。
        vetting_l2_hook: L2 沙箱验证钩子（构建产物引用的部署前门禁）。
        approval_levels: 审批分级表（kind → L0/L1/L2）。
        retrieval_sources: 检索源工厂清单（接收装配产物，返回 Retriever）。
        apply_targets: 活跃态应用目标工厂（kind → 接收装配产物，返回
            ApplyTarget；补丁落链后的运行时生效钩子）。
        graph_recipe: 图配方（接收装配上下文，返回回合图）。
        on_reverted: 回退通知钩子（宿主行为信号触发点）。
        convergence_provider: 演化收敛管制钩子提供者（可选前置闸门；
            None = 不启用）。
        run_options: 执行域选项覆盖（None = 引擎默认；非 None 时按字段
            级覆盖装配默认——plan_policy/plan_workflow/budget/evaluator
            等执行约束经此注入，装配产物字段由 Runtime 注入不建议覆盖）。
        compress_policy: 回合内上下文压缩策略（None = 引擎默认
            :class:`ThresholdCompressionPolicy`，30 条 / 40000 字符——
            仅极端膨胀回合触发）。回合 LLM 调用前经
            :class:`~ink_engine.core.llm.guard.CompressingLLM` 应用。
    """

    set_id: str = "default"
    seeds: list[tuple[str, Callable[[], list[KnowledgeEntry]]]] = field(
        default_factory=list
    )
    harness_definitions: list[HarnessDefinition] = field(default_factory=list)
    event_type_specs: list[EventTypeSpec] = field(default_factory=list)
    ui_spec: dict | None = None
    ui_allowed_channels: tuple[str, ...] = DEFAULT_BIND_CHANNELS
    ui_allowed_components: tuple[str, ...] = ()
    ui_allowed_theme_tokens: tuple[str, ...] = ()
    tool_wiring: ToolWiring | None = None
    vetting_static_hooks: list[Callable[[Sequence[Path]], list[str]]] | None = None
    vetting_l2_hook: Callable[[Any], list[str]] | None = None
    approval_levels: dict[PatchKind, ApprovalLevel] = field(default_factory=dict)
    retrieval_sources: list[Callable[[Any], Retriever]] = field(default_factory=list)
    apply_targets: dict[PatchKind, Callable[[Any], ApplyTarget]] = field(
        default_factory=dict
    )
    graph_recipe: Callable[[GraphRecipeContext], Graph] | None = None
    on_reverted: Callable[[int, str], Any] | None = None
    convergence_provider: Callable[[], ConvergenceHook | None] | None = None
    run_options: RunOptions | None = None
    # 回合内上下文压缩策略（None = 引擎默认 ThresholdCompressionPolicy）
    compress_policy: CompressionPolicy | None = None


class Runtime:
    """运行时：装配产物持有者 + 生命周期状态机（进程级）。

    装配（boot）幂等；生命周期转换带守卫（非法转换显式报错）；stop
    幂等且按序关停（MCP 会话 → 存储 → 宿主钩子）。装配决策全部来自
    配方数据，Runtime 只做「读配方并执行装配」——装配动作是机制，
    不可被补丁链修改（与补丁链不能补丁自己同族的自指终止）。
    """

    def __init__(self) -> None:
        self._state = RuntimeState.UNINITIALIZED
        self._host: Host | None = None
        self._recipe: AssemblyRecipe | None = None
        # 宿主审批策略（Host 五件套之一）：boot 时取用一次，经自指工具
        # 上下文供宿主级审批卡（种子沉淀等）消费
        self._host_policy: Any | None = None
        # 在途 run 登记表 + 排空信号（stop 据此等待自然完成）
        self._active_runs: dict[str, RunTicket] = {}
        self._drained = asyncio.Event()
        # 中止追踪（abort_current_run 的依据）：最近一个在途 run 的任务
        # 句柄与回合线程（begin_run 时登记，end_run 时注销）。中止语义
        # 以「当前 run」为粒度——业务并发表是多 run 场景时，中止动作
        # 指向最近登记的 run（多任务并发路由主机自行管理各自任务的取消）。
        self._active_ticket_id: str | None = None
        self._active_run_task: asyncio.Task | None = None
        self._active_run_thread: str | None = None
        # 引擎重建缓存身份（配置/工具表变更才重建；is 比较 + 工具表名集合）
        self._engine_storage: Storage | None = None
        self._engine_spec_key: tuple[str, ...] | None = None
        # 知识集变更落库任务集合（on_mutation 钩子调度的 fire-and-forget
        # 落库任务；持有引用防 GC 提前回收）+ 变更钩子（链恢复替换知识集
        # 实例后重新挂钩用）
        self._persist_tasks: set[asyncio.Task[None]] = set()
        self._knowledge_mutation_hook: Callable[[], None] | None = None

        # ── 装配产物（boot 后齐备；None = 未装配）──
        self.storage: Storage | None = None
        self.guard_token: str | None = None
        self.graph_registries: GraphRegistries | None = None
        self.knowledge_set: KnowledgeSet | None = None
        self.harness_registry: HarnessRegistry | None = None
        self.harness_repository: HarnessRepository | None = None
        self.event_type_registry: EventTypeRegistry | None = None
        self.validator: ProposalValidator | None = None
        self.vetting: ToolVetting | None = None
        self.introspection_service: IntrospectionService | None = None
        self.introspection_specs: tuple[ToolSpec, ...] = ()
        self.introspection_pipeline: ToolPipeline | None = None
        self.self_pipeline: SelfApplicationPipeline | None = None
        self.self_specs: tuple[ToolSpec, ...] = ()
        self.self_pipeline_runner: ToolPipeline | None = None
        self.retriever_registry: RetrieverRegistry | None = None
        self.mcp_manager: McpClientManager | None = None
        self.tool_pipeline: ToolPipeline | None = None
        # 调参接线（E-P5）：回合指标聚合 + MetaTuner（round 结束后按
        # 失败信号调参；None = 未装配）
        self.meta_tuner: MetaTuner | None = None
        self.turn_metrics: TurnMetrics | None = None
        # 宿主动态工具表（挂载/从链恢复的工具定义；统一分发第三路）
        self.tool_registry: dict[str, ToolSpec] = {}
        # 池治理登记器（容量/淘汰/合并/预算四规则；只登记不执行）
        self.pool_governance: PoolGovernance | None = None
        # 本回合注入的知识条目 id（知识使用留痕：provide 命中即记，回合
        # 收尾按成败归因 usage/fail——演化候选（失败驱动）的数据源）
        self._round_knowledge_hits: set[str] = set()

        # 工具向量索引（工具注入瘦身）：search_tools/request_tool 的检索后端
        self.tool_index: ToolVectorIndex | None = None
        # 工具调配器（工具注入瘦身接线）：保底工具 priority 高 + 调用权重
        self.tool_selector: ToolSelector | None = None
        # 常驻必带工具集（出厂基线 = BASELINE_TOOL_NAMES；用户可在设置页
        # 增删——collect_specs 只注入本集合的完整 schema 进每回合 tools
        # 参数，其余工具经 search_tools/request_tool 动态绑定）
        self._baseline_names: frozenset[str] = BASELINE_TOOL_NAMES
        # 出厂界面组件白名单基线（= 配方 ui_allowed_components 未过滤全集；
        # 用户可在组件 tab 启停，停用集从活跃白名单剔除）
        self._ui_factory_components: frozenset[str] = frozenset()
        # 已停用出厂组件（装配期过滤 ui_allowed_components；records 持久化）
        self._ui_components_disabled: frozenset[str] = frozenset()
        self.engine: Engine | None = None
        self.engine_llm: AsyncLLM | None = None

    # ── 生命周期 ──

    @property
    def state(self) -> RuntimeState:
        """当前生命周期状态（观察侧；转换只能经 pause/resume/stop）。"""
        return self._state

    async def boot(self, host: Host, recipe: AssemblyRecipe) -> Runtime:
        """装配运行时（幂等：已装配再次调用直接返回自身）。

        装配顺序（机制依赖自上而下）：存储 → 图注册表 → 种子 → harness
        → 事件类型 → 校验器/vetting → 应用管线 → 界面基线 → 元工具
        流水线 → 调配源 → MCP 管理器 → 统一工具流水线 → 从链恢复 →
        apply 目标注册 → 引擎重建。不含任何宿主产品内容（宿主产品经
        配方钩子注入，装配动作本身是机制）。

        失败语义（非事务化，最小可用）：中途异常时装配步骤本身不回滚
        （链/仓库为 append-only 权威记录，落库写入幂等——重试不重复
        追加），但已建**进程级资源**（MCP 会话/LLM 链/存储连接）尽力
        关闭后原样上抛，不留悬置连接；状态保持未装配态（可重试 boot）。
        """
        if self._state is RuntimeState.RUNNING:
            return self
        if self._state is not RuntimeState.UNINITIALIZED:
            raise RuntimeError(f"运行时不处于未装配态，无法装配: {self._state}")
        if recipe.tool_wiring is None:
            raise RuntimeError("装配配方缺工具三路声明（tool_wiring）")
        if recipe.graph_recipe is None:
            raise RuntimeError("装配配方缺图配方（graph_recipe）")
        self._host = host
        self._recipe = recipe
        try:
            await self._assemble(host, recipe)
        except BaseException as exc:
            # 装配失败显式留痕 + 资源回收（静默失败会让宿主拿到半装配
            # 运行时；此处只回收资源，异常原样上抛交宿主处置）
            logger.error("运行时装配失败（已回收装配中资源，原样上抛）: %s", exc)
            await self._boot_cleanup()
            raise
        self._drained.set()
        self._state = RuntimeState.RUNNING
        return self

    async def _boot_cleanup(self) -> None:
        """装配失败的资源回收（各步独立容错；失败只记日志不掩盖原异常）。

        回收对象 = 进程级资源（MCP 远端会话 → LLM 链 → 存储连接），顺序
        与 :meth:`stop` 一致；宿主关停钩子不在此调用（宿主的资源由宿主
        自己在 boot 失败路径处置，Runtime 不越界代关）。
        """
        # 在途知识落库任务先收口：存储将被关闭，悬置的 save 只会报错
        await self._drain_persist_tasks()
        if self.mcp_manager is not None:
            try:
                await self.mcp_manager.close_all()
            except Exception as exc:
                logger.warning("装配失败清理：MCP 会话关闭失败: %s", exc)
        if self.engine_llm is not None:
            try:
                await self.engine_llm.aclose()
            except Exception as exc:
                logger.warning("装配失败清理：LLM 链关闭失败: %s", exc)
        if self.storage is not None:
            try:
                await self.storage.close()
            except Exception as exc:
                logger.warning("装配失败清理：存储关闭失败: %s", exc)
        # 半装配产物置空：失败后的运行时不得被当作可用装配态使用
        self.storage = None
        self.engine = None
        self.engine_llm = None
        self._engine_storage = None
        self._engine_spec_key = None

    async def _drain_persist_tasks(self) -> None:
        """等待在途知识落库任务完成（异常已在任务内记录，此处只收口）。"""
        pending = [task for task in self._persist_tasks if not task.done()]
        if not pending:
            return
        await asyncio.gather(*pending, return_exceptions=True)

    async def _assemble(self, host: Host, recipe: AssemblyRecipe) -> None:
        """装配步骤 ①–⑰（boot 的内部实现；异常由 boot 统一清理后上抛）。"""
        # ① 存储（宿主工厂）+ 旁路写防护：集内可演化资产的唯一写入
        #    路径 = 应用管线；守卫令牌只归管线持有，宿主其余路径拦截
        raw_storage = await host.create_storage()
        guard_token = uuid.uuid4().hex
        self.storage = GuardedStorage(raw_storage, guard_token=guard_token)
        self.guard_token = guard_token

        # ② 图注册表（节点类型/条件边注册位）
        self.graph_registries = GraphRegistries()
        # 感知结点登记（视觉理解：截图引用 → 结构化描述；可被组装器组装）
        with contextlib.suppress(Exception):
            # 重复装配防护：已登记则跳过（同进程多次 boot 不报错）
            register_perception_nodes(self.graph_registries.nodes)

        # 知识集变更落库任务集合（ENG3-17 on_mutation 钩子调度——持有
        # 引用防 GC 提前回收；task 完成自动从集合移除）
        self._persist_tasks = set()

        # ③ 种子注入（通用基线恒注 + 配方领域种子；注入属启动装配
        #    机制路径，经旁路写防护全豁免上下文放行）
        # ENG3-17：on_mutation 钩子在变更时调度持久化（create_task
        # fire-and-forget——种子注入期落库不阻断 boot；落库走机制旁路
        # 上下文放行，不污染守卫审计）。
        async def _persist_knowledge_set() -> None:
            if self.knowledge_set is None or self.storage is None:
                return
            try:
                # 豁免集合名须与知识集真实集合一致（KnowledgeSet.collection
                # = knowledge:<user_id>）——旧字面量 "knowledge_set" 与守卫
                # 判定的集合名不匹配，落库被恒拦截（知识演化从不持久化，
                # 重启退化为基线）
                with self.storage.allow_mechanism(self.knowledge_set.collection):
                    await self.knowledge_set.save()
            except Exception as exc:
                # 落库失败不再静默（fire-and-forget 的异常无人接手）：
                # 明确记错误——知识演化未持久化，重启会退化为基线
                logger.error("知识集落库失败（本次知识演化未持久化）: %s", exc)

        def _on_knowledge_mutated() -> None:
            try:
                loop = asyncio.get_event_loop()
            except RuntimeError:
                return
            if loop.is_running():
                task = loop.create_task(_persist_knowledge_set())
                # 持有 task 引用防 GC 提前回收（fire-and-forget 调度不
                # 阻断 boot；落库失败在 task 内部显式记录）
                self._persist_tasks.add(task)
                task.add_done_callback(self._persist_tasks.discard)

        # 变更钩子持有（链恢复替换知识集实例后重新挂钩，否则恢复后的
        # 实例无钩子 = 演化仍不落库）
        self._knowledge_mutation_hook = _on_knowledge_mutated
        self.knowledge_set = KnowledgeSet(
            recipe.set_id, storage=self.storage, on_mutation=_on_knowledge_mutated
        )
        with self.storage.allow_mechanism():
            seed_general(self.knowledge_set)
            for _domain, provider in recipe.seeds:
                seed_knowledge_set(self.knowledge_set, provider())

        # ③-a 自学习管线（孵化闭环）：回合事件 → 信号 → 蒸馏 → 三层闸门
        #    → 知识集落位。出厂默认开启、引擎自承载（成长状态视图只读消费
        #    snapshot）；重建引擎时注册进 settle 钩子链与事件观察传输。
        from .growth import GrowthPipeline

        self.growth_pipeline = GrowthPipeline(
            self.knowledge_set, metric_store=self.storage
        )

        # ④ harness 装配（定义注册 + 仓库落库；装配期写入经豁免上下文）。
        #    集合按集隔离（harness:<set_id>），与 knowledge:<set> 同构
        self.harness_registry = HarnessRegistry(registries=self.graph_registries)
        self.harness_repository = HarnessRepository(
            self.storage, set_id=recipe.set_id
        )
        harness_coll = harness_collection(recipe.set_id)
        for definition in recipe.harness_definitions:
            self.harness_registry.register(definition)
            # 幂等落库：仓库 save 每次 append 一个版本——库内最新版与
            # 装配基线一致时跳过写入，重启/装配重试不再无限追加版本
            existing = None
            try:
                existing = await self.harness_repository.get(definition.name)
            except Exception as exc:
                logger.warning(
                    "harness 库内版本读取失败（按需重写）: %s: %s",
                    definition.name,
                    exc,
                )
            if existing is not None and existing.to_dict() == definition.to_dict():
                continue
            with self.storage.allow_mechanism(harness_coll):
                await self.harness_repository.save(
                    definition, note="开局装配：自举领域基线"
                )

        # ⑤ 事件类型注册表（基线登记 + 集内演化类型加载；脏记录跳过）。
        #    集合按集隔离（event_types:<set_id>）
        self.event_type_registry = EventTypeRegistry(
            storage=self.storage, set_id=recipe.set_id
        )
        for spec in recipe.event_type_specs:
            self.event_type_registry.register(spec)
        with self.storage.allow_mechanism(event_types_collection(recipe.set_id)):
            await self.event_type_registry.load()
            await self.event_type_registry.save()

        # ⑥ 校验器与工具可信度闸门（配方白名单；提案形态的第一道闸门）。
        #    出厂界面组件启停恢复在此前装载：配方白名单 - 停用集 = 活跃
        #    白名单，校验器与初始界面校验（⑧）共用同一过滤结果
        self._ui_factory_components = frozenset(recipe.ui_allowed_components)
        self._ui_components_disabled = await self._load_ui_components_disabled()
        ui_allowed_components = tuple(
            sorted(self._ui_factory_components - self._ui_components_disabled)
        )
        self.validator = ProposalValidator(
            allowed_components=ui_allowed_components,
            allowed_channels=recipe.ui_allowed_channels,
            allowed_theme_tokens=recipe.ui_allowed_theme_tokens,
            graph_registries=self.graph_registries,
        )
        # 钩子字段空清单可观测性：语义「未启用」= None；非 None 但清单为空
        # = 启用了但零钩子生效——打 warn 提示（种子/宿主若确为空清单未启用，
        # 应写 None；此处仅提示不阻断）
        if (
            recipe.vetting_static_hooks is not None
            and not recipe.vetting_static_hooks
        ):
            logger.warning(
                "配方 vetting_static_hooks 非 None 但清单为空——静态审查"
                "钩子实际零生效（未启用请置 None，字段语义：None = 未启用）"
            )
        self.vetting = ToolVetting(
            static_hooks=recipe.vetting_static_hooks or ()
        )

        # ⑦ 应用管线：提案 → 校验 → 分级审批 → 落链 → 应用 → 审计。
        #    审批策略 = 宿主五件套之一（host.interrupt_policy()，宿主侧
        #    按实例缓存）：注入管线后宿主的直过白名单/超时窗口对补丁审批
        #    生效——原实现让管线自建默认策略，宿主对补丁批准闸门无感知
        #    （用户 auto_approve_keys 设置对补丁审批一律无效）。分级表
        #    L0 键的「直过」语义由管线侧适配器与宿主策略合成（键命名空间
        #    不同，见 self_application._PatchApprovalPolicy）。
        #    宿主策略在此取用一次并持有（⑨ 自指上下文复用同一实例，
        #    避免每次取用产生不同策略实例）
        self._host_policy = host.interrupt_policy()
        self.self_pipeline = SelfApplicationPipeline(
            self.storage,
            validator=self.validator,
            approval_levels=recipe.approval_levels or None,
            interrupt_policy=self._host_policy,
            l2_vetting=recipe.vetting_l2_hook,
            on_reverted=recipe.on_reverted,
            guard_token=guard_token,
        )

        # ⑧ 界面基线：初始布局 = 数据，装配期经三层白名单校验（组件/
        #    绑定通道/主题 token）；基线损坏回落未定形，不击穿启动
        ui_spec: dict | None = recipe.ui_spec
        ui_violations = UISchemaValidator().validate(
            recipe.ui_spec or {},
            allowed_components=ui_allowed_components,
            allowed_channels=recipe.ui_allowed_channels,
            allowed_theme_tokens=recipe.ui_allowed_theme_tokens,
        )
        if ui_violations:
            logger.warning("初始界面描述校验未通过，回落未定形: %s", ui_violations)
            ui_spec = None

        # ⑨ 元工具流水线：内省（只读）+ 自指（演化）+ 统一三路分发。
        #    工具规格先于服务装配（内省快照需要工具清单）。宿主审批
        #    策略已在 ⑦ 取用并持有（self._host_policy），此处直接复用——
        #    经自指上下文供宿主级审批卡（种子沉淀等）消费
        wiring = recipe.tool_wiring
        self.introspection_specs = tuple(introspection_tool_specs())
        self.self_specs = tuple(wiring.self_specs())
        introspection_names = {spec.name for spec in self.introspection_specs}
        self_names = {spec.name for spec in self.self_specs}
        self.introspection_service = IntrospectionService(
            IntrospectionSources(
                knowledge_set=self.knowledge_set,
                harness_registry=self.harness_registry,
                tools=(),
                ui_spec=ui_spec,
            )
        )
        self.introspection_pipeline = build_introspection_pipeline(
            self.introspection_service
        )
        introspection_executor = make_introspection_executor(self.introspection_service)
        self_executor = wiring.self_executor_factory(
            self.self_pipeline, self._self_context
        )
        self.self_pipeline_runner = ToolPipeline(
            gate=PermissionGate(),
            # 流水线按 extractor(spec, args) 双参调用；自指判定只取工具名，
            # 参数位透传忽略（与统一分发同一调用形态）
            extractor=lambda spec, _args: wiring.self_operation_of(spec),
            executor=self_executor,
        )

        # ⑩ 调配源注册（检索源 → evidence 源；回合内节点预装配消费）。
        #    知识集注册为检索源（E-P6 Retriever 注册路线）：检索命中含
        #    知识条目（weight=credibility 分级注入），提供者延迟取用——
        #    链恢复（⑬）替换知识集实例后检索源仍读到最新实例
        self.retriever_registry = RetrieverRegistry()
        self.retriever_registry.register(
            KnowledgeSetRetriever(lambda: self.knowledge_set)
        )
        for factory in recipe.retrieval_sources:
            self.retriever_registry.register(factory(self))

        # ⑪ MCP 客户端管理器：外部 server 会话生命周期 + 工具导入 +
        #    分发执行器注册（离线降级时为空，内建工具集照常可用）
        self.mcp_manager = McpClientManager()
        register_mcp_executor(self.harness_registry.declarative, self.mcp_manager)

        # ⑫ 统一工具流水线：内省/自指/声明式三路分发，同一权限门禁
        #    与审计管线（按名路由；未命中任何一路 = 分发处显式拒绝）
        def unified_extractor(spec, args):
            if spec.name in introspection_names:
                return ("read", "*")
            if spec.name in self_names:
                return wiring.self_operation_of(spec)
            definition = self.harness_registry.declarative.definitions.get(
                spec.name
            )
            if definition is None:
                return None
            return endpoint_operation(
                definition.endpoint, args, config=definition.endpoint_config
            )

        async def unified_executor(ctx, spec, args, approval):
            if spec.name in introspection_names:
                return await introspection_executor(ctx, spec, args, approval)
            if spec.name in self_names:
                return await self_executor(ctx, spec, args, approval)
            return await self.harness_registry.declarative.dispatch(
                ctx, spec, args, approval
            )

        def unified_failure_reason(spec, args):
            definition = self.harness_registry.declarative.definitions.get(
                spec.name
            )
            if definition is None:
                return None
            return endpoint_operation_failure_reason(
                definition.endpoint, args, config=definition.endpoint_config
            )

        self.tool_pipeline = ToolPipeline(
            gate=PermissionGate(),
            extractor=unified_extractor,
            failure_reason=unified_failure_reason,
            executor=unified_executor,
        )

        # ⑬ 从链恢复集状态（重启/回退后活跃态一致；链损坏回落基线）
        await self._restore_set_state(recipe)

        # ⑬-a 自学习管线跟随集状态恢复后的最新知识集实例（from_export
        #    会替换知识集对象——管线持旧引用 = 落位落在被替换的实例上）
        if self.growth_pipeline is not None:
            self.growth_pipeline.knowledge_set = self.knowledge_set

        # ⑬-a 用户常驻必带工具集恢复（records 通道；缺记录/坏形态沿用
        #    出厂基线；恢复在 _restore_set_state 之后——校验须见全量工具表）
        await self._restore_baseline()

        # ⑬-a 工具向量索引构建（工具注入瘦身）：全量工具 → 向量，
        #     search_tools/request_tool 检索后端；失败降级关键词基线
        self.tool_index = ToolVectorIndex(embedder=build_default_embedder())
        self._rebuild_tool_index()

        # ⑬-b 工具调配器接线（工具注入瘦身）：保底工具 priority 高 + 调用权重
        self.tool_selector = ToolSelector(
            max_tools=16,
            baseline_names=self._baseline_names,
        )

        # ⑭ apply 目标注册（补丁落链后的活跃态生效钩子；配方工厂注入）
        for kind, factory in recipe.apply_targets.items():
            self.self_pipeline.register_target(kind, factory(self))

        # ⑮ 调参接线（E-P5）：回合指标聚合 + MetaTuner（round 结束后
        #    按失败信号调参，参数回写知识集权重/阈值条目——与知识孵化
        #    闭环同源，下次调参从条目读回基线）
        self.meta_tuner = MetaTuner(knowledge_set=self.knowledge_set)
        self.turn_metrics = TurnMetrics()

        # ⑯ 池治理登记器（容量/淘汰/合并/预算四规则；只登记不执行决策）
        self.pool_governance = PoolGovernance()

        # ⑰ 引擎重建（按当前模型配置装配回合图；工具表/配置变更重建）
        self.introspection_service._sources.tools = self.collect_specs()
        await self.rebuild_engine()

    def pause(self) -> None:
        """暂停接受新 run（在途 run 自然完成，不强制打断）。"""
        if self._state is not RuntimeState.RUNNING:
            raise RuntimeError(
                f"非法状态转换: {self._state.value} -> paused（仅 running 可暂停）"
            )
        self._state = RuntimeState.PAUSED

    def resume(self) -> None:
        """恢复接受新 run（仅 paused 可恢复）。"""
        if self._state is not RuntimeState.PAUSED:
            raise RuntimeError(
                f"非法状态转换: {self._state.value} -> running（仅 paused 可恢复）"
            )
        self._state = RuntimeState.RUNNING

    async def stop(self) -> None:
        """关停（幂等）：拒新 → 等在途完成 → 关 MCP 会话 → 关 LLM 链 →
        关存储 → 宿主关停钩子。顺序保证优雅退出时远端会话与模型连接先于
        存储被显式关闭。

        故障隔离：各关停步骤独立 try/except——任一步失败不跳过后续
        清理（MCP→LLM→存储→宿主钩子全部尽力关闭），失败仅记日志。
        """
        if self._state in (RuntimeState.UNINITIALIZED, RuntimeState.STOPPED):
            return
        self._state = RuntimeState.STOPPED
        if self._active_runs:
            await self._drained.wait()
        # 在途知识落库任务收口：fire-and-forget 的 save 若跨过存储关闭，
        # 最后一批知识演化会写失败（关停期静默丢演化）——先等其完成
        await self._drain_persist_tasks()
        if self.mcp_manager is not None:
            try:
                await self.mcp_manager.close_all()
            except Exception as exc:
                logger.warning("MCP 会话关闭失败（继续后续清理）: %s", exc)
        if self.engine_llm is not None:
            try:
                # LLM 链显式关闭：httpx 长连接/重载残留不再
                # 依赖 GC 回收；关停失败只记日志不阻断后续清理
                await self.engine_llm.aclose()
            except Exception as exc:
                logger.warning("LLM 链关闭失败（继续后续清理）: %s", exc)
        if self.storage is not None:
            try:
                await self.storage.close()
            except Exception as exc:
                logger.warning("存储关闭失败（继续后续清理）: %s", exc)
        if self._host is not None:
            try:
                await self._host.close()
            except Exception as exc:
                logger.warning("宿主关停钩子失败: %s", exc)

    # ── 在途 run 登记（回合粒度；传输按请求注入，Runtime 不持单例传输）──

    def begin_run(self, thread_id: str | None = None) -> RunTicket:
        """登记一个在途 run（拒绝新 run 的判据：非 running 状态显式报错）。

        Args:
            thread_id: 回合归属线程 id（提供给 abort_current_run 落
                CANCELLED 终止快照的锚点线索；None = 只登记不落快照，
                中止仍取消在途任务）。
        """
        if self._state is not RuntimeState.RUNNING:
            raise RuntimeError(
                f"运行时状态不允许开始新 run: {self._state.value}"
                "（pause 拒新、stop 拒新，在途 run 自然完成后可恢复）"
            )
        ticket = RunTicket(id=uuid.uuid4().hex)
        self._active_runs[ticket.id] = ticket
        self._active_ticket_id = ticket.id
        self._active_run_task = asyncio.current_task()
        self._active_run_thread = thread_id
        self._drained.clear()
        return ticket

    def end_run(self, ticket: RunTicket) -> None:
        """注销一个在途 run（幂等；全部注销后 stop 的排空等待解除）。"""
        if ticket.id in self._active_runs:
            del self._active_runs[ticket.id]
            if ticket.id == self._active_ticket_id:
                self._active_ticket_id = None
                self._active_run_task = None
                self._active_run_thread = None
            if not self._active_runs:
                self._drained.set()

    async def abort_current_run(self) -> bool:
        """中止当前在途 run（取消 → CANCELLED 终止快照 → 可续跑）。

        语义（与 pause 只拒新不打断、stop 全停排空正交）：
        1. 取消在途 run 任务：CancelledError 投递到在途节点当前 await 点
           （节点/适配器退出路径收尾；引擎取消语义 = BaseException 原样
           穿透，不归节点异常重试路径）；
        2. 取消完成后按线程链尾 checkpoint 写入 CANCELLED 终态快照
           （复用既有 checkpoint 写入路径——链写入不变量在存储层）；
        3. 后续续跑：以该快照为锚点 resume（从已完成节点的下一节点继续，
           被中止节点重新执行——其状态从未提交）。

        Returns:
            True = 有在途 run 且已中止；False = 无在途 run（幂等 no-op）
            或任务已自然完成。

        Raises:
            RuntimeError: 从被中止的 run 自身发起中止（自取消无意义）。
        """
        if not self._active_runs:
            return False
        task = self._active_run_task
        if task is None or task.done():
            return False
        if task is asyncio.current_task():
            raise RuntimeError(
                "不能从被中止的 run 自身发起中止（自取消无意义）"
            )
        # 线程 id 先取用：任务收尾时 end_run 会清空登记（快照锚点须
        # 在取消前读取，任务取消期间登记表注销是预期路径）
        thread_id = self._active_run_thread
        task.cancel()
        # 等待任务真正停止（取消只是投递，底层资源/上游请求须等其收尾）；
        # CancelledError 属预期终止路径，吞掉即可——当前任务不受影响
        with contextlib.suppress(BaseException):
            await task
        await self._write_abort_checkpoint(thread_id)
        return True

    async def _write_abort_checkpoint(self, thread_id: str | None) -> None:
        """取消后的 CANCELLED 终止快照（链尾续接，恢复锚点语义与中断卡一致）。

        快照 = 链尾 checkpoint 的副本 + reason=cancelled：中止发生在
        节点执行中途，节点的增量从未提交——链尾快照即「已完成节点
        边界」的一致状态，后续 resume 从该边界继续（被中止节点重跑）。
        快照写入失败只记日志：中止本身已完成（任务已取消），快照是
        续跑的恢复锚点而非中止动作的组成部分。
        """
        if self.storage is None or thread_id is None:
            if thread_id is None:
                logger.warning(
                    "中止未登记线程 id（begin_run(thread_id=...)），"
                    "跳过 CANCELLED 终止快照（恢复锚点缺失，宿主请从链重查）"
                )
            return
        try:
            latest = await self.storage.get_latest_checkpoint(
                thread_id
            )
            if latest is None:
                logger.warning(
                    "中止快照跳过：线程 %s 尚无 checkpoint（无已提交状态可快照）",
                    thread_id,
                )
                return
            await self.storage.put_checkpoint(
                CheckpointRecord(
                    checkpoint_id=0,
                    thread_id=thread_id,
                    node=latest.node,
                    graph_path=latest.graph_path,
                    state=latest.state,
                    parent_id=latest.checkpoint_id,
                    reason=TerminateReason.CANCELLED,
                    event_seq=latest.event_seq,
                    graph_version=latest.graph_version,
                    plan=latest.plan,
                )
            )
            logger.info(
                "run 已中止，CANCELLED 终态快照落链: thread=%s",
                thread_id,
            )
        except Exception as exc:
            logger.warning("中止快照写入失败（不影响中止本身）: %s", exc)

    # ── 审批决议重入样板（宿主请求入口之外的引擎通用方法）──

    async def resume_run(
        self,
        thread_id: str,
        decision: dict,
        *,
        round_id: str | None = None,
        transports: list[EngineTransport] | None = None,
    ) -> Any:
        """审批决议重入：挂起卡 → 决议注入 → 续跑（get_latest_interrupt
        → checkpoint 锚点 → ainvoke(resume_from, inject) 样板下沉）。

        决议形态（inject 值）由宿主构造与校验（web 宿主从请求体解析、
        stdio 宿主从终端行解析）——本方法只负责重入执行本身。无挂起卡
        或卡已失效时显式报错（宿主转用户可读拒绝）。
        """
        if self.engine is None or self.storage is None:
            raise RuntimeError("运行时未装配或引擎未重建（无法决议重入）")
        interrupt = await self.engine.get_latest_interrupt(thread_id)
        if interrupt is None:
            raise RuntimeError("该会话无挂起审批卡")
        latest = await self.storage.get_latest_checkpoint(thread_id)
        if latest is None or latest.interrupt is None:
            raise RuntimeError("挂起卡已失效，请重新发起回合")
        ticket = self.begin_run(thread_id)
        result = None
        try:
            result = await self.engine.ainvoke(
                {},
                thread_id=thread_id,
                round_id=round_id or uuid.uuid4().hex,
                resume_from=latest.checkpoint_id,
                inject={interrupt.key: decision},
                transports=transports,
            )
            return result
        finally:
            self.end_run(ticket)
            self._tune_round_end(result)

    def tune_after_round(self, *, failed: bool = False, error: str = "") -> TuneResult | None:
        """回合收尾调参（E-P5 接线入口）：失败信号聚合 → MetaTuner 调参。

        语义：round 结束后按失败信号调参（失败率偏高 → 重试预算上调/
        web 验证阈值下调，评审反馈维度降权……），参数回写知识集权重/
        阈值条目（下次调参从条目读回基线，与知识孵化闭环同源）。未
        装配（meta_tuner 缺省 None）或调参无变化 = no-op。失败信号由
        宿主/运行时在回合收尾处上报——本方法是同步确定性调参，不阻塞
        回合结果回流。
        """
        if self.meta_tuner is None or self.turn_metrics is None:
            return None
        if self.knowledge_set is None:
            return None
        self.turn_metrics.record_turn(failed=failed, error=error)
        params = MetaTuner.load_params(self.knowledge_set)
        return self.meta_tuner.tune_persisted(params, self.turn_metrics)

    def _tune_round_end(self, result: Any) -> None:
        """resume_run 收尾调参：按回合结果错误信号调参（best-effort）。

        调参失败只记日志不击穿决议回流（机制是增强，回合结果已定）。
        结果缺失（决议执行抛异常）= 失败信号（异常回合同样计入失败率）。
        """
        if self.meta_tuner is None:
            return
        try:
            error = getattr(result, "error", None)
            self.tune_after_round(
                failed=result is None or bool(error),
                error=(
                    str(error)
                    if error
                    else ("回合执行异常（无结果）" if result is None else "")
                ),
            )
        except Exception as exc:
            logger.warning("回合收尾调参失败（忽略）: %s", exc)

    # ── 装配产物访问器 ──

    def merged_specs(self) -> list[ToolSpec]:
        """全量工具清单（内省 + 自指 + 动态），供工具索引构建与内省快照。

        与 collect_specs 分工：collect_specs 只返回保底 8+2 常驻集（进
        tools 参数），merged_specs 返回全部（检索/内省用）。
        """
        return [
            *self.introspection_specs,
            *self.self_specs,
            *self.tool_registry.values(),
        ]

    def collect_specs(self) -> list[ToolSpec]:
        """工具清单汇总（常驻必带集），供回合装配 tools 参数。

        终稿注入策略：常驻 ≤12 个完整 schema（出厂保底 8 + 自指 2，用户
        可在设置页增删），其余工具不再全量进 tools 参数——模型经
        search_tools 检索、request_tool 绑定后注入下一轮。
        """
        baseline = self._baseline_names
        return [
            spec for spec in self.merged_specs()
            if spec.name in baseline
        ]

    # ── 常驻必带工具集（设置页「工具」管理面；出厂基线可增删）──

    @property
    def baseline_names(self) -> tuple[str, ...]:
        """当前常驻必带工具名（排序，含强制常驻的检索工具）。"""
        return tuple(sorted(self._baseline_names))

    def _apply_baseline(self, names: Iterable[str]) -> None:
        """应用常驻必带集（不校验；校验归 set_baseline_names 调用面）。"""
        next_set = frozenset(names) | BASELINE_IMMUTABLE_TOOLS
        changed = next_set != self._baseline_names
        self._baseline_names = next_set
        if changed:
            if self.tool_selector is not None:
                self.tool_selector = ToolSelector(
                    max_tools=self.tool_selector.max_tools,
                    baseline_names=self._baseline_names,
                )
            if self.introspection_service is not None:
                self.introspection_service._sources.tools = self.collect_specs()

    async def set_baseline_names(self, names: list[str] | tuple[str, ...]) -> list[str]:
        """设置常驻必带工具集（设置页勾选落地面）。

        - 强制并入动态注册机制工具（search_tools/request_tool）；
        - 非法名（不在全量工具表 merged_specs 内）结构化拒绝；
        - 生效面：collect_specs 立即按新集注入 → 引擎重建缓存键随之
          变化（rebuild_engine spec_key 含常驻集身份），下一回合生效；
        - 持久化：records 通道（runtime_config/tool_baseline），重启经
          _restore_baseline 装载。
        """
        merged_names = {spec.name for spec in self.merged_specs()}
        requested = frozenset(names or ())
        unknown = sorted(requested - merged_names)
        if unknown:
            raise ValueError(f"未注册工具不能加入常驻必带集: {', '.join(unknown)}")
        self._apply_baseline(requested)
        if self.storage is not None:
            await self.storage.put_record(
                BASELINE_RECORD_COLLECTION,
                BASELINE_RECORD_KEY,
                {"tools": sorted(self._baseline_names)},
            )
        return self.baseline_names

    async def _restore_baseline(self) -> None:
        """重启装载用户常驻必带集（records 通道；坏形态沿用出厂基线）。

        宽松应用（不走 set_baseline_names 的实时校验）：持久化名可能含
        尚未登记的挂载工具（MCP server 未装/链恢复前），名字在表内缺失
        时注入面自然无效应，登记后即自动生效。
        """
        if self.storage is None:
            return
        try:
            record = await self.storage.get_record(
                BASELINE_RECORD_COLLECTION, BASELINE_RECORD_KEY
            )
        except Exception as exc:
            logger.warning("常驻必带集读取失败（沿用出厂基线）: %s", exc)
            return
        tools = (record or {}).get("tools")
        if isinstance(tools, list):
            self._apply_baseline(tools)

    # ── 出厂界面组件启停（组件 tab 管理面；出厂白名单可停用）──

    @property
    def ui_factory_components(self) -> tuple[str, ...]:
        """出厂界面组件白名单基线（配方 ui_allowed_components 未过滤全集）。"""
        return tuple(sorted(self._ui_factory_components))

    @property
    def ui_components_disabled(self) -> tuple[str, ...]:
        """当前已停用出厂组件名（排序）。"""
        return tuple(sorted(self._ui_components_disabled))

    @property
    def ui_allowed_components(self) -> tuple[str, ...]:
        """活跃界面组件白名单（出厂全集 - 停用集；校验器/界面校验同源）。"""
        return tuple(sorted(self._ui_factory_components - self._ui_components_disabled))

    async def set_ui_components_disabled(
        self, names: list[str] | tuple[str, ...]
    ) -> tuple[str, ...]:
        """停用/恢复出厂组件（组件 tab 勾选落地面）。

        - 仅可停用出厂白名单内的组件（未登记名结构化拒绝）；
        - 生效面：校验器白名单即时剔除 → 后续 ui 补丁引用停用组件被拒；
        - 持久化：records 通道（runtime_config/ui_components_disabled），
          重启经 _load_ui_components_disabled 装配期过滤（同源）。
        """
        requested = frozenset(names or ())
        unknown = sorted(requested - self._ui_factory_components)
        if unknown:
            raise ValueError(
                f"未登记出厂组件不能停用: {', '.join(unknown)}"
            )
        self._ui_components_disabled = requested
        if self.validator is not None:
            self.validator.set_allowed_components(self.ui_allowed_components)
        if self.storage is not None:
            await self.storage.put_record(
                UI_COMPONENTS_RECORD_COLLECTION,
                UI_COMPONENTS_RECORD_KEY,
                {"disabled": sorted(self._ui_components_disabled)},
            )
        return self.ui_components_disabled

    async def _load_ui_components_disabled(self) -> frozenset[str]:
        """重启装载停用组件集（records 通道；坏形态/缺记录沿用出厂全量白名单）。"""
        if self.storage is None:
            return frozenset()
        try:
            record = await self.storage.get_record(
                UI_COMPONENTS_RECORD_COLLECTION, UI_COMPONENTS_RECORD_KEY
            )
        except Exception as exc:
            logger.warning("停用组件集读取失败（沿用出厂全量白名单）: %s", exc)
            return frozenset()
        names = (record or {}).get("disabled")
        if isinstance(names, list) and all(isinstance(name, str) for name in names):
            return frozenset(names)
        return frozenset()

    async def rebuild_engine(self, llm: AsyncLLM | None = None) -> Engine:
        """重建回合图引擎（配置/工具表变更才重建；llm 缺省 = 宿主解析）。

        重建缓存键 = 模型实例身份 + 存储身份 + 工具表名集合——三者不变
        时复用既有引擎（「配置变更才重建」语义）；MCP 挂载/补丁链工具
        变化会改变名集合，自动触发重建。

        身份比较用「保留引用 + is 相等」而非 id()：id() 仅在对象存活
        期内稳定，宿主 resolve_llm 每次返回新实例时 id 不同会静默每次
        重建（缓存失效），对象被 GC 后地址复用还可能误命中旧键——本
        运行时持 self.engine_llm/self.storage 强引用，is 比较稳定可靠。
        """
        if self._host is None or self._recipe is None:
            raise RuntimeError("运行时未装配（rebuild_engine 须在 boot 之后）")
        if llm is None:
            llm = await self._host.resolve_llm()
        specs = self.collect_specs()
        # 缓存键须含工具**身份**（名称+结构序列化），而非仅名称：
        # 同名工具被补丁改写端点/参数时旧缓存仍命中 → 引擎持有过期
        # schema（节点类型只注册一次，差异化重写无效）。结构序列化取
        # 各 spec 的确定性 JSON，使补丁改动实际生效才触发重建。
        spec_key = tuple(
            sorted(f"{s.name}\u241f{_spec_identity(s)}" for s in specs)
        )
        if self.engine is not None and self.engine_llm is llm and self.storage is self._engine_storage and spec_key == self._engine_spec_key:
            return self.engine
        # 引擎重建前显式关闭旧 LLM 链：模型变更时旧链的
        # httpx 连接池随引用替换悬置，长会话/重载会残留连接——关闭
        # 失败只记日志不阻断重建（重建语义优先，清理是增强）
        if self.engine_llm is not None and self.engine_llm is not llm:
            try:
                await self.engine_llm.aclose()
            except Exception as exc:
                logger.warning("旧 LLM 链关闭失败（继续重建）: %s", exc)
        # LLM 链守卫包装（用量闭环 + 回合内压缩）：节点消费的 llm =
        # 包装后的实例——usage 帧进结点成本账与 llm_usage 指标事件，
        # 调用前按压缩策略折叠历史。engine_llm
        # 保持宿主原始实例（重建缓存身份比较不变），包装器随引擎装配
        guard_llm = None
        if llm is not None:
            compress_policy = self._recipe.compress_policy
            guard_llm = UsageTrackingLLM(
                CompressingLLM(
                    llm,
                    policy=(
                        compress_policy
                        if compress_policy is not None
                        else ThresholdCompressionPolicy()
                    ),
                )
            )
        recipe = self._recipe
        context = GraphRecipeContext(
            llm=guard_llm,
            tool_pipeline=self.tool_pipeline,
            tool_specs=specs,
            storage=self.storage,
            registries=self.graph_registries,
            system_events=self.event_type_registry.system_events(),
            assembly=AssemblyConfig(),
            assembly_sources=self._assembly_sources(),
        )
        graph = recipe.graph_recipe(context)
        # 沉淀钩子链：池治理登记钩子（只登记不执行；桥 op 触发判定）
        from .settle import PoolGovernanceSettleHook, SettleHooks

        settle_hooks = SettleHooks()
        if self.pool_governance is not None:
            settle_hooks.register(PoolGovernanceSettleHook(self.pool_governance))
        # 知识使用归因（演化候选的数据源）：回合收尾按成败对注入知识
        # 记 usage/fail——失败驱动进化工厂的「失败日志」从此有来源。
        settle_hooks.register(_KnowledgeUsageSettleHook(self))
        # 自学习闭环（默认开）：回合收尾按需蒸馏 + 闸门落位知识集
        settle_hooks.register(self.growth_pipeline)
        options = RunOptions(
            storage=self.storage,
            registries=self.graph_registries,
            # 自学习管线观察回合事件流（观测不阻断执行；宿主各自注入
            # 传输，此传输不向宿主外发——只进不出）
            transports=[self.growth_pipeline],
            system_events=context.system_events,
            assembly=context.assembly,
            assembly_sources=context.assembly_sources,
            settle=settle_hooks,
        )
        recipe_run_options = recipe.run_options
        if recipe_run_options is not None:
            # 配方执行域覆盖：非 None 字段覆盖装配默认（装配产物字段由
            # Runtime 注入，宿主覆盖即替换装配态——声明即权威）
            for rf in fields(recipe_run_options):
                value = getattr(recipe_run_options, rf.name)
                if value is not None:
                    setattr(options, rf.name, value)
        engine = Engine(
            graph,
            options=options,
        )
        # 自学习管线发射回调接入引擎事件流：孵化动态（信号/蒸馏/闸门）
        # 落引擎事件日志并推送全部传输（宿主传输 → 壳侧 → 前端演化页签）。
        # 发射目标 = 引擎自身 publish（观测不阻断沉淀链路）。
        if self.growth_pipeline is not None:
            self.growth_pipeline.set_emit(
                lambda etype, payload: engine.publish_event(
                    etype,
                    payload,
                    thread_id="-",
                    node="growth",
                )
            )
        self.engine = engine
        self.engine_llm = llm
        self._engine_storage = self.storage
        self._engine_spec_key = spec_key
        self.introspection_service.set_graph(graph)
        return engine

    # ── 内部装配辅助 ──

    def _self_context(self) -> SelfToolContext:
        """自指工具执行上下文（装配产物 + 配方钩子组装，运行期取用）。"""
        recipe = self._recipe
        convergence = (
            recipe.convergence_provider()
            if recipe is not None and recipe.convergence_provider is not None
            else None
        )
        return SelfToolContext(
            self_pipeline=self.self_pipeline,
            harness_registry=self.harness_registry,
            knowledge_set=self.knowledge_set,
            convergence=convergence,
            interrupt_policy=self._host_policy,
            tool_index=self.tool_index,
        )

    def _rebuild_tool_index(self) -> None:
        """重建工具向量索引（全量 merged_specs → 向量）。"""
        if self.tool_index is None:
            return
        self.tool_index.build(self.merged_specs(), endpoints=self._tool_endpoints())

    def refresh_tool_index(self, specs: list[ToolSpec] | None = None) -> None:
        """增量刷新工具索引（工具增改 / MCP 挂载 hook 调用）。"""
        if self.tool_index is None:
            return
        target = specs if specs is not None else self.merged_specs()
        self.tool_index.refresh(target, endpoints=self._tool_endpoints())

    def _tool_endpoints(self) -> dict[str, str]:
        """工具端点类型映射（供索引元数据标注）。"""
        endpoints: dict[str, str] = {}
        for spec in self.introspection_specs:
            endpoints[spec.name] = "introspection"
        for spec in self.self_specs:
            endpoints[spec.name] = "self"
        for name in self.tool_registry:
            endpoints[name] = "declarative"
        return endpoints

    def _assembly_sources(self) -> Callable[..., Any]:
        """调配器源提供者：检索结果 + 知识注入 → 装配源（回合内节点预装配消费）。

        查询串取回合输入；检索源合并（知识集已注册为检索源之一：
        :class:`KnowledgeSetRetriever`）→ 知识命中条目经
        :func:`build_knowledge_sources` 转源（weight=credibility 映射、
        注入前指令注入扫描），其余检索 chunk 按可信度分级映射权重
        （复用 ``knowledge_set._SOURCE_CREDIBILITY``，不再恒 1.0/仅二元
        过滤）作 evidence 源。无检索源/空结果/调配未启用 = 空清单
        （检索是增强，不阻断回合）。
        """

        async def provide(ctx) -> list[ContextSource]:
            query = str(ctx.state.get("input") or "").strip()
            if not query:
                return []
            # 回合装配检索上限（ENG3-16 常量化）：与 retrieval.DEFAULT_LIMIT
            # 同值（8）——钳制注入体积；分级口径 = 全部分级放行 + weight
            # 按可信度映射（不再只放行 model 级——web/dialog 级经注入
            # 扫描防线与权重分级参与预算分配，低可信源自然被预算挤出）
            chunks = await self.retriever_registry.retrieve(
                query, limit=_ASSEMBLY_SOURCE_LIMIT
            )
            knowledge_hits: list[KnowledgeEntry] = []
            sources: list[ContextSource] = []
            for chunk in chunks:
                entry_id = (chunk.meta or {}).get("entry_id")
                if (
                    chunk.source == "knowledge"
                    and entry_id
                    and self.knowledge_set is not None
                ):
                    entry = self.knowledge_set.get(entry_id)
                    if entry is not None:
                        knowledge_hits.append(entry)
                        continue
                sources.append(
                    ContextSource(
                        type=SOURCE_EVIDENCE,
                        content=chunk.text[:1200],
                        title=f"检索：{chunk.source}/{chunk.doc_id}",
                        relevance=chunk.relevance,
                        priority=5,
                        weight=_SOURCE_CREDIBILITY.get(
                            chunk.level, _SOURCE_CREDIBILITY["model"]
                        ),
                        meta={"source": chunk.source, "doc_id": chunk.doc_id},
                    )
                )
            if self.knowledge_set is not None:
                sources.extend(
                    build_knowledge_sources(
                        knowledge_hits,
                        relevance=0.5,
                        source_type=SOURCE_EVIDENCE,
                        max_chars=1200,
                    )
                )
            # 知识使用留痕：命中条目记 usage（演化候选的数据源——失败
            # 归因在回合收尾钩子按成败标记 fail）。零记录不阻断装配。
            for entry in knowledge_hits:
                self._round_knowledge_hits.add(entry.id)
                try:
                    self.knowledge_set.record_usage(entry.id)
                except Exception:
                    pass
            return sources

        return provide

    async def _restore_set_state(self, recipe: AssemblyRecipe) -> None:
        """从集补丁链组装恢复活跃态（重启/回退后集状态一致）。

        链是权威记录：界面描述/harness/动态工具/事件类型/知识按最新
        组装形态重建运行时视图；恢复失败只记日志不击穿启动（链损坏时
        回落基线，可回退修复）。
        """
        try:
            state = await self.self_pipeline.chain.assemble()
        except Exception as exc:
            logger.warning("集状态组装失败，回落基线: %s", exc)
            return
        ui_state = state.get("ui") or {}
        if isinstance(ui_state, dict):
            spec = ui_state.get("boot.panel") or ui_state.get(next(iter(ui_state), ""))
            if isinstance(spec, dict) and spec.get("root"):
                try:
                    violations = UISchemaValidator().validate(
                        spec,
                        allowed_components=recipe.ui_allowed_components,
                        allowed_channels=recipe.ui_allowed_channels,
                        allowed_theme_tokens=recipe.ui_allowed_theme_tokens,
                    )
                    if not violations:
                        self.introspection_service._sources.ui_spec = spec
                except Exception:
                    pass
        for name, definition in (state.get("harness") or {}).items():
            if not isinstance(definition, dict):
                continue
            try:
                parsed = HarnessDefinition.from_dict(definition)
                self.harness_registry.register(parsed)
            except Exception as exc:
                logger.warning("harness 恢复失败（跳过）: %s: %s", name, exc)
        for name, tool_data in (state.get("tools") or {}).items():
            if not isinstance(tool_data, dict):
                continue
            try:
                from .declarative_tools import DeclarativeToolSpec

                declarative = DeclarativeToolSpec.from_dict(tool_data)
                self.harness_registry.declarative.register_definition(declarative)
                self.tool_registry[name] = declarative.to_spec()
            except Exception as exc:
                logger.warning("工具恢复失败（跳过）: %s: %s", name, exc)
        for name, spec_data in (state.get("event_types") or {}).items():
            if not isinstance(spec_data, dict) or name in self.event_type_registry.names():
                continue
            try:
                spec = EventTypeSpec.from_dict(spec_data)
                self.event_type_registry.register(spec)
            except Exception as exc:
                logger.warning("事件类型恢复失败（跳过）: %s: %s", name, exc)
        knowledge_state = state.get("knowledge") or {}
        if isinstance(knowledge_state, dict) and knowledge_state:
            try:
                # 知识集内存链按集状态重建（权威 = 集补丁链；重启后
                # 检索/内省立即反映演化产物）
                self.knowledge_set = KnowledgeSet.from_export(
                    recipe.set_id,
                    {"base": {"entries": knowledge_state}, "patches": []},
                    storage=self.storage,
                )
                # 变更钩子重挂：from_export 新建实例不带 on_mutation，
                # 不重挂 = 恢复后的知识演化不再落库（钩子在 ③ 构造）
                if self._knowledge_mutation_hook is not None:
                    self.knowledge_set.on_mutation = self._knowledge_mutation_hook
                # 内省视图同步指向恢复后的集实例（替换前指向旧对象，
                # inspect_knowledge 会返回恢复前数据）
                if self.introspection_service is not None:
                    self.introspection_service._sources.knowledge_set = (
                        self.knowledge_set
                    )
            except Exception as exc:
                logger.warning("知识集恢复失败（跳过）: %s", exc)


__all__ = [
    "AssemblyRecipe",
    "GraphRecipeContext",
    "Host",
    "RunTicket",
    "Runtime",
    "RuntimeState",
    "ToolWiring",
]
