"""开局装配：把引擎机制骨架与产品服务装配成可运行的 Forge 实例。

装配顺序（机制依赖自上而下，与引擎初始化装配约定一致；尚未就绪的
环节先留空位，随能力逐步接入）：

① 存储（SQLite 集目录 engine.db）+ 进程锁（防双开）
② 图注册表（GraphRegistries：节点类型/条件边注册位）
③ 种子注入（seed_user_set 通用种子恒注；领域种子后续接入）
④ harness 装配（forge 领域定义 → HarnessRegistry 注册 + HarnessRepository 落库）
⑤ 事件类型注册表（boot 内置类型登记 + 集内演化类型加载）+ 界面描述装配
⑥ 工具装配（内省元工具 → 只读流水线，权限门禁/审计/截断）
⑦ vetting 闸门（尚未接入，留空位）
⑧ LLM 挡位解析（settings 模型配置，未配置 = None 由路由端拦截引导）
⑨ 调配器源注册（尚未接入，留空位）
⑩ RunOptions DI → Engine 实例（按当前 LLM 配置缓存，配置变更自动重建）
⑪ EngineTransport（SSE 桥，回合期注入）→ 前端壳渲染

装配产物（ForgeApp）为进程级单例；路由/回合均经 boot 取用。
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any

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
)
from ink_engine.core.knowledge_set import KnowledgeSet
from ink_engine.core.llm import AsyncLLM, create_llm
from ink_engine.core.registry import GraphRegistries
from ink_engine.core.seeds import seed_user_set
from ink_engine.core.storage import Storage
from ink_engine.core.tool_pipeline import ToolPipeline
from ink_engine.core.ui_schema import DEFAULT_BIND_CHANNELS, UISchemaValidator

from . import config
from . import engine as engine_store
from . import secrets as secrets_store
from .domains.files.mounts import MountRegistry
from .round import build_forge_graph

logger = logging.getLogger(__name__)

FORGE_SET_USER = "default"

# boot 内置事件类型登记：协议 v2 的建卡型事件 → 前端同名渲染组件。
# 更新型事件（*_token/*_end）不独立建卡不登记；schema 缺省不校验
# payload 形态（发射侧保持宽松——注册表是增强不是收紧）
BOOT_EVENT_TYPES: tuple[EventTypeSpec, ...] = (
    EventTypeSpec(
        name="reply_token",
        renderer="StreamingRow",
        meta={"source": "boot", "description": "正文流式输出"},
    ),
    EventTypeSpec(
        name="thinking_start",
        renderer="ThinkingRow",
        meta={"source": "boot", "description": "思考卡"},
    ),
    EventTypeSpec(
        name="plan_start",
        renderer="PlanRow",
        meta={"source": "boot", "description": "规划卡"},
    ),
    EventTypeSpec(
        name="tool_start",
        renderer="ToolRow",
        meta={"source": "boot", "description": "工具卡"},
    ),
    EventTypeSpec(
        name="node_start",
        renderer="NodeRow",
        meta={"source": "boot", "description": "节点卡"},
    ),
    EventTypeSpec(
        name="review_card",
        renderer="ReviewCard",
        meta={"source": "boot", "description": "审核卡"},
    ),
    EventTypeSpec(
        name="suggestions",
        renderer="TextRow",
        meta={"source": "boot", "description": "建议卡"},
    ),
    EventTypeSpec(
        name="error",
        renderer="ErrorRow",
        meta={"source": "boot", "description": "错误消息"},
    ),
)

# boot 初始界面描述（对话面板 = 数据；渲染器消费布局树即时重渲）
BOOT_UI_SPEC: dict[str, Any] = {
    "name": "boot.panel",
    "version": 1,
    "root": {
        "kind": "container",
        "type": "column",
        "children": [
            {
                "kind": "component",
                "type": "message_list",
                "bind": {"channel": "state", "path": "messages"},
            },
            {"kind": "component", "type": "agent_input"},
        ],
    },
    "theme": {"bg": "#09090b", "fg": "#e4e4e7", "accent": "#f59e0b"},
}

# boot 渲染器组件白名单（界面描述只能引用已注册组件，JSON 不能执行任意代码）
ALLOWED_UI_COMPONENTS: tuple[str, ...] = (
    "column",
    "message_list",
    "agent_input",
    "files_panel",
)
# 主题 token 白名单（布局只能使用已声明的主题键）
ALLOWED_THEME_TOKENS: tuple[str, ...] = ("bg", "fg", "accent")


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
    engine: Engine | None = None
    engine_llm: AsyncLLM | None = None

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
        graph = build_forge_graph(
            llm,
            self.introspection_pipeline,
            self.introspection_specs,
            storage=self.storage,
        )
        engine = Engine(
            graph,
            options=RunOptions(
                storage=self.storage,
                registries=self.graph_registries,
                transports=[],
                system_events=self.event_type_registry.system_events(),
            ),
        )
        self.engine = engine
        self.introspection_service.set_graph(graph)
        return engine


_app: ForgeApp | None = None
_lock = asyncio.Lock()


async def init_app() -> ForgeApp:
    """装配 Forge 实例（幂等；进程生命周期内只装配一次）。"""
    global _app
    async with _lock:
        if _app is not None:
            return _app
        await engine_store.init_engine()
        storage = engine_store.get_storage()

        # ② 图注册表：节点类型/条件边注册位（回合图经此解析）
        registries = GraphRegistries()

        # ③ 种子注入：通用种子恒注（幂等基线；领域种子后续接入）
        knowledge_set = KnowledgeSet(FORGE_SET_USER, storage=storage)
        seed_user_set(knowledge_set)

        # ④ harness 装配：forge 领域定义（自指元能力集）注册 + 落库
        harness_registry = HarnessRegistry(registries=registries)
        harness_repository = HarnessRepository(storage)
        forge_definition = HarnessDefinition(
            name="forge",
            description="自举领域：观察/提案/应用的元能力集",
            keywords=("观察", "内省", "演化", "自举"),
            meta={"set_id": "default", "role": "self"},
        )
        harness_registry.register(forge_definition)
        await harness_repository.save(
            forge_definition, note="开局装配：forge 自举领域基线"
        )

        # ⑤ 事件类型注册表：boot 内置类型登记 + 集内演化类型加载。
        # 内置基线优先，集内同名校验跳过（AI 改类型走补丁链版本化，
        # 不覆盖基线）；脏记录跳过不阻断启动
        event_registry = EventTypeRegistry(storage=storage, set_id=FORGE_SET_USER)
        for spec in BOOT_EVENT_TYPES:
            event_registry.register(spec)
        await event_registry.load()

        # 本地文件访问授权（挂载点模型）：AI 只见显式授权的挂载点，
        # 磁盘其余部分 fail-closed 不可见；注册/撤销是用户动作
        mount_registry = MountRegistry(storage)

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

        # ⑥ 工具装配：内省元工具（只读流水线，fail-closed 权限门禁）
        specs = introspection_tool_specs()
        introspection_service = IntrospectionService(
            IntrospectionSources(
                knowledge_set=knowledge_set,
                harness_registry=harness_registry,
                tools=specs,
                ui_spec=ui_spec,
            )
        )
        pipeline = build_introspection_pipeline(introspection_service)

        # ⑧ LLM 挡位 + ⑩ Engine 实例（⑪ SSE 桥为回合期注入）
        app = ForgeApp(
            storage=storage,
            graph_registries=registries,
            knowledge_set=knowledge_set,
            harness_registry=harness_registry,
            harness_repository=harness_repository,
            event_type_registry=event_registry,
            mount_registry=mount_registry,
            introspection_service=introspection_service,
            introspection_specs=specs,
            introspection_pipeline=pipeline,
        )
        await app.rebuild_engine()
        logger.info("Forge 装配完成（集目录: %s）", config.SET_DIR)
        _app = app
        return _app


async def close_app() -> None:
    """关闭装配产物（进程退出前调用，幂等）。"""
    global _app
    async with _lock:
        _app = None
        await engine_store.close_engine()


def get_app() -> ForgeApp:
    """访问装配产物；未装配时抛错（lifespan 之外调用即编程错误）。"""
    if _app is None:
        raise RuntimeError("Forge 未装配（init_app 未执行）")
    return _app
