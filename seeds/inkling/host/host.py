"""InKling 宿主：Host 五件套 + 装配动作（PLAN §4 host/ 与 §6 M3）。

Host 五件套（引擎嵌入契约，见 core/runtime.Host）：
- create_storage：存储工厂（memory/sqlite 后端，URI 由装配参数决定；
  后端/路径/进程锁归宿主）；
- resolve_llm：模型解析（注入实例或环境变量配置；None = 未配置，
  路由端引导——离线 stub 评测与真实模型 live 评测同一入口）；
- interrupt_policy：审批策略（直过白名单/超时窗口归宿主）；
- build_transport：事件传输工厂（回合事件收集器；web/stdio 宿主
  按形态换实现，同一签名）；
- close：关停钩子（宿主资源回收；Runtime.stop 在存储关闭后调用）。

装配动作（boot_inkling）：Runtime.boot（配方数据装配）→ 声明式工具
进统一工具表（tools.json 数据形态）→ 工具安全纵深（三档门禁/沙箱
代理/工作区授权/影子 vetting/OS 执行器进工具表）→ 环境装配域 →
构建管线域 → 宿主执行器注册 → 引擎重建。装配动作是机制路径，不含
产品内容。
"""
from __future__ import annotations

import os
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ink_engine.core.approval import DefaultInterruptPolicy, InterruptPolicy
from ink_engine.core.declarative_tools import EndpointType
from ink_engine.core.events import CollectorTransport, EngineEvent, EngineTransport
from ink_engine.core.llm import AsyncLLM, create_llm
from ink_engine.core.runtime import Host, Runtime
from ink_engine.core.self_application import APPROVAL_TIMEOUT_SECONDS
from ink_engine.core.self_proposal import PatchKind
from ink_engine.core.storage import Storage, create_storage

from .build_domain import ArtifactApplyTarget, BuildDomain
from .environment_domain import EnvironmentApplyTarget, EnvironmentDomain
from .knowledge_domain import IncubationDomain
from .live_apply import (
    rebuild_declarative_tools,
    register_live_targets,
    restore_live_views,
)
from .mcp_service import McpMountService
from .recipe_loader import (
    SeedDataBundle,
    declarative_specs_from_tools,
    load_seed_data,
)
from .review_pipeline import build_review_pipeline
from .round_steps_feed import RoundStepsTransport
from .security_domain import (
    SecurityDomain,
    WorkspaceAuthorizer,
    build_security_l2_vetting_hook,
    make_file_ops_executor,
    make_http_fetch_executor,
    make_process_exec_executor,
)

# 环境/产物等运行数据目录缺省形态：进程级临时目录（可销毁重建的会话态
# 数据；正式宿主经 data_dir 注入持久目录）
_DEFAULT_DATA_DIR_PREFIX = "inkling-runtime-"


@dataclass(slots=True)
class _RecordedTransport:
    """回合步骤记录包裹：事件先喂 RoundSteps 累积，再转发下游传输。"""

    recorder: RoundStepsTransport
    inner: EngineTransport

    async def send(self, event: EngineEvent) -> None:
        self.recorder.feed(event)
        await self.inner.send(event)


class InKlingHost(Host):
    """InKling 宿主五件套（存储后端/模型/审批策略/事件传输/关停钩子）。"""

    def __init__(
        self,
        *,
        storage_uri: str = "memory://",
        llm: AsyncLLM | None = None,
        transport: EngineTransport | None = None,
        auto_approve_keys: frozenset[str] = frozenset(),
        timeout: float | None = APPROVAL_TIMEOUT_SECONDS,
    ) -> None:
        self._storage_uri = storage_uri
        self._llm = llm
        self._transport = transport or CollectorTransport()
        self._auto_approve_keys = auto_approve_keys
        self._timeout = timeout
        self._storage: Storage | None = None
        # 回合步骤记录器（core.round_steps 原语：事件流 → 步骤序列）
        self.round_recorder = RoundStepsTransport()
        # 装配域（boot 后齐备；设置页/评测侧消费的运行期入口）
        self.security: SecurityDomain | None = None
        self.workspaces: WorkspaceAuthorizer | None = None
        self.environments: EnvironmentDomain | None = None
        self.builds: BuildDomain | None = None
        self.incubation: IncubationDomain | None = None
        self.review_pipeline: Callable | None = None
        self.tier_chains: dict[str, Any] = {}
        self.tier_stats: Any | None = None
        self.boot_prompt: dict[str, Any] | None = None

    async def create_storage(self) -> Storage:
        """存储工厂（memory/sqlite URI 由装配参数决定；幂等，重入返回同一实例）。"""
        if self._storage is None:
            self._storage = create_storage(self._storage_uri)
        return self._storage

    async def resolve_llm(self) -> AsyncLLM | None:
        """模型解析：注入实例优先，否则环境变量配置；缺配置返回 None。"""
        if self._llm is not None:
            return self._llm
        config = _model_config_from_env()
        if not config:
            return None
        try:
            return create_llm(config)
        except Exception:
            return None

    def interrupt_policy(self) -> InterruptPolicy:
        """审批策略（直过白名单 + 审批超时窗口；缺省走引擎默认超时）。"""
        return DefaultInterruptPolicy(
            auto_approve_keys=self._auto_approve_keys,
            timeout=self._timeout,
        )

    def build_transport(self) -> EngineTransport:
        """事件传输工厂（回合事件收集；web/stdio 宿主按形态换实现）。

        返回传输经回合步骤记录器包裹：事件流同时喂入 RoundSteps
        （步骤序列累积/checkpoint 恢复形态），记录失败零噪声。
        """
        return _RecordedTransport(self.round_recorder, self._transport)

    def begin_round(self, round_id: str) -> None:
        """回合边界（host 驱动：round_id 下文事件进入新累积器）。"""
        self.round_recorder.begin_round(round_id)

    def round_snapshot(self) -> list[dict]:
        """当前回合步骤序列快照（checkpoint/回放形态；host 消费）。"""
        return self.round_recorder.snapshot()

    async def close(self) -> None:
        """关停钩子（宿主资源回收；Runtime.stop 在存储关闭后调用）。"""
        return

    @property
    def events(self) -> list[Any]:
        """已收集回合事件（评测/观测侧读取；CollectorTransport 形态）。"""
        return self._transport.events


class InkRuntime(Runtime):
    """InKling 运行时：引擎 Runtime 之上叠加五源实时装配源。

    调配器动态组装的产品化接线：回合装配源 = 五源统一预算提供者
    （上下文/知识/工具/记忆/证据），其中工具源按运行时工具表实时
    读取——新挂载工具在下一回合自动纳入工具源预算（工具表变更 →
    引擎重建 → 装配源携带最新清单）。
    """

    def __init__(
        self, five_source_factory: Callable[[Runtime], Callable[..., Any]] | None = None
    ) -> None:
        super().__init__()
        self._five_source_factory = five_source_factory

    def _assembly_sources(self) -> Callable[..., Any]:
        """回合调配源：五源统一预算（宿主注入）优先，缺省回退引擎 evidence。"""
        if self._five_source_factory is not None:
            return self._five_source_factory(self)
        return super()._assembly_sources()


async def boot_inkling(
    root: Path,
    *,
    llm: AsyncLLM | None = None,
    storage_uri: str = "memory://",
    host: InKlingHost | None = None,
    market: dict[str, Any] | None = None,
    data_dir: Path | None = None,
) -> tuple[Runtime, InKlingHost, McpMountService]:
    """装配 InKling 运行时（配方数据装配 + 宿主装配动作）。

    流程：
    1. 装载 seed_data → 装配配方（17 字段全落值，纯数据映射）；
    2. Runtime.boot（引擎机制装配：种子/harness/事件类型/审批管线/
       界面基线/元工具流水线/检索源/引擎重建）；
    3. 声明式工具进统一工具表（tools.json 数据形态，与 mcp 挂载
       工具同一张表）；
    4. 工具安全纵深装配（三档门禁替换流水线 gate、声明式沙箱代理、
       文件工具占位符形态注册、OS 控制执行器 + 挂载执行器注册）；
    5. 环境装配域（env.json 三提供器 + 链恢复）+ 构建管线域
       （build.json 白名单 + 产物目录）+ 工作区授权恢复；
    6. 补丁链应用目标注册（ENVIRONMENT/ARTIFACT 活跃态生效）；
    7. 引擎重建（工具表/流水线变更触发）。

    Args:
        root: 种子根（seed_data/manifest 所在目录）。
        llm: 模型实例（None = 宿主解析/缺配置）。
        storage_uri: 存储后端 URI（memory:// / sqlite:///:memory:）。
        host: 宿主实例（缺省自建）。
        market: MCP 市场数据覆盖（缺省 = seed_data/mcp_market.json）。
        data_dir: 运行数据目录（envs/artifacts 落盘根；缺省 = 进程级
            临时目录——环境/产物是可销毁重建的会话态数据）。

    Returns:
        (runtime, host, mount_service)——mount_service 是挂载双入口
        （设置页一键挂载 / 对话式安装）的共用编排入口；装配域挂在
        host 上（host.security/host.workspaces/host.environments/
        host.builds）。
    """
    bundle = load_seed_data(root)
    data_dir = _resolve_data_dir(data_dir)
    security = SecurityDomain(bundle.data["tools.json"])
    hook, mark_vetted = build_security_l2_vetting_hook(security.shadow)
    # 构建管线域先于配方构造（ARTIFACT 补丁的 L2 验证钩子需要）
    build_domain = BuildDomain(
        bundle.data["build.json"],
        artifact_dir=data_dir / "artifacts",
    )

    def composed_l2_hook(proposal: Any) -> list[str]:
        """组合 L2 验证钩子：ARTIFACT → 构建验证；TOOL → 挂载影子核对。"""
        if getattr(proposal, "kind", None) is PatchKind.ARTIFACT:
            return build_domain.l2_vetting_hook()(proposal)
        return hook(proposal)

    # 回退通知状态（boot 后注入：环境/产物活跃态随链回退同步——回退 =
    # 声明回退 + 实例重建，补丁链为权威；界面/主题/工具表/知识集等
    # 其余活跃态经 restore_live_views 整体还原到最新链态）
    revert_state: dict[str, Any] = {}

    async def _on_reverted(patch_id: int, reason: str) -> None:
        runtime_ref = revert_state.get("runtime")
        if runtime_ref is None:
            return
        assembled = await runtime_ref.self_pipeline.chain.assemble()
        domain = revert_state.get("env_domain")
        if domain is not None:
            await domain.restore(assembled.get("environments") or {})
        build_ref = revert_state.get("build_domain")
        if build_ref is not None:
            build_ref.sync_artifact_tools(
                runtime_ref, assembled.get("artifacts") or {}
            )
        restore_live_views(
            runtime_ref,
            assembled,
            base_event_names=revert_state.get("base_event_names") or (),
            base_ui_spec=revert_state.get("base_ui_spec"),
        )
        base_tools = revert_state.get("base_tools") or []
        rebuild_declarative_tools(runtime_ref, base_tools, assembled)
        await runtime_ref.rebuild_engine()

    host = host or InKlingHost(llm=llm, storage_uri=storage_uri)
    from .recipe_loader import build_recipe

    recipe = build_recipe(
        bundle,
        l2_vetting_hook=composed_l2_hook,
        on_reverted=_on_reverted,
    )
    runtime = await InkRuntime(_five_source_factory(bundle)).boot(host, recipe)
    revert_state["runtime"] = runtime
    mount_service = McpMountService(
        runtime,
        market=market if market is not None else bundle.data["mcp_market.json"],
        external_mark_vetted=mark_vetted,
    )
    register_domain_tools(runtime, bundle)
    register_host_executors(runtime, mount_service, security)
    # 环境装配域（storage 在 boot 后可用：审计/恢复）
    env_allowlist = tuple(
        (bundle.data["build.json"].get("builder") or {}).get("allowlist") or ()
    )
    env_domain = EnvironmentDomain(
        bundle.data["env.json"],
        envs_dir=data_dir / "envs",
        storage=runtime.storage,
        run_allowlist=env_allowlist,
    )
    # 安全纵深替换运行时流水线（图配方实时持有者，替换后下一回合生效）
    security.apply(runtime)
    security.reregister_file_tools(root=None)
    # 装配域挂到宿主（设置页/评测侧运行期入口）
    host.security = security
    host.builds = build_domain
    host.environments = env_domain
    revert_state["env_domain"] = env_domain
    revert_state["build_domain"] = build_domain
    build_domain.attach(runtime)
    host.workspaces = WorkspaceAuthorizer(
        runtime.storage, security=security, runtime=runtime
    )
    # 补丁链应用目标注册（落链即生效；链为权威记录，重启经链恢复）
    runtime.self_pipeline.register_target(
        PatchKind.ENVIRONMENT, EnvironmentApplyTarget(env_domain)
    )
    runtime.self_pipeline.register_target(
        PatchKind.ARTIFACT, ArtifactApplyTarget(build_domain, runtime)
    )
    # 活跃态目标补全（UI/THEME/HARNESS/RULE/KNOWLEDGE——落链即生效）
    register_live_targets(runtime)
    # 模型层挡位装配（tiers.json 双挡位链 + 回合级调用统计钩子）：
    # 环境配置投影为主挡配置（router 缺省经 resolve_tier_chain 回落 main）
    from .model_layers import build_tier_chains, make_tier_stats, resolve_tier_chain

    _env_config = _model_config_from_env()
    host.tier_chains = build_tier_chains(
        bundle.data["tiers.json"],
        {"main_config": dict(_env_config)} if _env_config else {},
    )
    host.tier_stats = make_tier_stats()
    # 孵化域（信号 → 蒸馏 → 闸门 → 落库 → 自指挂载的产品化入口）
    host.incubation = IncubationDomain(
        runtime,
        signals_data=bundle.data["signals.json"],
        samples_data=bundle.data["samples.json"],
        review_data=bundle.data["review.json"],
        on_llm_call=host.tier_stats.record,
    )
    # 蒸馏链接线：router 挡（缺失回落 main；全缺 = 确定性蒸馏基线，不静默降级）
    host.incubation.distiller.chain = resolve_tier_chain(host.tier_chains, "router")
    # 自举提示词（boot_prompt 定稿形态，注入侧产品数据入口）
    host.boot_prompt = bundle.data["boot_prompt.json"]
    # 评审-收敛管线（引擎 core.review 机制：review.json 数据驱动；
    # 模型缺省 = 无评审 fail-open，不阻断主流程）；LLM 调用归因主挡位
    host.review_pipeline = build_review_pipeline(
        await host.resolve_llm(),
        bundle.data["review.json"],
        tier="main",
        on_llm_call=host.tier_stats.record,
    )
    revert_state["base_tools"] = bundle.data["tools.json"].get("tools") or ()
    revert_state["base_event_names"] = tuple(
        spec["name"] for spec in bundle.data["event_types.json"].get("events") or ()
    )
    revert_state["base_ui_spec"] = dict(bundle.data["ui_spec.json"])
    # 补丁来源知识条目登记位（回退恢复的撤销清单；宿主 boot 初始化）
    runtime.patch_entries: set[str] = set()
    # 链恢复：环境段（声明生效）+ 产物段（声明工具注册）+ 工作区授权
    # + 活跃态整体还原（界面/主题/知识/事件类型——重启装配从链恢复）
    assembled = await runtime.self_pipeline.chain.assemble()
    await env_domain.restore(assembled.get("environments") or {})
    build_domain.sync_artifact_tools(runtime, assembled.get("artifacts") or {})
    await host.workspaces.load()
    restore_live_views(
        runtime,
        assembled,
        base_event_names=revert_state.get("base_event_names") or (),
        base_ui_spec=revert_state.get("base_ui_spec"),
    )
    # 种子条目重注入：引擎链恢复在种子注入之后整体替换知识集实例，
    # 出厂基线条目（内存态、不在链上）随之丢失——按既定语义「种子 =
    # 启动注入基线，链只承载演化」，此处重注入并与链段条目按 id 去重
    # （晋升过的条目已上链，以链态为准不覆盖）
    for _seed_name, seed_provider in recipe.seeds:
        for seed_entry in seed_provider():
            if runtime.knowledge_set.get(seed_entry.id) is None:
                runtime.knowledge_set.add(seed_entry)
    runtime.introspection_service._sources.tools = runtime.collect_specs()
    await runtime.rebuild_engine()
    return runtime, host, mount_service


def _five_source_factory(
    bundle: SeedDataBundle,
) -> Callable[[Runtime], Callable[..., Any]]:
    """五源实时装配源工厂（InkRuntime 回合调配源的产品化接线）。

    记忆源经 runtime.storage 惰性构建（boot 后可用）；工具源按
    ``runtime.collect_specs`` 实时读取（调配器动态组装：新挂载工具
    下一回合纳入工具源预算）。
    """
    from .assembly_domain import build_five_source_provider, build_memory_store

    def factory(runtime: Runtime) -> Callable[..., Any]:
        memory_store = build_memory_store(runtime.storage)
        return build_five_source_provider(
            memory_store=memory_store,
            retriever_registry=runtime.retriever_registry,
            knowledge_set=runtime.knowledge_set,
            tool_specs_provider=runtime.collect_specs,
        )

    return factory


def _resolve_data_dir(data_dir: Path | None) -> Path:
    """运行数据目录（注入优先；缺省进程级临时目录，进程结束即清理）。"""
    if data_dir is not None:
        data_dir = Path(data_dir)
        data_dir.mkdir(parents=True, exist_ok=True)
        return data_dir
    return Path(tempfile.mkdtemp(prefix=_DEFAULT_DATA_DIR_PREFIX))


def _model_config_from_env() -> dict[str, str]:
    """环境变量模型配置（INK_LLM_* 命名与 examples/stdio_host 同口径）。"""
    base_url = os.environ.get("INK_LLM_BASE_URL", "")
    model_id = os.environ.get("INK_LLM_MODEL", "")
    if not base_url or not model_id:
        return {}
    config: dict[str, str] = {
        "adapter": os.environ.get("INK_LLM_ADAPTER", "openai_compat"),
        "base_url": base_url,
        "model_id": model_id,
    }
    api_key = os.environ.get("INK_LLM_API_KEY")
    if api_key:
        config["api_key"] = api_key
    return config


def register_domain_tools(runtime: Runtime, bundle: SeedDataBundle) -> None:
    """tools.json 声明式工具进统一工具表（挂载/声明同表，机制零差异）。

    声明是数据：工具定义（名称/参数/权限/端点）全部来自 tools.json；
    执行端点由宿主执行器注册兜底（未注册端点在调用时降级为明确
    失败文本，不崩溃）。
    """
    for spec in declarative_specs_from_tools(bundle):
        runtime.harness_registry.declarative.register_definition(spec)
        runtime.tool_registry[spec.name] = spec.to_spec()


def register_host_executors(
    runtime: Runtime, mount_service: McpMountService, security: SecurityDomain
) -> None:
    """宿主声明式执行器注册（机制层不代注册执行实现，宿主职责）。

    - process_exec：propose_mcp_mount（对话式安装入口）走挂载服务；
      OS 控制七件经 OS 执行器注册表分发（桌面壳/测试 stub 注入，
      未注册时降级为明确失败文本）；deny 档（shell_exec）执行体
      二次拒绝（纵深防御）；
    - http_fetch：fetch_web 网络策略执行体（域名白名单二次核对，
      取回实现可注入，缺省 httpx）；
    - file_ops：文件开发执行体（工作区读写编辑 + 写前快照 + 大小上限）。
    """
    runtime.harness_registry.declarative.register(
        EndpointType.PROCESS_EXEC,
        make_process_exec_executor(
            mount_service, security.os_registry, tiers=security.tiers
        ),
    )
    runtime.harness_registry.declarative.register(
        EndpointType.HTTP_FETCH,
        make_http_fetch_executor(),
    )
    runtime.harness_registry.declarative.register(
        EndpointType.FILE_OPS,
        make_file_ops_executor(),
    )


__all__ = [
    "InKlingHost",
    "InkRuntime",
    "boot_inkling",
    "register_domain_tools",
    "register_host_executors",
]
