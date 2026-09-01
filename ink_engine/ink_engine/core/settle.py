"""沉淀钩子（回合收尾的注册式证据采集扩展，只记录不裁决）。

挂接点：引擎顶层 run 收尾（``_record_run_metrics`` 之后）注册式触发；
**零 LLM 硬规则**——证据采集纯算法归集（成败/成本/轮次自动归集），
绝不引入 LLM 调用；任何「评审/总结」冲动一律上移为离线演化机制，
不进运行路径。

轨迹来源（引擎内部留痕）：执行器在结点执行边界记录结点级成败轨迹
（``TraceStep``，不发射事件——观测侧零影响）。本模块据轨迹回放路径：
成功才全边 ``success+1``；失败只记失败结点入边 ``fail+1``、上游边
中性不记；成本每次执行归集 avg_cost。失败点触发新结点提案（契约草案
而非代码，评审走宿主 vetting）；成功组合触发指纹缓存 upsert（接口
先行，缓存本体后置；无闸门注入 = fail-closed 不入缓存）；失败日志
留痕审计（append-only）。

审计事件类型（组装/汇流裁决/指纹顶替/策略边复审）注册在
``event_types`` 注册表（类型是数据），本模块不产出事件。
"""
from __future__ import annotations

import itertools
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

from .edge_evidence import (
    DEFAULT_CONTRACT_VERSION,
    TIER_PROMOTE_N,
    TIER_PROMOTE_P,
    EdgeEvidence,
    EdgeEvidenceStore,
    EdgeKey,
    laplace_success,
)
from .edge_evidence import (
    import_seed_paths as _import_seed_paths,
)
from .event_types import EVENT_AUDIT_POLICY_REVIEW, EVENT_AUDIT_PROMOTION
from .exceptions import GraphDefinitionError
from .graph import Graph, TerminateReason
from .logging import get_logger
from .run_result import RunResult
from .schema_validator import SchemaField, SchemaSpec

logger = get_logger(__name__)
# 结点级成败留痕三态（执行器轨迹；挂起 = 不裁决，成败均不记）
TRACE_SUCCESS = "success"
TRACE_FAILED = "failed"
TRACE_SKIPPED = "skipped"

# 失败点提案阈值（同一失败点累计 N≥3 次或入边失败率>0.4 才提案，
# 一次偶发失败不污染评审队列）
PROPOSAL_MIN_FAILS = 3
PROPOSAL_FAIL_RATE = 0.4
# 入边失败率判定所需最小样本（单样本不判率——偶发失败不误伤）
PROPOSAL_RATE_MIN_N = 2

# 失败归因分类（error 事件 message 分类器）：把失败原因归到能力缺口类
# 才走「新结点提案」通道，环境/配置类失败（权限/校验/网络）不污染评审
# 队列（垃圾提案率断言由此压低）。model / unknown 视为能力缺口类。
FAIL_CAT_PERMISSION = "permission"
FAIL_CAT_VALIDATION = "validation"
FAIL_CAT_NETWORK = "network"
FAIL_CAT_MODEL = "model"
FAIL_CAT_UNKNOWN = "unknown"
# 能力缺口类（才触发结点提案）：模型能力本身不足 / 未归类未知
CAPABILITY_GAP_CATEGORIES = frozenset({FAIL_CAT_MODEL, FAIL_CAT_UNKNOWN})


def classify_failure(message: str | None) -> str:
    """失败消息 → 类别（permission/validation/network/model/unknown）。

    纯关键词分类（无 LLM）；命中多类按优先级 permission>validation>
    network>model 取首类，均无 → unknown（能力缺口兜底）。
    """
    text = (message or "").lower()
    if any(k in text for k in ("permission", "forbidden", "denied", "unauthorized", "403")):
        return FAIL_CAT_PERMISSION
    if any(k in text for k in ("validation", "schema", "invalid", "400", "malformed")):
        return FAIL_CAT_VALIDATION
    if any(k in text for k in ("network", "timeout", "connection", "dns", "502", "503", "504")):
        return FAIL_CAT_NETWORK
    if any(k in text for k in ("model", "llm", "context length", "context_length", "max tokens", "max_tokens", "rate limit", "rate_limit", "429", "token", "quota", "insufficient", "billing")):
        return FAIL_CAT_MODEL
    return FAIL_CAT_UNKNOWN

# 归因更新种类（声明式枚举）
UPDATE_SUCCESS = "success"
UPDATE_FAIL = "fail"

# 默认上下文域（未注入域时的登记归属）
DEFAULT_DOMAIN = "default"

# 推荐先验自动晋升（评审文档第十三节第七条：高强度证据路径自动晋升为「推荐先验」，
# 晋升不需人工拍板——与信任档推导式同一组常数，见 edge_evidence）
PROMOTION_MIN_N = TIER_PROMOTE_N  # 30
PROMOTION_MIN_P = TIER_PROMOTE_P  # 0.9

# 策略边对抗复审（评审文档第十三节坑六：刚性堤坝冻死系统——对抗证据可触发
# 复审，复审前该边降级为普通统计边）
POLICY_REVIEW_FAIL_THRESHOLD = 5  # 失败累计超阈值（默认 5 次）
# 域证据均值反超判定所需非策略边最小样本（样本不足只按失败累计判定）
POLICY_REVIEW_DOMAIN_MIN_EDGES = 2


@dataclass(slots=True)
class TraceStep:
    """执行器轨迹中的一步（结点级成败留痕，不发射事件）。

    执行器在采集期就地改写 status/tokens（成败判定与成本归集在结点
    块收尾时定型），故非冻结。member=True = 并行组成员步骤（不参与
    边遍历推导——成员间无图边语义，仅参与成败/审计统计）。
    """

    graph_path: tuple[str, ...]
    node: str
    status: str  # TRACE_SUCCESS / TRACE_FAILED / TRACE_SKIPPED
    tokens: int = 0  # 结点执行边界 token 计账（usage 帧纯算法归集）
    member: bool = False  # 并行组成员步骤标记

    def to_dict(self) -> dict[str, Any]:
        return {
            "graph_path": list(self.graph_path),
            "node": self.node,
            "status": self.status,
            "tokens": self.tokens,
        }


@dataclass(frozen=True, slots=True)
class Traversal:
    """轨迹回放推导出的一条边遍历（连续执行且图中存在该边）。"""

    graph_path: tuple[str, ...]
    src: TraceStep
    dst: TraceStep
    src_type: str
    dst_type: str
    src_contract_version: str
    dst_contract_version: str
    src_variant_hash: str = ""
    dst_variant_hash: str = ""


@dataclass(frozen=True, slots=True)
class EdgeUpdate:
    """归因更新计划（纯数据：成败 + 成本 + 增量；由存储钩子逐条落库）。"""

    key: EdgeKey
    kind: str  # UPDATE_SUCCESS / UPDATE_FAIL
    cost: float
    delta: int = 1  # 增量（成功 +1；失败 = 加权分摊 blame 量）


@dataclass(slots=True)
class SettleContext:
    """一次 run 的沉淀上下文（引擎在收尾处组装，钩子只读消费）。"""

    thread_id: str
    round_id: str | None
    trace_id: str
    domain: str
    steps: tuple[TraceStep, ...]
    node_tokens: dict[tuple[tuple[str, ...], str], int]
    graphs: dict[tuple[str, ...], Graph]
    result: RunResult


def node_identity(graph: Graph | None, node: str) -> tuple[str, str, str]:
    """结点 → (类型名, 契约版本, 变体指纹)：声明式绑定取注册类型与配置
    内版本，以及可选 ``variant_hash``（节点配置/提示词变体指纹，空 = 类型
    级兼容）；直挂函数取结点名 + 缺省版本 + 空变体。
    """
    if graph is None:
        return node, DEFAULT_CONTRACT_VERSION, ""
    binding = graph.node_bindings.get(node)
    if binding is not None:
        config = binding.config if isinstance(binding.config, dict) else {}
        version = str(config.get("contract_version", DEFAULT_CONTRACT_VERSION))
        variant_hash = str(config.get("variant_hash", ""))
        return binding.type_name, version, variant_hash
    return node, DEFAULT_CONTRACT_VERSION, ""


def derive_traversals(ctx: SettleContext) -> tuple[Traversal, ...]:
    """轨迹回放：同图路径内连续执行且图中存在该边 = 一条边遍历。

    嵌套执行（子图/实例/分支）与并行组成员步骤可能插入主循环步骤
    之间——按图路径分组后取各路径内非成员步骤的相邻对，父图边链
    不被子层步骤打断；计划驱动的跳跃（相邻执行结点间无图边）不构成
    遍历——没有边的执行不产生证据。
    """
    sequences: dict[tuple[str, ...], list[TraceStep]] = {}
    for step in ctx.steps:
        if step.member:
            continue  # 并行组成员无图边语义，不参与遍历推导
        sequences.setdefault(step.graph_path, []).append(step)
    traversals: list[Traversal] = []
    for path, seq in sequences.items():
        graph = ctx.graphs.get(path)
        if graph is None:
            continue
        for prev, cur in itertools.pairwise(seq):
            targets = {e.target for e in graph.edges.get(prev.node, ())}
            if cur.node not in targets:
                continue
            src_type, src_version, src_variant = node_identity(graph, prev.node)
            dst_type, dst_version, dst_variant = node_identity(graph, cur.node)
            traversals.append(
                Traversal(
                    graph_path=path,
                    src=prev,
                    dst=cur,
                    src_type=src_type,
                    dst_type=dst_type,
                    src_contract_version=src_version,
                    dst_contract_version=dst_version,
                    src_variant_hash=src_variant,
                    dst_variant_hash=dst_variant,
                )
            )
    return tuple(traversals)


def run_verdict(ctx: SettleContext) -> str:
    """证据归因方向判定（只记录不裁决的「裁决」= 归因方向）：

    - 有失败结点 → 失败归因（只记失败结点入边）；
    - 挂起（中断未决）/ 错误收尾（无失败结点，如计划步级错误）/
      预算截断 → 中性不记（路径未走完，无证据裁决）；
    - 其余（正常回复/停止）→ 成功归因（路径全通才证明每条边有效）。
    """
    if any(s.status == TRACE_FAILED for s in ctx.steps):
        return UPDATE_FAIL
    if any(s.status == TRACE_SKIPPED for s in ctx.steps):
        return "neutral"
    if ctx.result.interrupt is not None or ctx.result.reason == "interrupted":
        return "neutral"
    if ctx.result.reason in (TerminateReason.ERROR, TerminateReason.BUDGET_EXCEEDED):
        return "neutral"
    return UPDATE_SUCCESS


def attribution_plan(
    ctx: SettleContext,
    evidence_index: dict[EdgeKey, Any] | None = None,
) -> tuple[EdgeUpdate, ...]:
    """归因计划（纯函数）：按归因规则逐边生成更新，不落库。

    - 成功归因：全部遍历边 ``success+delta``（delta=1，成功才全边 +1）；
    - 失败归因（归因对称）：失败事件视同整链可疑，惩罚按
      边权重 / 成功史加权分摊到全路径边（非只记失败结点入边、非全边等权
      fail+1）——权重 = 该边成功计数 + 1（零证据边取 1），使「成功膨胀」
      被失败信号按真实证据强度回撤；失败结点的入边额外 +1 作为诊断信号
      （定位最可疑边），避免失败信号被稀释；
    - 成本每次执行归集：目标结点执行边界 token 计账随归因携带；
    - ``evidence_index`` 为可选边证据快照（钩子注入），缺省退化为等权
      （每边权重 1）的口径。
    """
    verdict = run_verdict(ctx)
    if verdict not in (UPDATE_SUCCESS, UPDATE_FAIL):
        return ()
    traversals = derive_traversals(ctx)
    if not traversals:
        return ()
    updates: list[EdgeUpdate] = []
    failed_tr = next((t for t in traversals if t.dst.status == TRACE_FAILED), None)
    for tr in traversals:
        key = EdgeKey(
            src_type=tr.src_type,
            dst_type=tr.dst_type,
            src_contract_version=tr.src_contract_version,
            dst_contract_version=tr.dst_contract_version,
            context_domain=ctx.domain,
            variant_hash=tr.dst_variant_hash,
        )
        cost = ctx.node_tokens.get((tr.dst.graph_path, tr.dst.node), 0)
        if verdict == UPDATE_SUCCESS:
            updates.append(EdgeUpdate(key=key, kind=UPDATE_SUCCESS, cost=float(cost), delta=1))
            continue
        # 失败：加权分摊（权重 = 成功史 + 1，等权退化 = 1）
        weight = 1
        if evidence_index:
            ev = evidence_index.get(key)
            if ev is not None:
                weight = getattr(ev, "success_count", 0) + 1
        delta = weight + (1 if tr is failed_tr else 0)
        updates.append(EdgeUpdate(key=key, kind=UPDATE_FAIL, cost=float(cost), delta=delta))
    return tuple(updates)


def should_propose(fail_count: int, success_count: int) -> bool:
    """失败点提案判据：同一失败点累计 N≥3 次或入边失败率>0.4。

    入边失败率判定须至少 2 个样本（单样本偶发失败不污染评审队列）。
    """
    if fail_count >= PROPOSAL_MIN_FAILS:
        return True
    n = fail_count + success_count
    if n < PROPOSAL_RATE_MIN_N:
        return False
    return fail_count / n > PROPOSAL_FAIL_RATE


def recommended_prior_eligible(success_count: int, fail_count: int) -> bool:
    """推荐先验晋升证据判据：N≥30 且成功率≥0.9（拉普拉斯口径）。

    与信任档推导式（转正档）同一组常数——纯算法自动晋升，零审批；
    路径级晋升 = 每条遍历边均达此线 + 闸门 + canary（见钩子）。
    """
    n = success_count + fail_count
    return n >= PROMOTION_MIN_N and laplace_success(success_count, fail_count) >= PROMOTION_MIN_P


def policy_edge_needs_review(
    evidence: Any, *, domain_average_p: float | None
) -> tuple[bool, str]:
    """策略边对抗复审判据：失败累计≥5，或所在域证据均值反超其承诺。

    - 失败累计超阈值（默认 5 次）：对抗证据直接触发；
    - 域证据均值反超：该策略边成功率低于同域非策略边均值——普通统计
      边已比「人工堤坝」更可靠，承诺失去优先依据；
    - domain_average_p 为 None（非策略边样本不足）= 只按失败累计判定。
    返回 (是否复审, 原因)；复审动作（L2 提请 + 降级）由钩子执行。
    """
    if not getattr(evidence, "policy", False):
        return False, ""
    if evidence.fail_count >= POLICY_REVIEW_FAIL_THRESHOLD:
        return (
            True,
            f"策略边失败累计 {evidence.fail_count} 次"
            f" ≥ 阈值 {POLICY_REVIEW_FAIL_THRESHOLD}（对抗证据触发复审）",
        )
    if domain_average_p is not None:
        p = laplace_success(evidence.success_count, evidence.fail_count)
        if p < domain_average_p:
            return (
                True,
                f"策略边成功率 {p:.2f} 低于域证据均值 {domain_average_p:.2f}"
                "（域均值反超承诺，触发复审）",
            )
    return False, ""


def draft_node_contract(
    node_type: str,
    *,
    consumes: Sequence[str] = (),
    produces: Sequence[str] = (),
    note: str = "",
) -> dict[str, Any]:
    """失败点契约草案生成（纯函数）：从字段缺口反推输入/输出契约。

    草案 = schema 声明（SchemaSpec 数据形态）而非代码——评审走宿主
    vetting，转正后才进结点池。consumes = 缺失的输入字段，produces =
    应产出的字段；字段名去重保序，缺省 type=string/required=True
    （草案语义：缺口字段必填）。
    """
    input_fields = tuple(
        SchemaField(name=name, required=True, kind="string")
        for name in dict.fromkeys(consumes)
    )
    output_fields = tuple(
        SchemaField(name=name, required=True, kind="string")
        for name in dict.fromkeys(produces)
    )
    draft: dict[str, Any] = {
        "node_type": node_type,
        "input_schema": SchemaSpec(
            name=f"{node_type}.input", fields=input_fields
        ).to_dict(),
        "output_schema": SchemaSpec(
            name=f"{node_type}.output", fields=output_fields
        ).to_dict(),
    }
    if note:
        draft["note"] = note
    return draft


@runtime_checkable
class SettleHook(Protocol):
    """沉淀钩子接口（注册式扩展；失败仅记日志不阻断主流程）。"""

    async def settle(self, ctx: SettleContext) -> None: ...


class SettleHooks:
    """沉淀钩子注册体（引擎 run 收尾触发；可单块关闭 = 不注册即关闭）。

    钩子按注册序执行；单个钩子异常 = 记录日志跳过（观测不影响执行
    ——沉淀失败不得污染 run 结果）。
    """

    def __init__(self) -> None:
        self._hooks: list[SettleHook] = []

    def register(self, hook: SettleHook) -> None:
        if not isinstance(hook, SettleHook):
            raise TypeError(f"沉淀钩子须实现 SettleHook 协议: {type(hook).__name__}")
        self._hooks.append(hook)

    @property
    def hooks(self) -> tuple[SettleHook, ...]:
        return tuple(self._hooks)

    async def run(self, ctx: SettleContext) -> tuple[Exception, ...]:
        """触发全部钩子（返回收集的异常清单；不向调用方抛出）。"""
        errors: list[Exception] = []
        for hook in self._hooks:
            try:
                await hook.settle(ctx)
            except Exception as exc:  # 沉淀失败不阻断执行
                logger.warning(
                    f"沉淀钩子失败（忽略）[{type(hook).__name__}] trace={ctx.trace_id}: {exc}"
                )
                errors.append(exc)
        return tuple(errors)


class EdgeEvidenceSettleHook:
    """归因钩子：轨迹回放 → 按归因规则逐边更新边证据（纯算法）。

    零 LLM：成败/成本/轮次全部自动归集；本钩子不产出任何决策。
    """

    def __init__(self, store: EdgeEvidenceStore) -> None:
        self._store = store

    async def settle(self, ctx: SettleContext) -> None:
        evidence_index = None
        if ctx.steps and any(s.status == TRACE_FAILED for s in ctx.steps):
            evidence_index = {}
            for tr in derive_traversals(ctx):
                key = EdgeKey(
                    src_type=tr.src_type,
                    dst_type=tr.dst_type,
                    src_contract_version=tr.src_contract_version,
                    dst_contract_version=tr.dst_contract_version,
                    context_domain=ctx.domain,
                    variant_hash=tr.dst_variant_hash,
                )
                evidence_index[key] = await self._store.get(key)
        for update in attribution_plan(ctx, evidence_index=evidence_index):
            if update.kind == UPDATE_SUCCESS:
                await self._store.record_success(
                    update.key, cost=update.cost, delta=update.delta
                )
            else:
                await self._store.record_failure(
                    update.key, cost=update.cost, delta=update.delta
                )


class FailureAuditSettleHook:
    """失败日志留痕审计（append-only：记录只增不删，可长期追溯）。

    登记形态为内存清单 + 可选落库回调（宿主注入）；本钩子只记录
    失败事实，不做任何后续动作。
    """

    def __init__(
        self, sink: Callable[[dict[str, Any]], Any] | None = None
    ) -> None:
        self.records: list[dict[str, Any]] = []
        self._sink = sink

    async def settle(self, ctx: SettleContext) -> None:
        ts = time.time()
        for step in ctx.steps:
            if step.status != TRACE_FAILED:
                continue
            record: dict[str, Any] = {
                "ts": ts,
                "thread_id": ctx.thread_id,
                "round_id": ctx.round_id or "",
                "trace_id": ctx.trace_id,
                "domain": ctx.domain,
                "node": step.node,
                "graph_path": list(step.graph_path),
                "reason": ctx.result.error or "节点执行失败",
            }
            self.records.append(record)
            if self._sink is not None:
                self._sink(record)


@runtime_checkable
class QualityGate(Protocol):
    """产出质量闸门（窄协议，随组装请求注入；宿主按域提供判定）。

    无闸门注入 = fail-closed 不入缓存（高质量归纳前提不满足）。
    """

    async def evaluate(self, ctx: SettleContext) -> bool: ...


@runtime_checkable
class FingerprintCache(Protocol):
    """指纹缓存接口（接口先行；缓存本体与顶替机制后置）。

    ``fingerprint`` = 缓存主键：注入上下文指纹（组装请求侧纯函数产出）
    时与查找侧键一致；未注入时退化为图摘要（旧调用形态向后兼容）。
    ``path_fingerprint`` = 路径图指纹（Graph.digest）；``domain`` = 上下文
    域（容量淘汰按域分组）。两键为可选扩展参数，既有实现零破坏。
    """

    async def upsert(
        self,
        fingerprint: str,
        *,
        path: dict[str, Any],
        evidence_snapshot: list[dict[str, Any]],
        model_id: str,
        gate_passed: bool,
        path_fingerprint: str = "",
        domain: str = "",
    ) -> None: ...


class FingerprintSettleHook:
    """成功组合 → 指纹缓存 upsert（接口先行；缓存本体后置）。

    fail-closed：未注入缓存或未注入质量闸门 = 不入缓存；闸门结论只
    记录布尔值（闸门评估发生在执行期宿主侧，本钩子零 LLM）。注入
    ``context_fingerprint``（组装请求侧纯函数产出）时以之为缓存主键，
    与组装查找侧键一致——未注入保持旧形态（图摘要作键，向后兼容）。
    """

    def __init__(
        self,
        cache: FingerprintCache | None = None,
        gate: QualityGate | None = None,
        store: EdgeEvidenceStore | None = None,
        *,
        model_id: str = "",
        context_fingerprint: str | Callable[[], str | None] | None = None,
    ) -> None:
        self._cache = cache
        self._gate = gate
        self._store = store
        self._model_id = model_id
        self._context_fingerprint = context_fingerprint
        # 本次 run 是否尝试了入库（供测试断言 fail-closed 语义）
        self.attempts: list[dict[str, Any]] = []

    def _resolve_fingerprint(self) -> str | None:
        """解析缓存主键：静态字符串直取；callable 惰性求值（生产装配
        读取组装运行期最近一次请求指纹——写入键与组装查找键同空间）。
        """
        value = self._context_fingerprint
        if callable(value):
            try:
                value = value()
            except Exception:
                return None
        return str(value) if value else None

    async def settle(self, ctx: SettleContext) -> None:
        if self._cache is None or self._gate is None:
            return  # 无闸门/无缓存 = fail-closed 不入缓存
        if any(s.status == TRACE_FAILED for s in ctx.steps):
            return
        top = ctx.graphs.get(())
        if top is None:
            return
        gate_passed = bool(await self._gate.evaluate(ctx))
        record = {"fingerprint": top.digest(), "gate_passed": gate_passed}
        self.attempts.append(record)
        if not gate_passed:
            return
        snapshot: list[dict[str, Any]] = []
        if self._store is not None:
            snapshot = [e.to_dict() for e in await self._store.list_edges(ctx.domain)]
        # 路径数据 = 图定义序列化；直挂函数图不可序列化时退化携带指纹
        # （缓存体只读身份，指纹即身份）
        try:
            path_data = top.to_dict()
        except GraphDefinitionError:
            path_data = {"fingerprint": top.digest()}
        # 缓存主键：注入上下文指纹（静态或 callable）时与组装查找侧一致；
        # 未注入退化为图摘要（向后兼容）。注入但解析失败 = 写入键不可得
        # 的 fail-closed——不降级图摘要（降级会写进错误键空间污染缓存）
        resolved = self._resolve_fingerprint()
        if self._context_fingerprint is not None and resolved is None:
            return
        key = resolved or top.digest()
        await self._cache.upsert(
            key,
            path=path_data,
            evidence_snapshot=snapshot,
            model_id=self._model_id,
            gate_passed=True,
            path_fingerprint=top.digest(),
            domain=ctx.domain,
        )


class NodeProposalSettleHook:
    """失败点 → 新结点提案（契约草案，非代码；评审走宿主 vetting）。

    判据（同一失败点累计 N≥3 次或入边失败率>0.4）读边证据的历史
    统计；提案 = 登记记录（内存清单 + 可选回调），不执行任何决策。
    """

    def __init__(
        self,
        store: EdgeEvidenceStore,
        proposal_sink: Callable[[dict[str, Any]], Any] | None = None,
    ) -> None:
        self._store = store
        self._sink = proposal_sink
        self.proposals: list[dict[str, Any]] = []

    async def settle(self, ctx: SettleContext) -> None:
        category = classify_failure(ctx.result.error)
        # 失败分类分流：仅能力缺口类（model / unknown）才提案，环境/
        # 配置类（permission/validation/network）不污染评审队列
        if category not in CAPABILITY_GAP_CATEGORIES:
            return
        for tr in derive_traversals(ctx):
            if tr.dst.status != TRACE_FAILED:
                continue
            key = EdgeKey(
                src_type=tr.src_type,
                dst_type=tr.dst_type,
                src_contract_version=tr.src_contract_version,
                dst_contract_version=tr.dst_contract_version,
                context_domain=ctx.domain,
                variant_hash=tr.dst_variant_hash,
            )
            evidence = await self._store.get(key)
            fail = evidence.fail_count if evidence is not None else 1
            success = evidence.success_count if evidence is not None else 0
            if not should_propose(fail, success):
                continue
            draft = draft_node_contract(
                tr.dst_type,
                note=f"失败点提案：入边 {tr.src_type}→{tr.dst_type} "
                f"失败 {fail} 次 / 成功 {success} 次（域 {ctx.domain}）",
            )
            record = {
                **draft,
                "src_type": tr.src_type,
                "domain": ctx.domain,
                "failure_category": category,
                "trace_id": ctx.trace_id,
                "ts": time.time(),
            }
            self.proposals.append(record)
            if self._sink is not None:
                self._sink(record)


async def import_seed_paths(store: EdgeEvidenceStore, seed_edges: Sequence[dict]) -> int:
    """种子路径导入（出厂资产通道只供数据）：边证据初始化。

    复用 :func:`~ink_engine.core.edge_evidence.import_seed_paths`，
    本层为沉淀侧的统一入口形态。
    """
    return await _import_seed_paths(store, seed_edges)


class RecommendedPriorSettleHook:
    """推荐先验自动晋升钩子（高强度证据路径 → 晋升登记 + 审计留痕）。

    判据（与信任档推导同一组常数）：路径全通（成功归因）+ 每条遍历边
    N≥30 且成功率≥0.9 + 注入的 QualityGate 通过 + canary 通过——自动
    晋升为「推荐先验」（workflow 同等的组装先验待遇），**晋升不需人工
    拍板**；登记 = 推荐先验记录（随审计 append-only），供组装先验消费。
    缺闸门注入 = fail-closed 不晋升（高质量归纳前提不满足）；零 LLM。
    """

    def __init__(
        self,
        store: EdgeEvidenceStore,
        gate: QualityGate | None = None,
        *,
        canary_ok: Callable[[SettleContext], bool] | None = None,
        sink: Callable[[dict[str, Any]], Any] | None = None,
        model_id: str = "",
        persisted_signatures: set[tuple[str, ...]] | None = None,
        on_promoted: Callable[[tuple[str, ...]], Any] | None = None,
    ) -> None:
        self._store = store
        self._gate = gate
        self._canary_ok = canary_ok
        self._sink = sink
        self._model_id = model_id
        self.promotions: list[dict[str, Any]] = []
        # 已晋升路径签名（去重：同一路径不重复登记）。
        # 持久化语义（ENG1-18）：进程内存集重启即丢——旧实现重启后同一
        # 路径会重复登记晋升（审计重复）。现支持：
        # - persisted_signatures：装配期从持久化去重键恢复（宿主从审计
        #   记录回读 signature 字段）；
        # - on_promoted：每次新晋升签名回调（宿主幂等 upsert 去重键，
        #   重启后经 persisted_signatures 恢复）。
        self._promoted: set[tuple[str, ...]] = set(persisted_signatures or ())
        self._on_promoted = on_promoted

    async def settle(self, ctx: SettleContext) -> None:
        if self._gate is None:
            return  # 无闸门 = fail-closed 不晋升
        if run_verdict(ctx) != UPDATE_SUCCESS:
            return
        traversals = derive_traversals(ctx)
        if not traversals:
            return
        keys = tuple(
            dict.fromkeys(
                EdgeKey(
                    src_type=tr.src_type,
                    dst_type=tr.dst_type,
                    src_contract_version=tr.src_contract_version,
                    dst_contract_version=tr.dst_contract_version,
                    context_domain=ctx.domain,
                    variant_hash=tr.dst_variant_hash,
                )
                for tr in traversals
            )
        )
        rows = [await self._store.get(key) for key in keys]
        if any(
            row is None
            or not recommended_prior_eligible(row.success_count, row.fail_count)
            for row in rows
        ):
            return
        if self._canary_ok is not None and not self._canary_ok(ctx):
            return
        gate_passed = bool(await self._gate.evaluate(ctx))
        if not gate_passed:
            return
        signature = tuple(sorted(k.key() for k in keys))
        if signature in self._promoted:
            return
        self._promoted.add(signature)
        if self._on_promoted is not None:
            try:
                self._on_promoted(signature)
            except Exception as exc:
                logger.warning(f"晋升去重键持久化失败（忽略）: {exc}")
        record: dict[str, Any] = {
            "type": EVENT_AUDIT_PROMOTION,
            "ts": time.time(),
            "domain": ctx.domain,
            "edges": [k.to_dict() for k in keys],
            "evidence": [e.to_dict() for e in rows],
            "gate_passed": gate_passed,
            "model_id": self._model_id,
            "trace_id": ctx.trace_id,
            # 去重键（宿主幂等 upsert 依据：重启后经 persisted_signatures
            # 恢复，杜绝重复晋升登记——ENG1-18）
            "signature": list(signature),
        }
        self.promotions.append(record)
        if self._sink is not None:
            self._sink(record)


class PoolGovernanceSettleHook:
    """池治理登记钩子：把 PoolGovernance 挂入 settle 钩子链（只登记不执行）。

    钩子本身不在 settle 路径做治理判定——治理判定由桥 op 触发
    （pool.snapshot 读快照、pool.evaluate 判定提案）。本钩子只把
    PoolGovernance 登记器注册进钩子链，使运行时持有可观测的治理状态。
    """

    def __init__(self, governance: Any) -> None:
        self._governance = governance

    @property
    def governance(self) -> Any:
        return self._governance

    async def settle(self, ctx: SettleContext) -> None:
        # 沉淀路径不做治理判定（纯登记模块由桥 op 触发）；钩子占位
        # 使运行时持有治理登记器可观测
        pass


class PolicyEdgeReviewSettleHook:
    """策略边对抗复审钩子（对抗证据 → 自动提请 L2 复审 + 复审前降级）。

    判据（评审文档第十三节坑六）：策略边失败累计≥5，或所在域非策略边证据均值
    反超其承诺 → 自动提请人工复审（L2 审批）并把该边降级为普通统计边
    （复审前不再享受 τ=1.0/豁免时间衰减的先验待遇）。零 LLM：复审请求
    经审计事件（policy_edge_review_audit）留痕，审批裁决归宿主通道。

    增量 + 限频（ENG1-9）：旧实现每 run 全量 ``list_edges`` + O(N) 遍历。
    现改为——
    - **增量面**：只评估本 run 触达的策略边（对抗证据来自被触达边的
      失败累积，未触达边不重复全量扫描）；
    - **限频面**：域证据均值（非策略边全量扫描）带缓存，每
      ``scan_interval`` 次触发评估重算一次（均值随证据缓慢变化，适度
      陈旧不影响「失败累计」主判据）。
    """

    def __init__(
        self,
        store: EdgeEvidenceStore,
        *,
        sink: Callable[[dict[str, Any]], Any] | None = None,
        scan_interval: int = 10,
    ) -> None:
        self._store = store
        self._sink = sink
        self._scan_interval = max(1, scan_interval)
        self.reviews: list[dict[str, Any]] = []
        # 已降级边签名（去重：降级后不再重复提请）
        self._downgraded: set[tuple[str, ...]] = set()
        # 域证据均值限频缓存（domain → 均值；重算间隔 = scan_interval）
        self._domain_average_cache: dict[str, float] = {}
        self._runs_since_refresh: dict[str, int] = {}

    async def _touched_policy_edges(self, ctx: SettleContext) -> list[EdgeEvidence]:
        """本 run 触达的策略边（增量评估面，按边主键去重）。"""
        seen: set[tuple[str, ...]] = set()
        touched: list[EdgeEvidence] = []
        for tr in derive_traversals(ctx):
            key = EdgeKey(
                src_type=tr.src_type,
                dst_type=tr.dst_type,
                src_contract_version=tr.src_contract_version,
                dst_contract_version=tr.dst_contract_version,
                context_domain=ctx.domain,
                variant_hash=tr.dst_variant_hash,
            )
            if key.key() in seen:
                continue
            seen.add(key.key())
            edge = await self._store.get(key)
            if edge is not None and edge.policy:
                touched.append(edge)
        return touched

    async def _domain_average(self, domain: str) -> float | None:
        """域证据均值（限频缓存：每 scan_interval 次评估重算一次）。"""
        runs = self._runs_since_refresh.get(domain, 0)
        cached = self._domain_average_cache.get(domain)
        if cached is not None and runs < self._scan_interval:
            self._runs_since_refresh[domain] = runs + 1
            return cached
        non_policy = [
            e for e in await self._store.list_edges(domain) if not e.policy
        ]
        self._runs_since_refresh[domain] = 1
        if len(non_policy) < POLICY_REVIEW_DOMAIN_MIN_EDGES:
            self._domain_average_cache.pop(domain, None)
            return None
        avg = sum(
            laplace_success(e.success_count, e.fail_count) for e in non_policy
        ) / len(non_policy)
        self._domain_average_cache[domain] = avg
        return avg

    async def settle(self, ctx: SettleContext) -> None:
        touched = await self._touched_policy_edges(ctx)
        if not touched:
            return  # 增量：本 run 未触达策略边 = 无复审需求，零全量扫描
        domain_average_p = await self._domain_average(ctx.domain)
        for edge in touched:
            needs, reason = policy_edge_needs_review(
                edge, domain_average_p=domain_average_p
            )
            if not needs:
                continue
            signature = edge.key.key()
            if signature in self._downgraded:
                continue
            self._downgraded.add(signature)
            # 复审前降级为普通统计边（policy=False：不再 τ=1.0/豁免衰减）
            await self._store.put(
                EdgeEvidence(
                    key=edge.key,
                    success_count=edge.success_count,
                    fail_count=edge.fail_count,
                    avg_cost=edge.avg_cost,
                    policy=False,
                    last_used_at=edge.last_used_at,
                    created_at=edge.created_at,
                )
            )
            record: dict[str, Any] = {
                "type": EVENT_AUDIT_POLICY_REVIEW,
                "ts": time.time(),
                "domain": ctx.domain,
                "src_type": edge.src_type,
                "dst_type": edge.dst_type,
                "reason": reason,
                "action": "downgraded_to_statistical",
                "review_tier": "l2",
                "trace_id": ctx.trace_id,
            }
            self.reviews.append(record)
            if self._sink is not None:
                self._sink(record)


__all__ = [
    "DEFAULT_DOMAIN",
    "POLICY_REVIEW_DOMAIN_MIN_EDGES",
    "POLICY_REVIEW_FAIL_THRESHOLD",
    "PROMOTION_MIN_N",
    "PROMOTION_MIN_P",
    "PROPOSAL_FAIL_RATE",
    "PROPOSAL_MIN_FAILS",
    "PROPOSAL_RATE_MIN_N",
    "TRACE_FAILED",
    "TRACE_SKIPPED",
    "TRACE_SUCCESS",
    "UPDATE_FAIL",
    "UPDATE_SUCCESS",
    "EdgeEvidenceSettleHook",
    "EdgeUpdate",
    "FailureAuditSettleHook",
    "FingerprintCache",
    "FingerprintSettleHook",
    "NodeProposalSettleHook",
    "PolicyEdgeReviewSettleHook",
    "PoolGovernanceSettleHook",
    "QualityGate",
    "RecommendedPriorSettleHook",
    "SettleContext",
    "SettleHook",
    "SettleHooks",
    "TraceStep",
    "Traversal",
    "attribution_plan",
    "derive_traversals",
    "draft_node_contract",
    "import_seed_paths",
    "node_identity",
    "policy_edge_needs_review",
    "recommended_prior_eligible",
    "run_verdict",
    "should_propose",
]
