"""工具调配器单测：候选打分/去重/门槛/预算截断 + 轨迹存储/查询过滤。

语义检查点：工具集 = 带元数据的候选池（任务相关度 = relevance、调用
频率/可信度 = weight、预算 = 工具集上限）；确定性选取零 LLM 调用；
工具调用轨迹 = 经验闭环的原始信号（append-only，可按工具/成败过滤）。
"""
from __future__ import annotations

import pytest

from ink_engine.core.llm.tools import ToolSpec
from ink_engine.core.tool_orchestrator import (
    ToolCandidate,
    ToolSelector,
    ToolTrace,
    ToolTraceStore,
    WeightedToolScorer,
)


def _spec(name: str) -> ToolSpec:
    return ToolSpec(name=name, description=f"{name} 工具", parameters={})


def test_tool_spec_round_trip():
    """工具描述数据化：序列化/还原（参数 schema 与权限声明无损）。"""
    spec = ToolSpec(
        name="write_file",
        description="写文件",
        parameters={"type": "object", "properties": {"path": {"type": "string"}}},
        permissions=("filesystem:write:/book/**",),
    )
    data = spec.to_dict()
    rebuilt = ToolSpec.from_dict(data)
    assert rebuilt.name == "write_file"
    assert rebuilt.description == "写文件"
    assert rebuilt.parameters["properties"]["path"]["type"] == "string"
    assert rebuilt.permissions == ("filesystem:write:/book/**",)
    # 未知键容忍（增量演进兼容）
    assert ToolSpec.from_dict({"name": "x", "future": 1}).name == "x"


def test_candidate_validation():
    """候选校验：负权重/越界相关度 → 拒绝（配置错误声明期暴露）。"""
    with pytest.raises(ValueError, match="权重"):
        ToolCandidate(spec=_spec("a"), weight=-1)
    with pytest.raises(ValueError, match="相关度"):
        ToolCandidate(spec=_spec("a"), relevance=1.5)


def test_weighted_scorer_ranks_and_budgets():
    """调配分排序 + 预算截断：高分入选、超预算截断。"""
    scorer = WeightedToolScorer()
    candidates = [
        ToolCandidate(spec=_spec("low"), weight=1.0, relevance=0.2),
        ToolCandidate(spec=_spec("high"), weight=2.0, relevance=0.9),
        ToolCandidate(spec=_spec("mid"), weight=1.0, relevance=0.6),
    ]
    selected = scorer.select(candidates, max_tools=2)
    assert [s.name for s in selected] == ["high", "mid"]


def test_weighted_scorer_drops_below_threshold():
    """门槛丢弃：调配分低于下限 = 近似噪音，不入选。"""
    scorer = WeightedToolScorer(min_score=0.5)
    candidates = [
        ToolCandidate(spec=_spec("noise"), weight=1.0, relevance=0.1),
        ToolCandidate(spec=_spec("good"), weight=1.0, relevance=0.9),
    ]
    assert [s.name for s in scorer.select(candidates, max_tools=10)] == ["good"]


def test_weighted_scorer_dedup_by_name():
    """同名去重：同工具重复注册取调配分最高者（最强声明生效）。"""
    scorer = WeightedToolScorer()
    candidates = [
        ToolCandidate(spec=_spec("dup"), weight=1.0, relevance=0.3),
        ToolCandidate(spec=_spec("dup"), weight=1.0, relevance=0.9),
    ]
    selected = scorer.select(candidates, max_tools=10)
    assert len(selected) == 1
    assert selected[0].name == "dup"


def test_weighted_scorer_budget_hard_limit():
    """预算硬上界：入选数量永不超预算（0 = 空集，负预算拒绝）。"""
    scorer = WeightedToolScorer()
    candidates = [ToolCandidate(spec=_spec(f"t{i}"), relevance=1.0) for i in range(10)]
    assert scorer.select(candidates, max_tools=0) == []
    with pytest.raises(ValueError, match="预算"):
        scorer.select(candidates, max_tools=-1)
    assert len(scorer.select(candidates, max_tools=3)) == 3


def test_selector_default_budget():
    """调配器门面：缺省预算取构造值（成本护栏配置化）。"""
    selector = ToolSelector(max_tools=2)
    candidates = [ToolCandidate(spec=_spec(f"t{i}"), relevance=1.0) for i in range(5)]
    assert len(selector.select(candidates)) == 2
    assert selector.max_tools == 2  # 构造值生效


async def test_trace_store_records_and_filters(memory_storage):
    """轨迹存储：追加/按工具过滤/按成败过滤/时间倒序。"""
    store = ToolTraceStore(memory_storage)
    await store.record(ToolTrace(tool="write", ok=True, duration_ms=10.0))
    await store.record(ToolTrace(tool="write", ok=False, error="权限拒绝"))
    await store.record(ToolTrace(tool="read", ok=True, duration_ms=5.0))

    all_traces = await store.list()
    assert len(all_traces) == 3
    writes = await store.list(tool="write")
    assert len(writes) == 2
    failed = await store.list(tool="write", ok=False)
    assert len(failed) == 1
    assert failed[0].error == "权限拒绝"
    ok_reads = await store.list(tool="read", ok=True)
    assert len(ok_reads) == 1
    assert len(await store.list(limit=2)) == 2


async def test_trace_round_trip_keeps_fields(memory_storage):
    """轨迹数据往返：字段完整（持久化契约）。"""
    store = ToolTraceStore(memory_storage)
    trace = ToolTrace(
        tool="fetch", ok=False, decision="deny",
        args={"url": "https://example.com"}, error="域名不在白名单",
    )
    trace_id = await store.record(trace)
    traces = await store.list(tool="fetch")
    assert traces[0].id == trace_id
    assert traces[0].decision == "deny"
    assert traces[0].args == {"url": "https://example.com"}
