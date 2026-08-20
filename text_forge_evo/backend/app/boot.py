"""开局装配（薄入口）：宿主五件套 + 装配配方 → Runtime.boot 装配。

装配动作已下沉内核 Runtime（core/runtime.py）——本模块只保留产品
服务（孵化闭环/收敛管制/挂载点注册表/孵化管线）与兼容访问契约
（ForgeApp 字段代理、init_app/close_app/get_app 签名不变）。

ForgeApp 为薄壳兼容层：字段代理到 Runtime 装配产物，方法
（resolve_llm/rebuild_engine/MCP 挂载卸载）委托宿主与运行时组件——
路由/round/CLI/测试深度直取的字段契约全部保留。
"""
from __future__ import annotations

import asyncio
import logging

from ink_engine.core.declarative_tools import EndpointType
from ink_engine.core.executor import Engine
from ink_engine.core.llm import AsyncLLM
from ink_engine.core.mcp_client import McpServerConfig, McpToolImportError
from ink_engine.core.runtime import Runtime
from ink_engine.core.self_application import ApprovalLevel, SelfApplicationPipeline
from ink_engine.core.self_proposal import PatchKind
from ink_engine.core.tool_vetting import ToolVetting

from . import config
from .domains.files.mounts import MountRegistry
from .evolution import ConvergencePolicy, IncubatorService
from .forge_host import ForgeHost
from .forge_recipe import _KnowledgeTarget, build_forge_recipe

logger = logging.getLogger(__name__)


class ForgeApp:
    """装配产物视图（薄壳兼容层）：字段代理到 Runtime 装配产物。

    类名与字段契约保留（路由/round/CLI/测试深度直取）；产品服务
    （孵化/收敛管制/挂载点注册表/孵化管线）为宿主自有字段。
    """

    def __init__(self, runtime: Runtime, host: ForgeHost) -> None:
        self.runtime = runtime
        self.host = host
        # 宿主产品服务（Runtime 不持有宿主产品语义）
        self.mount_registry: MountRegistry | None = None
        self.incubator: IncubatorService | None = None
        self.incubation_pipeline: SelfApplicationPipeline | None = None
        self.convergence: ConvergencePolicy | None = None

    # ── 装配产物代理（Runtime 持有；字段契约与薄壳前一致）──
    @property
    def storage(self):
        return self.runtime.storage

    @property
    def graph_registries(self):
        return self.runtime.graph_registries

    @property
    def knowledge_set(self):
        return self.runtime.knowledge_set

    @property
    def harness_registry(self):
        return self.runtime.harness_registry

    @property
    def harness_repository(self):
        return self.runtime.harness_repository

    @property
    def event_type_registry(self):
        return self.runtime.event_type_registry

    @property
    def introspection_service(self):
        return self.runtime.introspection_service

    @property
    def introspection_specs(self):
        return self.runtime.introspection_specs

    @property
    def introspection_pipeline(self):
        return self.runtime.introspection_pipeline

    @property
    def self_pipeline(self):
        return self.runtime.self_pipeline

    @property
    def self_specs(self):
        return self.runtime.self_specs

    @property
    def self_pipeline_runner(self):
        return self.runtime.self_pipeline_runner

    @property
    def retriever_registry(self):
        return self.runtime.retriever_registry

    @property
    def mcp_manager(self):
        return self.runtime.mcp_manager

    @property
    def tool_vetting(self):
        return self.runtime.vetting

    @property
    def tool_pipeline(self):
        return self.runtime.tool_pipeline

    @property
    def tool_registry(self):
        return self.runtime.tool_registry

    @property
    def engine(self):
        return self.runtime.engine

    @property
    def engine_llm(self):
        return self.runtime.engine_llm

    async def resolve_llm(self) -> AsyncLLM | None:
        """模型解析委托宿主（保持类级注入契约：测试经 monkeypatch 替换）。"""
        return await self.host.resolve_llm()

    async def rebuild_engine(self, llm: AsyncLLM | None = None) -> Engine:
        """回合图引擎重建（委托 Runtime：配置/工具表变更才重建）。"""
        return await self.runtime.rebuild_engine(llm)

    async def mount_mcp_server(
        self, server_config: McpServerConfig, *, vetting: ToolVetting | None = None
    ) -> list[str]:
        """挂载外部 MCP server（委托 Runtime 组件；逻辑与薄壳前等价）。

        连接/导入失败抛 :class:`McpToolImportError`（宿主转拒绝，不静默
        降级），失败时已建立的连接回滚断开；vetting 闸门过滤被拒工具
        （fail-closed，信任靠审查证据）。工具名冲突显式拒绝——静默
        覆盖会把调用路由到错误的 server。挂载成功后重建回合引擎：
        模型立即获得新工具清单，``inspect_tools`` 可见且下一回合即可调用。
        """
        runtime = self.runtime
        stale_names = runtime.mcp_manager.imported_tools(server_config.id)
        await runtime.mcp_manager.connect(server_config)
        try:
            specs = await runtime.mcp_manager.import_tools(
                server_config.id,
                source=server_config.source,
                vetting=vetting or runtime.vetting,
            )
            self._guard_name_collisions(server_config.id, specs)
            for name in stale_names:
                runtime.harness_registry.declarative.unregister_definition(name)
                runtime.tool_registry.pop(name, None)
            for spec in specs:
                runtime.harness_registry.declarative.register_definition(spec)
                runtime.tool_registry[spec.name] = spec.to_spec()
        except Exception:
            await runtime.mcp_manager.disconnect(server_config.id)
            raise
        runtime.introspection_service._sources.tools = runtime.collect_specs()
        await runtime.rebuild_engine()
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
        runtime = self.runtime
        active_servers = set(runtime.mcp_manager.list_servers())
        conflicts: list[str] = []
        for spec in specs:
            existing = runtime.harness_registry.declarative.definitions.get(spec.name)
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
        runtime = self.runtime
        imported_names = runtime.mcp_manager.imported_tools(server_id)
        removed = await runtime.mcp_manager.disconnect(server_id)
        if not removed:
            return False
        for name in imported_names:
            runtime.harness_registry.declarative.unregister_definition(name)
            runtime.tool_registry.pop(name, None)
        runtime.introspection_service._sources.tools = runtime.collect_specs()
        await runtime.rebuild_engine()
        return True


# 装配产物进程级单例（幂等装配/关闭的共享句柄；None = 未装配）
_app: ForgeApp | None = None
_lock = asyncio.Lock()


async def init_app() -> ForgeApp:
    """装配 Forge 实例（幂等；进程生命周期内只装配一次）。

    装配主体 = Runtime.boot（host + recipe 三步挂载）：存储 → 注册表
    → 种子 → harness → 事件类型 → 应用管线 → 元工具流水线 → 调配源
    → 从链恢复 → apply 目标 → 引擎重建。宿主产品（孵化/收敛/挂载点
    注册表/孵化管线）在装配后挂接。
    """
    global _app
    async with _lock:
        if _app is not None:
            return _app
        host = ForgeHost()
        recipe = build_forge_recipe()
        runtime = await Runtime().boot(host, recipe)
        app = ForgeApp(runtime=runtime, host=host)
        app.mount_registry = MountRegistry(runtime.storage)
        # 孵化管线（宿主产品）：知识沉淀的专用通道——确定性蒸馏产物 +
        # 来源留痕 + 可回退，分级 L0 直过（宿主可整表替换分级），与
        # AI 提案共用同一链与校验器，写入路径仍唯一（应用管线）
        app.incubation_pipeline = SelfApplicationPipeline(
            runtime.storage,
            validator=runtime.validator,
            approval_levels={PatchKind.KNOWLEDGE: ApprovalLevel.L0},
            guard_token=runtime.guard_token,
        )
        app.incubation_pipeline.register_target(
            PatchKind.KNOWLEDGE, _KnowledgeTarget(runtime)
        )
        # 孵化闭环与收敛管制装配（宿主侧串联：信号源=审计/回退/审批）
        app.convergence = ConvergencePolicy(runtime.storage)
        app.incubator = IncubatorService(lambda: app, app.incubation_pipeline)
        _app = app
        logger.info("Forge 装配完成（集目录: %s）", config.SET_DIR)
        return _app


async def close_app() -> None:
    """关闭装配产物（进程退出前调用，幂等）。

    关停顺序由 Runtime 保证：拒新 → 等在途完成 → 关 MCP 会话 →
    关存储 → 宿主钩子（释放进程锁）。单例清空先行，防关停期间新
    请求取到半关闭装配。
    """
    global _app
    async with _lock:
        app = _app
        _app = None
        if app is not None:
            await app.runtime.stop()


def get_app() -> ForgeApp:
    """访问装配产物；未装配时抛错（lifespan 之外调用即编程错误）。"""
    if _app is None:
        raise RuntimeError("Forge 未装配（init_app 未执行）")
    return _app
