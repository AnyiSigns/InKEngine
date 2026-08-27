"""多径执行与汇流裁决（候选路径并行执行 → Junction 收口 → 证据回写）。

机制职责（与组装器分工）：组装器出候选（1..k 条图定义数据），本模块
把这些候选**执行**并裁决——输入 = 候选集 + 组装请求（安全档/质量闸门/
草稿合成源）+ 预算信封；默认 k=2（1 主 + 1 探），k=3 仅高风险任务
（组装请求 ``max_safety_tier ≥ 1``）放行。

执行形态（与既有子链执行同构——决策探测与执行并行分属两个配额域，
多径分支**不占用**决策探测配额，其预算约束由本模块的预算预检单独
执行）：

- 每条候选 = 独立子引擎执行（入口状态自包含）；
- checkpoint 独立子链：``{父thread}:multipath:{index}``（可单独回放/
  回溯/换选）；事件统一落父链（graph_path 归属 ``("multipath", index)``）；
- 中断语义继承既有行为：分支内中断提升为调用方挂起卡（checkpoint
  保留、已跑支流轨迹保留可回溯/换选），恢复即从各自链尾续跑——
  不另设第二套中断语义。

汇流裁决（Junction）：
- 同构输出（各支产出同类结果）：纯算法择优——质量闸门过者胜
  （无闸门 → 降级比信任档 → 再比成本，证据均值推导档同源边证据公式）；
- 异构输出：LLM 合成（合成源由使用方注入模板与调用方式；无源降级
  信任档裁决）；
- 无论胜负：胜者边成功 +1，败者/失败支流只记入边失败 +1（归因规则；
  成功才全边成功——失败只在失败结点入边记负样例）；
- 裁决理由入审计（junction 审计事件类型由事件注册表登记，本模块
  只产出记录不落库）。

机制开关（默认全关）：:class:`MultiPathConfig`，由装配入口按壳侧
透传键（``path_assembly_multipath_enabled``）读取构造；关闭时本模块
全部入口零生效（不触发、不执行、不写证据、不留审计）。
"""
from __future__ import annotations

import asyncio
import inspect
import itertools
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

from .budget import BudgetRemaining
from .contracts import PathAssemblyFlags, QualityGate
from .edge_evidence import (
    DEFAULT_CONTRACT_VERSION,
    TIER_OBSERVING,
    TIER_PROMOTED,
    TIER_REGULAR,
    EdgeEvidence,
    EdgeEvidenceStore,
    EdgeKey,
    derive_edge_tier,
)
from .event_types import EVENT_AUDIT_JUNCTION
from .exceptions import GraphDefinitionError
from .fanout import fan_out
from .graph import TerminateReason
from .interrupt import InterruptSignal
from .link_validator import produced_field_names
from .logging import get_logger
from .path_assembler import AssemblyCandidate, AssemblyRequest
from .recovery import tail_checkpoint
from .state import subgraph_overlay_delta

if TYPE_CHECKING:
    from .executor import Engine
    from .registry import NodeTypeRegistry

logger = get_logger(__name__)

# ── 多径执行默认参数（引擎钉死；使用方仅覆盖权）────────────────────
DEFAULT_MULTIPATH_K = 2  # 默认 k（1 主 + 1 探）
MAX_MULTIPATH_K = 3  # k 上界（k=3 仅高风险任务）
HIGH_RISK_SAFETY_TIER = 1  # 高风险判定线：max_safety_tier ≥ 1 才放行 k=3
DEFAULT_SHARED_RHO = 0.3  # 共享折扣默认值（共同前缀命中 = 边际成本趋低）
RHO_MIN = 0.2  # 共享折扣下界（前缀命中理想情形）
RHO_MAX = 1.0  # 共享折扣上界（无缓存 = 全边际成本）
DEFAULT_MULTIPATH_CONCURRENCY = 2  # 支流并发上限（fan_out 限流）

# 汇流裁决模式（声明式枚举，防魔法字符串）
MODE_QUALITY_GATE = "quality_gate"
MODE_TIER = "tier"
MODE_COST = "cost"
MODE_SYNTHETIC = "synthetic"
MODE_NONE = "none"

# 证据更新种类（与沉淀侧同一套枚举语义）
UPDATE_SUCCESS = "success"
UPDATE_FAIL = "fail"

# Junction 节点类型（注册表内建类型名；装配开关关闭时不注册 = 不参与执行）
JUNCTION_TYPE = "junction"

# 多径展开保留键（组装编排节点 → 执行入口的状态通道保留键；与
# __spawn__/__plan__/__simulate__ 同语义：弹出后不落状态/checkpoint）
MULTIPATH_KEY = "__multipath__"

# Junction 节点与执行体的状态通道保留键（数据形态：可序列化落库）
JUNCTION_BRANCHES_STATE_KEY = "multipath.branches"
JUNCTION_VERDICT_STATE_KEY = "multipath.verdict"

# 默认上下文域（与组装/沉淀侧同一常数）
DEFAULT_DOMAIN = "default"

# 信任档序（裁决档位序：观察 < 常规 < 转正；与评分公式 τ 档同阶）
_TIER_RANK = {TIER_OBSERVING: 0, TIER_REGULAR: 1, TIER_PROMOTED: 2}


def tier_rank(tier: str) -> int:
    """信任档序（裁决排序键：越高越优）。"""
    return _TIER_RANK.get(tier, 0)


@dataclass(frozen=True, slots=True)
class MultiPathConfig:
    """多径机制装配配置（默认全关；读取形态与既有装配配置一致）。

    Attributes:
        enabled: 机制入口开关（False = 不触发/不执行/零生效）。
        default_k: 默认径数。
        max_k: 径数上界（k=3 仅高风险任务放行，见 HIGH_RISK_SAFETY_TIER）。
        shared_rho: 共享折扣（多径成本核算的边际成本系数；见
            :func:`multipath_budget_required`）。
        concurrency: 支流并发上限。
    """

    enabled: bool = False
    default_k: int = DEFAULT_MULTIPATH_K
    max_k: int = MAX_MULTIPATH_K
    shared_rho: float = DEFAULT_SHARED_RHO
    concurrency: int = DEFAULT_MULTIPATH_CONCURRENCY

    def __post_init__(self) -> None:
        if isinstance(self.default_k, bool) or not isinstance(self.default_k, int):
            raise GraphDefinitionError(f"径数须为整数: {self.default_k!r}")
        if isinstance(self.max_k, bool) or not isinstance(self.max_k, int):
            raise GraphDefinitionError(f"径数上界须为整数: {self.max_k!r}")
        if self.default_k < 1 or self.max_k < 1 or self.default_k > self.max_k:
            raise GraphDefinitionError(
                f"径数配置非法: default_k={self.default_k} max_k={self.max_k}"
            )
        if not RHO_MIN <= self.shared_rho <= RHO_MAX:
            raise GraphDefinitionError(
                f"共享折扣越界: {self.shared_rho}（须在 [{RHO_MIN}, {RHO_MAX}]）"
            )
        if isinstance(self.concurrency, bool) or self.concurrency < 1:
            raise GraphDefinitionError(
                f"支流并发上限须为正整数: {self.concurrency!r}"
            )

    def to_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "default_k": self.default_k,
            "max_k": self.max_k,
            "shared_rho": self.shared_rho,
            "concurrency": self.concurrency,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> MultiPathConfig:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"多径配置声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        return cls(
            enabled=bool(data.get("enabled", False)),
            default_k=int(data.get("default_k", DEFAULT_MULTIPATH_K)),
            max_k=int(data.get("max_k", MAX_MULTIPATH_K)),
            shared_rho=float(data.get("shared_rho", DEFAULT_SHARED_RHO)),
            concurrency=int(data.get("concurrency", DEFAULT_MULTIPATH_CONCURRENCY)),
        )


def multipath_config_from_flags(flags: PathAssemblyFlags) -> MultiPathConfig:
    """装配入口接线：壳侧透传键 → 多径机制开关（缺省全关）。"""
    return MultiPathConfig(enabled=flags.multipath_enabled)


# ── 成本核算与预算预检（fail-closed 引擎强制）─────────────────────

def multipath_budget_required(
    base_cost: float, k: int, *, rho: float = DEFAULT_SHARED_RHO
) -> float:
    """多径预算需求核算：``B × (1 + (k-1) × ρ)``。

    B = 单径成本基准（主候选链的证据成本核算），ρ = 共享折扣
    （共同前缀命中时边际成本趋低；无缓存 ρ=1.0 = 全边际成本）。
    """
    if base_cost < 0 or k < 1:
        return 0.0
    return base_cost * (1.0 + (k - 1) * rho)


def check_multipath_budget(
    remaining: Sequence[BudgetRemaining],
    base_cost: float,
    k: int,
    *,
    rho: float = DEFAULT_SHARED_RHO,
) -> tuple[bool, str]:
    """预算预检（fail-closed）：够付才放行多径触发。

    - 未启用预算语义（无维度）→ 放行（无预算约束可言）；
    - 任一维度余量不可确定（查询故障，fail-closed 视为 0）→ 拒绝；
    - 否则需求 ≤ 各维度最小余量才放行；不足 → 拒绝（调用方降级单径）。
    """
    required = multipath_budget_required(base_cost, k, rho=rho)
    if not remaining:
        return True, "未启用预算语义（无预算维度），按可执行放行"
    if any(r.unavailable for r in remaining):
        return False, "预算余量不可确定（查询故障），预检拒绝"
    minimal = min(r.remaining for r in remaining)
    if required <= minimal:
        return True, f"预算预检通过（需 {required:.2f} ≤ 余量 {minimal:.2f}）"
    return False, f"预算预检拒绝：需求 {required:.2f} > 余量 {minimal:.2f}"


# ── 候选链证据口径（支流边证据均值推导档的数据源）─────────────────

@dataclass(frozen=True, slots=True)
class ChainEvidence:
    """一条候选链的边证据聚合口径（纯算法；按域分组后逐链汇总）。

    Attributes:
        edges: 链内边数。
        evidenced: 有证据行命中的边数。
        success_total/fail_total: 命中行的成功/失败计数合计。
        cost_total: 命中行 avg_cost 合计（无证据边按 0 计）。
    """

    edges: int = 0
    evidenced: int = 0
    success_total: int = 0
    fail_total: int = 0
    cost_total: float = 0.0

    @property
    def mean_success(self) -> float:
        """支流边证据均值：成功计数均值（无命中行 = 0）。"""
        return self.success_total / self.edges if self.edges else 0.0

    @property
    def mean_fail(self) -> float:
        return self.fail_total / self.edges if self.edges else 0.0

    @property
    def mean_cost(self) -> float:
        """支流边证据均值：成本均值（无证据 = 0，裁决的成本对照口径）。"""
        return self.cost_total / self.edges if self.edges else 0.0

    @property
    def cost_estimate(self) -> float:
        """链路成本核算（单径成本基准 B 的数据源）。"""
        return self.cost_total

    @property
    def tier(self) -> str:
        """支流边证据均值推导档（derive_edge_tier 同源公式）。"""
        return derive_edge_tier(round(self.mean_success), round(self.mean_fail))


@dataclass(frozen=True, slots=True)
class EdgeRef:
    """链内一条边（类型 + 契约版本引用；证据入口键）。"""

    src: str
    dst: str
    src_version: str
    dst_version: str

    def evidence_key(self, domain: str) -> EdgeKey:
        return EdgeKey(
            src_type=self.src,
            dst_type=self.dst,
            src_contract_version=self.src_version,
            dst_contract_version=self.dst_version,
            context_domain=domain,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "src": self.src,
            "dst": self.dst,
            "src_version": self.src_version,
            "dst_version": self.dst_version,
        }


def chain_edge_refs(candidate: AssemblyCandidate) -> tuple[EdgeRef, ...]:
    """候选链 → 边引用列（契约版本取自绑定契约快照；缺省版本入键）。"""
    bindings = candidate.graph.node_bindings
    refs: list[EdgeRef] = []
    for src, dst in itertools.pairwise(candidate.chain):
        src_contract = bindings.get(src)
        dst_contract = bindings.get(dst)
        refs.append(
            EdgeRef(
                src=src,
                dst=dst,
                src_version=(
                    str(src_contract.contract.version)
                    if src_contract is not None and src_contract.contract is not None
                    else DEFAULT_CONTRACT_VERSION
                ),
                dst_version=(
                    str(dst_contract.contract.version)
                    if dst_contract is not None and dst_contract.contract is not None
                    else DEFAULT_CONTRACT_VERSION
                ),
            )
        )
    return tuple(refs)


def chain_terminal_fields(candidate: AssemblyCandidate) -> tuple[str, ...]:
    """候选链收尾结点产出字段集（同构判定口径）。"""
    if not candidate.chain:
        return ()
    binding = candidate.graph.node_bindings.get(candidate.chain[-1])
    contract = binding.contract if binding is not None else None
    if contract is None or contract.output_schema is None:
        return ()
    return tuple(sorted(produced_field_names(contract.output_schema)))


def chain_evidence(
    candidate: AssemblyCandidate,
    evidence_index: Mapping[tuple[str, str, str, str], EdgeEvidence],
) -> ChainEvidence:
    """候选链证据聚合（索引内一次枚举；无命中 = 零证据口径）。"""
    edges = 0
    evidenced = 0
    success = 0
    fail = 0
    cost = 0.0
    for ref in chain_edge_refs(candidate):
        edges += 1
        row = evidence_index.get(
            (ref.src, ref.dst, ref.src_version, ref.dst_version)
        )
        if row is None:
            continue
        evidenced += 1
        success += row.success_count
        fail += row.fail_count
        cost += row.avg_cost
    return ChainEvidence(
        edges=edges,
        evidenced=evidenced,
        success_total=success,
        fail_total=fail,
        cost_total=cost,
    )


def evidence_index_of(
    rows: Sequence[EdgeEvidence],
) -> dict[tuple[str, str, str, str], EdgeEvidence]:
    """域内证据行 → 内存索引（组装/裁决全程在内存中计分）。

    口径 = 类型级（variant_hash 空）：变体专属证据不参与类型级聚合，
    同类型对多变体行不互相覆盖（后写入行不再顶掉先写入行）。
    """
    return {
        (row.src_type, row.dst_type, row.key.src_contract_version,
         row.key.dst_contract_version): row
        for row in rows
        if not row.key.variant_hash
    }


# ── 汇流裁决（Junction）──────────────────────────────────────────

@dataclass(frozen=True, slots=True)
class JunctionBranch:
    """一条已完成执行的支流（裁决输入：产物 + 证据口径）。

    Attributes:
        index: 支流序号。
        chain: 主链类型名序列。
        overlay: 执行回流增量（产物镜像）。
        terminal_fields: 收尾结点产出字段集（同构判定口径）。
        edge_refs: 链内边引用列（证据入口）。
        evidence: 链级证据聚合（None = 零证据口径）。
        graph_path: 支流事件路径。
        description: 支流说明（留痕可读）。
    """

    index: int
    chain: tuple[str, ...]
    overlay: dict[str, Any]
    terminal_fields: tuple[str, ...] = ()
    edge_refs: tuple[EdgeRef, ...] = ()
    evidence: ChainEvidence | None = None
    graph_path: tuple[str, ...] = ()
    description: str = ""

    @property
    def tier(self) -> str:
        return self.evidence.tier if self.evidence is not None else TIER_OBSERVING

    @property
    def mean_cost(self) -> float:
        return self.evidence.mean_cost if self.evidence is not None else 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "chain": list(self.chain),
            "overlay": dict(self.overlay),
            "terminal_fields": list(self.terminal_fields),
            "graph_path": list(self.graph_path),
            "description": self.description,
            "evidence": (
                {
                    "edges": self.evidence.edges,
                    "evidenced": self.evidence.evidenced,
                    "success_total": self.evidence.success_total,
                    "fail_total": self.evidence.fail_total,
                    "cost_total": self.evidence.cost_total,
                    "tier": self.evidence.tier,
                }
                if self.evidence is not None
                else None
            ),
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> JunctionBranch:
        raw_evidence = data.get("evidence")
        evidence = None
        if isinstance(raw_evidence, dict):
            evidence = ChainEvidence(
                edges=int(raw_evidence.get("edges", 0)),
                evidenced=int(raw_evidence.get("evidenced", 0)),
                success_total=int(raw_evidence.get("success_total", 0)),
                fail_total=int(raw_evidence.get("fail_total", 0)),
                cost_total=float(raw_evidence.get("cost_total", 0.0)),
            )
        return cls(
            index=int(data.get("index", 0)),
            chain=tuple(data.get("chain") or ()),
            overlay=dict(data.get("overlay") or {}),
            terminal_fields=tuple(data.get("terminal_fields") or ()),
            edge_refs=tuple(
                EdgeRef(
                    src=str(e.get("src", "")),
                    dst=str(e.get("dst", "")),
                    src_version=str(e.get("src_version", DEFAULT_CONTRACT_VERSION)),
                    dst_version=str(e.get("dst_version", DEFAULT_CONTRACT_VERSION)),
                )
                for e in data.get("edge_refs") or ()
                if isinstance(e, dict)
            ),
            graph_path=tuple(data.get("graph_path") or ()),
            description=str(data.get("description", "")),
            evidence=evidence,
        )


@dataclass(frozen=True, slots=True)
class JunctionVerdict:
    """汇流裁决收口：胜者 + 汇流产物 + 裁决理由 + 证据更新计划。

    Attributes:
        mode: 裁决模式（quality_gate/tier/cost/synthetic/none）。
        homogeneous: 是否同构输出（各支产物同类结果）。
        winner: 胜者分支序号（synthetic/none = None）。
        selection: 汇流产物（胜者整体或合成产物；无裁决 = 空）。
        reasons: 裁决理由（可读可审计）。
        losers: 负样例分支序号（败者/失败支流）。
        provenance: 来源留痕（哪条支流的产物被选中）。
    """

    mode: str
    homogeneous: bool
    winner: int | None
    selection: dict[str, Any]
    reasons: tuple[str, ...] = ()
    losers: tuple[int, ...] = ()
    provenance: tuple[dict[str, Any], ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "homogeneous": self.homogeneous,
            "winner": self.winner,
            "selection": dict(self.selection),
            "reasons": list(self.reasons),
            "losers": list(self.losers),
            "provenance": [dict(p) for p in self.provenance],
        }


def branches_are_homogeneous(branches: Sequence[JunctionBranch]) -> bool:
    """同构判定：各支收尾结点产出字段集一致（不一致 = 异构）。"""
    if not branches:
        return True
    first = set(branches[0].terminal_fields)
    return all(set(b.terminal_fields) == first for b in branches)


def _tier_cost_order(branches: Sequence[JunctionBranch]) -> Sequence[JunctionBranch]:
    """信任档降序 → 成本升序 → 序号升序（确定性裁决序）。"""
    return tuple(
        sorted(branches, key=lambda b: (-tier_rank(b.tier), b.mean_cost, b.index))
    )


@runtime_checkable
class JunctionSynthProvider(Protocol):
    """异构输出合成源（使用方注入：模板/模型调用方式归使用方）。

    引擎只提供上下文数据（支流清单 + 域名 + 缺省指引）与合成调用的
    时机；返回 None = 本次放弃合成（调用方降级信任档裁决）。
    """

    async def synthesize(
        self, context: JunctionSynthContext
    ) -> dict[str, Any] | None: ...


@dataclass(frozen=True, slots=True)
class JunctionSynthContext:
    """合成上下文（结构化输入；提示词模板归使用方）。

    Attributes:
        domain: 上下文域。
        goal: 目标字段。
        branches: 支流摘要（索引/链/产物字段/证据档）。
        notes: 合成触发指引（异构/全败等状况说明）。
    """

    domain: str
    goal: tuple[str, ...]
    branches: tuple[JunctionBranch, ...]
    notes: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "domain": self.domain,
            "goal": list(self.goal),
            "branches": [b.to_dict() for b in self.branches],
            "notes": list(self.notes),
        }


@dataclass(frozen=True, slots=True)
class JunctionEvidenceUpdate:
    """汇流证据更新项（胜者边成功 / 败者入边失败；由调用方落库）。"""

    key: EdgeKey
    kind: str  # UPDATE_SUCCESS / UPDATE_FAIL

    def to_dict(self) -> dict[str, Any]:
        return {"key": self.key.to_dict(), "kind": self.kind}


async def junction_verdict(
    branches: Sequence[JunctionBranch],
    *,
    domain: str,
    goal: tuple[str, ...] = (),
    quality_gate: QualityGate | None = None,
    synth_provider: JunctionSynthProvider | None = None,
    now: float | None = None,
) -> JunctionVerdict:
    """汇流裁决核心：同构纯算法择优 / 异构合成；理由入审计留痕。

    同构择优链：质量闸门过者胜（无闸门或全部未过 → 降级比信任档 →
    比成本 → 序号，确定性序）；异构：合成源产出（无源 → 降级信任档）。
    """

    async def gate_passed(branch: JunctionBranch) -> bool:
        if quality_gate is None:
            return False
        try:
            verdict = quality_gate.judge(domain, branch.overlay)
            if inspect.isawaitable(verdict):
                verdict = await verdict
            return bool(verdict)
        except Exception as exc:
            logger.warning(f"质量闸门判定失败（按未过处理）[{branch.index}]: {exc}")
            return False

    if not branches:
        return JunctionVerdict(
            mode=MODE_NONE,
            homogeneous=True,
            winner=None,
            selection={},
            reasons=("无可裁决支流（候选集为空）",),
        )
    homogeneous = branches_are_homogeneous(branches)
    reasons: list[str] = []
    # 模式集中确定（ENG2-17）：优先档位单一决策点——同构 → 质量闸门
    # 优先；异构 → 合成源优先；两者不可用/未过/失败统一降级信任档。
    # 各分支只做「通过即返回」/「失败追加降级理由」，不再分散赋 mode。
    if homogeneous and quality_gate is not None:
        passed = [b for b in branches if await gate_passed(b)]
        if passed:
            ordered = _tier_cost_order(passed)
            winner = ordered[0]
            reasons.append(
                f"质量闸门过者胜（{len(passed)}/{len(branches)} 过关）"
                + (
                    f"；同过者比信任档（{winner.tier}）再比成本"
                    f"（{winner.mean_cost:.2f}）"
                    if len(passed) > 1
                    else ""
                )
            )
            return _winner_verdict(
                winner,
                branches,
                mode=MODE_QUALITY_GATE,
                reasons=tuple(reasons),
                homogeneous=homogeneous,
            )
        reasons.append("质量闸门全部未过，降级信任档裁决")
    elif not homogeneous and synth_provider is not None:
        try:
            context = JunctionSynthContext(
                domain=domain,
                goal=tuple(goal),
                branches=tuple(branches),
                notes=("异构输出：各支产物字段不一致",),
            )
            selection = await synth_provider.synthesize(context)
        except Exception as exc:
            logger.warning(f"异构合成失败（降级信任档裁决）: {exc}")
            selection = None
        if selection is not None:
            return JunctionVerdict(
                mode=MODE_SYNTHETIC,
                homogeneous=False,
                winner=None,
                selection=dict(selection),
                reasons=("异构输出经合成源合成（支流产物字段不一致）",),
                losers=tuple(b.index for b in branches),
            )
        reasons.append("异构合成无产出/失败，降级信任档裁决")
    elif not homogeneous:
        reasons.append("异构输出且未注入合成源，降级信任档裁决")
    ordered = _tier_cost_order(branches)
    winner = ordered[0]
    if sum(1 for b in ordered if b.tier == winner.tier) > 1:
        reasons.append(
            f"同信任档（{winner.tier}）比成本（胜 {winner.mean_cost:.2f}）"
        )
    reasons.append(f"信任档裁决胜出：{winner.index}（档位 {winner.tier}）")
    return _winner_verdict(
        winner,
        branches,
        mode=MODE_TIER,
        reasons=tuple(reasons),
        homogeneous=homogeneous,
    )


def _winner_verdict(
    winner: JunctionBranch,
    branches: Sequence[JunctionBranch],
    *,
    mode: str,
    reasons: tuple[str, ...],
    homogeneous: bool,
) -> JunctionVerdict:
    """胜者收口：产物 = 胜者整体提交（来源留痕）。"""
    return JunctionVerdict(
        mode=mode,
        homogeneous=homogeneous,
        winner=winner.index,
        selection=dict(winner.overlay),
        reasons=reasons,
        losers=tuple(b.index for b in branches if b.index != winner.index),
        provenance=({"branch_index": winner.index, "note": f"整体提交（{mode}）"},),
    )


def plan_junction_updates(
    verdict: JunctionVerdict,
    branches: Sequence[JunctionBranch],
    *,
    domain: str,
    failed_indexes: Sequence[int] = (),
) -> tuple[JunctionEvidenceUpdate, ...]:
    """证据更新计划（归因规则：成功全边 +1；失败只记入边失败 +1）。

    胜者全边成功（路径全通才证明每条边有效）；败者/失败支流只记
    收尾结点入边（枝尾入边）失败 +1——一次下游失败不得毒化整条链。
    合成/无裁决（无胜者）时：已执行失败支流记负样例，未失败支流
    中性不记（合成 ≠ 失败，不产生负样例）。
    """
    updates: list[JunctionEvidenceUpdate] = []
    failed = set(failed_indexes)
    for branch in branches:
        if verdict.winner == branch.index:
            for ref in branch.edge_refs:
                updates.append(
                    JunctionEvidenceUpdate(
                        key=ref.evidence_key(domain), kind=UPDATE_SUCCESS
                    )
                )
        elif branch.index in failed or verdict.winner is not None:
            for ref in branch.edge_refs[-1:]:
                updates.append(
                    JunctionEvidenceUpdate(
                        key=ref.evidence_key(domain), kind=UPDATE_FAIL
                    )
                )
    return tuple(updates)


async def apply_junction_updates(
    store: EdgeEvidenceStore,
    updates: Sequence[JunctionEvidenceUpdate],
    *,
    now: float | None = None,
) -> int:
    """证据更新落库（胜利/失败归集；返回落库条数）。"""
    applied = 0
    for update in updates:
        if update.kind == UPDATE_SUCCESS:
            await store.record_success(update.key, now=now)
        else:
            await store.record_failure(update.key, now=now)
        applied += 1
    return applied


def junction_audit_record(
    verdict: JunctionVerdict,
    branches: Sequence[JunctionBranch],
    *,
    domain: str,
    fingerprint: str = "",
    ts: float,
) -> dict[str, Any]:
    """汇流裁决审计记录（append-only；类型名与事件注册表登记一致）。"""
    return {
        "type": EVENT_AUDIT_JUNCTION,
        "ts": ts,
        "domain": domain,
        "fingerprint": fingerprint,
        "mode": verdict.mode,
        "homogeneous": verdict.homogeneous,
        "winner": verdict.winner,
        "losers": list(verdict.losers),
        "reasons": list(verdict.reasons),
        "branches": [b.to_dict() for b in branches],
    }


# ── Junction 节点类型（注册表内建；开关关闭时不注册 = 不参与执行）──

class JunctionExecutor:
    """汇流执行体（Junction 节点型用途的依赖持有者；裁决核心复用）。

    工厂以本对象为实时引用（依赖装配期后置注入：质量闸门/合成源/
    证据存储随运行期绑定），节点执行时现取——与注册表工厂的实时引用
    契约一致。未装配/未绑定依赖时节点执行显式失败（不静默）。
    """

    def __init__(
        self,
        *,
        evidence_store: EdgeEvidenceStore | None = None,
        sink: Any = None,
        now: float | None = None,
    ) -> None:
        self.evidence_store = evidence_store
        self.sink = sink
        self.now = now
        self.quality_gate: QualityGate | None = None
        self.synth_provider: JunctionSynthProvider | None = None

    def bind(
        self,
        *,
        quality_gate: QualityGate | None = None,
        synth_provider: JunctionSynthProvider | None = None,
    ) -> None:
        """运行期依赖绑定（节点执行前由使用方接线）。"""
        self.quality_gate = quality_gate
        self.synth_provider = synth_provider


def _junction_node(executor: JunctionExecutor | None):
    """Junction 节点执行体（数据形态：支流清单经状态通道注入）。"""

    async def node(ctx: Any) -> dict | None:
        if executor is None:
            raise GraphDefinitionError(
                "Junction 节点执行需要汇流执行体（register_junction_node 注入）"
            )
        raw_branches = ctx.state.get(JUNCTION_BRANCHES_STATE_KEY)
        if not isinstance(raw_branches, list) or not raw_branches:
            raise GraphDefinitionError(
                f"Junction 节点缺失支流清单（{JUNCTION_BRANCHES_STATE_KEY}）"
            )
        branches = tuple(
            JunctionBranch.from_dict(b) for b in raw_branches if isinstance(b, dict)
        )
        domain = str(ctx.state.get("domain") or DEFAULT_DOMAIN)
        verdict = await junction_verdict(
            branches,
            domain=domain,
            goal=tuple(ctx.state.get("goal") or ()),
            quality_gate=executor.quality_gate,
            synth_provider=executor.synth_provider,
            now=executor.now,
        )
        if executor.sink is not None:
            executor.sink(
                junction_audit_record(
                    verdict,
                    branches,
                    domain=domain,
                    ts=executor.now if executor.now is not None else time.time(),
                )
            )
        overlay = dict(verdict.selection)
        overlay[JUNCTION_VERDICT_STATE_KEY] = verdict.to_dict()
        return overlay

    return node


def register_junction_node(
    registry: NodeTypeRegistry,
    *,
    executor: JunctionExecutor | None = None,
) -> None:
    """注册 Junction 节点类型（重复注册显式拒绝；装配处调用）。

    机制开关关闭时装配处不调用本函数 = 类型不存在 = 引用图定义在
    建图期被拒（Junction 不参与执行——默认全关的零影响语义）。
    """
    if registry.has(JUNCTION_TYPE):
        raise GraphDefinitionError(f"节点类型重复注册: {JUNCTION_TYPE}")
    registry.register(JUNCTION_TYPE, lambda config: _junction_node(executor))


# ── 多径运行器（候选集执行 + 汇流收口）────────────────────────────

def multipath_branch_thread(parent_thread: str, index: int) -> str:
    """支流独立子链归属：``{父thread}:multipath:{index}``。"""
    return f"{parent_thread}:multipath:{index}"


def multipath_branch_path(index: int) -> tuple[str, ...]:
    """支流事件路径归属（事件统一父链 + 路径标记）。"""
    return ("multipath", str(index))


@dataclass(frozen=True, slots=True)
class BudgetView:
    """预算只读查询上下文（多径预检的轻量 ctx；策略可读字段最小集）。"""

    node: str | None = None
    graph_path: tuple[str, ...] = ("multipath",)
    step_count: int = 0
    thread_id: str | None = None
    round_id: str | None = None
    state: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class MultiPathBranchResult:
    """一条支流执行结果（终态 + 归因口径 + 子链锚点）。

    Attributes:
        index: 支流序号。
        chain: 主链类型名序列。
        digest: 候选图指纹（图定义身份）。
        overlay: 执行回流增量（产物镜像）。
        final_state: 支流终态。
        terminal: 终止原因（reply/stop/error/...）。
        error: 执行失败原因（None = 正常收尾）。
        interrupt: 中断负载（中断后提升为调用方挂起卡；None = 无中断）。
        evidence: 链级证据聚合（裁决输入口径）。
        thread_id: 独立子链线程 id（回溯/换选锚点）。
        graph_path: 支流事件路径。
    """

    index: int
    chain: tuple[str, ...]
    digest: str
    overlay: dict[str, Any]
    final_state: dict[str, Any]
    terminal: str
    error: str | None
    interrupt: dict[str, Any] | None
    evidence: ChainEvidence | None
    thread_id: str
    graph_path: tuple[str, ...]
    terminal_fields: tuple[str, ...] = ()
    edge_refs: tuple[EdgeRef, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "chain": list(self.chain),
            "digest": self.digest,
            "overlay": dict(self.overlay),
            "final_state": dict(self.final_state),
            "terminal": self.terminal,
            "error": self.error,
            "interrupt": self.interrupt,
            "evidence": (
                {
                    "edges": self.evidence.edges,
                    "evidenced": self.evidence.evidenced,
                    "success_total": self.evidence.success_total,
                    "fail_total": self.evidence.fail_total,
                    "cost_total": self.evidence.cost_total,
                    "tier": self.evidence.tier,
                }
                if self.evidence is not None
                else None
            ),
            "thread_id": self.thread_id,
            "graph_path": list(self.graph_path),
            "terminal_fields": list(self.terminal_fields),
            "edge_refs": [r.to_dict() for r in self.edge_refs],
        }


@dataclass(frozen=True, slots=True)
class MultiPathResult:
    """一次多径执行的收口结果（触发/执行/裁决/证据回写全量留痕）。

    Attributes:
        triggered: 是否实际触发多径（开关/预算/径数全部放行 = True）；
            False = 未触发（零生效/预算预检拒绝/候选不足/降级单径）。
        k: 实际执行径数（1 = 单径降级；0 = 未执行）。
        candidates: 候选条数（请求入口）。
        base_cost: 单径成本基准（主候选证据成本核算）。
        budget_required: 多径预算需求（B×(1+(k-1)ρ)）。
        budget_passed: 预算预检是否放行。
        budget_note: 预算预检说明（审计可读）。
        degraded_reason: 降级原因（预算拒绝/k>2 高风险门限等；None = 未降级）。
        branches: 支流执行结果（按序号）。
        verdict: 汇流裁决（k≥2 且至少一条成功支流时产出；None = 未裁决）。
        thread_ids: 支流序号 → 独立子链线程 id（回溯/换选锚点）。
        updates: 证据更新计划（已随落库；留痕可查）。
        audit: 审计记录（append-only；落库经 sink/回调）。
    """

    triggered: bool
    k: int
    candidates: int
    base_cost: float = 0.0
    budget_required: float = 0.0
    budget_passed: bool = True
    budget_note: str = ""
    degraded_reason: str | None = None
    branches: tuple[MultiPathBranchResult, ...] = ()
    verdict: JunctionVerdict | None = None
    thread_ids: dict[int, str] = field(default_factory=dict)
    updates: tuple[JunctionEvidenceUpdate, ...] = ()
    audit: tuple[dict[str, Any], ...] = ()

    @property
    def winner(self) -> int | None:
        return self.verdict.winner if self.verdict is not None else None

    def to_dict(self) -> dict[str, Any]:
        return {
            "triggered": self.triggered,
            "k": self.k,
            "candidates": self.candidates,
            "base_cost": self.base_cost,
            "budget_required": self.budget_required,
            "budget_passed": self.budget_passed,
            "budget_note": self.budget_note,
            "degraded_reason": self.degraded_reason,
            "branches": [b.to_dict() for b in self.branches],
            "verdict": self.verdict.to_dict() if self.verdict else None,
            "thread_ids": dict(self.thread_ids),
            "updates": [u.to_dict() for u in self.updates],
            "audit": [dict(r) for r in self.audit],
        }


class MultipathRunner:
    """多径运行器：候选集并行执行 → 汇流裁决 → 证据回写。

    Args:
        engine: 父引擎（承载注册表/存储/预算/传输；候选图经构建期
            注册表解析，执行期从各自子链尾续跑）。
        evidence_store: 边证据存储（裁决与回写数据源；None = 零证据）。
        config: 机制开关（None = 直连可用；enabled=False = 零生效）。
        sink: 审计记录回调（append-only；本模块只产出记录不落库）。
        now: 当前时间戳（确定性注入；None = 实时）。
    """

    def __init__(
        self,
        engine: Engine,
        *,
        evidence_store: EdgeEvidenceStore | None = None,
        config: MultiPathConfig | None = None,
        sink: Any = None,
        now: float | None = None,
    ) -> None:
        self._engine = engine
        self._store = evidence_store
        self._config = config
        self._sink = sink
        self._now = now

    async def _evidence_index(
        self, domain: str
    ) -> dict[tuple[str, str, str, str], EdgeEvidence]:
        if self._store is None:
            return {}
        rows = await self._store.list_edges(domain)
        return evidence_index_of(rows)

    async def _budget_remaining(self) -> tuple[BudgetRemaining, ...]:
        """预算余量只读查询（BudgetManager.query_remaining；无管理器 = 空）。"""
        manager = self._engine.options.budget
        if manager is None:
            return ()
        return await manager.query_remaining(BudgetView())

    async def run(
        self,
        request: AssemblyRequest,
        candidates: Sequence[AssemblyCandidate],
        *,
        entry_state: Mapping[str, Any],
        thread_id: str,
        round_id: str | None = None,
        trace_id: str | None = None,
        k: int | None = None,
        concurrency: int | None = None,
        quality_gate: QualityGate | None = None,
        synth_provider: JunctionSynthProvider | None = None,
        inject: Mapping[str, Any] | None = None,
        budget_remaining: Sequence[BudgetRemaining] | None = None,
    ) -> MultiPathResult:
        """执行一次多径（触发判据复用组装信号的语义；只执行不判定触发）。

        Args:
            request: 组装请求（安全档/闸门/域；k=3 高风险门限按
                ``max_safety_tier ≥ 1`` 判定）。
            candidates: 候选路径（组装器候选清单；取前 k 条执行）。
            entry_state: 支流入口状态（各支相同的自包含任务输入）。
            thread_id: 回合线程 id（事件统一父链 + 子链归属）。
            round_id/trace_id: 事件契约透传。
            k: 径数（缺省 = 配置 default_k；上界 = max_k 与候选数）。
            concurrency: 支流并发上限（缺省 = 配置值）。
            quality_gate: 质量闸门（缺省 = 请求注入；同构择优用）。
            synth_provider: 合成源（异构输出合成用；合成源归使用方）。
            inject: 中断注入值（{key: value} 一次性；重入语义与引擎一致）。
            budget_remaining: 预算余量（缺省 = 经引擎 BudgetManager 只读
                查询；预检 fail-closed）。

        Returns:
            MultiPathResult：触发/执行/裁决/证据回写全量留痕。

        Raises:
            InterruptSignal: 支流内中断（提升为调用方挂起卡；子链
                checkpoint 保留，注入重入后从链尾续跑）。
        """
        config = self._config or MultiPathConfig()
        if not config.enabled:
            return MultiPathResult(
                triggered=False,
                k=0,
                candidates=len(candidates),
                budget_note="机制开关关闭（默认全关），未触发",
            )
        if not candidates:
            return MultiPathResult(
                triggered=False,
                k=0,
                candidates=0,
                budget_note="无候选（组装未解出），未触发",
            )
        evidence_index = await self._evidence_index(request.domain)
        trace_id = trace_id or f"multipath-{time.time_ns():x}"
        desired = int(k) if k is not None else config.default_k
        k_eff = max(1, min(desired, len(candidates), config.max_k))
        degradations: list[str] = []
        if (
            k_eff > DEFAULT_MULTIPATH_K
            and request.max_safety_tier < HIGH_RISK_SAFETY_TIER
        ):
            degradation = "k>2 仅高风险任务放行（max_safety_tier ≥ 1），已降为 2"
            k_eff = DEFAULT_MULTIPATH_K
            degradations.append(degradation)
        if k_eff < 2:
            branch_results = []
            if k_eff == 1:
                branch_results = await self._execute_branches(
                    candidates[:1],
                    request,
                    entry_state=entry_state,
                    thread_id=thread_id,
                    round_id=round_id,
                    trace_id=trace_id,
                    concurrency=1,
                    inject=inject,
                    evidence_index=evidence_index,
                )
            result = MultiPathResult(
                triggered=False,
                k=k_eff,
                candidates=len(candidates),
                degraded_reason="候选不足（<2 条），单径执行",
                budget_note="候选不足，未触发多径",
                branches=tuple(branch_results),
                thread_ids={b.index: b.thread_id for b in branch_results},
            )
            return self._finalize_result(
                result,
                request,
                trace_id,
                run_record={
                    "triggered": False,
                    "k": k_eff,
                    "base_cost": 0.0,
                    "budget_required": 0.0,
                    "budget_passed": True,
                    "budget_note": "候选不足，未触发多径",
                    "degraded_reason": "候选不足（<2 条），单径执行",
                },
            )
        base_cost = chain_evidence(candidates[0], evidence_index).cost_estimate
        required = multipath_budget_required(base_cost, k_eff, rho=config.shared_rho)
        remaining = (
            tuple(budget_remaining)
            if budget_remaining is not None
            else await self._budget_remaining()
        )
        budget_ok, budget_note = check_multipath_budget(
            remaining, base_cost, k_eff, rho=config.shared_rho
        )
        if not budget_ok:
            k_eff = 1
            degradations.append(f"预算预检拒绝（{budget_note}），降级单径执行")
        if k_eff < 2:
            branch_results = await self._execute_branches(
                candidates[:1],
                request,
                entry_state=entry_state,
                thread_id=thread_id,
                round_id=round_id,
                trace_id=trace_id,
                concurrency=1,
                inject=inject,
                evidence_index=evidence_index,
            )
            degraded = "; ".join(degradations) or None
            result = MultiPathResult(
                triggered=False,
                k=1,
                candidates=len(candidates),
                base_cost=base_cost,
                budget_required=required,
                budget_passed=budget_ok,
                budget_note=budget_note,
                degraded_reason=degraded,
                branches=tuple(branch_results),
                thread_ids={b.index: b.thread_id for b in branch_results},
            )
            return self._finalize_result(
                result,
                request,
                trace_id,
                run_record={
                    "triggered": False,
                    "k": 1,
                    "base_cost": base_cost,
                    "budget_required": required,
                    "budget_passed": budget_ok,
                    "budget_note": budget_note,
                    "degraded_reason": degraded,
                },
            )
        branch_results = await self._execute_branches(
            candidates[:k_eff],
            request,
            entry_state=entry_state,
            thread_id=thread_id,
            round_id=round_id,
            trace_id=trace_id,
            concurrency=concurrency or config.concurrency,
            inject=inject,
            evidence_index=evidence_index,
        )
        failed_indexes = tuple(b.index for b in branch_results if self._failed(b))
        successful = [b for b in branch_results if not self._failed(b)]
        verdict: JunctionVerdict | None = None
        updates: tuple[JunctionEvidenceUpdate, ...] = ()
        junction_branches: tuple[JunctionBranch, ...] = ()
        if successful:
            junction_branches = tuple(
                self._as_junction_branch(b) for b in successful
            )
            effective_gate = quality_gate or request.quality_gate
            verdict = await junction_verdict(
                junction_branches,
                domain=request.domain,
                goal=request.goal_fields(),
                quality_gate=effective_gate,
                synth_provider=synth_provider,
                now=self._now,
            )
            all_branches = tuple(
                self._as_junction_branch(b) for b in branch_results
            )
            updates = plan_junction_updates(
                verdict,
                all_branches,
                domain=request.domain,
                failed_indexes=failed_indexes,
            )
        else:
            if synth_provider is not None:
                try:
                    context = JunctionSynthContext(
                        domain=request.domain,
                        goal=request.goal_fields(),
                        branches=tuple(
                            self._as_junction_branch(b) for b in branch_results
                        ),
                        notes=("全部支流执行失败",),
                    )
                    selection = await synth_provider.synthesize(context)
                except Exception as exc:
                    logger.warning(f"全败合成失败: {exc}")
                    selection = None
                if selection is not None:
                    verdict = JunctionVerdict(
                        mode=MODE_SYNTHETIC,
                        homogeneous=False,
                        winner=None,
                        selection=dict(selection),
                        reasons=("全部支流执行失败，经合成源合成",),
                        losers=tuple(b.index for b in branch_results),
                    )
            if verdict is None:
                verdict = JunctionVerdict(
                    mode=MODE_NONE,
                    homogeneous=False,
                    winner=None,
                    selection={},
                    reasons=("全部支流执行失败，且无合成源",),
                    losers=tuple(b.index for b in branch_results),
                )
            all_branches = tuple(
                self._as_junction_branch(b) for b in branch_results
            )
            updates = plan_junction_updates(
                verdict,
                all_branches,
                domain=request.domain,
                failed_indexes=failed_indexes,
            )
        if self._store is not None and updates:
            await apply_junction_updates(self._store, updates, now=self._now)
        result = MultiPathResult(
            triggered=True,
            k=k_eff,
            candidates=len(candidates),
            base_cost=base_cost,
            budget_required=required,
            budget_passed=budget_ok,
            budget_note=budget_note,
            degraded_reason="; ".join(degradations) or None,
            branches=tuple(branch_results),
            verdict=verdict,
            thread_ids={b.index: b.thread_id for b in branch_results},
            updates=updates,
        )
        run_record = {
            "triggered": True,
            "k": k_eff,
            "base_cost": base_cost,
            "budget_required": required,
            "budget_passed": budget_ok,
            "budget_note": budget_note,
            "degraded_reason": "; ".join(degradations) or None,
        }
        junction_record = None
        if verdict is not None:
            junction_record = junction_audit_record(
                verdict,
                junction_branches
                or tuple(self._as_junction_branch(b) for b in branch_results),
                domain=request.domain,
                fingerprint=(
                    result.branches[0].digest if result.branches else ""
                ),
                ts=self._now if self._now is not None else time.time(),
            )
        return self._finalize_result(
            result,
            request,
            trace_id,
            run_record=run_record,
            junction_record=junction_record,
        )

    def _finalize_result(
        self,
        result: MultiPathResult,
        request: AssemblyRequest,
        trace_id: str,
        *,
        run_record: dict[str, Any],
        junction_record: dict[str, Any] | None = None,
    ) -> MultiPathResult:
        """审计组装 + 回调发射（append-only；失败留痕同样经回调）。"""
        ts = self._now if self._now is not None else time.time()
        records: list[dict[str, Any]] = [
            {"ts": ts, "domain": request.domain, "trace_id": trace_id, **run_record}
        ]
        if junction_record is not None:
            records.append(junction_record)
        result = replace(result, audit=tuple(records))
        if self._sink is not None:
            for record in records:
                self._sink(dict(record))
        return result

    async def _execute_branches(
        self,
        candidates: Sequence[AssemblyCandidate],
        request: AssemblyRequest,
        *,
        entry_state: Mapping[str, Any],
        thread_id: str,
        round_id: str | None,
        trace_id: str,
        concurrency: int,
        inject: Mapping[str, Any] | None,
        evidence_index: Mapping[tuple[str, str, str, str], EdgeEvidence],
    ) -> list[MultiPathBranchResult]:
        """支流并行执行（子链隔离 + 事件统一父链；与既有子链同构）。

        注入按分支隔离（ENG2-12）：跨分支共享父 coordinator 时，同一
        review_key 的注入值被首条命中中断点的支流 consume（一次性弹出），
        其余支流再 interrupt() 无值可消费 → InterruptError/反复挂起。
        每条支流执行前预载父级注入快照到**支流专属 coordinator**——
        同键决策对每条命中中断点的支流都可消费（父级重入时各支流按
        自身副本续跑）；支流内嵌套 spawn 实例共享支流 coordinator，
        不回流父级。
        """
        storage = self._engine.options.storage
        schema = self._engine.options.schema
        results: dict[int, MultiPathBranchResult] = {}
        inject_snapshot = dict(inject) if inject else None

        async def run_one(position: int) -> None:
            index = position
            candidate = candidates[position]
            sub_engine = self._engine._make_instance_engine(
                candidate.graph, self._engine.options.spawn_depth + 1
            )
            if inject_snapshot:
                from .interrupt import InterruptCoordinator

                sub_engine._coordinator = InterruptCoordinator(
                    pending_inject=dict(inject_snapshot)
                )
            sub_path = multipath_branch_path(index)
            branch_thread = multipath_branch_thread(thread_id, index)
            try:
                resume_from: int | None = None
                if storage is not None:
                    tail = await tail_checkpoint(storage, branch_thread)
                    if tail is not None and tail.reason in (None, "interrupted"):
                        resume_from = tail.checkpoint_id
                    sub_engine._chain_advanced = True
                final_state, sub_result = await sub_engine._execute(
                    state=dict(entry_state),
                    thread_id=thread_id,
                    round_id=round_id,
                    resume_from=resume_from,
                    trace_id=trace_id,
                    queue=None,
                    graph_path=sub_path,
                    transports=self._engine.options.transports,
                    checkpoint_thread_id=branch_thread,
                )
            except (InterruptSignal, asyncio.CancelledError):
                self._merge_sub_engine(sub_engine)
                raise
            except Exception as exc:
                logger.warning(
                    "支流执行异常（index=%s）: %s", index, exc, exc_info=True
                )
                self._merge_sub_engine(sub_engine)
                results[index] = MultiPathBranchResult(
                    index=index,
                    chain=candidate.chain,
                    digest=candidate.graph.digest(),
                    overlay={},
                    final_state={},
                    terminal="error",
                    error=str(exc),
                    interrupt=None,
                    evidence=chain_evidence(candidate, evidence_index),
                    thread_id=branch_thread,
                    graph_path=sub_path,
                    terminal_fields=chain_terminal_fields(candidate),
                    edge_refs=chain_edge_refs(candidate),
                )
                return
            self._merge_sub_engine(sub_engine)
            if sub_result.interrupt is not None:
                raise InterruptSignal(
                    sub_result.interrupt.key, sub_result.interrupt.payload
                )
            # 支流步数截止（同推演分支护栏口径）：执行步数超限 = 支流
            # 失败（terminal=error，汇流裁决按失败支流处理并记负样例）
            step_limit = self._engine.options.simulate_max_branch_steps
            if step_limit > 0 and sub_engine.executed_node_steps > step_limit:
                results[index] = MultiPathBranchResult(
                    index=index,
                    chain=candidate.chain,
                    digest=candidate.graph.digest(),
                    overlay={},
                    final_state=dict(final_state),
                    terminal="error",
                    error=f"支流步数超限: {sub_engine.executed_node_steps} > {step_limit}",
                    interrupt=None,
                    evidence=chain_evidence(candidate, evidence_index),
                    thread_id=branch_thread,
                    graph_path=sub_path,
                    terminal_fields=chain_terminal_fields(candidate),
                    edge_refs=chain_edge_refs(candidate),
                )
                return
            if sub_result.reason == TerminateReason.ERROR:
                results[index] = MultiPathBranchResult(
                    index=index,
                    chain=candidate.chain,
                    digest=candidate.graph.digest(),
                    overlay={},
                    final_state=dict(final_state),
                    terminal=sub_result.reason,
                    error=sub_result.error or "支流执行失败",
                    interrupt=None,
                    evidence=chain_evidence(candidate, evidence_index),
                    thread_id=branch_thread,
                    graph_path=sub_path,
                    terminal_fields=chain_terminal_fields(candidate),
                    edge_refs=chain_edge_refs(candidate),
                )
                return
            overlay = subgraph_overlay_delta(dict(entry_state), final_state, schema)
            results[index] = MultiPathBranchResult(
                index=index,
                chain=candidate.chain,
                digest=candidate.graph.digest(),
                overlay=overlay,
                final_state=dict(final_state),
                terminal=sub_result.reason,
                error=None,
                interrupt=None,
                evidence=chain_evidence(candidate, evidence_index),
                thread_id=branch_thread,
                graph_path=sub_path,
                terminal_fields=chain_terminal_fields(candidate),
                edge_refs=chain_edge_refs(candidate),
            )

        await fan_out(
            [lambda pos: run_one(pos) for pos in range(len(candidates))],
            max(1, int(concurrency)),
            propagate=InterruptSignal,
        )
        return [results[i] for i in range(len(candidates)) if i in results]

    def _merge_sub_engine(self, sub_engine: Engine) -> None:
        """支流事件计数/seq 锚点/轨迹并入父引擎（与 spawn 实例同口径）。"""
        self._engine._event_counter += sub_engine._event_counter
        if sub_engine._latest_event_seq is not None:
            self._engine._latest_event_seq = (
                sub_engine._latest_event_seq
                if self._engine._latest_event_seq is None
                else max(self._engine._latest_event_seq, sub_engine._latest_event_seq)
            )
        self._engine._trace_merge_from(sub_engine)

    def _failed(self, branch: MultiPathBranchResult) -> bool:
        return branch.terminal == "error" or branch.error is not None

    def _as_junction_branch(
        self, branch: MultiPathBranchResult
    ) -> JunctionBranch:
        return JunctionBranch(
            index=branch.index,
            chain=branch.chain,
            overlay=dict(branch.overlay),
            terminal_fields=branch.terminal_fields,
            edge_refs=branch.edge_refs,
            evidence=branch.evidence,
            graph_path=branch.graph_path,
        )


__all__ = [
    "DEFAULT_DOMAIN",
    "DEFAULT_MULTIPATH_CONCURRENCY",
    "DEFAULT_MULTIPATH_K",
    "DEFAULT_SHARED_RHO",
    "HIGH_RISK_SAFETY_TIER",
    "JUNCTION_BRANCHES_STATE_KEY",
    "JUNCTION_TYPE",
    "JUNCTION_VERDICT_STATE_KEY",
    "MAX_MULTIPATH_K",
    "MODE_COST",
    "MODE_NONE",
    "MODE_QUALITY_GATE",
    "MODE_SYNTHETIC",
    "MODE_TIER",
    "MULTIPATH_KEY",
    "RHO_MAX",
    "RHO_MIN",
    "UPDATE_FAIL",
    "UPDATE_SUCCESS",
    "BudgetView",
    "ChainEvidence",
    "EdgeRef",
    "JunctionBranch",
    "JunctionEvidenceUpdate",
    "JunctionExecutor",
    "JunctionSynthContext",
    "JunctionSynthProvider",
    "JunctionVerdict",
    "MultiPathBranchResult",
    "MultiPathConfig",
    "MultiPathResult",
    "MultipathRunner",
    "apply_junction_updates",
    "branches_are_homogeneous",
    "chain_edge_refs",
    "chain_evidence",
    "chain_terminal_fields",
    "check_multipath_budget",
    "evidence_index_of",
    "junction_audit_record",
    "junction_verdict",
    "multipath_branch_path",
    "multipath_branch_thread",
    "multipath_budget_required",
    "multipath_config_from_flags",
    "plan_junction_updates",
    "register_junction_node",
    "tier_rank",
]
