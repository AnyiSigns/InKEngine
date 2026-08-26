"""路径组装器（只读：出候选计划供观察/审计，不接执行路径）。

组装 = 把「结点池（注册表 + 契约）+ 边证据 + 目标 schema」装成 1..k 条
候选路径，产物为图定义数据（可序列化、可经 :meth:`Graph.from_dict` 重建、
可走 canary 试跑）。本模块只组装不执行：不替换任何既有 workflow 执行
路径，观测出口 = 组装候选事件（``event_types`` 注册表）+ 审计记录落库
（宿主经注入的落库回调承接）。

三条产出层（默认全关——由 :class:`AssemblyEnvelope.llm_draft` 与注入的
草稿源开启，与机制装配开关 :class:`~ink_engine.core.contracts.PathAssemblyConfig`
对齐）：

1. **schema 反推**（纯算法）：正向链式搜索——从入口字段出发，
   按前缀可达性（弱校验，多源汇聚合法）逐层扩边，直到覆盖目标字段；
   beam 排序按**目标相关度优先**（已覆盖字段 ∩ 目标字段数），同相关度
   按末边证据分序再按路径长度确定（实验定稿：全量覆盖贪婪排序会导致
   可并行分支在第 3 层被挤出 beam）。
2. **LLM 草稿**（使用方注入接口）：草稿源提供语义方向（上下文只给
   契约摘要 + 目标字段 + 规则，机制存在不告知——见实验记录），链接
   校验器逐边验证；重试上限 2 次；空响应/非 JSON 不重试直接兜底。
3. **证据评分 + beam top-k**：候选按全链边证据分排序（edge_score
   复用 :mod:`~ink_engine.core.edge_evidence` 评分公式与确定性
   tie-break），取 top-k。

**算法自动修复**（有名字的图编辑算子集，修复器不是自由生成）：
``replace_node`` / ``add_branch`` / ``remove_node`` / ``reroute_edge``
——每算子执行后重跑前缀可达性校验；修复不可达 → 全量算法重组装兜底
（LLM 草稿只给语义方向，算法层保合法与修复）。

约束（红线）：

- **序列化红线**：产物 = 图定义数据（``to_dict`` 兼容、可
  ``from_dict(validate=True)``），禁止函数直挂进组装路径——候选图节点
  一律按注册表类型名引用；
- **检索解耦**：候选缩小消费 :class:`~ink_engine.core.retrieval.Retriever`
  协议（域过滤后 top-N 窗口供 LLM 上下文），与向量栈解耦——内存暴力
  top-N 为默认注入兜底，向量栈上线后换注入实现复测；
- **仿真零副作用**：本模块不发射事件、不写存储（边证据只读）、不改变
  引擎 run 执行路径；统计口径（beam 扩展数/评分计算量）随结果携带
  供规模基准与审计。
"""
from __future__ import annotations

import itertools
import json
import random
import re
import time
from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any, Protocol, runtime_checkable

from .contracts import (
    NodeContract,
    PathAssemblyConfig,
    PathAssemblyFlags,
    QualityGate,
)
from .audit_log import AUDIT_COLLECTION, emit_audit
from .event_types import EVENT_ASSEMBLY_CANDIDATE, EVENT_AUDIT_ASSEMBLY
from .edge_evidence import (
    DEFAULT_CONTRACT_VERSION,
    EdgeEvidence,
    EdgeEvidenceStore,
    cold_start_index,
    edge_score,
    is_exploration_mode,
    multi_path_trigger,
)
from .exceptions import GraphDefinitionError
from .fingerprint import graph_fingerprint, request_fingerprint
from .fingerprint_cache import (
    REPLACE_REASON_DRIFT,
    REPLACE_REASON_SAMPLE,
    FingerprintCacheEntry,
    FingerprintCacheStore,
    evidence_drifted,
    fingerprint_replace_audit_record,
)
from .graph import Graph, TerminateReason
from .link_validator import (
    produced_field_names,
    required_field_names,
    validate_prefix_reachability,
)
from .logging import get_logger
from .registry import NodeTypeRegistry
from .retrieval import RetrievedChunk, Retriever
from .run_result import RunOptions
from .schema_validator import SchemaSpec
from .state import StateSchema

logger = get_logger(__name__)

# ── 组装默认参数（引擎钉死；使用方仅覆盖权）──────────────────────
DEFAULT_BEAM_WIDTH = 4  # beam 宽度（组合爆炸四层压：类型契约/证据偏置/预算信封/池治理）
DEFAULT_MAX_PATH_LENGTH = 10  # 候选链最大深度
DEFAULT_TOP_K = 2  # 候选条数（默认 1 主 + 1 探）
LLM_RETRY_LIMIT = 2  # 草稿重试上限（首次 + 2 次重试 = 最多 3 次调用）
DEFAULT_LLM_WINDOW = 30  # 草稿上下文窗口（域过滤后 top-N 契约摘要，上下文分两层缩放）
MAX_REPAIR_ROUNDS = 4  # 自动修复最大轮数（防算子组合全枚举）
# 默认上下文域（未注入域时的登记归属，与沉淀侧同一常数）
DEFAULT_DOMAIN = "default"
# 默认放行档位（默认 0 最严；映射策略归使用方）
DEFAULT_MAX_SAFETY_TIER = 0
# 缓存抽样重装概率（命中时以 ε 概率绕过缓存重新组装对比；轻任务由
# 使用方注入 ε≈0 关闭——执行成本 ≤ 组装成本时收益不对称前提不成立）
DEFAULT_CACHE_EPSILON = 0.05

# 候选来源标记（声明式枚举，防魔法字符串）
CANDIDATE_SOURCE_ALGORITHM = "algorithm"
CANDIDATE_SOURCE_DRAFT = "draft"
CANDIDATE_SOURCE_CACHE = "cache"

# 统计口径键（声明式枚举）
STATS_BEAM_EXTENSIONS = "beam_extensions"
STATS_EDGE_SCORE_CALLS = "edge_score_calls"
STATS_REPAIR_ATTEMPTS = "repair_attempts"
STATS_LLM_ATTEMPTS = "llm_attempts"
STATS_CACHE_HITS = "cache_hits"
STATS_CACHE_MISSES = "cache_misses"
STATS_CACHE_INVALIDATIONS = "cache_invalidations"
STATS_CACHE_REPLACEMENTS = "cache_replacements"


@dataclass(frozen=True, slots=True)
class NodeSummary:
    """结点契约摘要（草稿上下文的窗口条目；提示词措辞归使用方策略）。

    Attributes:
        type_name: 类型名。
        inputs: 必填输入字段（契约 input_schema 的必填声明）。
        outputs: 产出字段（contract output_schema 的全部字段）。
        safety_tier: 安全档。
    """

    type_name: str
    inputs: tuple[str, ...] = ()
    outputs: tuple[str, ...] = ()
    safety_tier: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "type_name": self.type_name,
            "inputs": list(self.inputs),
            "outputs": list(self.outputs),
            "safety_tier": self.safety_tier,
        }

    @classmethod
    def from_contract(cls, type_name: str, contract: NodeContract) -> NodeSummary:
        return cls(
            type_name=type_name,
            inputs=tuple(sorted(required_field_names(contract.input_schema))),
            outputs=tuple(sorted(produced_field_names(contract.output_schema))),
            safety_tier=contract.safety_tier,
        )


@dataclass(frozen=True, slots=True)
class AssemblyDraftContext:
    """草稿上下文（引擎组装的**结构化输入**；提示词模板归使用方）。

    Attributes:
        goal_fields: 目标字段（须产出的状态通道字段）。
        entry_fields: 入口字段（外部已提供）。
        node_summaries: 候选窗口内的结点契约摘要（经检索缩小）。
        feedback: 上一轮校验失败理由（重试反馈；首轮为空）。
    """

    goal_fields: tuple[str, ...]
    entry_fields: tuple[str, ...]
    node_summaries: tuple[NodeSummary, ...] = ()
    feedback: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "goal_fields": list(self.goal_fields),
            "entry_fields": list(self.entry_fields),
            "node_summaries": [n.to_dict() for n in self.node_summaries],
            "feedback": self.feedback,
        }


@runtime_checkable
class DraftProvider(Protocol):
    """草稿源（使用方注入；语义方向，拓扑合法性归系统校验）。

    实现职责 = 组织提示词 + 调用模型（只输出原始文本）；JSON 解析、
    校验与兜底全部归本模块——模型不自知机制存在（实验记录：靠模型
    自觉配合不可靠，机制在系统层兜底）。
    """

    async def draft(self, context: AssemblyDraftContext) -> str: ...


@dataclass(frozen=True, slots=True)
class AssemblyRequest:
    """组装请求（输入声明：目标 + 域 + 安全档 + 质量闸门 + 草稿源）。

    Attributes:
        goal_schema: 目标 schema（目标字段 = 必填字段；未声明必填时按
            全部声明字段计；两者皆空 = 无字段可组装，返回空结果）。
        entry_fields: 入口字段（外部注入的初始可用字段）。
        domain: 上下文域（边证据按域聚合——评分/统计永远按域分组）。
        max_safety_tier: 组装放行档位（默认 0 最严；高安全结点不可进
            低信任路径；映射策略归使用方）。
        quality_gate: 产出质量判定窄协议（使用方按域注入；本步只读
            不消费——沉淀/汇流的 fail-closed 降级链由使用方接线）。
        state_schema: 状态通道 schema（缺省 None = 跳过通道写入规则）。
        draft_provider: 草稿源（None = 不使用 LLM 层；提示词归使用方）。
        top_k: 候选条数上限（默认 2）。
        graph_name: 候选图名（缺省 = 按序生成）。
    """

    goal_schema: SchemaSpec | None = None
    entry_fields: tuple[str, ...] = ()
    domain: str = DEFAULT_DOMAIN
    max_safety_tier: int = DEFAULT_MAX_SAFETY_TIER
    quality_gate: QualityGate | None = None
    state_schema: StateSchema | None = None
    draft_provider: DraftProvider | None = None
    top_k: int = DEFAULT_TOP_K
    graph_name: str | None = None

    def goal_fields(self) -> tuple[str, ...]:
        """目标字段：必填字段优先；无必填声明 = 全部声明字段。"""
        if self.goal_schema is None:
            return ()
        required = required_field_names(self.goal_schema)
        if required:
            return tuple(sorted(required))
        return tuple(sorted(produced_field_names(self.goal_schema)))

    def to_dict(self) -> dict[str, Any]:
        """序列化为数据形态（供 JSON 通道传递；运行态注入件不入键）。

        闸门与草稿源为运行态对象（协议实现），不随数据形态走——通道
        侧在重建时按注入点补挂（``from_dict`` 的注入参数）。
        """
        data: dict[str, Any] = {
            "domain": self.domain,
            "max_safety_tier": self.max_safety_tier,
            "top_k": self.top_k,
            "entry_fields": list(self.entry_fields),
        }
        if self.goal_schema is not None:
            data["goal_schema"] = self.goal_schema.to_dict()
        if self.state_schema is not None:
            data["state_schema"] = self.state_schema.to_dict()
        if self.graph_name is not None:
            data["graph_name"] = self.graph_name
        return data

    @classmethod
    def from_dict(
        cls,
        data: Mapping[str, Any],
        *,
        quality_gate: QualityGate | None = None,
        draft_provider: DraftProvider | None = None,
        state_schema: StateSchema | None = None,
    ) -> AssemblyRequest:
        """从数据形态重建（数据键 + 运行态注入件分列；缺省键 = 默认值）。"""
        raw_goal = data.get("goal_schema")
        raw_state = data.get("state_schema")
        if raw_state is not None:
            state_schema = StateSchema.from_dict(raw_state)
        return cls(
            goal_schema=(
                SchemaSpec.from_dict(raw_goal) if raw_goal is not None else None
            ),
            entry_fields=tuple(data.get("entry_fields") or ()),
            domain=str(data.get("domain", DEFAULT_DOMAIN)),
            max_safety_tier=int(data.get("max_safety_tier", DEFAULT_MAX_SAFETY_TIER)),
            quality_gate=quality_gate,
            state_schema=state_schema,
            draft_provider=draft_provider,
            top_k=int(data.get("top_k", DEFAULT_TOP_K)),
            graph_name=data.get("graph_name"),
        )


@dataclass(frozen=True, slots=True)
class AssemblyEnvelope:
    """预算信封（组装资源上限；默认值引擎钉死，使用方仅覆盖权）。

    Attributes:
        beam_width: beam 宽度（并行候选数上限）。
        max_path_length: 候选链最大深度。
        llm_retry_limit: 草稿重试上限（空响应/非 JSON 不重试直接兜底）。
        llm_draft: 草稿层开关（默认关；使用方按「仅反推解不出时」开启）。
        llm_window: 草稿上下文窗口（检索 top-N 上限）。
    """

    beam_width: int = DEFAULT_BEAM_WIDTH
    max_path_length: int = DEFAULT_MAX_PATH_LENGTH
    llm_retry_limit: int = LLM_RETRY_LIMIT
    llm_draft: bool = False
    llm_window: int = DEFAULT_LLM_WINDOW


@dataclass(frozen=True, slots=True)
class AssemblyCandidate:
    """一条候选路径（产物 = 图定义数据，可序列化/重建/试跑）。

    Attributes:
        rank: 最终排序序号（从 1 起；证据分降序确定性序）。
        source: 候选来源（algorithm / draft）。
        repaired: 是否经算法修复算子修形（草稿层产物才可能为 True）。
        graph: 候选图定义（线性链：节点全部为声明式类型绑定，含契约
            快照——图定义数据的一部分，随产物落库）。
        score: 全链边证据总分（零证据边取先验下界；确定性 tie-break 见
            :func:`~ink_engine.core.edge_evidence.edge_score`）。
    """

    rank: int
    source: str
    repaired: bool
    graph: Graph
    score: float = 0.0

    @property
    def chain(self) -> tuple[str, ...]:
        """候选链（类型名序；节点名 = 类型名，链内不重复）。"""
        return tuple(self.graph.node_bindings)

    def to_dict(self) -> dict[str, Any]:
        """序列化（审计记录形态：rank/来源/修形标记/评分 + 图定义数据）。"""
        return {
            "rank": self.rank,
            "source": self.source,
            "repaired": self.repaired,
            "score": self.score,
            "chain": list(self.chain),
            "graph": self.graph.to_dict(),
        }


@dataclass(frozen=True, slots=True)
class CanaryVerdict:
    """候选图的 canary 验证结论（重建 + 单回合执行；风险前置校验）。

    Attributes:
        rank: 对应候选序号（从 1 起）。
        digest: 图定义指纹（重建后重算，校验定义身份）。
        ok: 重建/编译/单回合收尾全部通过（False = 校验失败留痕）。
        executed: 是否执行了单回合（False = 仅重建级校验）。
        terminal: 单回合终止原因（执行过时；重建级 = None）。
        error: 失败原因（重建失败/执行失败/异常收尾；None = 通过）。
    """

    rank: int
    digest: str
    ok: bool
    executed: bool = False
    terminal: str | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "rank": self.rank,
            "digest": self.digest,
            "ok": self.ok,
            "executed": self.executed,
            "terminal": self.terminal,
            "error": self.error,
        }


@dataclass(frozen=True, slots=True)
class AssemblyResult:
    """组装结果（只读候选清单 + 观测统计 + 验证/审计留痕）。

    Attributes:
        candidates: 候选路径（按证据分降序；空 = 无解或零生效）。
        fingerprint: 首候选图定义指纹（Graph.digest 规范摘要；空 = 无候选）。
        cold_start_index: 冷启动指数（有证据边数 / 候选边数）。
        exploration_mode: 探索模式判定（指数 < 0.3 = 探索模式）。
        multipath_signal: 多径触发信号（top-1/top-2 候选边证据判据；
            只给信号，触发决策归使用方——本步只记录不裁决）。
        fallback_reason: 兜底原因（草稿层失败时标注；算法层无解亦标注）。
        llm_attempts: 草稿源调用次数（0 = 未启用草稿层）。
        stats: 统计口径（beam_extensions / edge_score_calls /
            repair_attempts / llm_attempts）——规模基准与审计用。
        canary: 各候选的 canary 验证结论（重建 + 单回合；指令入口
            装配时产出，只读组装不产出——观测侧零影响）。
        audit: 本结果随附的审计留痕（append-only 记录；落库归
            sink/audit_sink 回调，本字段只携带不落库）。
    """

    candidates: tuple[AssemblyCandidate, ...] = ()
    fingerprint: str = ""
    cold_start_index: float = 0.0
    exploration_mode: bool = False
    multipath_signal: bool = False
    fallback_reason: str | None = None
    llm_attempts: int = 0
    stats: dict[str, int] = field(default_factory=dict)
    canary: tuple[CanaryVerdict, ...] = ()
    audit: tuple[dict[str, Any], ...] = ()

    @property
    def is_empty(self) -> bool:
        return not self.candidates

    def to_dict(self) -> dict[str, Any]:
        return {
            "candidates": [c.to_dict() for c in self.candidates],
            "fingerprint": self.fingerprint,
            "cold_start_index": self.cold_start_index,
            "exploration_mode": self.exploration_mode,
            "multipath_signal": self.multipath_signal,
            "fallback_reason": self.fallback_reason,
            "llm_attempts": self.llm_attempts,
            "stats": dict(self.stats),
            "canary": [v.to_dict() for v in self.canary],
            "audit": [dict(r) for r in self.audit],
        }


# ── 候选链校验（纯函数；自组装基础语义）──────────────────────────

def validate_chain(
    chain: Sequence[str],
    *,
    pool: Mapping[str, NodeContract],
    goal_fields: Sequence[str],
    entry_fields: Sequence[str] = (),
    max_safety_tier: int = DEFAULT_MAX_SAFETY_TIER,
    state_schema: StateSchema | None = None,
) -> tuple[bool, list[str]]:
    """候选链校验：池成员 + 唯一性 + 前缀可达性（弱校验）+ 目标覆盖。

    多源汇聚合法：序列中每个结点的必填输入 ⊆ 入口 ∪ 前缀结点产出并集；
    高安全结点按放行档位剪枝（安全档逐结点检查）。理由序稳定可断言。
    """
    if not chain:
        return False, ["候选链为空"]
    reasons: list[str] = []
    seen: set[str] = set()
    for name in chain:
        if name not in pool:
            reasons.append(f"结点未知: {name}")
        elif name in seen:
            reasons.append(f"结点重复: {name}")
        seen.add(name)
    if reasons:
        return False, reasons
    contracts = [pool[name] for name in chain]
    _prefix_ok, prefix_reasons = validate_prefix_reachability(
        contracts,
        entry_fields=entry_fields,
        max_safety_tier=max_safety_tier,
        state_schema=state_schema,
    )
    reasons.extend(prefix_reasons)
    available = set(entry_fields)
    for name in chain:
        available |= produced_field_names(pool[name].output_schema)
    missing_goal = sorted(set(goal_fields) - available)
    if missing_goal:
        reasons.append(f"未覆盖目标字段: {'、'.join(missing_goal)}")
    return (not reasons), reasons


# ── 草稿解析（纯函数）────────────────────────────────────────────

def parse_draft_chain(text: str) -> tuple[str, ...] | None:
    """草稿解析：提取 JSON 字符串数组（容忍 ```json 包裹与空白）。

    空响应/非 JSON/非字符串数组 = None（调用方不重试直接兜底）。
    """
    if not text or not text.strip():
        return None
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.M).strip()
    try:
        data = json.loads(cleaned)
    except (ValueError, TypeError):
        return None
    if not isinstance(data, list) or not all(
        isinstance(item, str) and item for item in data
    ):
        return None
    return tuple(data)


# ── 算法自动修复算子集（有名字的图编辑；每算子后重跑可达性校验）──

def _chain_available(
    chain: Sequence[str],
    pool: Mapping[str, NodeContract],
    entry_fields: Sequence[str],
) -> set[str]:
    available = set(entry_fields)
    for name in chain:
        contract = pool.get(name)
        if contract is None:
            continue  # 未知结点（待替换位）无产出信息，跳过
        available |= produced_field_names(contract.output_schema)
    return available


def replace_node(
    chain: Sequence[str],
    *,
    pool: Mapping[str, NodeContract],
    goal_fields: Sequence[str],
    entry_fields: Sequence[str] = (),
    max_safety_tier: int = DEFAULT_MAX_SAFETY_TIER,
    state_schema: StateSchema | None = None,
) -> tuple[str, ...] | None:
    """替换算子：结点 → 可达等价结点（输出覆盖不缩水、输入可达）。

    逐位尝试池内候选（排除自身与既有重复），产出即校验——保证替换后
    目标覆盖不丢失；无可达等价结点 = None。
    """
    base = tuple(chain)
    for i in range(len(base)):
        for alt in pool:
            if alt == base[i] or alt in base:
                continue
            candidate = (*base[:i], alt, *base[i + 1:])
            ok, _ = validate_chain(
                candidate,
                pool=pool,
                goal_fields=goal_fields,
                entry_fields=entry_fields,
                max_safety_tier=max_safety_tier,
                state_schema=state_schema,
            )
            if ok:
                return candidate
    return None


def add_branch(
    chain: Sequence[str],
    *,
    pool: Mapping[str, NodeContract],
    goal_fields: Sequence[str],
    entry_fields: Sequence[str] = (),
    max_safety_tier: int = DEFAULT_MAX_SAFETY_TIER,
    state_schema: StateSchema | None = None,
) -> tuple[str, ...] | None:
    """补链算子：缺口字段 → 补一条前置生产链（多源汇聚合法）。

    缺口 = 某结点必填输入不被前缀覆盖，或目标字段不被全链覆盖；生产链
    经正向链式搜索找出（排除既有链结点防重复），前置于首个消费结点
    （目标缺口则追加于链尾）；产物即校验。
    """
    base = tuple(chain)
    for i, name in enumerate(base):
        contract = pool.get(name)
        if contract is None:
            continue  # 未知结点由替换算子处理，补链算子不触碰
        prefix = set(entry_fields)
        for prev in base[:i]:
            prev_contract = pool.get(prev)
            if prev_contract is None:
                continue
            prefix |= produced_field_names(prev_contract.output_schema)
        missing = sorted(set(required_field_names(contract.input_schema)) - prefix)
        if not missing:
            continue
        producers = _forward_search(
            missing,
            tuple(sorted(prefix)),
            pool,
            beam_width=DEFAULT_BEAM_WIDTH,
            max_depth=DEFAULT_MAX_PATH_LENGTH,
            max_safety_tier=max_safety_tier,
            exclude=set(base),
        )
        if not producers:
            return None
        candidate = base[:i] + producers[0] + base[i:]
        ok, _ = validate_chain(
            candidate,
            pool=pool,
            goal_fields=goal_fields,
            entry_fields=entry_fields,
            max_safety_tier=max_safety_tier,
            state_schema=state_schema,
        )
        if ok:
            return candidate
        return None
    missing_goal = sorted(set(goal_fields) - _chain_available(base, pool, entry_fields))
    if not missing_goal:
        return None
    producers = _forward_search(
        missing_goal,
        tuple(sorted(_chain_available(base, pool, entry_fields))),
        pool,
        beam_width=DEFAULT_BEAM_WIDTH,
        max_depth=DEFAULT_MAX_PATH_LENGTH,
        max_safety_tier=max_safety_tier,
        exclude=set(base),
    )
    if not producers:
        return None
    candidate = base + producers[0]
    ok, _ = validate_chain(
        candidate,
        pool=pool,
        goal_fields=goal_fields,
        entry_fields=entry_fields,
        max_safety_tier=max_safety_tier,
        state_schema=state_schema,
    )
    return candidate if ok else None


def remove_node(
    chain: Sequence[str],
    *,
    pool: Mapping[str, NodeContract],
    goal_fields: Sequence[str],
    entry_fields: Sequence[str] = (),
    max_safety_tier: int = DEFAULT_MAX_SAFETY_TIER,
    state_schema: StateSchema | None = None,
) -> tuple[str, ...] | None:
    """剪枝算子：冗余/不可达结点剪除（产出不被任何后继需求也不补目标）。

    从链尾向链首尝试——优先剪冗余尾结点（形态退化修复的确定性选择）；
    剪除后校验须仍可达；无可剪结点（删除任何结点都会破坏目标覆盖或
    可达性）返回 None。
    """
    base = tuple(chain)
    for i in range(len(base) - 1, -1, -1):
        candidate = base[:i] + base[i + 1:]
        ok, _ = validate_chain(
            candidate,
            pool=pool,
            goal_fields=goal_fields,
            entry_fields=entry_fields,
            max_safety_tier=max_safety_tier,
            state_schema=state_schema,
        )
        if ok:
            return candidate
    return None


def reroute_edge(
    chain: Sequence[str],
    *,
    pool: Mapping[str, NodeContract],
    goal_fields: Sequence[str],
    entry_fields: Sequence[str] = (),
    max_safety_tier: int = DEFAULT_MAX_SAFETY_TIER,
    state_schema: StateSchema | None = None,
) -> tuple[str, ...] | None:
    """改接算子：结点重新落位（生产者前置 / 消费者后移，补齐覆盖顺序）。

    把链中任一结点移动到另一位置（等价于改写前后邻接边），移动后即
    校验；同一时刻首达合法改接即收（确定性顺序）；无合法改接返回 None。
    """
    base = tuple(chain)
    for i in range(len(base)):
        for j in range(len(base)):
            if j == i:
                continue
            node = base[i]
            rest = base[:i] + base[i + 1:]
            candidate = (*rest[:j], node, *rest[j:])
            if candidate == base:
                continue
            ok, _ = validate_chain(
                candidate,
                pool=pool,
                goal_fields=goal_fields,
                entry_fields=entry_fields,
                max_safety_tier=max_safety_tier,
                state_schema=state_schema,
            )
            if ok:
                return candidate
    return None


# 自动修复算子序（固定顺序驱动：先替换不合产出的结点、再补缺口、剪
# 冗余、最后改接顺序——每算子执行后重跑可达性校验）
_REPAIR_OPERATORS: tuple[Callable[..., tuple[str, ...] | None], ...] = (
    replace_node,
    add_branch,
    remove_node,
    reroute_edge,
)


def repair_chain(
    chain: Sequence[str],
    *,
    pool: Mapping[str, NodeContract],
    goal_fields: Sequence[str],
    entry_fields: Sequence[str] = (),
    max_safety_tier: int = DEFAULT_MAX_SAFETY_TIER,
    state_schema: StateSchema | None = None,
    max_rounds: int = MAX_REPAIR_ROUNDS,
) -> tuple[str, ...] | None:
    """自动修复驱动：按固定算子集逐轮修复，每算子后重跑可达性校验。

    单轮内按 {replace_node → add_branch → remove_node → reroute_edge}
    顺序尝试首个产出合法链的算子；轮数上限 = max_rounds（防算子组合全
    枚举）；修复不可达或既有链已合法不可再进 = None（调用方走全量算法
    重组装兜底）。
    """
    if not chain:
        return None
    current = tuple(chain)
    for _ in range(max(1, max_rounds)):
        ok, _ = validate_chain(
            current,
            pool=pool,
            goal_fields=goal_fields,
            entry_fields=entry_fields,
            max_safety_tier=max_safety_tier,
            state_schema=state_schema,
        )
        if ok:
            return current
        progressed = False
        for op in _REPAIR_OPERATORS:
            repaired = op(
                current,
                pool=pool,
                goal_fields=goal_fields,
                entry_fields=entry_fields,
                max_safety_tier=max_safety_tier,
                state_schema=state_schema,
            )
            if repaired is None or repaired == current:
                continue
            ok, _ = validate_chain(
                repaired,
                pool=pool,
                goal_fields=goal_fields,
                entry_fields=entry_fields,
                max_safety_tier=max_safety_tier,
                state_schema=state_schema,
            )
            if ok:
                current = repaired
                progressed = True
                break
        if not progressed:
            return None
    ok, _ = validate_chain(
        current,
        pool=pool,
        goal_fields=goal_fields,
        entry_fields=entry_fields,
        max_safety_tier=max_safety_tier,
        state_schema=state_schema,
    )
    return current if ok else None


# ── 正向链式搜索（schema 反推纯算法）─────────────────────────────

def _forward_search(
    goal_fields: Sequence[str],
    entry_fields: Sequence[str],
    pool: Mapping[str, NodeContract],
    *,
    beam_width: int = DEFAULT_BEAM_WIDTH,
    max_depth: int = DEFAULT_MAX_PATH_LENGTH,
    max_safety_tier: int = DEFAULT_MAX_SAFETY_TIER,
    exclude: Collection[str] = (),
    edge_score_lookup: Callable[[str, str], float] | None = None,
    stats: dict[str, int] | None = None,
) -> list[tuple[str, ...]]:
    """正向链式（前缀可达性）beam 搜索：从入口字段出发逐层扩边至目标覆盖。

    多源汇聚合法：结点的必填输入 ⊆ 入口 ∪ 前缀产出并集（弱校验——相邻
    覆盖会误杀多输入结点）。防发散：只扩展产出新增的结点；防重复：路径
    内不重复、无环；安全档：翻档结点在扩展期即剪枝（搜索即保证合法）。

    Beam 排序 = 目标相关度优先（已覆盖 ∩ 目标字段数降序）→ 末边证据分
    （edge_score_lookup 注入时，未注入按 0 计）→ 路径长度升序 → 末结点
    名字典序（确定性）——实验定稿：全量覆盖贪婪排序会把可并行分支在第
    3 层挤出 beam（排序必须目标相关度优先，否则 market_report 类目标
    永远不可达）。

    Returns:
        全部解出目标的候选链（beam 宽度内；按搜索序，去重）。
    """
    goal = set(goal_fields)
    found: list[tuple[str, ...]] = []
    seen_found: set[tuple[str, ...]] = set()
    beam = max(1, int(beam_width))
    depth = max(1, int(max_depth))
    exclude_set = set(exclude)
    # 候选形态：(链, 已覆盖字段, 末边证据分)
    candidates: list[tuple[tuple[str, ...], frozenset[str], float]] = [
        ((), frozenset(entry_fields), 0.0)
    ]
    visited: set[tuple[tuple[str, ...], frozenset[str]]] = set()
    for _ in range(depth):
        if not candidates:
            break
        nxt: list[tuple[tuple[str, ...], frozenset[str], float]] = []
        for path, covered, _last_score in candidates:
            key = (path, covered)
            if key in visited:
                continue
            visited.add(key)
            for type_name, contract in pool.items():
                if type_name in exclude_set or type_name in path:
                    continue
                if contract.safety_tier > max_safety_tier:
                    continue  # 安全档剪枝：高安全结点不可进低信任路径
                required = required_field_names(contract.input_schema)
                if not required <= set(covered):
                    continue
                if path and required <= set(entry_fields):
                    # 根结点剪枝：入口字段即满足的结点只作链首——置于链中可
                    # 置换到链首（其后置冗余），裁剪不减完整性（多根目标由
                    # 外层分支机制承担，线性链只表达单一连贯目标）
                    continue
                produced = produced_field_names(contract.output_schema)
                new_covered = frozenset(set(covered) | produced)
                if new_covered == covered:
                    continue  # 无新增产出的结点跳过（防发散）
                new_path = (*path, type_name)
                if goal <= set(new_covered):
                    if new_path not in seen_found:
                        seen_found.add(new_path)
                        found.append(new_path)
                    continue  # 已解出目标，不再扩展
                last = (
                    edge_score_lookup(path[-1], type_name)
                    if path and edge_score_lookup
                    else 0.0
                )
                nxt.append((new_path, new_covered, last))
        if not nxt:
            break
        # 排序：目标相关度优先 → 末边证据分 → 深度 → 末结点名（确定性）
        nxt.sort(
            key=lambda item: (
                -len(set(item[1]) & goal),
                -item[2],
                len(item[0]),
                item[0][-1],
            )
        )
        candidates = nxt[:beam]
        if stats is not None:
            stats[STATS_BEAM_EXTENSIONS] = stats.get(STATS_BEAM_EXTENSIONS, 0) + len(nxt)
    return found


# ── 内存暴力 top-N 兜底检索器（默认注入；与向量栈解耦）───────────

class InMemoryPoolRetriever:
    """内存暴力 top-N 兜底（默认注入实现；向量栈上线后换注入实现复测）。

    计分 = 产出字段 ∩ 目标字段数（检索只管「把谁拿给草稿源看」——检索
    相似度 ≠ 信任：信任只来自运行结果（边证据），两套分数永不混用）。
    查询串 = 引擎约定的 JSON（goal/entry/pool 字段名清单）。
    """

    name = "in_memory_pool"

    def __init__(self, pool: Mapping[str, NodeContract]) -> None:
        self._pool = dict(pool)

    async def retrieve(self, query: str, *, limit: int) -> list[RetrievedChunk]:
        goal: set[str] = set()
        try:
            payload = json.loads(query) if isinstance(query, str) else {}
            goal = set(payload.get("goal") or ())
        except (ValueError, TypeError):
            goal = set()
        scored: list[tuple[int, str, NodeContract]] = []
        for type_name, contract in self._pool.items():
            produced = produced_field_names(contract.output_schema)
            scored.append((len(set(produced) & goal), type_name, contract))
        scored.sort(key=lambda item: (-item[0], item[1]))
        capped = max(1, min(int(limit or 1), len(scored)))
        denom = max(1, len(goal))
        return [
            RetrievedChunk(
                source=self.name,
                doc_id=type_name,
                text=_node_text(type_name, contract),
                relevance=overlap / denom,
            )
            for overlap, type_name, contract in scored[:capped]
        ]


def _node_text(type_name: str, contract: NodeContract) -> str:
    """结点摘要文本（检索结果文本；供草稿层上下文展示）。"""
    inputs = sorted(required_field_names(contract.input_schema))
    outputs = sorted(produced_field_names(contract.output_schema))
    return (
        f"{type_name} 输入={','.join(inputs) or '无'} "
        f"输出={','.join(outputs) or '无'} 安全档={contract.safety_tier}"
    )


def _snapshot_edge(
    rows: Sequence[Mapping[str, Any]], src: str, dst: str
) -> EdgeEvidence | None:
    """快照行 → 边证据（按类型对匹配；未命中 = 零证据先验下界）。

    匹配口径 = 类型级（variant_hash 空）：变体专属证据不参与缓存路径
    评分，与组装侧证据索引同口径。
    """
    for row in rows:
        if not row.get("variant_hash", ""):
            if row.get("src_type") == src and row.get("dst_type") == dst:
                return EdgeEvidence.from_dict(row)
    return None


def _graph_chain(graph: Graph) -> tuple[str, ...]:
    """线性链图 → 节点名序（入口起沿边走；图定义数据序列化不保节点序，
    命中重建后必须按结构还原链序——评分/展示依赖链序）。"""
    chain: list[str] = []
    current = graph.entry
    for _ in range(len(graph.node_bindings)):
        if current is None or current in chain:
            break
        chain.append(current)
        edge_list = graph.edges.get(current, ())
        if not edge_list:
            break
        current = edge_list[0].target
    return tuple(chain)


# ── 组装器 ───────────────────────────────────────────────────────

@dataclass(frozen=True, slots=True)
class _ContractView:
    """契约预解析视图（字段名集缓存；避免大规模池重复计算）。"""

    required: frozenset[str]
    produced: frozenset[str]
    contract: NodeContract


class PathAssembler:
    """只读路径组装器（出候选计划供观察/审计，不接执行路径）。

    Args:
        registry: 结点类型注册表（池子底座；只取带契约的类型参与组装——
            无契约结点不参与组装，仅可被手绘图引用，旧行为零破坏）。
        evidence_store: 边证据存储（只读；None = 无证据，全部按零证据
            先验下界计分）。
        retriever: 候选缩小检索器（None = 默认注入内存暴力 top-N；向量
            栈上线后宿主注入新实现复测）。
        config: 机制装配开关（None = 直连可用；enabled=False = 零生效——
            与增量接入的开关语义对齐，默认关）。
        sink: 审计记录落库回调（append-only；本模块只产出记录不落库）。
        now: 当前时间戳（确定性注入；None = 实时）。
        cache: 指纹缓存存储（flag 开启时构造/注入；None = 缓存零参与——
            无查找无写入，先例层不生效）。
        model_id: 模型标识（组装请求上下文指纹入键；与沉淀侧同一标识，
            变化 = 旧条目降级不命中）。
        cache_epsilon: 抽样重装概率（命中时以 ε 概率绕过缓存重新组装
            对比；ε≈0 = 关闭，默认引擎钉死，使用方仅覆盖权）。
    """

    def __init__(
        self,
        *,
        registry: NodeTypeRegistry,
        evidence_store: EdgeEvidenceStore | None = None,
        retriever: Retriever | None = None,
        config: PathAssemblyConfig | None = None,
        sink: Callable[[dict[str, Any]], Any] | None = None,
        now: float | None = None,
        cache: FingerprintCacheStore | None = None,
        model_id: str = "",
        cache_epsilon: float = DEFAULT_CACHE_EPSILON,
    ) -> None:
        self._registry = registry
        self._evidence = evidence_store
        self._retriever = retriever
        self._config = config
        self._sink = sink
        self._now = now
        self._cache = cache
        self._model_id = model_id
        self._cache_epsilon = max(0.0, float(cache_epsilon))

    def contract_pool(self) -> dict[str, NodeContract]:
        """池子快照：注册表内全部带契约的类型（类型名 → 契约）。"""
        pool: dict[str, NodeContract] = {}
        for type_name in self._registry.types():
            contract = self._registry.contract_for(type_name)
            if contract is not None:
                pool[type_name] = contract
        return pool

    def _index_pool(self, pool: Mapping[str, NodeContract]) -> dict[str, _ContractView]:
        return {
            type_name: _ContractView(
                required=required_field_names(contract.input_schema),
                produced=produced_field_names(contract.output_schema),
                contract=contract,
            )
            for type_name, contract in pool.items()
        }

    async def _evidence_index(self, domain: str) -> dict[tuple[str, str, str, str, str], EdgeEvidence]:
        """边证据索引（一次域内查询；组装全程在内存中计分——百万结点量级
        逐边查询不可行，域内枚举 + 内存索引是规模前提）。

        索引键含实例粒度维（variant_hash）：组装是类型级口径，只消费
        类型级行（variant_hash 空 = 旧行空值归类型级），变体专属证据
        不混入类型级评分，也不互相覆盖。
        """
        if self._evidence is None:
            return {}
        rows = await self._evidence.list_edges(domain)
        return {
            (
                row.src_type,
                row.dst_type,
                row.key.src_contract_version,
                row.key.dst_contract_version,
                row.key.variant_hash,
            ): row
            for row in rows
            if not row.key.variant_hash
        }

    def _cache_key(self, request: AssemblyRequest, goal: tuple[str, ...]) -> str:
        """缓存主键：请求侧纯函数（目标/入口字段序无关 + 域 + 档位 + 模型）。"""
        return request_fingerprint(
            goal_fields=goal,
            entry_fields=request.entry_fields,
            domain=request.domain,
            max_safety_tier=request.max_safety_tier,
            model_id=self._model_id,
        )

    async def _invalidate_cache(
        self, cache_key: str, *, reason: str, stats: dict[str, int]
    ) -> None:
        cache = self._cache
        if cache is None:
            return
        await cache.invalidate(cache_key, reason=reason)
        stats[STATS_CACHE_INVALIDATIONS] = stats.get(STATS_CACHE_INVALIDATIONS, 0) + 1

    async def _validate_cache_entry(
        self,
        cache_key: str,
        entry: FingerprintCacheEntry,
        pool: Mapping[str, NodeContract],
        evidence_rows: Sequence[Mapping[str, Any]],
        stats: dict[str, int],
    ) -> str:
        """缓存条目三钉校验：契约版本快照 / 模型 id / 证据漂移。

        返回三态：hit=可命中；drift=证据漂移失效（条目保留供顶替对比）；
        stale=版本/模型钉死失效（降级不命中，不参与顶替）。
        """
        if entry.model_id != self._model_id:
            await self._invalidate_cache(cache_key, reason="模型变更", stats=stats)
            return "stale"
        for type_name, version in entry.contract_snapshot:
            contract = pool.get(type_name)
            if contract is not None and str(contract.version) != version:
                await self._invalidate_cache(
                    cache_key, reason="契约版本漂移", stats=stats
                )
                return "stale"
            if contract is None and version != DEFAULT_CONTRACT_VERSION:
                await self._invalidate_cache(cache_key, reason="类型已移除", stats=stats)
                return "stale"
        if self._evidence is not None and evidence_drifted(
            entry.evidence_snapshot, evidence_rows
        ):
            await self._invalidate_cache(cache_key, reason="证据漂移", stats=stats)
            return "drift"
        return "hit"

    @staticmethod
    def _cached_chain(entry: FingerprintCacheEntry) -> tuple[str, ...]:
        """缓存路径类型链（入口起沿边走还原链序；退化条目仅携指纹 = 空链）。"""
        path = entry.path if isinstance(entry.path, dict) else {}
        nodes = path.get("nodes")
        edges = path.get("edges")
        start = path.get("entry")
        if not isinstance(nodes, dict) or not isinstance(edges, dict):
            return ()
        chain: list[str] = []
        current = start
        for _ in range(len(nodes)):
            spec = nodes.get(current) if isinstance(current, str) else None
            if not isinstance(spec, dict):
                break
            chain.append(str(spec.get("type", current)))
            edge_list = edges.get(current)
            target = (
                edge_list[0].get("target")
                if isinstance(edge_list, list) and edge_list
                and isinstance(edge_list[0], dict)
                else None
            )
            if not isinstance(target, str) or target in chain:
                break
            current = target
        return tuple(chain)

    def _score_from_snapshot(
        self,
        chain: Sequence[str],
        snapshot_rows: Sequence[Mapping[str, Any]],
    ) -> float:
        """缓存路径证据分：按快照各边 s/f 计数重算（与组装评分同口径）。"""
        total = 0.0
        edge_count = 0
        for src, dst in itertools.pairwise(chain):
            evidence = _snapshot_edge(snapshot_rows, src, dst)
            total += edge_score(evidence, now=self._now).score
            edge_count += 1
        return total / max(edge_count, 1) if edge_count else 0.0

    def _cold_index_from_snapshot(
        self,
        chain: Sequence[str],
        snapshot_rows: Sequence[Mapping[str, Any]],
    ) -> float:
        """冷启动指数（命中口径）：有快照证据的边数 / 候选边数。"""
        candidate_edges: set[tuple[str, str]] = set()
        evidenced = 0
        for src, dst in itertools.pairwise(chain):
            if (src, dst) in candidate_edges:
                continue
            candidate_edges.add((src, dst))
            if _snapshot_edge(snapshot_rows, src, dst) is not None:
                evidenced += 1
        return cold_start_index(evidenced, len(candidate_edges))

    async def _result_from_cache(
        self,
        entry: FingerprintCacheEntry,
        stats: dict[str, int],
    ) -> AssemblyResult | None:
        """命中构造：缓存路径图定义重建 → 单候选结果（含图定义，可走 canary）。

        重建失败（退化条目仅携指纹/结构损坏）＝ 按未命中处理，不静默
        返回残缺产物。
        """
        try:
            graph = Graph.from_dict(
                dict(entry.path), registry=self._registry, validate=True
            )
        except GraphDefinitionError as exc:
            logger.warning(f"缓存路径重建失败（按未命中处理）: {exc}")
            return None
        # 图定义数据序列化不保节点序：按入口→边序还原绑定序（链序一致）
        chain = _graph_chain(graph)
        if len(chain) == len(graph.node_bindings):
            ordered = {name: graph.node_bindings[name] for name in chain}
            graph.node_bindings.clear()
            graph.node_bindings.update(ordered)
        type_chain = tuple(
            graph.node_bindings[name].type_name for name in chain if name in graph.node_bindings
        )
        score = self._score_from_snapshot(type_chain, entry.evidence_snapshot)
        cold_index = self._cold_index_from_snapshot(type_chain, entry.evidence_snapshot)
        candidate = AssemblyCandidate(
            rank=1,
            source=CANDIDATE_SOURCE_CACHE,
            repaired=False,
            graph=graph,
            score=score,
        )
        stats[STATS_CACHE_HITS] = stats.get(STATS_CACHE_HITS, 0) + 1
        return AssemblyResult(
            candidates=(candidate,),
            fingerprint=graph_fingerprint(graph),
            cold_start_index=cold_index,
            exploration_mode=is_exploration_mode(cold_index),
            multipath_signal=False,
            llm_attempts=0,
            stats=stats,
        )

    async def _maybe_replace_cache_entry(
        self,
        cache: FingerprintCacheStore,
        cache_key: str,
        entry: FingerprintCacheEntry,
        request: AssemblyRequest,
        result: AssemblyResult,
        evidence_rows: Sequence[Mapping[str, Any]],
        replace_reason: str,
        stats: dict[str, int],
    ) -> None:
        """顶替对比：失效/抽样重装后的重组装结果与缓存条目标的分比较，
        更高才顶替（fingerprint_replace 审计留痕；分不高 = 顶替不成立）。
        顶替写入 = 缓存维护写（新路径 + 当前证据快照，计数清零重新起算）。"""
        if result.is_empty:
            return
        new_score = result.candidates[0].score
        cached_score = self._score_from_snapshot(
            self._cached_chain(entry), entry.evidence_snapshot
        )
        if new_score <= cached_score:
            return
        new_graph = result.candidates[0].graph
        stats[STATS_CACHE_REPLACEMENTS] = stats.get(STATS_CACHE_REPLACEMENTS, 0) + 1
        if self._sink is not None:
            self._sink(
                fingerprint_replace_audit_record(
                    domain=request.domain,
                    fingerprint=graph_fingerprint(new_graph),
                    old_fingerprint=entry.path_fingerprint,
                    reason=replace_reason,
                    old_score=cached_score,
                    new_score=new_score,
                    ts=self._now if self._now is not None else time.time(),
                )
            )
        await cache.upsert(
            cache_key,
            path=new_graph.to_dict(),
            evidence_snapshot=evidence_rows,
            model_id=self._model_id,
            gate_passed=True,
            path_fingerprint=graph_fingerprint(new_graph),
            domain=request.domain,
        )

    def _edge_score_of(
        self,
        src: str,
        dst: str,
        index: dict[str, _ContractView],
        evidence_index: dict[tuple[str, str, str, str], EdgeEvidence],
        stats: dict[str, int],
    ) -> float:
        """边证据分（评分公式复用 edge_evidence；零证据 = 先验下界）。"""
        key = (
            src,
            dst,
            str(index[src].contract.version),
            str(index[dst].contract.version),
            "",
        )
        evidence = evidence_index.get(key)
        score = edge_score(evidence, now=self._now).score
        stats[STATS_EDGE_SCORE_CALLS] = stats.get(STATS_EDGE_SCORE_CALLS, 0) + 1
        return score

    async def _window_summaries(
        self,
        request: AssemblyRequest,
        goal: tuple[str, ...],
        pool: Mapping[str, NodeContract],
        envelope: AssemblyEnvelope,
    ) -> tuple[NodeSummary, ...]:
        """草稿上下文窗口：检索 top-N 契约摘要（域过滤后第二层缩小）。"""
        retriever = self._retriever or InMemoryPoolRetriever(pool)
        query = json.dumps(
            {
                "goal": sorted(goal),
                "entry": sorted(request.entry_fields),
                "pool": sorted(pool),
            },
            ensure_ascii=False,
        )
        window = max(1, min(int(envelope.llm_window), max(1, len(pool))))
        try:
            chunks = await retriever.retrieve(query, limit=window)
        except Exception as exc:
            logger.warning(f"组装候选缩小检索失败（兜底内存暴力）: {exc}")
            chunks = await InMemoryPoolRetriever(pool).retrieve(query, limit=window)
        summaries: list[NodeSummary] = []
        for chunk in chunks:
            contract = pool.get(chunk.doc_id)
            if contract is None:
                continue
            summaries.append(NodeSummary.from_contract(chunk.doc_id, contract))
        if not summaries:
            for type_name in sorted(pool):
                summaries.append(NodeSummary.from_contract(type_name, pool[type_name]))
                if len(summaries) >= window:
                    break
        return tuple(summaries)

    async def _draft_path(
        self,
        request: AssemblyRequest,
        goal: tuple[str, ...],
        pool: Mapping[str, NodeContract],
        envelope: AssemblyEnvelope,
        stats: dict[str, int],
    ) -> tuple[list[tuple[tuple[str, ...], str, bool]], str | None]:
        """草稿层：草稿源 → 逐边校验 → 算法自动修复；空/非 JSON 不重试。

        返回 (候选链清单, 兜底原因)；兜底原因非 None = 草稿路径失败，ALGORITHM
        层候选即为全量算法重组装兜底。重试上限 = 重试次数上限（首次 +
        重试 = 最多 3 次调用）；空响应/非 JSON 一律不重试直接兜底。
        """
        provider = request.draft_provider
        if provider is None:
            return [], None
        summaries = await self._window_summaries(request, goal, pool, envelope)
        feedback = ""
        fallback_reason: str | None = None
        max_calls = max(1, int(envelope.llm_retry_limit) + 1)
        for attempts in range(1, max_calls + 1):
            stats[STATS_LLM_ATTEMPTS] = attempts
            context = AssemblyDraftContext(
                goal_fields=goal,
                entry_fields=request.entry_fields,
                node_summaries=summaries,
                feedback=feedback,
            )
            raw = await provider.draft(context)
            chain = parse_draft_chain(raw)
            if chain is None:
                # 空响应/非 JSON：不重试直接兜底（重试闭环对环境抖动无意义）
                return [], f"草稿解析失败（空响应或非 JSON，共 {attempts} 次调用）"
            ok, reasons = validate_chain(
                chain,
                pool=pool,
                goal_fields=goal,
                entry_fields=request.entry_fields,
                max_safety_tier=request.max_safety_tier,
                state_schema=request.state_schema,
            )
            if ok:
                return [(chain, CANDIDATE_SOURCE_DRAFT, False)], None
            # 语义偏好 vs 结构可达冲突：先走算法自动修复（实验定稿：重试
            # 闭环不可靠——模型固执不改，需第三级算法自动修复）
            stats[STATS_REPAIR_ATTEMPTS] = stats.get(STATS_REPAIR_ATTEMPTS, 0) + 1
            repaired = repair_chain(
                chain,
                pool=pool,
                goal_fields=goal,
                entry_fields=request.entry_fields,
                max_safety_tier=request.max_safety_tier,
                state_schema=request.state_schema,
            )
            if repaired is not None:
                ok, _ = validate_chain(
                    repaired,
                    pool=pool,
                    goal_fields=goal,
                    entry_fields=request.entry_fields,
                    max_safety_tier=request.max_safety_tier,
                    state_schema=request.state_schema,
                )
                if ok:
                    return [(repaired, CANDIDATE_SOURCE_DRAFT, True)], None
            feedback = "; ".join(reasons)
            fallback_reason = "草稿非法且算法修复不可达（重试耗尽，转全量算法重组装兜底）"
        return [], fallback_reason or "草稿未通过校验且修复不可达"

    async def _rank_chains(
        self,
        chains: Sequence[
            tuple[tuple[str, ...], str, bool]
        ],
        index: dict[str, _ContractView],
        evidence_index: dict[tuple[str, str, str, str], EdgeEvidence],
        stats: dict[str, int],
    ) -> list[tuple[tuple[str, ...], str, bool, float]]:
        """证据评分 + beam top-k：全链边证据分平均值排序（确定性 tie-break）。

        平均而非求和：零证据时每条边同取先验下界，求和会系统性偏好长链
        （多绕的链路反而「加分」）；平均 + 链长升序 = 证据相同时偏短链
        （便宜路径优先，与成本 tie-break 同一取向）。排序 = 平均分降序 →
        链长升序 → 链序字典序（冷启动零分并列可断言）。
        """
        scored: list[tuple[tuple[str, ...], str, bool, float]] = []
        for chain, source, repaired in chains:
            total = 0.0
            for src, dst in itertools.pairwise(chain):
                total += self._edge_score_of(src, dst, index, evidence_index, stats)
            edges = max(1, len(chain) - 1)
            scored.append((chain, source, repaired, total / edges))
        seen: set[tuple[str, ...]] = set()
        unique: list[tuple[tuple[str, ...], str, bool, float]] = []
        for item in scored:
            if item[0] in seen:
                continue  # 同链去重（保留先出现者 = 算法层优先）
            seen.add(item[0])
            unique.append(item)
        unique.sort(key=lambda item: (-item[3], len(item[0]), item[0]))
        return unique

    async def _multipath_signal(
        self,
        top1: AssemblyCandidate | None,
        top2: AssemblyCandidate | None,
        index: dict[str, _ContractView],
        evidence_index: dict[tuple[str, str, str, str], EdgeEvidence],
    ) -> bool:
        """多径触发信号（判据复用 edge_evidence；只给信号不裁决）。

        取 top-1/top-2 候选收尾边的证据行（None = 零证据）交由
        :func:`~ink_engine.core.edge_evidence.multi_path_trigger` 判定——
        样本不足（N<5）或分差不足（<0.15）触发；证据强绝不触发；冷启动
        因样本不足自然落入触发分支。
        """

        def tail_evidence(candidate: AssemblyCandidate | None) -> EdgeEvidence | None:
            if candidate is None:
                return None
            chain = candidate.chain
            if len(chain) < 2:
                return None
            src, dst = chain[-2], chain[-1]
            return evidence_index.get(
                (
                    src,
                    dst,
                    str(index[src].contract.version),
                    str(index[dst].contract.version),
                    "",
                )
            )

        return multi_path_trigger(
            tail_evidence(top1), tail_evidence(top2), now=self._now
        )

    async def _cold_start_index(
        self,
        chains: Sequence[tuple[tuple[str, ...], str, bool, float]],
        index: dict[str, _ContractView],
        evidence_index: dict[tuple[str, str, str, str], EdgeEvidence],
    ) -> float:
        """冷启动指数 = 有证据边数 / 候选边数（候选 0 = 0.0）。"""
        candidate_edges: set[tuple[str, str]] = set()
        evidenced = 0
        for chain, _source, _repaired, _score in chains:
            for src, dst in itertools.pairwise(chain):
                if (src, dst) in candidate_edges:
                    continue
                candidate_edges.add((src, dst))
                key = (
                    src,
                    dst,
                    str(index[src].contract.version),
                    str(index[dst].contract.version),
                    "",
                )
                if key in evidence_index:
                    evidenced += 1
        return cold_start_index(evidenced, len(candidate_edges))

    def _build_graph(
        self,
        chain: tuple[str, ...],
        pool: Mapping[str, NodeContract],
        request: AssemblyRequest,
        rank: int,
    ) -> Graph:
        """候选链 → 图定义数据（节点 = 类型绑定 + 契约快照；线性链）。"""
        graph = Graph(
            name=request.graph_name or f"assembly.{rank + 1}.{request.domain}",
            entry=chain[0],
        )
        for name in chain:
            graph.add_node_type(name, name, config={}, contract=pool[name])
        for src, dst in itertools.pairwise(chain):
            graph.add_edge(src, dst)
        graph.add_exit(chain[-1])
        return graph

    async def assemble(
        self,
        request: AssemblyRequest,
        envelope: AssemblyEnvelope | None = None,
    ) -> AssemblyResult:
        """执行一次只读组装（出候选计划；不接执行路径）。

        约束：机制开关关闭（config.enabled=False）时零生效——无候选、
        无统计、无回调；池子无带契约结点或目标无字段 = 空结果 + 原因。
        缓存参与（注入缓存实例时）：先例层命中最优先——命中直接返回
        缓存路径候选（含图定义）；未命中走既有组装三产出层。组装完成
        后不入缓存（入库 = 沉淀侧）；仅顶替机制（证据漂移/抽样重装后
        重组装比分更高）写缓存维护条目并留 fingerprint_replace 审计。
        """
        if self._config is not None and not self._config.enabled:
            return AssemblyResult()
        envelope = envelope or AssemblyEnvelope()
        goal = request.goal_fields()
        if not goal:
            return AssemblyResult(fallback_reason="目标 schema 未声明字段")
        pool = self.contract_pool()
        if not pool:
            return AssemblyResult(fallback_reason="结点池无带契约结点")
        stats: dict[str, int] = {
            STATS_BEAM_EXTENSIONS: 0,
            STATS_EDGE_SCORE_CALLS: 0,
            STATS_REPAIR_ATTEMPTS: 0,
            STATS_LLM_ATTEMPTS: 0,
        }
        # ── 先例层：缓存命中（注入缓存实例时参与；未注入 = 零查找零写入）──
        cache = self._cache
        cache_key: str | None = None
        entry: FingerprintCacheEntry | None = None
        comparable = False
        replace_reason: str | None = None
        evidence_rows: list[dict[str, Any]] = []
        if cache is not None:
            stats.update(
                {
                    STATS_CACHE_HITS: 0,
                    STATS_CACHE_MISSES: 0,
                    STATS_CACHE_INVALIDATIONS: 0,
                    STATS_CACHE_REPLACEMENTS: 0,
                }
            )
            if self._evidence is not None:
                evidence_rows = [
                    e.to_dict() for e in await self._evidence.list_edges(request.domain)
                ]
            cache_key = self._cache_key(request, goal)
            entry = await cache.lookup(cache_key)
            if entry is None:
                stats[STATS_CACHE_MISSES] = 1
            else:
                status = await self._validate_cache_entry(
                    cache_key, entry, pool, evidence_rows, stats
                )
                if status == "drift":
                    # 证据漂移失效：重组装后与缓存条目标的分比较，更高则顶替
                    comparable = True
                    replace_reason = REPLACE_REASON_DRIFT
                    stats[STATS_CACHE_MISSES] = 1
                elif status == "stale":
                    # 契约版本/模型钉死失效：降级不命中，不参与顶替
                    entry = None
                    stats[STATS_CACHE_MISSES] = 1
                elif self._cache_epsilon > 0 and random.random() < self._cache_epsilon:
                    # ε 抽样重装：绕过缓存重新组装对比（条目保留供顶替对比）
                    comparable = True
                    replace_reason = REPLACE_REASON_SAMPLE
                    stats[STATS_CACHE_MISSES] = 1
                else:
                    hit = await self._result_from_cache(entry, stats)
                    if hit is not None:
                        if self._sink is not None:
                            self._sink(self._audit_record(request, goal, hit))
                        return hit
                    entry = None
                    stats[STATS_CACHE_MISSES] = 1
        index = self._index_pool(pool)
        evidence_index = await self._evidence_index(request.domain)
        # ① schema 反推（纯算法，全量搜索——无需上下文，池子规模解耦）
        algorithm_chains = _forward_search(
            goal,
            request.entry_fields,
            pool,
            beam_width=envelope.beam_width,
            max_depth=envelope.max_path_length,
            max_safety_tier=request.max_safety_tier,
            edge_score_lookup=(
                lambda src, dst: self._edge_score_of(
                    src, dst, index, evidence_index, stats
                )
            ),
            stats=stats,
        )
        chains: list[tuple[tuple[str, ...], str, bool]] = [
            (chain, CANDIDATE_SOURCE_ALGORITHM, False) for chain in algorithm_chains
        ]
        llm_attempts = 0
        fallback_reason: str | None = None
        # ② LLM 草稿（使用方注入；仅反推解不出时由使用方开启 llm_draft）
        if envelope.llm_draft and request.draft_provider is not None:
            draft_chains, reason = await self._draft_path(
                request, goal, pool, envelope, stats
            )
            chains.extend(draft_chains)
            llm_attempts = stats[STATS_LLM_ATTEMPTS]
            fallback_reason = reason
            if not chains and reason is None:
                fallback_reason = "草稿层未产出候选且算法层无解"
        else:
            stats[STATS_LLM_ATTEMPTS] = 0
        if not chains:
            return AssemblyResult(
                fallback_reason=fallback_reason or "算法层未解出目标覆盖链",
                llm_attempts=llm_attempts,
                stats=stats,
            )
        # 候选合法性兜底过滤（搜索/修复已保证，此处为序列化红线的最终防线：
        # 产物候选必须全链合法——未知/重复/翻档/缺口一律不得进入候选清单）
        pairs: list[tuple[tuple[str, ...], str, bool]] = []
        for chain, source, repaired in chains:
            ok, _ = validate_chain(
                chain,
                pool=pool,
                goal_fields=goal,
                entry_fields=request.entry_fields,
                max_safety_tier=request.max_safety_tier,
                state_schema=request.state_schema,
            )
            if ok:
                pairs.append((chain, source, repaired))
        if not pairs:
            return AssemblyResult(
                fallback_reason=fallback_reason or "全部候选未通过合法性校验",
                llm_attempts=llm_attempts,
                stats=stats,
            )
        # ③ 证据评分 + beam top-k（确定性序）
        ranked = await self._rank_chains(pairs, index, evidence_index, stats)
        top_k = max(1, int(request.top_k))
        selected = ranked[:top_k]
        candidates = tuple(
            AssemblyCandidate(
                rank=rank,
                source=source,
                repaired=repaired,
                graph=self._build_graph(chain, pool, request, rank),
                score=score,
            )
            for rank, (chain, source, repaired, score) in enumerate(selected, 1)
        )
        cold_index = await self._cold_start_index(ranked, index, evidence_index)
        multipath = await self._multipath_signal(
            candidates[0] if candidates else None,
            candidates[1] if len(candidates) > 1 else None,
            index,
            evidence_index,
        )
        fingerprint = graph_fingerprint(candidates[0].graph) if candidates else ""
        result = AssemblyResult(
            candidates=candidates,
            fingerprint=fingerprint,
            cold_start_index=cold_index,
            exploration_mode=is_exploration_mode(cold_index),
            multipath_signal=multipath,
            fallback_reason=fallback_reason,
            llm_attempts=llm_attempts,
            stats=stats,
        )
        if cache is not None and cache_key is not None and entry is not None and comparable:
            await self._maybe_replace_cache_entry(
                cache,
                cache_key,
                entry,
                request,
                result,
                evidence_rows,
                replace_reason or "",
                stats,
            )
        if self._sink is not None:
            self._sink(self._audit_record(request, goal, result))
        return result

    def _audit_record(
        self,
        request: AssemblyRequest,
        goal: tuple[str, ...],
        result: AssemblyResult,
    ) -> dict[str, Any]:
        """组装审计记录（append-only 留痕；历史图定义快照随记录落库）。"""
        return assembly_audit_record(
            request,
            goal,
            result,
            ts=self._now if self._now is not None else time.time(),
        )


def assembly_audit_record(
    request: AssemblyRequest,
    goal: tuple[str, ...],
    result: AssemblyResult,
    *,
    ts: float,
) -> dict[str, Any]:
    """组装审计记录构建（纯函数；指令入口与只读组装共用同一形态）。"""
    return {
        "ts": ts,
        "domain": request.domain,
        "fingerprint": result.fingerprint,
        "goal_fields": list(goal),
        "entry_fields": list(request.entry_fields),
        "candidates": [c.to_dict() for c in result.candidates],
        "llm_attempts": result.llm_attempts,
        "fallback_reason": result.fallback_reason,
        "stats": dict(result.stats),
    }


# ── canary 兼容验证链路（重建 + 单回合；产物执行前的风险前置）──────

def canary_instantiate(
    graph_data: Mapping[str, Any],
    *,
    registry: NodeTypeRegistry,
    edge_registry: Any = None,
) -> Graph:
    """候选图定义数据 → 重建实例（``from_dict(validate=True)`` 口径）。

    重建即校验：结构非法（悬挂入口/未知类型引用/边解析失败）在建图期
    暴露，不延后到执行期。重建图与组装产物同指纹（契约快照随图定义
    数据落库，注册表现状变化不影响重建语义）。
    """
    return Graph.from_dict(
        dict(graph_data), registry=registry, edge_registry=edge_registry, validate=True
    )


@dataclass(frozen=True, slots=True)
class CanaryResult:
    """单回合执行结果（无存储、无预算约束；stub 模型由使用方 RunOptions 注入）。"""

    ok: bool
    reason: str
    final_state: dict[str, Any]
    events_emitted: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "reason": self.reason,
            "final_state": self.final_state,
            "events_emitted": self.events_emitted,
        }


async def canary_round(
    graph: Graph,
    *,
    entry_state: Mapping[str, Any] | None = None,
    options: RunOptions | None = None,
) -> CanaryResult:
    """stub 一回合执行：图合法 + 单回合走通（无存储、无预算约束）。

    校验语义：正常收尾（reply/stop）且无挂起卡 = 可以通过；异常收尾
    （error/budget_exceeded/cancelled）或挂起 = 失败。stub 模型注入归
    使用方（RunOptions 承载——样例模型/传输出口均直接替换）。执行不发
    checkpoint（storage=None）；规模可控（一级图单回合）。
    """
    from .executor import Engine

    engine = Engine(graph, options=options or RunOptions())
    result = await engine.ainvoke(dict(entry_state or {}))
    ok = result.reason in (TerminateReason.REPLY, TerminateReason.STOP) and (
        result.interrupt is None
    )
    return CanaryResult(
        ok=ok,
        reason=result.reason,
        final_state=dict(result.state),
        events_emitted=result.events_emitted,
    )


# ── 组装指令入口（组装产物执行入口；壳侧 op 与策略层调用）──────────

@dataclass(frozen=True, slots=True)
class PathAssemblyRuntime:
    """指令运行期：注册表/证据/开关的持有者，提供组装指令执行入口。

    Args:
        registry: 结点类型注册表（池子底座；带契约类型参与组装）。
        evidence_store: 边证据存储（只读；None = 零证据口径）。
        retriever: 候选缩小检索器（None = 默认注入内存暴力 top-N）。
        config: 机制装配开关（None = 直连可用；enabled=False = 零生效）。
        sink: 审计落库回调（boot 级装配注入；append-only）。
        now: 当前时间戳（确定性注入；None = 实时）。
        canary: 是否执行单回合验证（False = 仅重建级校验；默认 True）。
        cache: 指纹缓存存储（flag 开启时构造/注入；None = 缓存零参与）。
        model_id: 模型标识（组装请求上下文指纹入键；与沉淀侧同一标识）。
        cache_epsilon: 抽样重装概率（命中时以 ε 概率绕过缓存重新组装
            对比；轻任务注入 ε≈0 关闭，默认引擎钉死）。
    """

    registry: NodeTypeRegistry
    evidence_store: EdgeEvidenceStore | None = None
    retriever: Retriever | None = None
    config: PathAssemblyConfig | None = None
    sink: Callable[[dict[str, Any]], Any] | None = None
    now: float | None = None
    canary: bool = True
    cache: FingerprintCacheStore | None = None
    model_id: str = ""
    cache_epsilon: float = DEFAULT_CACHE_EPSILON

    def bind(self) -> PathAssembler:
        """构造只读组装器（同源配置；单次绑定复用）。"""
        return PathAssembler(
            registry=self.registry,
            evidence_store=self.evidence_store,
            retriever=self.retriever,
            config=self.config,
            sink=self.sink,
            now=self.now,
            cache=self.cache,
            model_id=self.model_id,
            cache_epsilon=self.cache_epsilon,
        )

    async def report_cache_execution(self, request: AssemblyRequest, *, ok: bool) -> bool:
        """缓存路径执行结果回馈（执行失败强失效信号接线口）。

        命中成功执行 → 命中数+1 并刷新时间戳；命中失败 → 失败数+1 且
        条目立即失效（不命中），调用方重组装。未注入缓存（flag 关闭）
        时零参与返回 False。
        """
        if self.cache is None:
            return False
        key = request_fingerprint(
            goal_fields=request.goal_fields(),
            entry_fields=request.entry_fields,
            domain=request.domain,
            max_safety_tier=request.max_safety_tier,
            model_id=self.model_id,
        )
        return await self.cache.report(key, ok=ok)

    async def assemble_plan(
        self,
        request: AssemblyRequest,
        *,
        audit_sink: Callable[[dict[str, Any]], Any] | None = None,
    ) -> AssemblyResult:
        """组装指令：组装 + canary 验证链路 + 审计留痕。

        产物（AssemblyResult.to_dict）= 候选图定义数据 + 统计 + canary
        结论 + 审计记录；候选图经 :func:`canary_instantiate` 重建后即可
        走既有 run 通道（Graph.from_dict(validate=True) 语义）。

        审计留痕（每条记录调用 audit_sink 一次；落库归回调）：
        1. 组装记录（候选清单 + 指纹 + 统计，形状与只读组装一致）；
        2. 各候选 canary 结论（重建指纹 + 单回合收尾原因）。

        缓存命中候选须过 canary 验证：命中路径验证失败（执行失败）=
        强失效——失败数+1 且条目立即失效（不命中），随后本入口代调用方
        重组装（失效后自然走 miss 路径）。

        机制开关关闭（config.enabled=False）时零生效：无候选、无验证、
        无审计回调；无默认装配时不产出任何审计（模块级入口语义）。
        """
        if self.config is not None and not self.config.enabled:
            return AssemblyResult()
        assembler = self.bind()
        result = await assembler.assemble(request)
        ts = self.now if self.now is not None else time.time()
        if self.cache is not None and result.stats.get(STATS_CACHE_HITS, 0) > 0:
            # 命中候选先行验证：失败 = 强失效 + 立即重组装（缓存路径执行失败路径）
            hit_verdicts = [
                await self._verify_candidate(candidate, ts=ts)
                for candidate in result.candidates
            ]
            if any(not verdict.ok for verdict in hit_verdicts):
                await self.report_cache_execution(request, ok=False)
                result = await assembler.assemble(request)
        goal = request.goal_fields()
        records: list[dict[str, Any]] = [
            assembly_audit_record(request, goal, result, ts=ts)
        ]
        if not result.candidates:
            result = replace(result, audit=tuple(records))
            self._emit_audit(records, audit_sink)
            return result
        verdicts: list[CanaryVerdict] = []
        for candidate in result.candidates:
            verdict = await self._verify_candidate(candidate, ts=ts)
            verdicts.append(verdict)
            records.append(
                {
                    "ts": ts,
                    "domain": request.domain,
                    "fingerprint": verdict.digest,
                    "verdict": verdict.to_dict(),
                }
            )
        result = replace(result, canary=tuple(verdicts), audit=tuple(records))
        self._emit_audit(records, audit_sink)
        return result

    async def _verify_candidate(
        self, candidate: AssemblyCandidate, *, ts: float
    ) -> CanaryVerdict:
        """单候选验证：重建（结构校验）→ 可选单回合（stub 执行）。"""
        try:
            rebuilt = canary_instantiate(
                candidate.to_dict()["graph"], registry=self.registry
            )
        except Exception as exc:
            return CanaryVerdict(
                rank=candidate.rank,
                digest=candidate.graph.digest(),
                ok=False,
                error=f"重建失败: {exc}",
            )
        if not self.canary:
            return CanaryVerdict(
                rank=candidate.rank, digest=rebuilt.digest(), ok=True, executed=False
            )
        try:
            round_result = await canary_round(rebuilt)
        except Exception as exc:
            return CanaryVerdict(
                rank=candidate.rank,
                digest=rebuilt.digest(),
                ok=False,
                executed=True,
                error=f"单回合执行失败: {exc}",
            )
        return CanaryVerdict(
            rank=candidate.rank,
            digest=rebuilt.digest(),
            ok=round_result.ok,
            executed=True,
            terminal=round_result.reason,
            error=None if round_result.ok else f"异常收尾（{round_result.reason}）",
        )

    @staticmethod
    def _emit_audit(
        records: Sequence[dict[str, Any]],
        audit_sink: Callable[[dict[str, Any]], Any] | None,
    ) -> None:
        if audit_sink is None:
            return
        for record in records:
            audit_sink(dict(record))


# 模块级默认运行期（装配入口 set_default_assembly_runtime 挂载；
# 未挂载 = 未装配 = 默认全关零生效）
_DEFAULT_ASSEMBLY_RUNTIME: PathAssemblyRuntime | None = None


def set_default_assembly_runtime(runtime: PathAssemblyRuntime | None) -> None:
    """挂载/替换默认组装运行期（boot 装配处调用；None = 卸载）。"""
    global _DEFAULT_ASSEMBLY_RUNTIME
    _DEFAULT_ASSEMBLY_RUNTIME = runtime


def get_default_assembly_runtime() -> PathAssemblyRuntime | None:
    """取默认组装运行期（未挂载 = None）。"""
    return _DEFAULT_ASSEMBLY_RUNTIME


async def assemble_plan(
    request: AssemblyRequest,
    *,
    audit_sink: Callable[[dict[str, Any]], Any] | None = None,
) -> AssemblyResult:
    """组装产物执行入口（默认运行期挂载后可用；壳侧 op 与策略层调用）。

    Args:
        request: 组装请求（目标 schema + 域 + 安全档 + 闸门 + 草稿源）。
        audit_sink: 审计记录回调（接受事件 dict；失败留痕也经此回调）。

    Returns:
        AssemblyResult：候选图定义数据 + stats + canary 结论 + 审计记录。

    未挂载默认运行期 = 机制未装配（默认全关）：返回空结果，无候选、
    无审计——零运行影响。装配处（boot）经 :func:`set_default_assembly_runtime`
    绑定注册表/证据/开关后本入口生效。
    """
    runtime = _DEFAULT_ASSEMBLY_RUNTIME
    if runtime is None:
        return AssemblyResult(fallback_reason="组装运行期未装配（默认关闭）")
    return await runtime.assemble_plan(request, audit_sink=audit_sink)


# ── 干预能力：候选选择 / 多径开关（assemble 后的运行期干预；状态落库 + 审计）──

# 候选选择落库集合（按域记录当前选中候选；清空 = 恢复多候选观察态）
PATH_CANDIDATE_COLLECTION = "path_candidate_selection"
# 多径开关落库集合（复用 PathAssemblyFlags 单块开关语义；按域持久化）
PATH_FLAGS_COLLECTION = "path_flags"


async def choose_candidate(
    storage: object,
    candidate_id: str,
    *,
    domain: str = "default",
    chain: Sequence[str] = (),
    fingerprint: str = "",
    now: float | None = None,
) -> dict[str, Any]:
    """记录候选路径人工选择（assemble 后挑选执行路径；选后状态落库 + 审计）。

    候选身份由调用方提供（assemble 产物的 rank / chain / fingerprint）；
    候选 id 为空 = fail-closed 拒绝（未知候选不落库）。选中态按域覆盖写入，
    同一域同时只持有一条选中候选——后续多径/执行消费此选中态。

    审计复用 ``assembly_candidate`` 既有类型（候选留痕），落 ``set_audit``
    集合（与沉淀侧审计同一通道）。
    """
    if not candidate_id:
        raise ValueError("候选 id 不能为空（fail-closed）")
    ts = now if now is not None else time.time()
    selection = {
        "domain": domain,
        "candidate_id": str(candidate_id),
        "chain": list(chain or ()),
        "fingerprint": fingerprint,
        "chosen_at": ts,
    }
    await storage.put_record(PATH_CANDIDATE_COLLECTION, domain, selection)  # type: ignore[attr-defined]
    await emit_audit(
        storage,
        {
            "type": EVENT_ASSEMBLY_CANDIDATE,
            "ts": ts,
            "domain": domain,
            "fingerprint": fingerprint,
            "candidate_id": str(candidate_id),
            "chain": list(chain or ()),
        },
    )
    return selection


async def clear_candidate_selection(
    storage: object,
    *,
    domain: str = "default",
    now: float | None = None,
) -> dict[str, Any]:
    """反向操作：清除候选选择（恢复多候选观察态，不持有任何选中路径）。

    选中态以「标记位」覆写而非删除（存储接口无删除原语），``candidate_id``
    置空代表无选中——与 choose_candidate 同一集合同一键，状态可断言轮转。
    """
    ts = now if now is not None else time.time()
    cleared = {"domain": domain, "candidate_id": "", "chosen_at": ts, "cleared": True}
    await storage.put_record(PATH_CANDIDATE_COLLECTION, domain, cleared)  # type: ignore[attr-defined]
    return cleared


async def set_multipath(
    storage: object,
    enabled: bool,
    *,
    domain: str = "default",
    now: float | None = None,
) -> dict[str, Any]:
    """多径开关（复用 PathAssemblyFlags 单块开关语义；状态落库 + 审计）。

    在既有 ``path.set_flags`` 的 flag 集合上只翻转 ``multipath_enabled`` 位：
    先按域取已存 flag（缺省全关），再以 :class:`~ink_engine.core.contracts
    .PathAssemblyFlags` 的 ``replace`` 更新多径位，落库后回流给运行期消费。
    非法域名 / 非布尔开关不静默吞错（fail-closed：异常上抛）。

    审计复用 ``assembly_audit`` 既有类型，落 ``set_audit`` 集合。
    """
    existing = await storage.get_record(PATH_FLAGS_COLLECTION, domain)  # type: ignore[attr-defined]
    flags = PathAssemblyFlags.from_boot(existing or {})
    new_flags = replace(flags, multipath_enabled=bool(enabled))
    await storage.put_record(  # type: ignore[attr-defined]
        PATH_FLAGS_COLLECTION, domain, dict(new_flags.to_dict())
    )
    ts = now if now is not None else time.time()
    await emit_audit(
        storage,
        {
            "type": EVENT_AUDIT_ASSEMBLY,
            "ts": ts,
            "domain": domain,
            "flag": "multipath_enabled",
            "enabled": bool(enabled),
        },
    )
    return {"multipath_enabled": bool(enabled), "flags": dict(new_flags.to_dict())}


__all__ = [
    "CANDIDATE_SOURCE_ALGORITHM",
    "CANDIDATE_SOURCE_CACHE",
    "CANDIDATE_SOURCE_DRAFT",
    "DEFAULT_BEAM_WIDTH",
    "DEFAULT_CACHE_EPSILON",
    "DEFAULT_DOMAIN",
    "DEFAULT_LLM_WINDOW",
    "DEFAULT_MAX_PATH_LENGTH",
    "DEFAULT_MAX_SAFETY_TIER",
    "DEFAULT_TOP_K",
    "LLM_RETRY_LIMIT",
    "MAX_REPAIR_ROUNDS",
    "STATS_BEAM_EXTENSIONS",
    "STATS_CACHE_HITS",
    "STATS_CACHE_INVALIDATIONS",
    "STATS_CACHE_MISSES",
    "STATS_CACHE_REPLACEMENTS",
    "STATS_EDGE_SCORE_CALLS",
    "STATS_LLM_ATTEMPTS",
    "STATS_REPAIR_ATTEMPTS",
    "AssemblyCandidate",
    "AssemblyDraftContext",
    "AssemblyEnvelope",
    "AssemblyRequest",
    "AssemblyResult",
    "CanaryResult",
    "CanaryVerdict",
    "DraftProvider",
    "InMemoryPoolRetriever",
    "NodeSummary",
    "PathAssembler",
    "PathAssemblyRuntime",
    "add_branch",
    "assemble_plan",
    "assembly_audit_record",
    "choose_candidate",
    "clear_candidate_selection",
    "canary_instantiate",
    "canary_round",
    "get_default_assembly_runtime",
    "parse_draft_chain",
    "remove_node",
    "repair_chain",
    "replace_node",
    "reroute_edge",
    "set_default_assembly_runtime",
    "set_multipath",
    "validate_chain",
]
