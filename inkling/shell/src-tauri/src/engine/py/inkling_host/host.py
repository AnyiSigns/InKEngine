"""InKling 宿主：Host 五件套 + 装配动作（设计文档第四节 host/ 与第六节模块 M3）。

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

import asyncio
import contextlib
import itertools
import json
import os
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ink_engine.core.approval import DefaultInterruptPolicy, InterruptPolicy
from ink_engine.core.context import (
    ThresholdCompressionPolicy,
)
from ink_engine.core.declarative_tools import (
    RETRIEVAL_CONTROLLED_FETCH,
    EndpointType,
    make_controlled_fetch_executor,
)
from ink_engine.core.events import CollectorTransport, EngineEvent, EngineTransport
from ink_engine.core.llm import AsyncLLM, create_llm
from ink_engine.core.logging import get_logger
from ink_engine.core.runtime import Host, Runtime
from ink_engine.core.self_application import (
    APPROVAL_TIMEOUT_SECONDS,
    DEFAULT_APPROVAL_LEVELS,
    ApprovalLevel,
)
from ink_engine.core.self_proposal import PatchKind
from ink_engine.core.self_tools import SELF_TOOL_CONTRACT
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
from .web_search_domain import make_web_search_executor

logger = get_logger(__name__)

# resolve_llm 缓存哨兵（None 是合法已解析结果，须用独立哨兵区分未解析）
_RESOLVED_LLM_MISSING = object()

# 引擎默认 L0 直过补丁键（THEME/UI 低风险形态）：host 提供审批策略会
# 覆盖管线自带的 L0 键，缺省会令低风险补丁改走弹卡——并入以保留引擎 L0 语义
_L0_PATCH_KEYS = frozenset(
    f"patch:{kind.value}"
    for kind, level in DEFAULT_APPROVAL_LEVELS.items()
    if level is ApprovalLevel.L0
)


class BehaviorLLM:
    """行为准则层协议代理（AsyncLLM 鸭子类型包装）。

    每个 LLM 调用的消息流前置系统消息 = 行为准则层（soul + 行为准则 +
    产品事实 + 目标设定 + 打标分类准则 + 推演档位 + 交错推理引导语 +
    工具名对照表）——「系统提示谈意图、工具描述谈动作」的纪律执行点：
    行为块不引用任何工具标识符，模型推理词汇 = 行为词。包装发生在
    resolve_llm 出口，覆盖全部宿主 LLM 调用路径（评审/蒸馏/路由），
    引擎侧零改动（协议代理形态与推理档位注入同构）。
    """

    def __init__(self, inner: AsyncLLM, behavior: str) -> None:
        self._inner = inner
        self._behavior = behavior

    def _with_behavior(self, messages: list[Any]) -> list[Any]:
        from ink_engine.core.llm.messages import system

        return [system(self._behavior), *list(messages)]

    async def ainvoke(self, messages, *, tools=None, params=None):
        return await self._inner.ainvoke(
            self._with_behavior(messages), tools=tools, params=params
        )

    async def astream(self, messages, *, tools=None, params=None):
        async for chunk in self._inner.astream(
            self._with_behavior(messages), tools=tools, params=params
        ):
            yield chunk

    async def aclose(self) -> None:
        return await self._inner.aclose()

# 环境/产物等运行数据目录缺省形态：进程级临时目录（可销毁重建的会话态
# 数据；正式宿主经 data_dir 注入持久目录）
_DEFAULT_DATA_DIR_PREFIX = "inkling-runtime-"


async def assemble_chain_with_boot_fallback(runtime: Runtime) -> dict:
    """链引导回退：最新链装配失败时逐尾回退重试（审计留痕）直至可启动。

    崩溃可回退红线的启动侧兜底——链上存在内容型坏补丁（组装即抛错）
    时，启动不再整轮失败：按「回退链尾 → 重试装配」逐尾收敛。回退走
    既有补丁链回退路径（审批决议预填放行，理由 = 启动引导回退），审计
    记录 append-only 完整保留；回退到基线仍失败 = 显式报错（交由宿主
    安全模式 / 一键回落处置）。
    """
    from inkling_bridge import StandaloneApprovalContext, prefill_approval_decision

    ctx = StandaloneApprovalContext(None)
    while True:
        try:
            return await runtime.self_pipeline.chain.assemble()
        except Exception as exc:
            try:
                current = await runtime.self_pipeline.chain.current_version()
            except Exception:
                raise RuntimeError(
                    f"链装配失败且链记录不可读（需安全模式处置）: {exc}"
                ) from exc
            if current < 2:
                raise RuntimeError(
                    f"链装配失败且已回退至基线（需宿主处置）: {exc}"
                ) from exc
            reason = f"启动引导回退：链装配失败（{exc}）"
            prefill_approval_decision(
                None, f"revert:{current}", decision="accept", reason=reason
            )
            outcome = await runtime.self_pipeline.revert(ctx, current, reason=reason)
            if getattr(outcome, "status", None) != "reverted":
                raise RuntimeError(
                    f"链引导回退失败（补丁 #{current}）: {outcome}"
                ) from exc


@dataclass(slots=True)
class _RecordedTransport:
    """回合步骤记录包裹：事件先喂 RoundSteps 累积，再转发下游传输。"""

    recorder: RoundStepsTransport
    inner: EngineTransport
    _seen_round_id: str | None = None

    async def send(self, event: EngineEvent) -> None:
        # 跨回合惰性重置：事件携带新 round_id 即换累积器，确保
        # round_snapshot/checkpoint 同一回合边界、不跨回合累积（嵌入态
        # 下 Rust 侧未调用 host.begin_round 时的兜底）。
        rid = getattr(event, "round_id", None)
        if rid and rid != self._seen_round_id:
            self._seen_round_id = rid
            with contextlib.suppress(Exception):
                self.recorder.begin_round(rid)
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
        embedder: Any | None = None,
        behavior: str | None = None,
        data_dir: Path | None = None,
    ) -> None:
        self._storage_uri = storage_uri
        self._llm = llm
        self._transport = transport or CollectorTransport()
        self._auto_approve_keys = auto_approve_keys
        self._timeout = timeout
        self._storage: Storage | None = None
        # 运行数据目录（model_archive.sqlite 等落盘根；压缩阈值读取 context_window）
        self._data_dir = data_dir
        # 本地语义嵌入器（Rust 协议注入形态；None = 关键词基线检索）
        self._embedder = embedder
        # 行为准则层文本（装配期组成；None = 不注入——离线单元形态）
        self._behavior = behavior
        # 模型实例解析缓存（resolve_llm 复用，避免每次 rebuild_engine 新建连接）
        self._resolved_llm: AsyncLLM | None = _RESOLVED_LLM_MISSING  # type: ignore[assignment]
        # 审批策略共享实例（G1 传入管线与宿主级审批卡须同一实例）
        self._interrupt_policy: InterruptPolicy | None = None
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
        # 路径装配机制的持久化存储（装配期接线；关停时统一关闭）
        self.assembly_stores: list[Any] = []

    async def create_storage(self) -> Storage:
        """存储工厂（memory/sqlite URI 由装配参数决定；幂等，重入返回同一实例）。"""
        if self._storage is None:
            self._storage = create_storage(self._storage_uri)
        return self._storage

    async def resolve_llm(self) -> AsyncLLM | None:
        """模型解析：注入实例优先，其次环境变量，再次文件配置；缺配置返回 None。

        返回实例统一经行为准则层包装（BehaviorLLM）——行为块前置为
        系统消息，覆盖全部宿主 LLM 调用路径。解析完成后按模型档案
        context_window 构建压缩策略（阈值随窗口动态化）。

        回落优先序（与环境变量门禁同口径）：注入实例 > 环境变量
        (INK_LLM_*) > model_connection.json（设置页落盘，data_dir 下）
        > None（壳侧据此注入 StubLLM 离线桩）。文件配置使桌面壳无需
        env 变量即可装配真实模型。
        """
        # 复用已解析实例（含行为准则层包装）：rebuild_engine 以
        # self.engine_llm is llm 作缓存键，每次新建实例会让缓存恒失效、
        # 每次重建引擎并新建 LLM 连接（中间实例泄漏）。
        if self._resolved_llm is not _RESOLVED_LLM_MISSING:
            return self._resolved_llm
        llm = self._llm
        config: dict = {}
        if llm is None:
            config = _model_config_from_env()
            if not config:
                config = _model_config_from_file(self._data_dir)
            if not config:
                self._resolved_llm = None
                return None
            try:
                llm = create_llm(config)
            except Exception:
                self._resolved_llm = None
                return None
        wrapped = BehaviorLLM(llm, self._behavior) if self._behavior is not None else llm
        self._resolved_llm = wrapped
        # 压缩阈值按模型档案 context_window × 全局压缩占比动态推算
        # （占比 = 用户唯一旋钮，设置页落盘；缺失回落默认 0.8）
        model_id = getattr(getattr(llm, "config", None), "model_id", None)
        context_window = _model_context_window_from_archive(self._data_dir, model_id)
        try:
            compression_ratio = float(config.get("compression_percent") or 80) / 100.0
        except (TypeError, ValueError):
            compression_ratio = 0.8
        compression_ratio = min(max(compression_ratio, 0.05), 1.0)
        self._compression_policy = ThresholdCompressionPolicy.from_context_window(
            context_window=context_window, ratio=compression_ratio
        )
        # 当前模型窗口同步给图配方（工具结果截断按模型档案动态化）
        from .graph_recipe import install_context_window

        install_context_window(context_window)
        return wrapped

    def reload_model_config(self) -> None:
        """重载模型连接配置：清空解析缓存 + 重建挡位链 + 压缩策略。

        设置页改模型连接后经壳命令调用，使运行期引擎感知新配置
        （resolve_llm 缓存键是引擎重建的判定依据，不清缓存则配置变更
        永不生效）。压缩策略随下一次 resolve 重建；挡位链（router/audit
        内部通道）即时重建——修复 boot 只投影 env 主挡、文件配置的
        router/audit 模型永不参与挡位链的缺口。
        """
        self._resolved_llm = _RESOLVED_LLM_MISSING  # type: ignore[assignment]
        self._compression_policy = None
        self._rebuild_model_domains()

    def _rebuild_model_domains(self) -> None:
        """重建模型域：挡位链 + 孵化蒸馏链 + 评审收敛链（热更新入口）。

        tiers/review 数据在 boot 装配期留档（_tiers_data/_review_data）；
        model.reload 后按文件连接配置重建——router 蒸馏链与 audit 评审
        链引用随之换新（不再持有旧链实例）。
        """
        tiers_data = getattr(self, "_tiers_data", None)
        if not tiers_data:
            return
        from .model_layers import build_tier_chains, resolve_tier_chain

        configs = _model_tier_configs_from_file(self._data_dir)
        self.tier_chains = build_tier_chains(tiers_data, configs)
        if self.incubation is not None:
            self.incubation.distiller.chain = resolve_tier_chain(
                self.tier_chains, "router"
            )
        review_data = getattr(self, "_review_data", None)
        if review_data is not None:
            from .review_pipeline import build_review_pipeline

            self.review_pipeline = build_review_pipeline(
                resolve_tier_chain(self.tier_chains, "audit"),
                review_data,
                tier="audit",
                on_llm_call=(
                    self.tier_stats.record
                    if self.tier_stats is not None
                    else None
                ),
            )

    def compression_policy(self) -> Any:
        """当前压缩策略（resolve_llm 后可用，未解析返回 None）。"""
        return getattr(self, "_compression_policy", None)

    def resolve_model_llm(
        self, provider: str | None, model_id: str | None
    ) -> AsyncLLM | None:
        """按模型引用解析 LLM（EntitySpec.model / 输入框选模型路径）。

        语义（fail-open，回落会话默认模型）：
        - 模型引用缺失/无提供方配置 → None（调用方回落默认）；
        - 提供方数组（model_connection.json）逐项匹配 provider（provider_id
          或 adapter；缺省 = 第一项=当前连接），用该项 base_url/api_key 建链
          并覆盖 model_id——无匹配提供方 = 该提供方未配置 → None；
        - 产物统一经行为准则层包装（与 resolve_llm 同语义）；压缩策略
          按该 model_id 档案 context_window 动态推算（调用方按需取
          compression_policy，不暴露 token 数）。
        """
        if not model_id or not str(model_id).strip():
            return None
        providers = _read_connection_providers(self._data_dir)
        if not providers:
            return None

        def _matches(item: dict[str, Any]) -> bool:
            if not provider or provider in ("", "default"):
                return True
            return provider in (
                str(item.get("provider_id") or ""),
                str(item.get("adapter") or ""),
            )

        target = next((item for item in providers if _matches(item)), None)
        if target is None:
            return None
        base_url = str(target.get("base_url") or "")
        if not base_url.strip():
            return None
        try:
            llm = create_llm(
                {
                    "adapter": target.get("adapter")
                    or target.get("provider_id")
                    or "openai_compatible",
                    "base_url": base_url,
                    "model_id": str(model_id),
                    **(
                        {"api_key": str(target["api_key"])}
                        if target.get("api_key")
                        else {}
                    ),
                }
            )
        except Exception as exc:
            logger.warning("按模型引用建链失败（回落默认）: %s: %s", model_id, exc)
            return None
        if self._behavior is not None:
            llm = BehaviorLLM(llm, self._behavior)
        return llm

    def interrupt_policy(self) -> InterruptPolicy:
        """审批策略（直过白名单 + 审批超时窗口；缺省走引擎默认超时）。

        缓存共享实例：G1 传入 SelfApplicationPipeline 的策略与宿主级
        审批卡须用同一实例（否则各自新建、auto_approve 语义分叉）。
        并入引擎默认 L0 直过补丁键（patch:ui/patch:theme），host 提供
        策略覆盖管线自带的 L0 键时仍保留引擎 L0 语义（低风险补丁直过）。
        """
        if self._interrupt_policy is None:
            keys = frozenset(self._auto_approve_keys) | _L0_PATCH_KEYS
            self._interrupt_policy = DefaultInterruptPolicy(
                auto_approve_keys=keys,
                timeout=self._timeout,
            )
        return self._interrupt_policy

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
        for store in self.assembly_stores:
            closer = getattr(store, "close", None)
            if closer is not None:
                try:
                    result = closer()
                    if asyncio.iscoroutine(result):
                        await result
                except Exception:
                    pass

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
    safe_mode: bool = False,
    embedder: Any | None = None,
    behavior: str | None = None,
    path_assembly: dict[str, Any] | None = None,
) -> tuple[Runtime, InKlingHost, McpMountService]:
    """装配 InKling 运行时（配方数据装配 + 宿主装配动作）。

    流程：
    1. 装载 seed_data → 装配配方（22 字段全落值，纯数据映射）；
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
        safe_mode: 安全模式（缺省 False）——崩溃循环下宿主自动转入：
            链内容（自写资产载体）整体不参与装配，出厂基线启动。
        path_assembly: 引擎路径装配机制开关数据（键名 = 引擎
            ``PathAssemblyFlags.from_boot`` 的 BOOT_KEY_* 同源；缺省
            None = 全关零生效）。开启的机制块在装配期接线：沉淀钩子
            （成败/成本归集、失败点提案、指纹入库线、推荐先验晋升线、
            策略边复审线）注入执行选项；组装指令运行期挂载默认运行期
            （注册表/证据/缓存/闸门）。

    Returns:
        (runtime, host, mount_service)——mount_service 是挂载双入口
        （设置页一键挂载 / 对话式安装）的共用编排入口；装配域挂在
        host 上（host.security/host.workspaces/host.environments/
        host.builds）。
    """
    bundle = load_seed_data(root)
    data_dir = _resolve_data_dir(data_dir)
    from ink_engine.core.contracts import PathAssemblyFlags

    path_flags = PathAssemblyFlags.from_boot(path_assembly)
    security = SecurityDomain(bundle.data["tools.json"])
    hook, mark_vetted = build_security_l2_vetting_hook(security.shadow)
    # 构建管线域先于配方构造（ARTIFACT 补丁的 L2 验证钩子需要）
    build_domain = BuildDomain(
        bundle.data["build.json"],
        artifact_dir=data_dir / "artifacts",
    )

    # ── 路径装配机制装配期接线（flag 关 = 零生效；全部零 LLM）──
    # 边证据库/指纹缓存随数据目录落盘（派生数据，可由运行历史重建）；
    # 审计 sink 经 storage 落 append-only 审计集合（storage 在 boot 后
    # 可用，经 holder 惰性取用）。
    runtime_holder: dict[str, Any] = {}
    evidence_store: Any = None
    fingerprint_store: Any = None
    skill_store: Any = None
    settle_hooks: Any = None
    # 结点池治理登记器（flag 开 = 四规则接入结点提案链路；关 = 零参与）
    pool_governance: Any = None
    if path_flags.pool_governance_enabled:
        from ink_engine.core.pool_governance import PoolGovernance

        pool_governance = PoolGovernance()

    def _audit_sink(record: dict[str, Any]) -> None:
        import uuid as _uuid

        runtime = runtime_holder.get("runtime")
        if runtime is None:
            return
        storage = getattr(runtime, "storage", None)
        if storage is None:
            return

        async def _write() -> None:
            await storage.put_record(
                "set_audit",
                f"settle-{_uuid.uuid4().hex[:12]}",
                {**record, "kind": record.get("type") or "settle"},
            )

        # 失败防护：落库异常经 done callback 记日志并重试一次，避免
        # fire-and-forget 静默丢失审计证据（done callback 未接手时异常
        # 仅以「Task exception never retrieved」警告形式出现，证据不可观测）。
        def _on_done(task: asyncio.Future) -> None:
            exc = task.exception()
            if exc is None:
                return
            logger.warning("路径装配审计落库失败（重试一次）: %s", exc)
            try:
                asyncio.ensure_future(_write())
            except Exception:  # 重试调度失败只记日志，不阻断沉淀
                pass

        try:
            asyncio.ensure_future(_write()).add_done_callback(_on_done)
        except Exception as exc:  # 调度失败只记日志，不阻断沉淀
            logger.warning("路径装配审计落库调度失败（忽略）: %s", exc)

    # 边证据库/指纹缓存随数据目录落盘（派生数据，可由运行历史重建）；
    # 审计 sink 经 storage 落 append-only 审计集合（storage 在 boot 后
    # 可用，经 holder 惰性取用）。
    # 注意：不再按 path_flags 门控创建——干预 op（edge.*/cache.*）与
    # 架构页边证据视图须读真实落盘库；门控只决定机制是否参与回合
    # （settle/assembler hook 注册），存储本身恒装配并挂 runtime。
    if data_dir:
        from ink_engine.core.edge_evidence import EdgeEvidenceStore

        evidence_store = EdgeEvidenceStore(
            db_path=str(data_dir / "edge_evidence.sqlite")
        )
        from ink_engine.core.fingerprint_cache import FingerprintCacheStore

        fingerprint_store = FingerprintCacheStore(
            db_path=str(data_dir / "fingerprint_cache.sqlite")
        )
    if path_flags.fingerprint_cache_enabled:
        from ink_engine.core.skill_crystal import KnowledgeSkillStore

        # 合并容器：技能 = 知识集 kind=path 条目（单一权威 = 知识集；
        # knowledge_set 在 runtime boot 后绑定，装配期前后无二阶段写入）
        skill_store = KnowledgeSkillStore()
    from ink_engine.core.run_result import RunOptions
    from ink_engine.core.simulation import PatchChainBranchMixer

    if path_flags.settle_hooks_enabled:
        from ink_engine.core.settle import (
            EdgeEvidenceSettleHook,
            FailureAuditSettleHook,
            FingerprintSettleHook,
            NodeProposalSettleHook,
            PolicyEdgeReviewSettleHook,
            RecommendedPriorSettleHook,
            SettleHooks,
        )

        from inkling_host.quality import SettleQualityGate

        hooks = SettleHooks()
        hooks.register(EdgeEvidenceSettleHook(evidence_store))
        hooks.register(FailureAuditSettleHook(sink=_audit_sink))
        # 结点提案链路（E-P9 接线）：池治理 flag 开启时，每条失败点结点
        # 提案先经 PoolGovernance 四规则判定（容量/淘汰/合并/预算），判定
        # 登记随提案审计落库——治理判定只登记不执行，采纳与否仍走既有
        # 评审通道（vetting/审批）
        proposal_sink = _audit_sink
        if pool_governance is not None:
            proposal_sink = _governed_proposal_sink_factory(
                pool_governance,
                registry_getter=lambda: _assembly_registry(runtime_holder),
                fallback_sink=_audit_sink,
            )
        hooks.register(
            NodeProposalSettleHook(evidence_store, proposal_sink=proposal_sink)
        )
        settle_gate = SettleQualityGate()
        hooks.register(
            FingerprintSettleHook(
                fingerprint_store,
                gate=settle_gate,
                store=evidence_store,
                model_id=os.environ.get("INK_LLM_MODEL", ""),
                # 写入键 = 组装查找侧同源（请求指纹）：经 callable 读取组装
                # 运行期最近一次请求的缓存主键——键空间一致缓存才命中
                context_fingerprint=lambda: getattr(
                    get_default_assembly_runtime(), "last_request_fingerprint", ""
                ),
            )
        )
        hooks.register(
            RecommendedPriorSettleHook(
                evidence_store,
                gate=settle_gate,
                sink=_audit_sink,
                model_id=os.environ.get("INK_LLM_MODEL", ""),
            )
        )
        hooks.register(PolicyEdgeReviewSettleHook(evidence_store, sink=_audit_sink))
        if skill_store is not None and fingerprint_store is not None:
            from ink_engine.core.skill_crystal import (
                SKILL_HIT_MIN_DEFAULT,
                SKILL_SUCCESS_RATE_DEFAULT,
                SkillCrystallizeHook,
            )

            hooks.register(
                SkillCrystallizeHook(
                    fingerprint_store,
                    skill_store,
                    hit_min=SKILL_HIT_MIN_DEFAULT,
                    success_rate=SKILL_SUCCESS_RATE_DEFAULT,
                )
            )
        settle_hooks = hooks

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

    host = host or InKlingHost(
        llm=llm,
        storage_uri=storage_uri,
        embedder=embedder,
        behavior=behavior,
        data_dir=data_dir,
    )
    # 池治理登记器挂到宿主（设置页/审计侧运行期入口；flag 关 = None）
    host.pool_governance = pool_governance
    if fingerprint_store is not None:
        host.assembly_stores.append(fingerprint_store)
    if skill_store is not None:
        host.assembly_stores.append(skill_store)
    if evidence_store is not None:
        host.assembly_stores.append(evidence_store)
    from .recipe_loader import build_recipe

    # 推演分支评估器（review.json 数据驱动 + 确定性 dimension_scorer）：
    # 注入后节点返回 __simulate__ 才可执行（此前 evaluator=None = 引擎
    # 显式拒绝）；评审策略外在于被评估者——默认实现只做启发式打分，
    # 不引入 LLM/随机，保持可回放可断言
    simulation_evaluator = None
    try:
        from .scoring import build_simulation_evaluator

        simulation_evaluator = build_simulation_evaluator(bundle.data["review.json"])
    except Exception:
        simulation_evaluator = None

    recipe = build_recipe(
        bundle,
        l2_vetting_hook=composed_l2_hook,
        on_reverted=_on_reverted,
        embedder=embedder,
        run_options=(
            RunOptions(
                settle=settle_hooks,
                # ENG12 接线1：跨分支拼接（补丁链 mixer）——生产环境默认
                # 走 PatchChainBranchMixer（overlay 逐键落 replace 补丁，
                # 来源可留痕可回放），RunOptions.branch_mixer 留出口给
                # 测试与重写场景
                branch_mixer=PatchChainBranchMixer(),
                evaluator=simulation_evaluator,
            )
            if settle_hooks is not None
            else RunOptions(
                branch_mixer=PatchChainBranchMixer(),
                evaluator=simulation_evaluator,
            )
        ),
    )
    runtime = await InkRuntime(_five_source_factory(bundle)).boot(host, recipe)
    runtime_holder["runtime"] = runtime
    revert_state["runtime"] = runtime
    # 干预 op / 架构页边证据视图消费的运行期存储挂载（桥接层
    # runtime.edge_evidence_store / runtime.fingerprint_cache_store）：
    # 真实落盘实例，干预不再自建 :memory: 假库。
    if evidence_store is not None:
        runtime.edge_evidence_store = evidence_store
    if fingerprint_store is not None:
        runtime.fingerprint_cache_store = fingerprint_store
    # 回合工具上限覆盖（能力记录设置项）启动装载：默认无记录 = 回落
    # seed graph.json 节点 config 值；设置保存后经 capability_put →
    # engine.rebuild 路径刷新
    try:
        from .graph_recipe import set_max_tool_rounds_override

        cap = await runtime.storage.get_record("app_capabilities", "capability")
        raw = None if cap is None else cap.get("max_tool_rounds")
        set_max_tool_rounds_override(None if raw is None else int(raw))
    except Exception:
        pass
    # 技能存储挂知识集（合并容器：技能 = 知识集 kind=path 条目；未开指纹
    # 缓存 flag 时也绑——市场安装/外部导入的技能可持久化，不再退化为
    # 无持久化的内存落点）
    if skill_store is None:
        from ink_engine.core.skill_crystal import KnowledgeSkillStore

        skill_store = KnowledgeSkillStore()
    skill_store.knowledge_set = runtime.knowledge_set
    runtime.skill_store = skill_store

    async def _skill_provider(request: Any) -> list[Any]:
        """组装技能先例提供器：技能存储（知识集 kind=path 视图）→ 技能清单。

        域过滤随组装请求传入（None = 全域）；未装配 = 空清单（技能层零参与）。
        消费时机 = 路径组装先例层（缓存未命中时），见 path_assembler._skill_chains。
        """
        store = runtime.skill_store
        if store is None:
            return []
        return await store.list(getattr(request, "domain", None))
    # 接线：装配期注入真实 MCP server 探测（graph_recipe 探测通道，
    # 收官形态——离线 server 的挂载工具从默认研究链剔除/调用降级，
    # 不再每回合 8 个必失败调用白跑）。探测 = runtime.mcp_manager 会话
    # health_check 语义（协议级 ping，失败含拉起尝试）：未连接/探测失败
    # 仅将该 server 标记离线，其余 server/工具不受影响（逐 server 独立
    # 标记由 graph_recipe.refresh_mcp_availability 保证）。
    from .graph_recipe import install_mcp_server_probe

    async def _probe_mcp_server(server_id: str) -> bool | None:
        """单 server 存活探测（runtime.mcp_manager 会话 health_check）。"""
        manager = runtime.mcp_manager
        if manager is None:
            return None
        handle = getattr(manager, "_sessions", {}).get(server_id)
        if handle is None:
            return False
        try:
            return bool(await handle.health_check())
        except Exception:  # noqa: BLE001 - 探测失败 = 该 server 独立标记离线
            return False

    install_mcp_server_probe(_probe_mcp_server)
    # 组装指令运行期挂载（flag 开 = 默认运行期生效；关 = 显式卸载零生效）
    if path_flags.assembler_enabled:
        from ink_engine.core.path_assembler import (
            PathAssemblyRuntime,
            set_default_assembly_runtime,
        )

        from inkling_host.quality import SettleQualityGate

        registries = getattr(runtime, "graph_registries", None)
        registry = getattr(registries, "nodes", None) if registries is not None else None
        if registry is not None:
            from ink_engine.core.contracts import PathAssemblyConfig

            # 契约登记（ENG9a-1）：声明式工具以「结点类型 = 工具名」带契约
            # 进注册表——组装池不再只有 vision_perceive 一个带契约类型，
            # 目标字段（result 等）与真实工具产出匹配、放行档按真实审批档
            # 剪枝，assemble 不再恒零候选恒回落 use_default_plan
            from .graph_recipe import register_tool_node_types

            register_tool_node_types(registry, declarative_specs_from_tools(bundle))
            # 多径装配注册（E-P2 接线）：开关开启时注入 junction 结点类型
            # （引用 junction 的图在建图期可解析）；关闭 = 类型不存在 =
            # 引用被拒（默认全关的零影响语义）
            if path_flags.multipath_enabled:
                from ink_engine.core.multipath import register_junction_node

                if not registry.has("junction"):
                    register_junction_node(registry)
            # 种子路径语料导入：path_seeds.json 的出厂路径链 →
            # 边证据冷启动基线（同键不覆盖，运行统计是事实）——组装器冷
            # 启动有先验可循，不靠裸奔
            if evidence_store is not None:
                seed_edges = _seed_edges_from_path_seeds(bundle)
                if seed_edges:
                    from ink_engine.core.edge_evidence import import_seed_paths

                    imported = await import_seed_paths(evidence_store, seed_edges)
                    if imported:
                        logger.info("路径种子导入边证据基线: %s 条", imported)
            set_default_assembly_runtime(
                PathAssemblyRuntime(
                    registry=registry,
                    evidence_store=evidence_store,
                    config=PathAssemblyConfig(enabled=True),
                    sink=_audit_sink,
                    cache=fingerprint_store,
                    model_id=os.environ.get("INK_LLM_MODEL", ""),
                    multipath_enabled=path_flags.multipath_enabled,
                    skill_provider=_skill_provider,
                )
            )
    else:
        from ink_engine.core.path_assembler import set_default_assembly_runtime

        set_default_assembly_runtime(None)
    _builtin_market = dict(market if market is not None else bundle.data["mcp_market.json"])
    _builtin_market.setdefault("id", "market")
    mount_service = McpMountService(
        runtime,
        markets=[_builtin_market],
        external_mark_vetted=mark_vetted,
    )
    # 挂载服务挂到运行时/宿主（bridge op 经 runtime_handle/host_handle 取用）：
    # 用户持久化市场（连接页「添加链接挂载新市场」摄入）启动装载。
    runtime.mcp_mount_service = mount_service
    host.mcp_mount_service = mount_service
    await mount_service.load_persisted_markets()
    from .skill_market import SkillMarketService

    market_path = bundle.root / "seed_data" / "skills_market.json"
    skills_market: dict[str, Any] = {}
    if market_path.is_file():
        import json as _json

        skills_market = _json.loads(market_path.read_text(encoding="utf-8"))
    skill_market_service = SkillMarketService(
        runtime,
        market=skills_market,
        skill_store=runtime.skill_store,
        external_mark_vetted=mark_vetted,
    )
    host.skill_market = skill_market_service
    runtime.skill_market = skill_market_service
    register_domain_tools(runtime, bundle)
    _auto_approve_all = (
        os.environ.get("INK_HEADLESS_AUTO_APPROVE_ALL", "").strip().lower()
        in ("1", "true", "yes")
    )
    register_host_executors(
        runtime, mount_service, security, host=host, auto_approve_all=_auto_approve_all
    )
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
    # 自动审批设置 + 档位覆盖恢复（用户预授权随启动装载；无记录 = 出厂空集）
    from .security_domain import restore_auto_approve

    await restore_auto_approve(runtime.storage, security)
    # 装配域挂到宿主（设置页/评测侧运行期入口）
    host.security = security
    host.builds = build_domain
    # 组件清单恢复（restore_live_views → restore_component_manifest）经 runtime
    # 取构建域：回退/重启后从链重建 data_dir/components/manifest.json
    runtime.builds = build_domain
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
    # 文件连接配置投影为各挡位链（main/router/audit——设置页落盘的
    # router/audit 模型即时参与内部通道），env 配置覆盖主挡（缺省回落
    # main）；tiers/review 数据留档供 model.reload 热重建挡位域
    from .model_layers import build_tier_chains, make_tier_stats, resolve_tier_chain

    _tier_configs = _model_tier_configs_from_file(data_dir)
    _env_config = _model_config_from_env()
    if _env_config:
        _tier_configs["main_config"] = dict(_env_config)
    host.tier_chains = build_tier_chains(bundle.data["tiers.json"], _tier_configs)
    host._tiers_data = bundle.data["tiers.json"]
    host._review_data = bundle.data["review.json"]
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
    # 模型缺省 = 无评审 fail-open，不阻断主流程）；治理类 LLM 调用归因
    # audit 挡（W8.3：缺省回落 main 链；audit_config 未配 = 走主挡位链，
    # 全缺 = 无评审 fail-open，中性分保留）
    host.review_pipeline = build_review_pipeline(
        resolve_tier_chain(host.tier_chains, "audit"),
        bundle.data["review.json"],
        tier="audit",
        on_llm_call=host.tier_stats.record,
    )
    revert_state["base_tools"] = bundle.data["tools.json"].get("tools") or ()
    revert_state["base_event_names"] = tuple(
        spec["name"] for spec in bundle.data["event_types.json"].get("events") or ()
    )
    revert_state["base_ui_spec"] = dict(bundle.data["ui_spec.json"])
    # 补丁来源知识条目登记位（回退恢复的撤销清单；宿主 boot 初始化）
    runtime.patch_entries: set[str] = set()
    # 知识「就地修改」补丁的回退快照（entry_id → 应用前条目 dict；
    # None 表示新建条目）：apply 侧写入，revert 侧据此还原，避免回退
    # 误删为「删除」语义（与 G1 约定的契约字段）
    runtime.knowledge_before_snapshots: dict[str, Any] = {}
    # 补丁链注入的 harness 定义名（回退注销清单：仅注销补丁来源、
    # 不动装配基线定义；与 patch_entries 同源机制）
    runtime.harness_patch_entries: set[str] = set()
    # 链恢复：环境段（声明生效）+ 产物段（声明工具注册）+ 工作区授权
    # + 活跃态整体还原（界面/主题/知识/事件类型——重启装配从链恢复）。
    # 安全模式 = 只读基线装配：链内容（自写资产的载体）整体不参与本次
    # 启动，链条目原样保留不触碰；崩溃循环下以出厂基线可用为优先，恢复
    # 动作（回落/重置）由宿主显式执行后退出安全模式
    if not safe_mode:
        assembled = await assemble_chain_with_boot_fallback(runtime)
        await env_domain.restore(assembled.get("environments") or {})
        build_domain.sync_artifact_tools(runtime, assembled.get("artifacts") or {})
        await host.workspaces.load()
        restore_live_views(
            runtime,
            assembled,
            base_event_names=revert_state.get("base_event_names") or (),
            base_ui_spec=revert_state.get("base_ui_spec"),
        )
        # MCP 挂载登记恢复（链内 mcp 端点工具按 server 回填；补丁序占位）
        mount_service.restore_mount_log(assembled)
        # 挂载 server 连接还原（持久化配置重建会话；失败离线降级）
        await mount_service.load_persisted_mount_configs()
    # 种子条目重注入：引擎链恢复在种子注入之后整体替换知识集实例，
    # 出厂基线条目（内存态、不在链上）随之丢失——按既定语义「种子 =
    # 启动注入基线，链只承载演化」，此处重注入并与链段条目按 id 去重
    # （晋升过的条目已上链，以链态为准不覆盖）
    for _seed_name, seed_provider in recipe.seeds:
        for seed_entry in seed_provider():
            if runtime.knowledge_set.get(seed_entry.id) is None:
                runtime.knowledge_set.add(seed_entry)
    runtime.introspection_service._sources.tools = runtime.collect_specs()
    runtime.introspection_service._sources.registered_tools = runtime.merged_specs()
    # 内置 MCP server 自动连接（出厂能力非市场挂载）：tools.json 声明
    # endpoint=mcp 且 server_id 属 BUILTIN_MCP_SERVERS 的工具随装配生效。
    # exec 二进制（inkling_exec）路径按数据目录 exec/ 解析；连接失败只
    # 记日志不阻断装配（server 离线降级，工具注册照常——单源 + 标签：
    # 注册 = 存在，可用性由执行时在线判定）
    await _connect_builtin_servers(runtime, data_dir, mount_service, seed_root=root)
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


async def _connect_builtin_servers(
    runtime: Any, data_dir: Path, mount_service: Any, *, seed_root: Path | None = None
) -> None:
    """装配期连接内置 MCP server（出厂能力，非市场挂载）。

    inkling_exec（stdio）需可执行二进制路径——优先数据目录 exec/
    （bundled 解包落位），再回落仓库内 exec 构建产物（开发形态，
    经 seed_root 即 repo/inkling 定位到 repo/inkling/exec/target）。
    连接失败只记日志（离线降级：工具注册照常、执行时在线判定）。
    """
    from ink_engine.core.mcp_client import BUILTIN_MCP_SERVERS, builtin_mcp_server_config

    seed_root = Path(seed_root) if seed_root is not None else Path(__file__).resolve().parent.parent
    candidates = [
        Path(data_dir) / "exec" / "inkling_exec.exe",
        Path(data_dir) / "resources" / "exec" / "inkling_exec.exe",
        seed_root / "exec" / "target" / "debug" / "inkling_exec.exe",
        seed_root / "exec" / "target" / "release" / "inkling_exec.exe",
    ]
    exec_binary = next((p for p in candidates if p.is_file()), None)
    if "inkling_exec" in BUILTIN_MCP_SERVERS and exec_binary is not None:
        try:
            config = builtin_mcp_server_config(
                "inkling_exec",
                command=str(exec_binary),
                args=(),
            )
            await runtime.mcp_manager.connect(config)
        except Exception as exc:
            logger.warning("内置 server 连接失败（离线降级）: %s", exc)
    # inkling_shell（in_memory）嵌入式 server：连接位经宿主装配注入，
    # 未接线 = 离线（shell 侧工具照常注册、执行时判定）
    for server_id in BUILTIN_MCP_SERVERS:
        if server_id == "inkling_exec":
            continue
        factory = (
            mount_service._server_factories.get(server_id)
            if mount_service is not None
            else None
        )
        if factory is None:
            continue
        try:
            config = builtin_mcp_server_config(server_id, server_factory=factory)
            await runtime.mcp_manager.connect(config)
        except Exception as exc:
            logger.warning("内置 server 连接失败（离线降级）: %s", exc)


def _model_config_from_env() -> dict[str, str]:
    """环境变量模型配置（INK_LLM_* 命名与 examples/stdio_host 同口径）。"""
    base_url = os.environ.get("INK_LLM_BASE_URL", "")
    model_id = os.environ.get("INK_LLM_MODEL", "")
    if not base_url or not model_id:
        return {}
    config: dict[str, str] = {
        "adapter": os.environ.get("INK_LLM_ADAPTER", "openai_compatible"),
        "base_url": base_url,
        "model_id": model_id,
    }
    api_key = os.environ.get("INK_LLM_API_KEY")
    if api_key:
        config["api_key"] = api_key
    return config


def _project_flat_connection(cfg: dict[str, Any]) -> dict[str, Any]:
    """旧 flat 形态 → 单提供方投影（迁移期兼容读；与壳侧归一化同语义）。

    provider_id 取自定义标识/vendor 预设 id；adapter 取 provider_id 字段
    （预设厂商该字段是适配器标识）；model_ids 从 main/router/audit 键投影。
    """
    vendor = str(cfg.get("vendor") or "")
    provider_field = str(cfg.get("provider_id") or "openai_compatible")
    is_custom = vendor == "__custom__"
    provider_id = provider_field if is_custom else (vendor or provider_field)
    model_ids: dict[str, str] = {}
    for tier, key in (
        ("main", "main_model_id"),
        ("router", "router_model_id"),
        ("audit", "audit_model_id"),
    ):
        value = cfg.get(key)
        if isinstance(value, str) and value.strip():
            model_ids[tier] = value
    provider: dict[str, Any] = {
        "provider_id": provider_id,
        "label": provider_id,
        "adapter": provider_field,
    }
    for key in ("base_url", "api_key", "context_window", "compression_percent"):
        if key in cfg:
            provider[key] = cfg[key]
    if model_ids:
        provider["model_ids"] = model_ids
    return provider


def _restore_connection_secret(value: Any) -> Any:
    """还原壳侧 DPAPI 加密的 api_key（``dpapi:<hex>`` 前缀 → 解密明文；
    其余原样透传——旧明文值迁移兼容）。非 Windows 无 DPAPI，透传原值。
    """
    if not isinstance(value, str) or not value.startswith("dpapi:"):
        return value
    if os.name != "nt":
        return value
    try:
        import ctypes
        from ctypes import wintypes

        class DATA_BLOB(ctypes.Structure):
            _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]

        crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        crypt32.CryptUnprotectData.argtypes = [
            ctypes.POINTER(DATA_BLOB),
            ctypes.POINTER(ctypes.c_void_p),
            ctypes.POINTER(DATA_BLOB),
            ctypes.c_void_p,
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.POINTER(DATA_BLOB),
        ]
        crypt32.CryptUnprotectData.restype = wintypes.BOOL
        blob = bytes.fromhex(value[len("dpapi:"):])
        in_blob = DATA_BLOB(len(blob), ctypes.cast(
            ctypes.create_string_buffer(blob), ctypes.POINTER(ctypes.c_byte)
        ))
        out_blob = DATA_BLOB()
        ok = crypt32.CryptUnprotectData(
            ctypes.byref(in_blob), None, None, None, None, 0x1, ctypes.byref(out_blob)
        )
        if not ok:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            return ctypes.string_at(out_blob.pbData, out_blob.cbData).decode("utf-8")
        finally:
            kernel32.LocalFree(ctypes.cast(out_blob.pbData, ctypes.c_void_p))
    except Exception:
        # 解密失败（跨用户/密钥不可用）保留原值，交由调用方降级
        return value


def _read_connection_providers(data_dir: Path | None) -> list[dict[str, Any]]:
    """model_connection.json → 提供方数组（多提供方唯一权威形态）。

    - ``providers`` 数组 = 直接返回；
    - 旧 flat 形态 = 投影为单提供方（迁移期兼容读）；
    - 缺文件/非法 = 空数组（回落离线桩）。
    与壳侧 :func:`read_connection_providers` 归一化语义一致，读写单一
    权威，读取方不感知文件形态。api_key 经壳侧 DPAPI 加密落盘
    （``dpapi:`` 前缀），此处还原为明文供真实模型建链。
    """
    if data_dir is None:
        return []
    path = Path(data_dir) / "model_connection.json"
    if not path.exists():
        return []
    try:
        with open(path, "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
    except Exception:
        return []
    if not isinstance(cfg, dict) or not cfg:
        return []
    providers = cfg.get("providers")
    if isinstance(providers, list):
        result = [p for p in providers if isinstance(p, dict)]
    else:
        result = [_project_flat_connection(cfg)]
    for provider in result:
        if isinstance(provider.get("api_key"), str):
            provider["api_key"] = _restore_connection_secret(provider["api_key"])
    return result


def _model_config_from_file(data_dir: Path | None) -> dict[str, str]:
    """文件配置回落（model_connection.json，设置页落盘；提供方数组形态）。

    环境变量缺配置时经此读取 base_url + 主档 model_id 装配真实模型；
    缺字段/文件不存在/非对象返回空（回落离线桩）。优先级：环境变量 >
    文件 > 桩。取提供方数组第一项为当前连接（多提供方扩展期：当前连接
    = 主提供方）；主档 model_id 优先，router/audit 缺省回落 main（与
    设置页回落口径一致）。旧 flat 形态经归一化投影（迁移期兼容读）。
    """
    providers = _read_connection_providers(data_dir)
    if not providers:
        return {}
    provider = providers[0]
    base_url = provider.get("base_url", "")
    if not base_url or not str(base_url).strip():
        return {}
    model_ids = provider.get("model_ids") or {}
    model_id = model_ids.get("main") or model_ids.get("router") or model_ids.get("audit")
    if not model_id or not str(model_id).strip():
        return {}
    config: dict[str, str] = {
        "adapter": str(provider.get("adapter") or provider.get("provider_id") or "openai_compatible"),
        "base_url": str(base_url),
        "model_id": str(model_id),
    }
    api_key = provider.get("api_key")
    if api_key:
        config["api_key"] = str(api_key)
    # 压缩占比（全局唯一旋钮，默认 80%）：设置页落盘字段，引擎按
    # 模型档案窗口 × 占比动态推算压缩阈值（不暴露 token 数）
    try:
        config["compression_percent"] = float(provider.get("compression_percent") or 80)
    except (TypeError, ValueError):
        config["compression_percent"] = 80.0
    return config


def _model_tier_configs_from_file(data_dir: Path | None) -> dict[str, Any]:
    """model_connection.json → 挡位配置投影（main/router/audit 各自成链）。

    与 :func:`_model_config_from_file` 单连接口径同源解析（提供方数组第一
    项 = 当前连接）：main/router/audit 各按档位 model_id 建一条链（配置
    缺失的挡位不入映射 = 该挡位 None，调用方按 resolve_tier_chain 缺省
    回落主挡）；api_key 留空沿用既有（壳侧逐提供方浅合并写保证缺省字段
    保留）。缺 base_url = 空映射（回落离线桩）；数据形态与引擎
    resolve_tier_config 对齐（``<tier>_config``）。
    """
    providers = _read_connection_providers(data_dir)
    if not providers:
        return {}
    provider = providers[0]
    base_url = str(provider.get("base_url") or "")
    if not base_url.strip():
        return {}
    adapter = provider.get("adapter") or provider.get("provider_id") or "openai_compatible"
    api_key = provider.get("api_key")
    model_ids = provider.get("model_ids") or {}
    configs: dict[str, Any] = {}
    for tier in ("main", "router", "audit"):
        model_id = model_ids.get(tier)
        if not model_id or not str(model_id).strip():
            continue
        entry: dict[str, str] = {
            "adapter": adapter,
            "base_url": base_url,
            "model_id": str(model_id),
        }
        if api_key:
            entry["api_key"] = str(api_key)
        configs[f"{tier}_config"] = entry
    return configs


def _model_context_window_from_archive(
    data_dir: Path | None, model_id: str | None
) -> int | None:
    """从模型档案库读取 context_window（压缩动态阈值数据源）。

    data_dir 缺省 / model_id 空 / 档案库不存在 / 记录缺失 = 返回 None
    （调用方回退硬底线或档位缺省）。只读不写，失败时静默回退。
    """
    if data_dir is None or not model_id:
        return None
    db_path = Path(data_dir) / "model_archive.sqlite"
    if not db_path.exists():
        return None
    try:
        import sqlite3

        with sqlite3.connect(str(db_path)) as conn:
            cur = conn.execute(
                "SELECT context_window FROM model_archive WHERE model_id = ?",
                (str(model_id),),
            )
            row = cur.fetchone()
        if row and row[0]:
            return int(row[0])
    except Exception as exc:
        logger.warning("模型档案 context_window 读取失败（回退）: %s", exc)
        return None
    return None


def register_domain_tools(runtime: Runtime, bundle: SeedDataBundle) -> None:
    """tools.json 声明式工具进统一工具表（挂载/声明同表，机制零差异）。

    声明是数据：工具定义（名称/参数/权限/端点）全部来自 tools.json；
    执行端点由宿主执行器注册兜底（未注册端点在调用时降级为明确
    失败文本，不崩溃）。

    同名防御：内核契约自指工具（propose_patch/apply_patch/revert_patch/
    propose_domain_manifest）以内核 spec 为权威，tools.json 若重复声明
    同名条目一律跳过——否则声明式副本（process:exec 权限）覆盖工具表
    同名项，自指判定（self:propose/self:apply）权限不命中导致
    「权限未命中」误拒（propose_patch 曾因 tools.json 冗余条目被拒）。
    """
    reserved = set(SELF_TOOL_CONTRACT)
    for spec in declarative_specs_from_tools(bundle):
        if spec.name in reserved:
            continue
        runtime.harness_registry.declarative.register_definition(spec)
        runtime.tool_registry[spec.name] = spec.to_spec()
    # 工具表唯一权威 = tool_registry：检索/绑定与工具 tab 同源，注册后
    # 必须刷新派生索引（tool_index 构建先于 register_domain_tools，否则
    # search_tools/request_tool 查不到本批工具）
    runtime.refresh_tool_index()


def make_task_manager_executor(runtime: Runtime) -> Any:
    """待办清单执行体：``todo:<thread_id>`` 持久化清单（agent 自我管理）。

    args（tools.json task_manager 声明）：operation=create/update/complete/
    list/clear + 条目字段。清单按 thread 隔离（各会话独立），操作即落库
    （任何时刻收口不丢），变更写 set_audit（append-only 审计）。storage
    不可用 = 纯内存降级（仍可操作，不落库）。
    """

    def _default() -> dict[str, Any]:
        return {"entries": [], "next_order": 0}

    async def _load(thread_id: str) -> dict[str, Any]:
        storage = getattr(runtime, "storage", None)
        if storage is None:
            return _default()
        rec = await storage.get_record(f"todo:{thread_id}", "list")
        if not isinstance(rec, dict):
            return _default()
        entries = rec.get("entries")
        if not isinstance(entries, list):
            entries = []
        return {"entries": entries, "next_order": int(rec.get("next_order") or len(entries))}

    async def _save(thread_id: str, data: dict[str, Any]) -> None:
        storage = getattr(runtime, "storage", None)
        if storage is None:
            return
        await storage.put_record(f"todo:{thread_id}", "list", data)

    async def _audit(record: dict[str, Any]) -> None:
        storage = getattr(runtime, "storage", None)
        if storage is None:
            return
        import uuid as _uuid

        key = f"todo-{_uuid.uuid4().hex[:12]}"
        try:
            allow = getattr(storage, "allow_mechanism", None)
            if callable(allow):
                async with allow("set_audit"):
                    await storage.put_record("set_audit", key, record)
            else:
                await storage.put_record("set_audit", key, record)
        except Exception:  # noqa: BLE001 - 审计失败不阻断操作
            pass

    async def execute(ctx: Any, definition: Any, args: dict, approval: Any) -> str:
        op = str(args.get("operation") or "")
        thread_id = getattr(ctx, "thread_id", None) or "default"
        data = await _load(thread_id)
        entries = data["entries"]
        now = time.time()
        if op == "create":
            title = str(args.get("title") or "").strip()
            if not title:
                return json.dumps({"ok": False, "error": "create 需 title 参数"}, ensure_ascii=False)
            n = data["next_order"]
            entry = {
                "id": f"task-{n}",
                "title": title,
                "detail": str(args.get("detail") or "").strip() or None,
                "priority": str(args.get("priority") or "medium"),
                "status": "pending",
                "evidence": None,
                "order": n,
                "created_at": now,
                "updated_at": now,
                "completed_at": None,
            }
            entries.append(entry)
            data["next_order"] = n + 1
            await _save(thread_id, data)
            await _audit(
                {"kind": "todo", "op": "create", "id": entry["id"], "thread_id": thread_id,
                 "title": title, "ts": now}
            )
            return json.dumps({"ok": True, "id": entry["id"], "status": "pending"}, ensure_ascii=False)
        if op in ("update", "complete"):
            eid = str(args.get("id") or "")
            entry = next((e for e in entries if e.get("id") == eid), None)
            if entry is None:
                return json.dumps({"ok": False, "error": f"待办条目不存在: {eid}"}, ensure_ascii=False)
            if op == "complete":
                entry["status"] = "done"
                entry["completed_at"] = now
                if args.get("evidence"):
                    entry["evidence"] = str(args["evidence"])
            else:
                for field in ("title", "detail", "priority", "status", "evidence"):
                    if field in args:
                        value = args[field]
                        entry[field] = str(value) if value is not None else None
                if entry.get("status") == "done" and entry.get("completed_at") is None:
                    entry["completed_at"] = now
            entry["updated_at"] = now
            await _save(thread_id, data)
            await _audit(
                {"kind": "todo", "op": op, "id": eid, "status": entry.get("status"),
                 "thread_id": thread_id, "ts": now}
            )
            return json.dumps({"ok": True, "entry": entry}, ensure_ascii=False)
        if op == "list":
            status_filter = str(args.get("status_filter") or "").strip()
            limit = max(1, min(int(args.get("limit") or 20), 100))
            result = [e for e in entries if not status_filter or e.get("status") == status_filter]
            result.sort(
                key=lambda e: (
                    {"high": 0, "medium": 1, "low": 2}.get(e.get("priority"), 1),
                    e.get("order", 0),
                )
            )
            return json.dumps(
                {"ok": True, "entries": result[:limit], "total": len(entries)}, ensure_ascii=False
            )
        if op == "clear":
            removed = [e["id"] for e in entries if e.get("status") == "done"]
            entries[:] = [e for e in entries if e.get("status") != "done"]
            await _save(thread_id, data)
            await _audit(
                {"kind": "todo", "op": "clear", "removed": removed, "thread_id": thread_id, "ts": now}
            )
            return json.dumps({"ok": True, "removed": removed}, ensure_ascii=False)
        if op == "delete":
            eid = str(args.get("id") or "")
            entry = next((e for e in entries if e.get("id") == eid), None)
            if entry is None:
                return json.dumps({"ok": False, "error": f"待办条目不存在: {eid}"}, ensure_ascii=False)
            entries[:] = [e for e in entries if e.get("id") != eid]
            await _save(thread_id, data)
            await _audit(
                {"kind": "todo", "op": "delete", "id": eid, "thread_id": thread_id, "ts": now}
            )
            return json.dumps({"ok": True, "id": eid, "removed": True}, ensure_ascii=False)
        return json.dumps({"ok": False, "error": f"未知 operation: {op}"}, ensure_ascii=False)

    return execute


def make_collab_request_executor(runtime: Runtime, host: Any = None) -> Any:
    """协作者召唤执行体：实体目录 → spawn 子图物化（多 agent 动态协作）。

    args（tools.json collab_request 声明）：entity_id（必填，目录已注册）、
    task（子任务描述，必填）、context_refs（可选，L2 消息 id 引用，本期
    未消费保留）、constraints（可选，max_tool_rounds 等护栏覆盖）。

    执行语义：
    - 实体未注册 → 显式失败文本（fail-closed，不静默降级主 agent）；
    - 物化 = 建协作者子图（llm_decider[entity.persona] ⇄ tool_pipeline
      → end，复用回合图条件边）→ ``ctx.spawn`` 注册实例 → 引擎展开；
    - 协作者事件落父链（L1 全量留痕）、结果随 spawn overlay 回流父状态；
    - 模型：EntitySpec.model 声明时按提供方解析（经宿主 resolve_model_llm，
      窗口参数按该模型档案 context_window；解析失败/未声明回落会话默认
      模型——fail-open）；工具全量共享必带集 + 检索动态注册。
    """

    async def execute(ctx: Any, definition: Any, args: dict, approval: Any) -> str:
        entity_id = str(args.get("entity_id") or "")
        task = str(args.get("task") or "")
        registry = runtime.entity_registry
        if registry is None:
            return "协作者目录未装配（EntityRegistry 不可用）"
        spec = registry.get(entity_id)
        if spec is None:
            return (
                f"协作者未注册: {entity_id!r}（inspect_entities 查看实体目录；"
                "召唤只允许目录内已注册实体，fail-closed）"
            )
        llm_override = None
        model_ref = spec.model
        if host is not None and isinstance(model_ref, dict):
            provider = str(model_ref.get("provider") or "")
            model_id = str(model_ref.get("model_id") or "")
            if provider and model_id:
                llm_override = host.resolve_model_llm(provider, model_id)
        graph = _build_collaborator_graph(spec, llm=llm_override)
        entry_state: dict[str, Any] = {"input": task, "step_args": {}}
        ctx.spawn(graph, entry_state)
        return (
            f"已召唤协作者 {spec.label or entity_id} 处理子任务"
            "（spawn 实例已注册，结果将回流汇总）。"
        )

    return execute


def _build_collaborator_graph(spec: Any, llm: Any = None) -> Any:
    """协作者子图：llm_decider[entity.persona] ⇄ tool_pipeline → end。

    与回合图同构（llm_decider 决策循环 + tool_pipeline 工具循环），仅
    system_prompt 换成实体 persona——工具全量共享（必带集 + 检索动态
    注册），权限/审批/审计走同一 tool_pipeline，零新执行机制。
    llm 非空 = 按 EntitySpec.model 解析的实体专属模型覆盖（llm_decider
    优先取 config 覆盖，回落会话默认模型）。
    """
    from ink_engine.core.graph import Graph
    from ink_engine.core.state import StateSchema

    from .graph_recipe import (
        COND_FINISHED,
        COND_PENDING,
        MAX_TOOL_ROUNDS,
        TYPE_LLM_DECIDER,
        TYPE_TOOL_PIPELINE,
    )

    graph = Graph(name=f"collab:{spec.id}", entry="llm_decider")
    # 协作者子图状态 schema（决策：「只回流结果通道」）：
    # - messages = add_messages：子图内消息按 id/内容追加归约（协作者自己
    #   的工具循环续接/中断重入不整链覆盖），且随 spawn 回流按 additive
    #   语义求差——不会整表替换父消息链；
    # - reply = 产出/结果摘要通道（终态回复文本），spawn 回流即它；
    # - 未声明的键（input/tool_rounds/step_args/results 等子图内部结构）
    #   不随 spawn 回流——父回合历史不被实例终态裸覆盖（引擎
    #   subgraph_flowback_overlay：声明结果通道才回流）。
    graph.schema = StateSchema({"messages": "add_messages", "reply": None})
    decider_config: dict[str, Any] = {
        "system_prompt": spec.persona,
        "max_tool_rounds": MAX_TOOL_ROUNDS,
        # 发言人身份（Message.name：前端发言人标签 / 事件留痕；主 agent 缺省无）
        "name": spec.label or spec.id,
    }
    if llm is not None:
        decider_config["llm"] = llm
    graph.add_node_type(
        "llm_decider",
        TYPE_LLM_DECIDER,
        decider_config,
    )
    graph.add_node_type("tool_pipeline", TYPE_TOOL_PIPELINE, {})
    graph.add_node_type("end", TYPE_TOOL_PIPELINE, {"role": "terminal"})
    graph.add_conditional_edge_by_name("llm_decider", "tool_pipeline", COND_PENDING)
    graph.add_conditional_edge_by_name("llm_decider", "end", COND_FINISHED)
    graph.add_edge("tool_pipeline", "llm_decider")
    graph.add_exit("end")
    return graph


def register_host_executors(
    runtime: Runtime,
    mount_service: McpMountService,
    security: SecurityDomain,
    host: Any = None,
    *,
    auto_approve_all: bool = False,
) -> None:
    """宿主声明式执行器注册（机制层不代注册执行实现，宿主职责）。

    - process_exec：propose_mcp_mount（对话式安装入口）走挂载服务；
      OS 控制件经 OS 执行器注册表分发——执行实现经回调桥转发到壳侧
      执行器注册表（同一套运行体，引擎链路与壳命令共用；回调桥未接线
      时降级为未注册明确失败，不崩溃）；shell_exec（混合 shell）白名单
      外命令经升级审批后带 _escalated 标记分发；
    - http_fetch：fetch 网络策略执行体（出网经审批网关裁决，
      取回实现可注入，缺省 httpx）；
    - file_ops：文件开发执行体（工作区读写编辑 + 写前快照 + 大小上限）。

    auto_approve_all=True（headless 离线验证/自动化巡检形态）：挂载类
    工具（propose_mcp_mount）跳过挂载审批卡直接放行（等同手动挂载的
    一键授权语义），与回合级 auto_accept_review 配套构成统一自动审批
    开关；生产宿主保持缺省 False（外部能力接入一律过审批卡）。
    """
    _register_os_bridge(security)
    runtime.harness_registry.declarative.register(
        EndpointType.PROCESS_EXEC,
        make_process_exec_executor(
            mount_service,
            security.os_registry,
            tiers=security.tiers,
            require_approval=not auto_approve_all,
        ),
    )
    runtime.harness_registry.declarative.register(
        EndpointType.HTTP_FETCH,
        make_http_fetch_executor(),
    )
    # 受控取回（collect_material url 档）：单声明内拆语义——url 档走受控
    # 执行体（策略/审批已在门禁先行，执行体只做协议收口 + 契约产物），
    # file/text 档仍经 MCP 分发到 inkling_exec（exec 保持 fail-closed 深度防御）。
    runtime.harness_registry.declarative.register(
        RETRIEVAL_CONTROLLED_FETCH,
        make_controlled_fetch_executor(),
    )
    runtime.harness_registry.declarative.register(
        EndpointType.FILE_OPS,
        make_file_ops_executor(),
    )
    runtime.harness_registry.declarative.register(
        EndpointType.WEB_SEARCH,
        make_web_search_executor(),
    )
    runtime.harness_registry.declarative.register(
        EndpointType.COLLAB_REQUEST,
        make_collab_request_executor(runtime, host=host),
    )
    runtime.harness_registry.declarative.register(
        EndpointType.TASK_MANAGER,
        make_task_manager_executor(runtime),
    )


# 壳侧执行器注册表承载的 OS 命令清单（与 fixtures/tools_os.json 一一对应；
# 执行体在壳侧 impls.rs，引擎链路经本桥转发，避免两套调度语义分叉）
_OS_BRIDGE_COMMANDS = (
    "launch_app",
    "open_file",
    "system_query",
    "set_volume",
    "set_brightness",
    "notify",
    "sleep",
    "file_query",
    "ui_query",
    "ui_click",
    "ui_type",
    "window_focus",
    "window_minimize",
    "doc_parse",
    "doc_generate",
    "screenshot_capture",
    "shell_exec",
)


def _register_os_bridge(security: SecurityDomain) -> None:
    """把 OS 命令经回调桥接到壳侧执行器注册表。

    回调未注册（壳未启动/测试环境）时返回结构化未注册失败——与
    执行器注册表缺实现的降级语义一致，调用方据此感知「桌面壳未挂载」。
    """

    def make_impl(command: str):
        def impl(ctx: Any, definition: Any, args: dict) -> str:
            try:
                from inkling_bridge import callback_host
            except Exception as exc:  # 桥模块不可用 = 未接线降级
                return json.dumps(
                    {
                        "ok": False,
                        "status": "executor_not_registered",
                        "error": f"OS 执行体桥未接线: {exc}",
                    },
                    ensure_ascii=False,
                )
            payload = json.dumps(
                {"tool": command, "args": dict(args or {})},
                ensure_ascii=False,
            )
            try:
                raw = callback_host().invoke("os.dispatch", payload)
            except Exception as exc:  # 回调未注册/壳未挂载 = 明确降级
                return json.dumps(
                    {
                        "ok": False,
                        "status": "executor_not_registered",
                        "error": f"OS 执行体未注册: {command}（桌面壳未挂载: {exc}）",
                    },
                    ensure_ascii=False,
                )
            return raw

        return impl

    for command in _OS_BRIDGE_COMMANDS:
        security.os_registry.register(command, make_impl(command))


def _assembly_registry(runtime_holder: dict[str, Any]) -> Any:
    """取装配注册表结点注册表（runtime 未就绪 = None；治理快照惰性取用）。"""
    runtime = runtime_holder.get("runtime")
    if runtime is None:
        return None
    registries = getattr(runtime, "graph_registries", None)
    if registries is None:
        return None
    return getattr(registries, "nodes", None)


def _governed_proposal_sink_factory(
    governance: Any,
    *,
    registry_getter: Callable[[], Any],
    fallback_sink: Callable[[dict[str, Any]], Any],
) -> Callable[[dict[str, Any]], Any]:
    """结点提案治理 sink 工厂（E-P9 接线：四规则判定随提案审计落库）。

    每条失败点结点提案先经 PoolGovernance.evaluate（容量/淘汰/合并/预算
    四规则，输入 = 提案 + 注册表快照），判定结果随提案记录经原审计通道
    落库——治理只判定登记不执行决策，采纳与否仍走既有评审通道。判定
    异常不阻断提案审计（治理故障只记日志，fail-open 于观测侧）。
    """

    def sink(record: dict[str, Any]) -> Any:
        from ink_engine.core.pool_governance import (
            pool_nodes_from_registry,
            proposal_from_node_draft,
            weekly_proposal_usage,
        )

        verdict = None
        try:
            registry = registry_getter()
            snapshot: dict[str, Any] = {
                "pool_count": len(registry) if registry is not None else 0,
                "used_this_week": weekly_proposal_usage(governance.log),
                "pool_nodes": (
                    pool_nodes_from_registry(registry)
                    if registry is not None
                    else []
                ),
                "duplicate_cosine": 0.0,
            }
            verdict = governance.evaluate(
                proposal_from_node_draft(record), snapshot
            )
        except (TypeError, ValueError, KeyError) as exc:
            # 治理判定失败只记日志走原审计（观测侧 fail-open，不阻断提案）
            logger.warning("结点提案池治理判定失败（忽略，走原审计）: %s", exc)
        if verdict is not None:
            return fallback_sink(
                {**record, "governance": verdict.to_dict()}
            )
        return fallback_sink(record)

    return sink


def _seed_edges_from_path_seeds(bundle: SeedDataBundle) -> list[dict[str, Any]]:
    """seed_data/path_seeds.json → 边证据种子清单（冷启动基线）。

    每条出厂路径链的相邻结点对展开为一条边证据种子（成败计数取该路径
    声明值，缺省回落文件级 edge_defaults）；同键行导入时不覆盖运行期
    事实（import_seed_paths 语义）。文件只读（不在 SEED_DATA_FILES 装配
    清单内，按需直读）——缺失/损坏 = 空清单（冷启动无先验，不阻断装配）。
    """
    try:
        path = bundle.root / "seed_data" / "path_seeds.json"
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    defaults = data.get("edge_defaults") or {}
    edges: list[dict[str, Any]] = []
    for seed in data.get("seed_paths") or ():
        chain = seed.get("chain") or ()
        stats = seed.get("edge_stats") or {}
        for src, dst in itertools.pairwise(chain):
            edges.append(
                {
                    "src_type": str(src),
                    "dst_type": str(dst),
                    "success_count": int(
                        stats.get("success_count", defaults.get("success_count", 3))
                    ),
                    "fail_count": int(
                        stats.get("fail_count", defaults.get("fail_count", 1))
                    ),
                    "avg_cost": float(defaults.get("avg_cost", 0.0)),
                    "context_domain": str(seed.get("domain") or "default"),
                    "src_contract_version": str(
                        defaults.get("src_contract_version", "1")
                    ),
                    "dst_contract_version": str(
                        defaults.get("dst_contract_version", "1")
                    ),
                }
            )
    return edges


__all__ = [
    "InKlingHost",
    "InkRuntime",
    "boot_inkling",
    "register_domain_tools",
    "register_host_executors",
]
