"""工具调配器与工具轨迹存储（按子任务动态组装本轮工具集的机制层）。

调配思想（上下文调配器的同构升级）：工具集 = 带元数据的候选池——
任务相关度 = relevance、调用频率/可信度 = weight、预算 = 工具集上限。
确定性选取（零 LLM 调用），宿主可注入自定义打分策略——换策略不改
装配，与 ContextMixer 的替换语义一致。

工具调用轨迹 = 信号源（经验闭环的原始数据）：成功组合 → 蒸馏为推荐
工具集、踩坑/误用 → 沉淀为工具使用规则（蒸馏发生在知识集孵化层，
本模块只提供 append-only 轨迹存储与查询原语，不含任何业务语义）。
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from .llm.tools import ToolSpec
from .logging import get_logger
from .storage import Storage

logger = get_logger(__name__)

# 默认本轮工具集预算（数量上限，与 spawn 清单上限同档成本护栏语义）
DEFAULT_MAX_TOOLS = 10

# 相关度默认值（与上下文源同口径：未声明取中值，防全默认均分预算）
DEFAULT_RELEVANCE = 0.5

# 工具入选门槛：score = weight × relevance 低于该值即丢弃（近似噪音）
DEFAULT_MIN_SCORE = 0.15


@dataclass(frozen=True, slots=True)
class ToolCandidate:
    """工具调配候选：工具 + 任务相关度 + 调用频率/可信度权重。

    Attributes:
        spec: 工具描述（数据形态，可序列化）。
        relevance: 任务相关度（0-1，与当前子任务的匹配度）。
        weight: 调用频率/可信度权重（数值大优先入选；经验闭环中高可信
            高频工具权重高）。
        priority: 同分排序键（数值大在前）。
    """

    spec: ToolSpec
    relevance: float = DEFAULT_RELEVANCE
    weight: float = 1.0
    priority: int = 5

    def __post_init__(self) -> None:
        if self.weight < 0:
            raise ValueError(f"工具权重不能为负: {self.weight}")
        if not 0 <= self.relevance <= 1:
            raise ValueError(f"工具相关度必须在 [0, 1] 内: {self.relevance}")

    def score(self) -> float:
        """调配分 = 权重 × 相关度（单一排序键，可解释、可断言）。"""
        return self.weight * self.relevance


@runtime_checkable
class ToolScoring(Protocol):
    """工具打分策略接口：候选列表 → 入选工具（按序，数量 ≤ 预算）。

    实现约定：确定性（同输入必得同输出）；返回的工具不得超出候选池；
    入选数量不得超过预算（硬上界）。默认实现见 WeightedToolScorer。
    """

    def select(self, candidates: list[ToolCandidate], *, max_tools: int) -> list[ToolSpec]: ...


class WeightedToolScorer:
    """确定性默认调配：按调配分排序、门槛丢弃、预算截断。

    规则：
    1. 跨工具去重（同名只保留调配分最高者——同一工具重复注册取最强声明）；
    2. score ≥ ``min_score`` 才可入选（低于门槛 = 近似噪音，丢弃）；
    3. 按 (优先级降序, 调配分降序) 排序，截断至预算上限。

    确定性 = 同一输入必得同一输出（可缓存、可断言、零 LLM 调用）。
    """

    def __init__(self, *, min_score: float = DEFAULT_MIN_SCORE) -> None:
        if min_score < 0:
            raise ValueError(f"工具入选门槛不能为负: {min_score}")
        self.min_score = min_score

    def select(self, candidates: list[ToolCandidate], *, max_tools: int) -> list[ToolSpec]:
        if max_tools < 0:
            raise ValueError(f"工具集预算不能为负: {max_tools}")
        if max_tools == 0 or not candidates:
            return []
        best: dict[str, ToolCandidate] = {}
        for candidate in candidates:
            prev = best.get(candidate.spec.name)
            if prev is None or (
                candidate.priority,
                candidate.score(),
            ) > (prev.priority, prev.score()):
                best[candidate.spec.name] = candidate
        ranked = [
            candidate
            for candidate in best.values()
            if candidate.score() >= self.min_score
        ]
        ranked.sort(key=lambda c: (c.priority, c.score()), reverse=True)
        return [candidate.spec for candidate in ranked[:max_tools]]


class ToolSelector:
    """工具调配器门面：候选池 → 预算内本轮工具集（策略可注入）。

    与 ContextMixer 同构：默认走确定性调配（WeightedToolScorer），宿主
    可注入自定义策略（如 LLM 语义匹配后的候选加权）——换策略不改装配。
    """

    def __init__(
        self,
        *,
        max_tools: int = DEFAULT_MAX_TOOLS,
        scorer: ToolScoring | None = None,
    ) -> None:
        if max_tools < 0:
            raise ValueError(f"工具集预算不能为负: {max_tools}")
        self.max_tools = max_tools
        self.scorer = scorer or WeightedToolScorer()

    def select(
        self, candidates: list[ToolCandidate], *, max_tools: int | None = None
    ) -> list[ToolSpec]:
        """本轮工具集选取：候选 → 预算内工具清单（确定性，零 LLM 调用）。"""
        budget = self.max_tools if max_tools is None else max_tools
        return self.scorer.select(candidates, max_tools=budget)


@dataclass(frozen=True, slots=True)
class ToolTrace:
    """单次工具调用轨迹（经验闭环的原始信号）。

    Attributes:
        tool: 工具名。
        ok: 是否成功执行（False = 拒绝/出错，踩坑信号）。
        decision: 工具流水线决议（allow/deny/error/accept/terminate）。
        args: 参数摘要（落库前经宿主裁剪/脱敏——引擎不解释内容，但
            存储层统一剥离敏感键；含不可 JSON 序列化值时由调用方负责）。
        error: 失败原因（ok=False 时）。
        duration_ms: 调用耗时（毫秒）。
        thread_id: 归属会话/线程。
        created_at: 记录时间戳（epoch 秒）。
        id: 轨迹唯一 id（存储分配，新建时为 None）。
    """

    tool: str
    ok: bool = True
    decision: str = "allow"
    args: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    duration_ms: float = 0.0
    thread_id: str = "-"
    created_at: float = field(default_factory=time.time)
    id: str | None = None

    def to_dict(self) -> dict:
        return {
            "tool": self.tool,
            "ok": self.ok,
            "decision": self.decision,
            "args": self.args,
            "error": self.error,
            "duration_ms": self.duration_ms,
            "thread_id": self.thread_id,
            "created_at": self.created_at,
            "id": self.id,
        }

    @classmethod
    def from_dict(cls, data: dict) -> ToolTrace:
        return cls(
            tool=data["tool"],
            ok=bool(data.get("ok", True)),
            decision=data.get("decision") or "allow",
            args=data.get("args") or {},
            error=data.get("error"),
            duration_ms=float(data.get("duration_ms") or 0.0),
            thread_id=data.get("thread_id") or "-",
            created_at=float(data.get("created_at") or time.time()),
            id=data.get("id"),
        )


class ToolTraceStore:
    """工具轨迹存储（append-only 记录，蒸馏层消费的信号源）。

    存储后盾 = 通用存储服务（memory/sqlite/postgres 共用，与记忆存储
    同构）；查询按工具名过滤 + 按时间倒序。轨迹只增不删（信号可完整
    回放，与引擎 Event Sourcing 哲学一致）。
    """

    def __init__(self, storage: Storage, collection: str = "tool_traces") -> None:
        self._storage = storage
        self._collection = collection

    async def record(self, trace: ToolTrace) -> str:
        """追加一条轨迹（同 id 覆写 = 补录，幂等安全）。"""
        trace_id = trace.id or f"{trace.tool}:{uuid.uuid4().hex}"
        data = trace.to_dict()
        data["id"] = trace_id  # 生成 id 回写记录（查询还原可关联原始轨迹）
        await self._storage.put_record(self._collection, trace_id, data)
        return trace_id

    async def list(
        self,
        *,
        tool: str | None = None,
        ok: bool | None = None,
        limit: int | None = None,
    ) -> list[ToolTrace]:
        """轨迹查询：按工具名/成败过滤，时间倒序（最新在前）。

        注：当前实现在行内完成全量载入后的过滤与排序（``limit`` 已生效）。
        在高吞吐/无界增长下，全量载入会带来无界内存占用——将过滤下推到
        存储层（查询期按 tool/ok 过滤 + 按时间分页）为规模演进项，本次
        不重构存储层，保持查询语义不变。
        """
        records = await self._storage.list_records(self._collection)
        traces = [ToolTrace.from_dict(r) for r in records]
        if tool is not None:
            traces = [t for t in traces if t.tool == tool]
        if ok is not None:
            traces = [t for t in traces if t.ok is ok]
        traces.sort(key=lambda t: t.created_at, reverse=True)
        if limit is not None:
            traces = traces[:limit]
        return traces


__all__ = [
    "DEFAULT_MAX_TOOLS",
    "DEFAULT_MIN_SCORE",
    "DEFAULT_RELEVANCE",
    "ToolCandidate",
    "ToolScoring",
    "ToolSelector",
    "ToolTrace",
    "ToolTraceStore",
    "WeightedToolScorer",
]
