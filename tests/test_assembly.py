"""输入调配管线单测：多源统一预算/激活留痕/一键开关。

语义检查点：
- 一次 LLM 调用前多源统一调配（上下文+知识+工具+记忆）预算合计不超
  调用点总预算；
- 能全量则全量（源内容总长 ≤ 预算 → 整包激活，无稀疏必要）；放不下
  才裁剪（分级池分配）；
- 工具激活数上限（每轮 3-10 个经验框架）；
- 激活留痕完整可回放（激活源 + 强度 + 版本快照）；
- 一键开关回退旧装配路径（enabled=False → 装配拒绝，调用点走旧路径）。
"""
from __future__ import annotations

import pytest

from ink_engine.core.assembly import (
    SOURCE_CONTEXT,
    SOURCE_KNOWLEDGE,
    SOURCE_MEMORY,
    SOURCE_TOOL,
    ActivationAggregator,
    ActivationRecord,
    AssemblyConfig,
    EntryCompressor,
    InputAssembler,
    SourceActivation,
)
from ink_engine.core.context import ContextSource
from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.executor import Engine


def _source(
    kind: str,
    text: str,
    *,
    weight: float = 1.0,
    relevance: float = 0.5,
    entry_ref: str = "",
) -> ContextSource:
    return ContextSource(
        type=kind,
        content=text,
        title=f"{kind}-{text[:8]}",
        weight=weight,
        relevance=relevance,
        meta={"entry_id": entry_ref} if entry_ref else {},
    )


def test_total_budget_never_exceeded():
    """统一预算硬上界：多源调配合计不超调用点总预算。"""
    config = AssemblyConfig(total_budget=500)
    assembler = InputAssembler(config)
    sources = [
        _source(SOURCE_CONTEXT, "对话历史 " * 30, weight=1.0),      # 240 字符
        _source(SOURCE_KNOWLEDGE, "知识条目 " * 30, weight=0.8),    # 240 字符
        _source(SOURCE_TOOL, "工具定义 " * 20, weight=0.9),         # 160 字符
    ]
    result = assembler.assemble(sources, total_budget=500)
    assert len(result.text) <= 500
    assert result.record.total_budget == 500
    assert result.record.assembled_chars == len(result.text)


def test_full_activation_when_fits():
    """能全量则全量：源内容总长 ≤ 预算 → 整包激活（无稀疏必要）。"""
    assembler = InputAssembler(AssemblyConfig(total_budget=1000))
    sources = [
        _source(SOURCE_CONTEXT, "对话"),
        _source(SOURCE_KNOWLEDGE, "知识"),
        _source(SOURCE_TOOL, "工具"),
    ]
    result = assembler.assemble(sources, total_budget=1000)
    assert all(s.mode == "keep_full" for s in result.record.sources)
    assert "对话" in result.text and "知识" in result.text and "工具" in result.text


def test_tool_limit_applied():
    """工具激活数上限：每轮工具集裁剪（经验框架 3-10 个）。"""
    assembler = InputAssembler(AssemblyConfig(total_budget=300, max_tools=2))
    sources = [
        _source(SOURCE_TOOL, f"工具{i}定义 " * 10, weight=1.0, relevance=0.9)
        for i in range(5)
    ]
    result = assembler.assemble(sources, total_budget=300)
    tool_activations = [
        s for s in result.record.sources if s.source_type == SOURCE_TOOL
    ]
    assert len(tool_activations) <= 2


def test_grouped_budget_allocation():
    """分级池分配：上下文/知识/工具/记忆/证据按占比分池（不再各自为政）。"""
    config = AssemblyConfig(
        total_budget=1000,
        context_ratio=0.5,
        knowledge_ratio=0.3,
        tool_ratio=0.1,
        memory_ratio=0.1,
        evidence_ratio=0.0,
    )
    assembler = InputAssembler(config)
    sources = [
        _source(SOURCE_CONTEXT, "上下文内容 " * 50, weight=1.0),
        _source(SOURCE_KNOWLEDGE, "知识内容 " * 50, weight=1.0),
        _source(SOURCE_TOOL, "工具内容 " * 50, weight=1.0),
        _source(SOURCE_MEMORY, "记忆内容 " * 50, weight=1.0),
    ]
    result = assembler.assemble(sources, total_budget=1000)
    assert len(result.text) <= 1000
    assert result.text


def test_version_snapshot_in_activation_record():
    """激活留痕含版本快照（知识/规则版本——全量原文可重建）。"""
    assembler = InputAssembler()
    result = assembler.assemble(
        [_source(SOURCE_KNOWLEDGE, "知识")],
        version_snapshot={"rules": "rules-v3", "knowledge": "ks-42"},
    )
    assert result.record.version_snapshot == {
        "rules": "rules-v3",
        "knowledge": "ks-42",
    }


def test_activation_record_roundtrip():
    """激活记录序列化 round-trip（留痕落库/回放契约）。"""
    record = ActivationRecord(
        total_budget=100,
        assembled_chars=50,
        sources=(
            SourceActivation(
                source_type=SOURCE_KNOWLEDGE,
                title="知识",
                weight=0.8,
                relevance=0.6,
                char_limit=30,
                mode="truncate",
                entry_ref="k-1",
            ),
        ),
        version_snapshot={"rules": "v2"},
    )
    rebuilt = ActivationRecord.from_dict(record.to_dict())
    assert rebuilt.total_budget == 100
    assert rebuilt.assembled_chars == 50
    assert rebuilt.sources[0].entry_ref == "k-1"
    assert rebuilt.sources[0].mode == "truncate"
    assert rebuilt.version_snapshot == {"rules": "v2"}


def test_disabled_assembly_rejected():
    """一键开关：enabled=False → 装配拒绝（调用点回退旧装配路径）。"""
    assembler = InputAssembler(AssemblyConfig(enabled=False))
    with pytest.raises(GraphDefinitionError, match="已禁用"):
        assembler.assemble([_source(SOURCE_CONTEXT, "对话")])


def test_unknown_source_type_rejected():
    """未知源类别拒绝（类别是预算分级的键，不得漂移）。"""
    assembler = InputAssembler()
    with pytest.raises(GraphDefinitionError, match="未知装配源类别"):
        assembler.assemble([_source("ghost", "未知类别")])


def test_config_ratio_sum_validation():
    """分级占比合计超限拒绝（防超分）。"""
    with pytest.raises(GraphDefinitionError, match="合计超限"):
        AssemblyConfig(context_ratio=0.7, knowledge_ratio=0.5)


def test_config_roundtrip():
    """装配配置序列化 round-trip（行为开关集中一处）。"""
    config = AssemblyConfig(
        enabled=False,
        total_budget=6000,
        context_ratio=0.5,
        max_tools=6,
    )
    rebuilt = AssemblyConfig.from_dict(config.to_dict())
    assert rebuilt == config


def test_negative_budget_rejected():
    """非正预算拒绝（配置构造期暴露）。"""
    with pytest.raises(GraphDefinitionError, match="总预算"):
        AssemblyConfig(total_budget=0)


def test_empty_sources_produce_empty_result():
    """无源 = 空装配（不抛错，留痕仍落库）。"""
    assembler = InputAssembler()
    result = assembler.assemble([], total_budget=100)
    assert result.text == ""
    assert result.record.sources == ()


def test_allocation_keeps_high_weight_sources():
    """高权重源全保留、低权重源裁剪（调配器机制复用）。"""
    config = AssemblyConfig(total_budget=200)
    assembler = InputAssembler(config)
    sources = [
        _source(SOURCE_KNOWLEDGE, "高可信知识 " * 10, weight=1.0, relevance=0.9),
        _source(SOURCE_KNOWLEDGE, "低可信噪音 " * 10, weight=0.1, relevance=0.1),
    ]
    result = assembler.assemble(sources, total_budget=200)
    assert "高可信知识" in result.text
    # 低可信源可能被裁剪（分配分 0.01 低于截断门槛）
    assert len(result.text) <= 200


# ── 组装期条目内压缩（摘要视图/非破坏性压缩接线）──


def _summary_compressor(source, budget: int) -> str:
    """测试压缩钩子：摘要视图 = 首句 + 省略标记（预算内）。"""
    prefix = "摘要:" + source.content[:12]
    return prefix[:budget]


def _knowledge_only_config() -> AssemblyConfig:
    """知识源独占的装配配置（其余分级占比清零，压缩测试聚焦知识池）。"""
    return AssemblyConfig(
        total_budget=300,
        knowledge_ratio=1.0,
        context_ratio=0.0,
        tool_ratio=0.0,
        memory_ratio=0.0,
        evidence_ratio=0.0,
    )


def test_entry_compression_applied_when_truncated():
    """条目内压缩接线：被截断的源经压缩钩子产出摘要视图。"""
    assembler = InputAssembler(
        _knowledge_only_config(), compressor=_summary_compressor
    )
    long_source = _source(
        SOURCE_KNOWLEDGE,
        "很长的知识条目内容 " * 60,  # 远超知识池预算（触发裁剪路径）
        weight=1.0,
        relevance=0.9,
        entry_ref="k-1",
    )
    result = assembler.assemble([long_source], total_budget=300)
    assert "摘要:" in result.text  # 压缩视图生效
    assert len(result.text) <= 300
    modes = {s.mode for s in result.record.sources}
    assert "compressed" in modes  # 留痕记录压缩模式


def test_entry_compression_original_untouched():
    """非破坏性：压缩视图不修改原文（仅本次调用使用摘要）。"""
    assembler = InputAssembler(
        _knowledge_only_config(), compressor=_summary_compressor
    )
    long_source = _source(
        SOURCE_KNOWLEDGE,
        "原文内容不被改写 " * 40,  # 超过预算 → 触发裁剪路径
        weight=1.0,
        relevance=0.9,
        entry_ref="k-1",
    )
    original = long_source.content
    assembler.assemble([long_source], total_budget=300)
    assert long_source.content == original  # 原文不动


def test_entry_compression_fallback_when_empty():
    """压缩钩子返回空串 → 走默认截断（压缩失败不破坏装配）。"""
    def empty_compressor(source, budget: int) -> str:
        return ""

    assembler = InputAssembler(_knowledge_only_config(), compressor=empty_compressor)
    source = _source(
        SOURCE_KNOWLEDGE, "没有压缩策略的内容 " * 40, weight=1.0, relevance=0.9
    )
    result = assembler.assemble([source], total_budget=300)
    assert len(result.text) <= 300  # 截断兜底仍在
    assert not any(s.mode == "compressed" for s in result.record.sources)


def test_entry_compressor_type_exported():
    """压缩钩子类型名导出（宿主按类型声明注入）。"""
    assert EntryCompressor is not None


# ── 激活留痕利用率聚合（MoE 借鉴：过热/过冷提示）──


def _record(*refs: str, budget: int = 100) -> ActivationRecord:
    return ActivationRecord(
        total_budget=budget,
        assembled_chars=50,
        sources=tuple(
            SourceActivation(
                source_type=SOURCE_KNOWLEDGE,
                title=ref,
                weight=1.0,
                relevance=0.5,
                char_limit=30,
                mode="keep_full",
                entry_ref=ref,
            )
            for ref in refs
        ),
    )


def test_aggregator_utilization_and_overheated():
    """利用率聚合：高频激活条目判为过热（激活失衡提示）。"""
    aggregator = ActivationAggregator(overheated_rate=0.85, cold_window=5)
    for i in range(5):
        if i == 4:
            aggregator.record(_record("k-hot"))  # k-other 本轮未激活
        else:
            aggregator.record(_record("k-hot", "k-other"))
    summary = aggregator.snapshot()
    assert summary.calls == 5
    assert summary.total_refs == 2
    assert summary.utilization == 1.0
    assert summary.overheated == ("k-hot",)  # 激活率 1.0 ≥ 0.85
    assert "k-other" not in summary.overheated  # 激活率 0.8 < 0.85
    by_ref = {s.entry_ref: s for s in summary.per_entry}
    assert by_ref["k-hot"].activations == 5
    assert by_ref["k-hot"].activation_rate == 1.0
    assert by_ref["k-other"].activation_rate == 0.8


def test_aggregator_cold_after_window():
    """过冷提示：曾激活但窗口内长期零激活 → 归档候选提示。"""
    aggregator = ActivationAggregator(overheated_rate=0.8, cold_window=3)
    aggregator.record(_record("k-cold"))  # 第 1 次调用激活
    for _ in range(3):
        aggregator.record(_record("k-other"))  # 之后只激活另一个
    summary = aggregator.snapshot()
    assert summary.calls == 4
    assert summary.cold == ("k-cold",)  # 最近 3 次调用零激活
    assert summary.active_refs == 1
    assert summary.utilization == 0.5


def test_aggregator_empty_and_single_call():
    """无记录 = 空快照；单次调用不判过热（无失衡语义）。"""
    empty = ActivationAggregator().snapshot()
    assert empty.calls == 0 and empty.overheated == () and empty.cold == ()

    aggregator = ActivationAggregator()
    aggregator.record(_record("k-1"))
    summary = aggregator.snapshot()
    assert summary.calls == 1
    assert summary.overheated == ()  # 单次调用不判定


def test_aggregator_summary_roundtrip():
    """利用率快照序列化 round-trip（可落库审计）。"""
    aggregator = ActivationAggregator()
    aggregator.record(_record("k-1", "k-2"))
    summary = aggregator.snapshot()
    rebuilt = type(summary).from_dict(summary.to_dict())
    assert rebuilt.calls == summary.calls
    assert rebuilt.total_refs == summary.total_refs
    assert rebuilt.overheated == summary.overheated
    assert rebuilt.cold == summary.cold
    assert [s.entry_ref for s in rebuilt.per_entry] == [
        s.entry_ref for s in summary.per_entry
    ]


def test_aggregator_invalid_params_rejected():
    """聚合阈值非法拒绝（构造期暴露）。"""
    with pytest.raises(GraphDefinitionError, match="过热"):
        ActivationAggregator(overheated_rate=1.5)
    with pytest.raises(GraphDefinitionError, match="过冷窗口"):
        ActivationAggregator(cold_window=0)


def test_aggregator_skips_unnamed_sources():
    """无条目引用的源（上下文/工具）不参与知识利用率聚合。"""
    aggregator = ActivationAggregator()
    aggregator.record(
        ActivationRecord(
            total_budget=100,
            assembled_chars=50,
            sources=(
                SourceActivation(
                    source_type=SOURCE_CONTEXT,
                    title="对话",
                    weight=1.0,
                    relevance=0.5,
                    char_limit=30,
                    mode="keep_full",
                    entry_ref="",  # 无条目引用
                ),
                SourceActivation(
                    source_type=SOURCE_KNOWLEDGE,
                    title="知识",
                    weight=1.0,
                    relevance=0.5,
                    char_limit=30,
                    mode="keep_full",
                    entry_ref="k-1",
                ),
            ),
        )
    )
    summary = aggregator.snapshot()
    assert summary.total_refs == 1
    assert summary.per_entry[0].entry_ref == "k-1"


# ── 执行器接线（ctx.assemble 统一调配 + 留痕 + 一键开关）──


async def test_executor_ctx_assemble_wiring(memory_storage, transport):
    """执行器接线：节点经 ctx.assemble 统一调配，激活留痕随事件落库。"""
    from ink_engine.core.context import ContextSource as CS
    from ink_engine.core.executor import RunOptions
    from ink_engine.core.graph import Graph

    async def plan(ctx):
        result = await ctx.assemble(
            [
                CS(type=SOURCE_CONTEXT, content="对话历史", title="对话"),
                CS(
                    type=SOURCE_KNOWLEDGE,
                    content="知识条目",
                    title="知识",
                    weight=0.8,
                    meta={"entry_id": "k-1"},
                ),
            ],
            total_budget=1000,
            version_snapshot={"rules": "v3"},
        )
        assert len(result.text) <= 1000
        assert "对话历史" in result.text
        assert "知识条目" in result.text
        return {"assembled": result.text}

    graph = Graph(name="asm", entry="plan")
    graph.add_node("plan", plan)
    graph.add_exit("plan")
    engine = Engine(
        graph,
        options=RunOptions(
            storage=memory_storage,
            transports=[transport],
            assembly=AssemblyConfig(total_budget=1000),
        ),
    )
    state, result = await engine._execute(
        state={}, thread_id="t1", round_id=None, resume_from=None,
        trace_id="trace", queue=None,
    )
    assert result.reason == "reply"
    assert "对话历史" in state["assembled"]
    events = [e for e in transport.events if e.type == "input_assembly"]
    assert len(events) == 1
    record = events[0].payload["record"]
    assert record["total_budget"] == 1000
    assert record["version_snapshot"] == {"rules": "v3"}
    kinds = {s["source_type"] for s in record["sources"]}
    assert kinds == {SOURCE_CONTEXT, SOURCE_KNOWLEDGE}


async def test_executor_ctx_assemble_disabled_fallback(memory_storage):
    """一键开关：装配未启用时 ctx.assemble 抛错（调用点回退旧路径）。"""
    from ink_engine.core.executor import RunOptions
    from ink_engine.core.graph import Graph

    async def plan(ctx):
        try:
            await ctx.assemble([])
        except GraphDefinitionError:
            return {"fallback": True}  # 回退旧装配路径
        return {"fallback": False}

    graph = Graph(name="asm", entry="plan")
    graph.add_node("plan", plan)
    graph.add_exit("plan")
    engine = Engine(graph, options=RunOptions(storage=memory_storage))
    state, result = await engine._execute(
        state={}, thread_id="t1", round_id=None, resume_from=None,
        trace_id="trace", queue=None,
    )
    assert result.reason == "reply"
    assert state["fallback"] is True


async def test_executor_ctx_assemble_then_plan_coexist(memory_storage, transport):
    """装配与重规划共存：节点先统一调配输入，再返回下一跳计划。"""
    from ink_engine.core.executor import RunOptions
    from ink_engine.core.graph import Graph

    async def plan(ctx):
        result = await ctx.assemble(
            [_source(SOURCE_CONTEXT, "输入")],
            total_budget=200,
        )
        return {"assembled": result.text, "__plan__": [{"nodes": ["after"]}]}

    async def after(ctx):
        return {"done": ctx.state.get("assembled", "") + "+after"}

    graph = Graph(name="asm", entry="plan")
    graph.add_node("plan", plan)
    graph.add_node("after", after)
    graph.add_edge("plan", "after")
    graph.add_exit("after")
    engine = Engine(
        graph,
        options=RunOptions(
            storage=memory_storage,
            transports=[transport],
            assembly=AssemblyConfig(total_budget=200),
        ),
    )
    state, result = await engine._execute(
        state={}, thread_id="t1", round_id=None, resume_from=None,
        trace_id="trace", queue=None,
    )
    assert result.reason == "reply"
    assert state["done"].endswith("+after")
    assert "输入" in state["done"]
