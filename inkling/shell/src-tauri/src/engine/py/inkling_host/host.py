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
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ink_engine.core.approval import DefaultInterruptPolicy, InterruptPolicy
from ink_engine.core.context import (
    ThresholdCompressionPolicy,
    infer_compression_tier,
)
from ink_engine.core.declarative_tools import EndpointType
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
        # 压缩阈值按 context_window 动态化（档案缺失回退硬底线）
        model_id = getattr(getattr(llm, "config", None), "model_id", None)
        context_window = _model_context_window_from_archive(self._data_dir, model_id)
        tier = infer_compression_tier(model_id)
        self._compression_policy = ThresholdCompressionPolicy.from_context_window(
            context_window=context_window, tier=tier
        )
        return wrapped

    def compression_policy(self) -> Any:
        """当前压缩策略（resolve_llm 后可用，未解析返回 None）。"""
        return getattr(self, "_compression_policy", None)

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

    if (
        path_flags.edge_evidence_enabled
        or path_flags.settle_hooks_enabled
        or path_flags.assembler_enabled
    ):
        from ink_engine.core.edge_evidence import EdgeEvidenceStore

        evidence_store = EdgeEvidenceStore(
            db_path=str(data_dir / "edge_evidence.sqlite")
        )
    if path_flags.fingerprint_cache_enabled:
        from ink_engine.core.fingerprint_cache import FingerprintCacheStore

        fingerprint_store = FingerprintCacheStore(
            db_path=str(data_dir / "fingerprint_cache.sqlite")
        )
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
            )
            if settle_hooks is not None
            else RunOptions(branch_mixer=PatchChainBranchMixer())
        ),
    )
    runtime = await InkRuntime(_five_source_factory(bundle)).boot(host, recipe)
    runtime_holder["runtime"] = runtime
    revert_state["runtime"] = runtime
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
    # 自动审批设置恢复（用户预授权随启动装载；无记录 = 出厂空集）
    from .security_domain import restore_auto_approve, restore_remembered_domains

    await restore_auto_approve(runtime.storage, security)
    # 已记住域名恢复（联网审批的域名级记忆；无记录 = 出厂空集 = 全走审批）
    await restore_remembered_domains(runtime.storage, security)
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


def _model_config_from_file(data_dir: Path | None) -> dict[str, str]:
    """文件配置回落（model_connection.json，设置页落盘）。

    环境变量缺配置时经此读取 base_url + 主档 model_id 装配真实模型；
    缺字段/文件不存在/非对象返回空（回落离线桩）。优先级：环境变量 >
    文件 > 桩。主档 main_model_id 优先，router/audit 缺省回落 main
    （与设置页回落口径一致）。
    """
    if data_dir is None:
        return {}
    path = Path(data_dir) / "model_connection.json"
    if not path.exists():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
    except Exception:
        return {}
    if not isinstance(cfg, dict):
        return {}
    base_url = cfg.get("base_url", "")
    if not base_url or not str(base_url).strip():
        return {}
    model_id = cfg.get("main_model_id") or cfg.get("router_model_id") or cfg.get("audit_model_id")
    if not model_id or not str(model_id).strip():
        return {}
    config: dict[str, str] = {
        "adapter": cfg.get("provider_id") or "openai_compat",
        "base_url": str(base_url),
        "model_id": str(model_id),
    }
    api_key = cfg.get("api_key")
    if api_key:
        config["api_key"] = str(api_key)
    return config


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


def register_host_executors(
    runtime: Runtime, mount_service: McpMountService, security: SecurityDomain
) -> None:
    """宿主声明式执行器注册（机制层不代注册执行实现，宿主职责）。

    - process_exec：propose_mcp_mount（对话式安装入口）走挂载服务；
      OS 控制九件经 OS 执行器注册表分发——执行实现经回调桥转发到壳侧
      执行器注册表（同一套运行体，引擎链路与壳命令共用；回调桥未接线
      时降级为未注册明确失败，不崩溃）；deny 档（shell_exec）执行体
      二次拒绝（纵深防御）；
    - http_fetch：fetch 网络策略执行体（域名白名单二次核对，
      取回实现可注入，缺省 httpx）；
    - file_ops：文件开发执行体（工作区读写编辑 + 写前快照 + 大小上限）。
    """
    _register_os_bridge(security)
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
    runtime.harness_registry.declarative.register(
        EndpointType.WEB_SEARCH,
        make_web_search_executor(),
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
    "schedule",
    "screen_query",
    "file_query",
    "run_typecheck",
    "run_test_cargo",
    "run_test_python",
    "run_test_web",
    "ui_click",
    "ui_type",
    "window_list",
    "window_focus",
    "window_minimize",
    "doc_parse",
    "doc_generate",
    "screenshot_capture",
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
