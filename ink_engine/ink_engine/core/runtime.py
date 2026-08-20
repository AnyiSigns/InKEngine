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
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from .approval import InterruptPolicy
from .assembly import SOURCE_EVIDENCE, AssemblyConfig
from .context import ContextSource
from .declarative_tools import endpoint_operation
from .event_types import EventTypeRegistry, EventTypeSpec
from .events import EngineTransport
from .executor import Engine, RunOptions
from .graph import Graph
from .harness import HarnessDefinition, HarnessRegistry, HarnessRepository
from .introspection import (
    IntrospectionService,
    IntrospectionSources,
    build_introspection_pipeline,
    introspection_tool_specs,
    make_introspection_executor,
)
from .knowledge_set import KnowledgeEntry, KnowledgeSet
from .llm import AsyncLLM
from .llm.tools import ToolSpec
from .logging import get_logger
from .mcp_client import McpClientManager, register_mcp_executor
from .permissions import PermissionGate
from .registry import GraphRegistries
from .retrieval import SOURCE_MODEL, Retriever, RetrieverRegistry
from .seeds import seed_general, seed_knowledge_set
from .self_application import (
    ApplyTarget,
    ApprovalLevel,
    GuardedStorage,
    SelfApplicationPipeline,
)
from .self_proposal import PatchKind, ProposalValidator
from .self_tools import ConvergenceHook, SelfToolContext
from .storage import Storage
from .tool_pipeline import ToolPipeline
from .tool_vetting import ToolVetting
from .ui_schema import DEFAULT_BIND_CHANNELS, UISchemaValidator

logger = get_logger(__name__)


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
        seeds: 领域种子注入清单 [(domain, entries_provider)]（通用基线恒注）。
        harness_definitions: 自举 harness 定义清单（注册 + 落库）。
        event_type_specs: 事件类型基线（装配期登记 + 集内演化类型加载）。
        ui_spec: 界面基线（装配期经三层白名单校验；损坏回落未定形）。
        ui_allowed_components: 界面组件白名单（校验器与渲染器同源）。
        ui_allowed_theme_tokens: 主题 token 白名单。
        tool_wiring: 统一工具分发声明（三路 specs + 执行器/判定工厂）。
        vetting_static_hooks: 静态审查钩子清单（工具可信度闸门）。
        vetting_l2_hook: L2 沙箱验证钩子（构建产物引用的部署前门禁）。
        approval_levels: 审批分级表（kind → L0/L1/L2）。
        retrieval_sources: 检索源工厂清单（接收装配产物，返回 Retriever）。
        apply_targets: 活跃态应用目标工厂（kind → 接收装配产物，返回
            ApplyTarget；补丁落链后的运行时生效钩子）。
        graph_recipe: 图配方（接收装配上下文，返回回合图）。
        on_reverted: 回退通知钩子（宿主行为信号触发点）。
        convergence_provider: 演化收敛管制钩子提供者（可选前置闸门；
            None = 不启用）。
    """

    set_id: str = "default"
    seeds: list[tuple[str, Callable[[], list[KnowledgeEntry]]]] = field(
        default_factory=list
    )
    harness_definitions: list[HarnessDefinition] = field(default_factory=list)
    event_type_specs: list[EventTypeSpec] = field(default_factory=list)
    ui_spec: dict | None = None
    ui_allowed_components: tuple[str, ...] = ()
    ui_allowed_theme_tokens: tuple[str, ...] = ()
    tool_wiring: ToolWiring | None = None
    vetting_static_hooks: list[Callable[[Sequence[Path]], list[str]]] = field(
        default_factory=list
    )
    vetting_l2_hook: Callable[[Any], list[str]] | None = None
    approval_levels: dict[PatchKind, ApprovalLevel] = field(default_factory=dict)
    retrieval_sources: list[Callable[[Any], Retriever]] = field(default_factory=list)
    apply_targets: dict[PatchKind, Callable[[Any], ApplyTarget]] = field(
        default_factory=dict
    )
    graph_recipe: Callable[[GraphRecipeContext], Graph] | None = None
    on_reverted: Callable[[int, str], Any] | None = None
    convergence_provider: Callable[[], ConvergenceHook | None] | None = None


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
        # 引擎重建缓存键（配置/工具表变更才重建；None = 尚未重建）
        self._engine_cache_key: tuple[Any, ...] | None = None

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
        # 宿主动态工具表（挂载/从链恢复的工具定义；统一分发第三路）
        self.tool_registry: dict[str, ToolSpec] = {}
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

        # ① 存储（宿主工厂）+ 旁路写防护：集内可演化资产的唯一写入
        #    路径 = 应用管线；守卫令牌只归管线持有，宿主其余路径拦截
        raw_storage = await host.create_storage()
        guard_token = uuid.uuid4().hex
        self.storage = GuardedStorage(raw_storage, guard_token=guard_token)
        self.guard_token = guard_token

        # ② 图注册表（节点类型/条件边注册位）
        self.graph_registries = GraphRegistries()

        # ③ 种子注入（通用基线恒注 + 配方领域种子；注入属启动装配
        #    机制路径，经旁路写防护全豁免上下文放行）
        self.knowledge_set = KnowledgeSet(recipe.set_id, storage=self.storage)
        with self.storage.allow_mechanism():
            seed_general(self.knowledge_set)
            for _domain, provider in recipe.seeds:
                seed_knowledge_set(self.knowledge_set, provider())

        # ④ harness 装配（定义注册 + 仓库落库；装配期写入经豁免上下文）
        self.harness_registry = HarnessRegistry(registries=self.graph_registries)
        self.harness_repository = HarnessRepository(self.storage)
        for definition in recipe.harness_definitions:
            self.harness_registry.register(definition)
            with self.storage.allow_mechanism("harness"):
                await self.harness_repository.save(
                    definition, note="开局装配：自举领域基线"
                )

        # ⑤ 事件类型注册表（基线登记 + 集内演化类型加载；脏记录跳过）
        self.event_type_registry = EventTypeRegistry(
            storage=self.storage, set_id=recipe.set_id
        )
        for spec in recipe.event_type_specs:
            self.event_type_registry.register(spec)
        with self.storage.allow_mechanism("event_types"):
            await self.event_type_registry.load()
            await self.event_type_registry.save()

        # ⑥ 校验器与工具可信度闸门（配方白名单；提案形态的第一道闸门）
        self.validator = ProposalValidator(
            allowed_components=recipe.ui_allowed_components,
            allowed_channels=DEFAULT_BIND_CHANNELS,
            allowed_theme_tokens=recipe.ui_allowed_theme_tokens,
            graph_registries=self.graph_registries,
        )
        self.vetting = ToolVetting(static_hooks=recipe.vetting_static_hooks)

        # ⑦ 应用管线：提案 → 校验 → 分级审批 → 落链 → 应用 → 审计。
        #    审批策略由管线按分级表自建（机制单一来源，宿主策略钩子
        #    用于管线之外的宿主级审批，如种子沉淀卡）
        self.self_pipeline = SelfApplicationPipeline(
            self.storage,
            validator=self.validator,
            approval_levels=recipe.approval_levels,
            l2_vetting=recipe.vetting_l2_hook,
            on_reverted=recipe.on_reverted,
            guard_token=guard_token,
        )

        # ⑧ 界面基线：初始布局 = 数据，装配期经三层白名单校验（组件/
        #    绑定通道/主题 token）；基线损坏回落未定形，不击穿启动
        ui_spec: dict | None = recipe.ui_spec
        ui_violations = UISchemaValidator().validate(
            recipe.ui_spec or {},
            allowed_components=recipe.ui_allowed_components,
            allowed_channels=DEFAULT_BIND_CHANNELS,
            allowed_theme_tokens=recipe.ui_allowed_theme_tokens,
        )
        if ui_violations:
            logger.warning("初始界面描述校验未通过，回落未定形: %s", ui_violations)
            ui_spec = None

        # ⑨ 元工具流水线：内省（只读）+ 自指（演化）+ 统一三路分发。
        #    工具规格先于服务装配（内省快照需要工具清单）。宿主审批
        #    策略在此取用（五件套之一），经自指上下文供宿主级审批卡
        #    （种子沉淀等）消费
        self._host_policy = host.interrupt_policy()
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

        # ⑩ 调配源注册（检索源 → evidence 源；回合内节点预装配消费）
        self.retriever_registry = RetrieverRegistry()
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

        self.tool_pipeline = ToolPipeline(
            gate=PermissionGate(),
            extractor=unified_extractor,
            executor=unified_executor,
        )

        # ⑬ 从链恢复集状态（重启/回退后活跃态一致；链损坏回落基线）
        await self._restore_set_state(recipe)

        # ⑭ apply 目标注册（补丁落链后的活跃态生效钩子；配方工厂注入）
        for kind, factory in recipe.apply_targets.items():
            self.self_pipeline.register_target(kind, factory(self))

        # ⑮ 引擎重建（按当前模型配置装配回合图；工具表/配置变更重建）
        self.introspection_service._sources.tools = self.collect_specs()
        await self.rebuild_engine()
        self._drained.set()
        self._state = RuntimeState.RUNNING
        return self

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
        """关停（幂等）：拒新 → 等在途完成 → 关 MCP 会话 → 关存储 →
        宿主关停钩子。顺序保证优雅退出时远端会话先于存储被显式关闭。
        """
        if self._state in (RuntimeState.UNINITIALIZED, RuntimeState.STOPPED):
            return
        self._state = RuntimeState.STOPPED
        if self._active_runs:
            await self._drained.wait()
        if self.mcp_manager is not None:
            await self.mcp_manager.close_all()
        if self.storage is not None:
            await self.storage.close()
        if self._host is not None:
            await self._host.close()

    # ── 在途 run 登记（回合粒度；传输按请求注入，Runtime 不持单例传输）──

    def begin_run(self) -> RunTicket:
        """登记一个在途 run（拒绝新 run 的判据：非 running 状态显式报错）。"""
        if self._state is not RuntimeState.RUNNING:
            raise RuntimeError(
                f"运行时状态不允许开始新 run: {self._state.value}"
                "（pause 拒新、stop 拒新，在途 run 自然完成后可恢复）"
            )
        ticket = RunTicket(id=uuid.uuid4().hex)
        self._active_runs[ticket.id] = ticket
        self._drained.clear()
        return ticket

    def end_run(self, ticket: RunTicket) -> None:
        """注销一个在途 run（幂等；全部注销后 stop 的排空等待解除）。"""
        if ticket.id in self._active_runs:
            del self._active_runs[ticket.id]
            if not self._active_runs:
                self._drained.set()

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
        return await self.engine.ainvoke(
            {},
            thread_id=thread_id,
            round_id=round_id or uuid.uuid4().hex,
            resume_from=latest.checkpoint_id,
            inject={interrupt.key: decision},
            transports=transports,
        )

    # ── 装配产物访问器 ──

    def collect_specs(self) -> list[ToolSpec]:
        """工具清单汇总（内省 + 自指 + 动态工具），供内省快照与回合装配。"""
        return [
            *self.introspection_specs,
            *self.self_specs,
            *self.tool_registry.values(),
        ]

    async def rebuild_engine(self, llm: AsyncLLM | None = None) -> Engine:
        """重建回合图引擎（配置/工具表变更才重建；llm 缺省 = 宿主解析）。

        重建缓存键 = 模型实例身份 + 存储身份 + 工具表名集合——三者不变
        时复用既有引擎（「配置变更才重建」语义）；MCP 挂载/补丁链工具
        变化会改变名集合，自动触发重建。
        """
        if self._host is None or self._recipe is None:
            raise RuntimeError("运行时未装配（rebuild_engine 须在 boot 之后）")
        if llm is None:
            llm = await self._host.resolve_llm()
        specs = self.collect_specs()
        spec_key = tuple(sorted(spec.name for spec in specs))
        cache_key = (id(llm), id(self.storage), spec_key)
        if self.engine is not None and cache_key == self._engine_cache_key:
            return self.engine
        recipe = self._recipe
        context = GraphRecipeContext(
            llm=llm,
            tool_pipeline=self.tool_pipeline,
            tool_specs=specs,
            storage=self.storage,
            registries=self.graph_registries,
            system_events=self.event_type_registry.system_events(),
            assembly=AssemblyConfig(),
            assembly_sources=self._assembly_sources(),
        )
        graph = recipe.graph_recipe(context)
        engine = Engine(
            graph,
            options=RunOptions(
                storage=self.storage,
                registries=self.graph_registries,
                transports=[],
                system_events=context.system_events,
                assembly=context.assembly,
                assembly_sources=context.assembly_sources,
            ),
        )
        self.engine = engine
        self.engine_llm = llm
        self._engine_cache_key = cache_key
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
        )

    def _assembly_sources(self) -> Callable[..., Any]:
        """调配器源提供者：检索结果 → evidence 源（回合内节点预装配消费）。

        查询串取回合输入；检索结果按可信度分级过滤（只放行集内知识/
        用户级来源），经注册表合并排序后作 evidence 源注入。无检索源/
        空结果/调配未启用 = 空清单（检索是增强，不阻断回合）。
        """

        async def provide(ctx) -> list[ContextSource]:
            query = str(ctx.state.get("input") or "").strip()
            if not query:
                return []
            chunks = await self.retriever_registry.retrieve(
                query, limit=8, levels=(SOURCE_MODEL,)
            )
            return [
                ContextSource(
                    type=SOURCE_EVIDENCE,
                    content=chunk.text[:1200],
                    title=f"检索：{chunk.source}/{chunk.doc_id}",
                    relevance=chunk.relevance,
                    priority=5,
                    meta={"source": chunk.source, "doc_id": chunk.doc_id},
                )
                for chunk in chunks
            ]

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
                        allowed_channels=DEFAULT_BIND_CHANNELS,
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
