"""开局装配：把引擎机制骨架与产品服务装配成可运行的 Forge 实例。

装配顺序（机制依赖自上而下；尚未就绪的环节先留空位，随能力逐步
接入）：

① 存储（SQLite 集目录 engine.db）+ 进程锁（防双开）
② 图注册表（GraphRegistries：节点类型/条件边注册位）
③ 种子注入（seed_user_set 通用种子恒注；领域种子后续接入）
④ harness 装配（forge 领域定义 → HarnessRegistry 注册 + HarnessRepository 落库）
⑤ 事件类型注册表（boot 内置类型登记 + 集内演化类型加载）+ 界面描述装配
⑥ 工具装配（内省元工具 → 只读流水线，权限门禁/审计/截断）
⑦ vetting 闸门（工具可信度：静态审查钩子 + L2 沙箱验证钩子）
⑧ LLM 挡位解析（settings 模型配置，未配置 = None 由路由端拦截引导）
⑨ 调配器源注册（检索源 → 装配源提供者，回合内证据汇入）
⑩ RunOptions DI → Engine 实例（按当前 LLM 配置缓存，配置变更自动重建）
⑪ EngineTransport（SSE 桥，回合期注入）→ 前端壳渲染

装配产物（ForgeApp）为进程级单例；路由/回合均经 boot 取用。
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ink_engine.core.assembly import SOURCE_EVIDENCE, AssemblyConfig
from ink_engine.core.context import ContextSource
from ink_engine.core.declarative_tools import EndpointType
from ink_engine.core.event_types import EventTypeRegistry, EventTypeSpec
from ink_engine.core.executor import Engine, RunOptions
from ink_engine.core.harness import (
    HarnessDefinition,
    HarnessRegistry,
    HarnessRepository,
)
from ink_engine.core.introspection import (
    IntrospectionService,
    IntrospectionSources,
    build_introspection_pipeline,
    introspection_tool_specs,
    make_introspection_executor,
)
from ink_engine.core.knowledge_set import KnowledgeSet
from ink_engine.core.llm import AsyncLLM, create_llm
from ink_engine.core.mcp_client import (
    McpClientManager,
    McpServerConfig,
    McpToolImportError,
    register_mcp_executor,
)
from ink_engine.core.permissions import PermissionGate
from ink_engine.core.registry import GraphRegistries
from ink_engine.core.retrieval import (
    SOURCE_MODEL,
    RetrievedChunk,
    RetrieverRegistry,
)
from ink_engine.core.seeds import seed_user_set
from ink_engine.core.self_application import (
    ApprovalLevel,
    GuardedStorage,
    SelfApplicationPipeline,
)
from ink_engine.core.self_proposal import PatchKind, ProposalValidator
from ink_engine.core.storage import Storage
from ink_engine.core.tool_pipeline import ToolPipeline
from ink_engine.core.tool_vetting import ToolVetting
from ink_engine.core.ui_schema import DEFAULT_BIND_CHANNELS, UISchemaValidator
from ink_engine.seeds.boot import (
    BOOT_EVENT_TYPES,
    BOOT_UI_SPEC,
    boot_harness_definition,
)

from . import config
from . import engine as engine_store
from . import secrets as secrets_store
from .domains.files.mounts import MountRegistry
from .evolution import ConvergencePolicy, IncubatorService
from .round import build_forge_graph
from .self_tools import (
    build_self_pipeline,
    make_self_executor,
    operation_of,
    self_tool_specs,
)

logger = logging.getLogger(__name__)

FORGE_SET_USER = "default"

# boot 渲染器组件白名单（界面描述只能引用已注册组件，JSON 不能执行任意代码）
ALLOWED_UI_COMPONENTS: tuple[str, ...] = (
    "column",
    "message_list",
    "agent_input",
    "files_panel",
)
# 主题 token 白名单（布局只能使用已声明的主题键）
ALLOWED_THEME_TOKENS: tuple[str, ...] = ("bg", "fg", "accent")


class KnowledgeRetriever:
    """知识集检索源（Retriever 实现）：检索集内知识条目作证据汇入。

    检索执行体 = 知识集的关键词基线（复用优先于生成：相似任务先检索
    已有条目）；检索结果带可信度分级（集内知识条目 = 模型级沉淀，
    非外部 web 来源），经注册表合并排序后作调配器 evidence 源注入。
    """

    name = "knowledge"

    def __init__(self, knowledge_set: KnowledgeSet) -> None:
        self._knowledge_set = knowledge_set

    async def retrieve(self, query: str, *, limit: int) -> list[RetrievedChunk]:
        hits = self._knowledge_set.search(query, limit=limit)
        return [
            RetrievedChunk(
                source=self.name,
                doc_id=entry.id,
                text=f"{entry.title}：{entry.data}",
                relevance=min(1.0, entry.credibility),
                level=SOURCE_MODEL,
                meta={"kind": entry.kind, "source": entry.source},
            )
            for entry in hits
        ]


def _build_static_hooks() -> list:
    """默认静态审查钩子：代码形态审查（零外部依赖）。

    审查面 = AI 生成代码的形态合法性：Python 语法可解析（ast 编译）、
    文件真实存在。eslint/tsc/ruff 等重型审查由宿主按环境注入
    （ToolVetting 接受任意钩子清单），缺省不阻塞装配。
    """
    import ast

    def python_syntax(paths):
        violations: list[str] = []
        for path in paths:
            if not str(path).endswith(".py"):
                continue
            try:
                ast.parse(Path(path).read_text(encoding="utf-8"))
            except (SyntaxError, OSError) as exc:
                violations.append(f"Python 语法审查未通过: {path}: {exc}")
        return violations

    return [python_syntax]


def _build_l2_vetting(vetting: ToolVetting):
    """L2 沙箱验证钩子：构建产物引用的部署前静态门禁。

    验证面（fail-closed）：产物哈希声明的每个文件须真实存在于集
    数据目录的 artifacts 子目录且内容哈希一致（防篡改静默切换）；
    任一文件缺失/哈希不符 = 违规（不弹卡、不落链）。
    """

    def vet(proposal) -> list[str]:
        if proposal.kind is not PatchKind.ARTIFACT:
            return []
        payload = proposal.payload
        hashes = payload.get("hashes") or {}
        artifacts_dir = config.SET_DIR / "artifacts"
        if not artifacts_dir.is_dir():
            return ["构建产物目录不存在，无可部署产物"]
        violations: list[str] = []
        for name, digest in hashes.items():
            source = artifacts_dir / name
            if not source.is_file():
                violations.append(f"产物文件缺失: {name}")
                continue
            actual = hashlib.sha256(source.read_bytes()).hexdigest()
            if actual != digest:
                violations.append(f"产物哈希不一致: {name}")
        return violations

    return vet


@dataclass(slots=True)
class ForgeApp:
    """装配产物：引擎实例与集内服务视图（进程级单例）。"""

    storage: Storage
    graph_registries: GraphRegistries
    knowledge_set: KnowledgeSet
    harness_registry: HarnessRegistry
    harness_repository: HarnessRepository
    event_type_registry: EventTypeRegistry
    mount_registry: MountRegistry
    introspection_service: IntrospectionService
    introspection_specs: list
    introspection_pipeline: ToolPipeline
    self_pipeline: SelfApplicationPipeline
    self_specs: list
    self_pipeline_runner: ToolPipeline
    retriever_registry: RetrieverRegistry
    mcp_manager: McpClientManager
    tool_vetting: ToolVetting
    tool_pipeline: ToolPipeline
    engine: Engine | None = None
    engine_llm: AsyncLLM | None = None
    # 孵化闭环：行为信号 → 蒸馏 → 知识沉淀（E 期宿主侧串联）
    incubator: IncubatorService | None = None
    incubation_pipeline: SelfApplicationPipeline | None = None
    # 演化收敛管制：同目标反复折腾 → 冷却/冻结（提案前置闸门）
    convergence: ConvergencePolicy | None = None

    # 宿主动态工具表（演化挂载的工具定义，重启从链组装恢复；每次
    # 重建回合图时与内省/自指工具合并进工具清单）
    tool_registry: dict = field(default_factory=dict)

    async def resolve_llm(self) -> AsyncLLM | None:
        """按引擎存储的模型配置解析主模型 LLM（records 为唯一真相）。

        未配置完整（base_url/model_id 必填）或配置解析失败时返回 None，
        由路由端拦截并引导用户进入模型设置。
        """
        try:
            record = await self.storage.get_record("settings", "models")
        except Exception as exc:
            logger.warning("模型配置读取失败: %s", exc)
            return None
        cfg = (record or {}).get("main") or {}
        if not cfg.get("model_id") or not cfg.get("base_url"):
            return None
        cfg = dict(cfg)
        cfg["api_key"] = await secrets_store.get_api_key("main")
        try:
            return create_llm(cfg)
        except Exception as exc:  # 配置形态异常不击穿启动
            logger.warning("模型配置解析失败: %s", exc)
            return None

    async def rebuild_engine(self, llm: AsyncLLM | None = None) -> Engine:
        """重建回合图引擎（按当前 LLM 配置装配；配置变更后取最新）。"""
        if llm is None:
            llm = await self.resolve_llm()
        self.engine_llm = llm
        specs = _collect_specs(self)
        graph = build_forge_graph(
            llm,
            self.tool_pipeline,
            specs,
            storage=self.storage,
        )
        engine = Engine(
            graph,
            options=RunOptions(
                storage=self.storage,
                registries=self.graph_registries,
                transports=[],
                system_events=self.event_type_registry.system_events(),
                # 输入调配：检索结果作 evidence 源汇入（回合内每节点
                # 预装配一次；无检索源/未启用时回合照常执行）
                assembly=AssemblyConfig(),
                assembly_sources=_retrieval_sources(self),
            ),
        )
        self.engine = engine
        self.introspection_service.set_graph(graph)
        return engine


    async def mount_mcp_server(
        self, server_config: McpServerConfig, *, vetting: ToolVetting | None = None
    ) -> list[str]:
        """挂载外部 MCP server：连接 → 导入工具（经 vetting 闸门）→ 注册
        进声明式执行体注册表与动态工具表（可被回合调用）。

        连接/导入失败抛 :class:`McpToolImportError`（宿主转拒绝，不静默
        降级），失败时已建立的连接回滚断开；vetting 闸门过滤被拒工具
        （fail-closed，信任靠审查证据）。工具名冲突（跨 server 同名或与
        集内既有工具同名）显式拒绝——静默覆盖会把调用路由到错误的
        server。挂载成功后重建回合引擎：模型立即获得新工具清单，
        ``inspect_tools`` 可见且下一回合即可调用。
        """
        stale_names = self.mcp_manager.imported_tools(server_config.id)
        await self.mcp_manager.connect(server_config)
        try:
            specs = await self.mcp_manager.import_tools(
                server_config.id, source=server_config.source, vetting=vetting or self.tool_vetting
            )
            self._guard_name_collisions(server_config.id, specs)
            for name in stale_names:
                self.harness_registry.declarative.unregister_definition(name)
                self.tool_registry.pop(name, None)
            for spec in specs:
                self.harness_registry.declarative.register_definition(spec)
                self.tool_registry[spec.name] = spec.to_spec()
        except Exception:
            await self.mcp_manager.disconnect(server_config.id)
            raise
        self.introspection_service._sources.tools = _collect_specs(self)
        await self.rebuild_engine()
        return [spec.name for spec in specs]

    def _guard_name_collisions(
        self, server_id: str, specs: list
    ) -> None:
        """挂载前的工具名冲突检查（fail-closed，防调用被静默改路由）。

        冲突判定：同名定义已存在且来源不同——MCP 工具属于仍在连接的
        另一个 server，或属于集内工具/补丁链工具（非 MCP 端点）。同一
        server 的重挂载允许覆盖（自己的工具换版）；已断开 server 的
        陈旧定义允许接管（会话已不存在，定义本身即将失效）。
        """
        active_servers = set(self.mcp_manager.list_servers())
        conflicts: list[str] = []
        for spec in specs:
            existing = self.harness_registry.declarative.definitions.get(spec.name)
            if existing is None:
                continue
            existing_server = existing.endpoint_config.get("server_id")
            if existing_server == server_id:
                continue
            if existing.endpoint is not EndpointType.MCP or existing_server in active_servers:
                conflicts.append(spec.name)
        if conflicts:
            raise McpToolImportError(
                f"MCP 工具名冲突，挂载被拒: {', '.join(sorted(conflicts))}"
                "（同名工具已属于其他 server 或集内工具；先卸载冲突源）"
            )

    async def unmount_mcp_server(self, server_id: str) -> bool:
        """断开并注销外部 MCP server：会话关闭，该 server 导入的工具
        定义同步撤出动态工具表并重建回合引擎——防连线断掉后模型仍被
        提供注定失败的调用。卸下的工具不持久化（server 非集内资产），
        重启不会复活。"""
        imported_names = self.mcp_manager.imported_tools(server_id)
        removed = await self.mcp_manager.disconnect(server_id)
        if not removed:
            return False
        for name in imported_names:
            self.harness_registry.declarative.unregister_definition(name)
            self.tool_registry.pop(name, None)
        self.introspection_service._sources.tools = _collect_specs(self)
        await self.rebuild_engine()
        return True


# 装配产物进程级单例（幂等装配/关闭的共享句柄；None = 未装配）
_app: ForgeApp | None = None
_lock = asyncio.Lock()


async def _on_reverted_trigger(patch_id: int, reason: str) -> None:
    """回退后的孵化触发（回退 = 修正信号源：立即消费一次）。

    回退回调由应用管线调用（链已回退、审计已留痕）；孵化循环自身
    幂等（游标增量），失败只留痕不击穿回退流程。
    """
    app = _app
    if app is None or app.incubator is None:
        return
    try:
        await app.incubator.run_cycle()
    except Exception as exc:
        logger.warning("回退后孵化循环失败（忽略）: %s", exc)


async def init_app() -> ForgeApp:
    """装配 Forge 实例（幂等；进程生命周期内只装配一次）。"""
    global _app
    async with _lock:
        if _app is not None:
            return _app
        await engine_store.init_engine()
        storage = engine_store.get_storage()

        # ① 旁路写防护：集内可演化资产集合的唯一写入路径 = 应用管线；
        #    引擎执行/机制通道（checkpoint/事件日志/用户位置感知/设置）
        #    经包装透传不受限。守卫令牌只归应用管线持有（补丁链/审计
        #    自身写入放行），宿主其余路径默认拦截
        guard_token = uuid.uuid4().hex
        guarded_storage = GuardedStorage(storage, guard_token=guard_token)
        storage = guarded_storage

        # ② 图注册表：节点类型/条件边注册位（回合图经此解析）
        registries = GraphRegistries()

        # ③ 种子注入：通用种子恒注（幂等基线）；boot 领域种子按名注入
        # 自举系统提示词（注册契约在 ink_engine.seeds.boot 模块导入时
        # 生效，此处按名解析消费，防注册与消费脱节）。
        # 种子注入属启动装配机制路径（注入非演化），经旁路写防护的
        # 全豁免上下文放行（knowledge 集合按前缀守卫，种子写入不受
        # 演化管线约束）
        knowledge_set = KnowledgeSet(FORGE_SET_USER, storage=storage)
        with storage.allow_mechanism():
            seed_user_set(knowledge_set, domain="boot")

        # ④ harness 装配：forge 领域定义（自指元能力集）注册 + 落库。
        # 装配期写入属机制内部路径，经显式豁免上下文放行
        harness_registry = HarnessRegistry(registries=registries)
        harness_repository = HarnessRepository(storage)
        forge_definition = boot_harness_definition()
        harness_registry.register(forge_definition)
        with storage.allow_mechanism("harness"):
            await harness_repository.save(
                forge_definition, note="开局装配：forge 自举领域基线"
            )

        # ⑤ 事件类型注册表：boot 内置类型登记 + 集内演化类型加载。
        # 内置基线优先，集内同名校验跳过（AI 改类型走补丁链版本化，
        # 不覆盖基线）；脏记录跳过不阻断启动。装配期写入属机制内部
        # 路径，经旁路写防护的显式豁免上下文放行
        event_registry = EventTypeRegistry(storage=storage, set_id=FORGE_SET_USER)
        for spec in BOOT_EVENT_TYPES:
            event_registry.register(spec)
        with storage.allow_mechanism("event_types"):
            await event_registry.load()
            await event_registry.save()

        # 本地文件访问授权（挂载点模型）：AI 只见显式授权的挂载点，
        # 磁盘其余部分 fail-closed 不可见；注册/撤销是用户动作
        mount_registry = MountRegistry(storage)

        # ⑫ 应用管线：提案 → 校验 → 分级审批 → 补丁链落库 →
        #    活跃态生效。校验器白名单与界面渲染器同源（组件/绑定通道/
        #    主题 token 三层）；审批分级默认 L0（界面/主题）直过、
        #    其余 L1 弹卡、构建产物引用 L2（沙箱验证 + 人工审批，
        #    宿主可整体替换分级表）
        validator = ProposalValidator(
            allowed_components=ALLOWED_UI_COMPONENTS,
            allowed_channels=DEFAULT_BIND_CHANNELS,
            allowed_theme_tokens=ALLOWED_THEME_TOKENS,
            graph_registries=registries,
        )
        vetting = ToolVetting(static_hooks=_build_static_hooks())
        # 主应用管线（AI 提案走 L0/L1/L2 分级审批）；回退后触发孵化
        # 循环（回退 = 行为信号源：立即消费一次，不等回合尾）
        self_pipeline = SelfApplicationPipeline(
            storage,
            validator=validator,
            guard_token=guard_token,
            l2_vetting=_build_l2_vetting(vetting),
            on_reverted=_on_reverted_trigger,
        )
        # 孵化管线（E 期）：知识沉淀的专用通道——确定性蒸馏产物 +
        # 来源留痕 + 可回退，分级 L0 直过（宿主可整表替换分级），与
        # AI 提案共用同一链与校验器，写入路径仍唯一（应用管线）
        incubation_pipeline = SelfApplicationPipeline(
            storage,
            validator=validator,
            approval_levels={PatchKind.KNOWLEDGE: ApprovalLevel.L0},
            guard_token=guard_token,
        )

        # 界面描述装配：初始面板布局 = 数据，装配期经三层白名单校验
        # （组件/绑定通道/主题 token）；基线损坏回落未定形，不击穿启动
        ui_spec: dict[str, Any] | None = BOOT_UI_SPEC
        ui_violations = UISchemaValidator().validate(
            BOOT_UI_SPEC,
            allowed_components=ALLOWED_UI_COMPONENTS,
            allowed_channels=DEFAULT_BIND_CHANNELS,
            allowed_theme_tokens=ALLOWED_THEME_TOKENS,
        )
        if ui_violations:
            logger.warning("初始界面描述校验未通过，回落未定形: %s", ui_violations)
            ui_spec = None

        # ⑥ 工具装配：内省元工具（只读）+ 自指元工具（演化）+ 动态
        #    工具表（重启从链恢复）。工具规格先于服务装配（内省快照
        #    需要工具清单）
        introspection_specs = introspection_tool_specs()
        self_specs = self_tool_specs()
        introspection_service = IntrospectionService(
            IntrospectionSources(
                knowledge_set=knowledge_set,
                harness_registry=harness_registry,
                tools=[],
                ui_spec=ui_spec,
            )
        )
        introspection_pipeline = build_introspection_pipeline(introspection_service)
        self_pipeline_runner = build_self_pipeline(
            self_pipeline, lambda: _app or get_app()
        )

        # ⑨ 检索原语装配：Retriever 注册表（知识集检索源注册，结果
        #    作调配器 evidence 源注入；FTS/向量/MCP 检索源由领域层
        #    后续注册，插拔 U 盘——注册即汇入）
        retriever_registry = RetrieverRegistry()
        retriever_registry.register(KnowledgeRetriever(knowledge_set))

        # ⑬ 统一工具流水线：内省（只读）/ 自指（演化）/ 动态工具
        #    （挂载定义）三路分发，同一权限门禁与审计管线
        introspection_executor = make_introspection_executor(introspection_service)
        self_executor = make_self_executor(self_pipeline, lambda: _app or get_app())
        introspection_names = {spec.name for spec in introspection_specs}
        self_names = {spec.name for spec in self_specs}

        async def unified_executor(ctx, spec, args, approval):
            if spec.name in introspection_names:
                return await introspection_executor(ctx, spec, args, approval)
            if spec.name in self_names:
                return await self_executor(ctx, spec, args, approval)
            return await harness_registry.declarative.dispatch(
                ctx, spec, args, approval
            )

        def unified_extractor(spec, args):
            if spec.name in introspection_names:
                return ("read", "*")
            if spec.name in self_names:
                return operation_of(spec)
            definition = harness_registry.declarative.definitions.get(spec.name)
            if definition is None:
                return None
            from ink_engine.core.declarative_tools import endpoint_operation

            return endpoint_operation(
                definition.endpoint, args, config=definition.endpoint_config
            )

        tool_pipeline = ToolPipeline(
            gate=PermissionGate(),
            extractor=unified_extractor,
            executor=unified_executor,
        )

        # MCP 客户端管理器：外部 server 会话生命周期 + 工具导入 + 分发
        # 执行器注册（端点 = MCP 的声明式工具经统一流水线转发调用）。
        # 离线降级时本管理器为空（无任何外挂载工具），内建工具集照常
        # 可用——MCP 是增强不是收紧
        mcp_manager = McpClientManager()
        register_mcp_executor(harness_registry.declarative, mcp_manager)

        app = ForgeApp(
            storage=storage,
            graph_registries=registries,
            knowledge_set=knowledge_set,
            harness_registry=harness_registry,
            harness_repository=harness_repository,
            event_type_registry=event_registry,
            mount_registry=mount_registry,
            introspection_service=introspection_service,
            introspection_specs=introspection_specs,
            introspection_pipeline=introspection_pipeline,
            self_pipeline=self_pipeline,
            self_specs=self_specs,
            self_pipeline_runner=self_pipeline_runner,
            retriever_registry=retriever_registry,
            mcp_manager=mcp_manager,
            tool_vetting=vetting,
            tool_pipeline=tool_pipeline,
        )
        _app = app
        app.incubation_pipeline = incubation_pipeline
        # 孵化闭环与收敛管制装配（宿主侧串联：信号源=审计/回退/审批）
        app.convergence = ConvergencePolicy(storage)
        app.incubator = IncubatorService(lambda: app, incubation_pipeline)

        # 从链恢复集状态（重启/回退后活跃态一致）：界面描述、harness、
        # 动态工具、事件类型（基线优先，不覆盖 boot 内置类型）
        await _restore_set_state(app)

        # ⑭ 活跃态应用目标：补丁落链后的运行时生效钩子（幂等可重放）
        await _register_apply_targets(app)

        # 统一工具流水线（内省 + 自指 + 动态工具经同一管线执行）
        app.introspection_service._sources.tools = _collect_specs(app)
        await app.rebuild_engine()
        logger.info("Forge 装配完成（集目录: %s）", config.SET_DIR)
        _app = app
        return _app


class _UITarget:
    """界面/主题补丁的活跃态目标：更新渲染器数据源 + 落库冗余视图。

    界面描述的权威记录 = 集补丁链（重启从链组装恢复）；此处只更新
    内存活跃态（渲染器消费）并写 ui 集合作审计视图（经旁路写防护
    的机制豁免——目标代码是应用管线的延伸）。
    """

    name = "ui"

    def __init__(self, app: ForgeApp) -> None:
        self._app = app

    async def apply(self, payload: dict, patch_id: int) -> None:
        spec = payload.get("spec")
        if isinstance(spec, dict):
            self._app.introspection_service._sources.ui_spec = spec
            with self._app.storage.allow_mechanism("ui"):
                await self._app.storage.put_record(
                    "ui", spec.get("name") or "boot.panel", {"spec": spec, "patch_id": patch_id}
                )


class _ThemeTarget:
    """主题补丁的活跃态目标：主题 token 覆盖渲染器数据源。"""

    name = "theme"

    def __init__(self, app: ForgeApp) -> None:
        self._app = app

    async def apply(self, payload: dict, patch_id: int) -> None:
        tokens = payload.get("tokens")
        if not isinstance(tokens, dict):
            return
        current = self._app.introspection_service._sources.ui_spec
        if not isinstance(current, dict):
            return
        updated = dict(current)
        updated["theme"] = {**dict(current.get("theme") or {}), **tokens}
        self._app.introspection_service._sources.ui_spec = updated


class _ToolTarget:
    """工具补丁的活跃态目标：登记声明式定义 + 注册进宿主动态工具表。

    执行体注册由宿主后续接入（未注册执行体的调用在分发处显式拒绝，
    fail-closed）；注册后 inspect_tools 立即可见、可被后续回合调用。
    """

    name = "tool"

    def __init__(self, app: ForgeApp) -> None:
        self._app = app

    async def apply(self, payload: dict, patch_id: int) -> None:
        from ink_engine.core.declarative_tools import DeclarativeToolSpec

        declarative = DeclarativeToolSpec.from_dict(payload)
        self._app.harness_registry.declarative.register_definition(declarative)
        self._app.tool_registry[declarative.name] = declarative.to_spec()
        self._app.introspection_service._sources.tools = _collect_specs(self._app)
        with self._app.storage.allow_mechanism("tool_defs"):
            await self._app.storage.put_record(
                "tool_defs", declarative.name, declarative.to_dict()
            )


class _EventTypeTarget:
    """事件类型补丁的活跃态目标：注册进事件类型注册表并落库。

    重复注册（AI 改类型）保守跳过——类型变更走「先废弃再注册」或
    补丁链版本化，不静默覆盖既有类型。
    """

    name = "event_type"

    def __init__(self, app: ForgeApp) -> None:
        self._app = app

    async def apply(self, payload: dict, patch_id: int) -> None:
        spec = EventTypeSpec.from_dict(payload)
        registry = self._app.event_type_registry
        if spec.name in registry.names():
            logger.info("事件类型已存在，跳过注册（类型变更走版本化）: %s", spec.name)
            return
        registry.register(spec)
        with self._app.storage.allow_mechanism("event_types"):
            await registry.save()


class _KnowledgeTarget:
    """知识补丁的活跃态目标：条目写入知识集（补丁链通道）并落库。

    知识集的权威记录 = 集补丁链（knowledge 段）；此处同步内存链
    （重启从链组装恢复），落库经旁路写防护的显式豁免——目标代码
    是应用管线的延伸。
    """

    name = "knowledge"

    def __init__(self, app: ForgeApp) -> None:
        self._app = app

    async def apply(self, payload: dict, patch_id: int) -> None:
        from ink_engine.core.knowledge_set import KnowledgeEntry

        raw = payload.get("entry")
        if not isinstance(raw, dict):
            return
        entry = KnowledgeEntry.from_dict(raw)
        ks = self._app.knowledge_set
        if ks.get(entry.id) is None:
            ks.add(entry)
        else:
            changes = {
                key: value
                for key, value in entry.to_dict().items()
                if key not in ("id", "created_at")
            }
            ks.update(entry.id, **changes)
        with self._app.storage.allow_mechanism():
            await ks.save()


class _HarnessTarget:
    """harness 补丁的活跃态目标：注册进 harness 注册表 + 仓库落库。"""

    name = "harness"

    def __init__(self, app: ForgeApp) -> None:
        self._app = app

    async def apply(self, payload: dict, patch_id: int) -> None:
        definition = payload.get("definition")
        if not isinstance(definition, dict):
            return
        parsed = HarnessDefinition.from_dict(definition)
        self._app.harness_registry.register(parsed)
        # 目标代码是应用管线的延伸：仓库落库经旁路写防护的显式豁免
        with self._app.storage.allow_mechanism("harness"):
            await self._app.harness_repository.save(
                parsed, note=f"补丁 #{patch_id}"
            )


async def _register_apply_targets(app: ForgeApp) -> None:
    """应用管线目标注册：补丁落链后按类型生效到运行时。

    孵化管线与主管线共用同一知识活跃态目标（同一条集补丁链，写入
    路径唯一）；孵化自身不注册其它目标——只沉淀知识，不碰形态。
    """
    pipeline = app.self_pipeline
    pipeline.register_target(PatchKind.UI, _UITarget(app))
    pipeline.register_target(PatchKind.THEME, _ThemeTarget(app))
    pipeline.register_target(PatchKind.TOOL, _ToolTarget(app))
    pipeline.register_target(PatchKind.EVENT_TYPE, _EventTypeTarget(app))
    pipeline.register_target(PatchKind.HARNESS, _HarnessTarget(app))
    pipeline.register_target(PatchKind.KNOWLEDGE, _KnowledgeTarget(app))
    if app.incubation_pipeline is not None:
        app.incubation_pipeline.register_target(
            PatchKind.KNOWLEDGE, _KnowledgeTarget(app)
        )


async def _restore_set_state(app: ForgeApp) -> None:
    """从集补丁链组装恢复活跃态（重启/回退后集状态一致）。

    链是权威记录：界面描述/harness/动态工具/事件类型/环境/产物按
    最新组装形态重建运行时视图；恢复失败只记日志不击穿启动（链
    损坏时回落基线，可回退修复）。
    """
    try:
        state = await app.self_pipeline.chain.assemble()
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
                    allowed_components=ALLOWED_UI_COMPONENTS,
                    allowed_channels=DEFAULT_BIND_CHANNELS,
                    allowed_theme_tokens=ALLOWED_THEME_TOKENS,
                )
                if not violations:
                    app.introspection_service._sources.ui_spec = spec
            except Exception:
                pass
    for name, definition in (state.get("harness") or {}).items():
        if not isinstance(definition, dict):
            continue
        try:
            parsed = HarnessDefinition.from_dict(definition)
            app.harness_registry.register(parsed)
        except Exception as exc:
            logger.warning("harness 恢复失败（跳过）: %s: %s", name, exc)
    for name, tool_data in (state.get("tools") or {}).items():
        if not isinstance(tool_data, dict):
            continue
        try:
            from ink_engine.core.declarative_tools import DeclarativeToolSpec

            declarative = DeclarativeToolSpec.from_dict(tool_data)
            app.harness_registry.declarative.register_definition(declarative)
            app.tool_registry[name] = declarative.to_spec()
        except Exception as exc:
            logger.warning("工具恢复失败（跳过）: %s: %s", name, exc)
    for name, spec_data in (state.get("event_types") or {}).items():
        if not isinstance(spec_data, dict) or name in app.event_type_registry.names():
            continue
        try:
            spec = EventTypeSpec.from_dict(spec_data)
            app.event_type_registry.register(spec)
        except Exception as exc:
            logger.warning("事件类型恢复失败（跳过）: %s: %s", name, exc)
    knowledge_state = state.get("knowledge") or {}
    if isinstance(knowledge_state, dict) and knowledge_state:
        try:
            from ink_engine.core.knowledge_set import KnowledgeSet

            # 知识集内存链按集状态重建（权威 = 集补丁链；重启后
            # 检索/内省立即反映演化产物）
            app.knowledge_set = KnowledgeSet.from_export(
                FORGE_SET_USER,
                {"base": {"entries": knowledge_state}, "patches": []},
                storage=app.storage,
            )
        except Exception as exc:
            logger.warning("知识集恢复失败（跳过）: %s", exc)


def _retrieval_sources(app: ForgeApp):
    """调配器源提供者：检索结果 → evidence 源（回合内节点预装配消费）。

    查询串取回合输入（用户原话）；检索结果按可信度分级过滤（只放行
    集内知识/用户级来源——web 级检索注入不汇入），经注册表合并排序
    后作 evidence 源注入。无检索源/空结果/调配未启用 = 空清单（检索
    是增强，不阻断回合）。
    """

    async def provide(ctx) -> list[ContextSource]:
        query = str(ctx.state.get("input") or "").strip()
        if not query:
            return []
        chunks = await app.retriever_registry.retrieve(
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


def _collect_specs(app: ForgeApp) -> list:
    """工具清单汇总（内省 + 自指 + 动态工具），供内省快照与回合装配。"""
    return [
        *app.introspection_specs,
        *app.self_specs,
        *app.tool_registry.values(),
    ]


async def close_app() -> None:
    """关闭装配产物（进程退出前调用，幂等）。

    先回收外部连接（MCP 会话/子进程传输），再清空单例与引擎存储——
    顺序保证优雅退出时远端会话被显式关闭而非随进程悬断。
    """
    global _app
    async with _lock:
        if _app is not None:
            await _app.mcp_manager.close_all()
        _app = None
        await engine_store.close_engine()


def get_app() -> ForgeApp:
    """访问装配产物；未装配时抛错（lifespan 之外调用即编程错误）。"""
    if _app is None:
        raise RuntimeError("Forge 未装配（init_app 未执行）")
    return _app
