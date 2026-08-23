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
    EdgeEvidenceStore,
    EdgeKey,
)
from .edge_evidence import (
    import_seed_paths as _import_seed_paths,
)
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

# 归因更新种类（声明式枚举）
UPDATE_SUCCESS = "success"
UPDATE_FAIL = "fail"

# 默认上下文域（未注入域时的登记归属）
DEFAULT_DOMAIN = "default"


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


@dataclass(frozen=True, slots=True)
class EdgeUpdate:
    """归因更新计划（纯数据：成败 + 成本；由存储钩子逐条落库）。"""

    key: EdgeKey
    kind: str  # UPDATE_SUCCESS / UPDATE_FAIL
    cost: float


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


def node_identity(graph: Graph | None, node: str) -> tuple[str, str]:
    """结点 → (类型名, 契约版本)：声明式绑定取注册类型与配置内版本，
    直挂函数取结点名 + 缺省版本（类型即身份，版本入键）。"""
    if graph is None:
        return node, DEFAULT_CONTRACT_VERSION
    binding = graph.node_bindings.get(node)
    if binding is not None:
        config = binding.config if isinstance(binding.config, dict) else {}
        version = str(config.get("contract_version", DEFAULT_CONTRACT_VERSION))
        return binding.type_name, version
    return node, DEFAULT_CONTRACT_VERSION


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
            src_type, src_version = node_identity(graph, prev.node)
            dst_type, dst_version = node_identity(graph, cur.node)
            traversals.append(
                Traversal(
                    graph_path=path,
                    src=prev,
                    dst=cur,
                    src_type=src_type,
                    dst_type=dst_type,
                    src_contract_version=src_version,
                    dst_contract_version=dst_version,
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


def attribution_plan(ctx: SettleContext) -> tuple[EdgeUpdate, ...]:
    """归因计划（纯函数）：按归因规则逐边生成更新，不落库。

    - 失败归因：只记失败结点的入边 ``fail+1``，上游边中性不记；
    - 成功归因：全部遍历边 ``success+1``；
    - 成本每次执行归集：目标结点执行边界 token 计账随归因携带。
    """
    verdict = run_verdict(ctx)
    if verdict not in (UPDATE_SUCCESS, UPDATE_FAIL):
        return ()
    updates: list[EdgeUpdate] = []
    for tr in derive_traversals(ctx):
        if verdict == UPDATE_FAIL and tr.dst.status != TRACE_FAILED:
            continue
        cost = ctx.node_tokens.get((tr.dst.graph_path, tr.dst.node), 0)
        updates.append(
            EdgeUpdate(
                key=EdgeKey(
                    src_type=tr.src_type,
                    dst_type=tr.dst_type,
                    src_contract_version=tr.src_contract_version,
                    dst_contract_version=tr.dst_contract_version,
                    context_domain=ctx.domain,
                ),
                kind=verdict,
                cost=float(cost),
            )
        )
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
        for update in attribution_plan(ctx):
            if update.kind == UPDATE_SUCCESS:
                await self._store.record_success(update.key, cost=update.cost)
            else:
                await self._store.record_failure(update.key, cost=update.cost)


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
    """指纹缓存接口（接口先行；缓存本体与顶替机制后置）。"""

    async def upsert(
        self,
        fingerprint: str,
        *,
        path: dict[str, Any],
        evidence_snapshot: list[dict[str, Any]],
        model_id: str,
        gate_passed: bool,
    ) -> None: ...


class FingerprintSettleHook:
    """成功组合 → 指纹缓存 upsert（接口先行；缓存本体后置）。

    fail-closed：未注入缓存或未注入质量闸门 = 不入缓存；闸门结论只
    记录布尔值（闸门评估发生在执行期宿主侧，本钩子零 LLM）。
    """

    def __init__(
        self,
        cache: FingerprintCache | None = None,
        gate: QualityGate | None = None,
        store: EdgeEvidenceStore | None = None,
        *,
        model_id: str = "",
    ) -> None:
        self._cache = cache
        self._gate = gate
        self._store = store
        self._model_id = model_id
        # 本次 run 是否尝试了入库（供测试断言 fail-closed 语义）
        self.attempts: list[dict[str, Any]] = []

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
        await self._cache.upsert(
            top.digest(),
            path=path_data,
            evidence_snapshot=snapshot,
            model_id=self._model_id,
            gate_passed=True,
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
        for tr in derive_traversals(ctx):
            if tr.dst.status != TRACE_FAILED:
                continue
            key = EdgeKey(
                src_type=tr.src_type,
                dst_type=tr.dst_type,
                src_contract_version=tr.src_contract_version,
                dst_contract_version=tr.dst_contract_version,
                context_domain=ctx.domain,
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


__all__ = [
    "DEFAULT_DOMAIN",
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
    "QualityGate",
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
    "run_verdict",
    "should_propose",
]
