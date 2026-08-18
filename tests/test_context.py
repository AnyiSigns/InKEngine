"""core/context.py 测试：调配器源模型 / 预算分配 / 加权组装 / 融合钩子。"""
from __future__ import annotations

import pytest

from ink_engine.core.context import (
    MODE_DROP,
    MODE_KEEP_FULL,
    MODE_TRUNCATE,
    ContextAssembler,
    ContextMixer,
    ContextSource,
    FusionRegistry,
    WeightedBudgetAllocator,
)


def _src(
    type_: str = "chapter",
    content: str = "内容",
    *,
    weight: float = 1.0,
    relevance: float = 0.9,
    priority: int = 5,
    ttl: float | None = None,
    max_chars: int | None = None,
    dedup_key: str | None = None,
    title: str | None = None,
    created_at: float | None = None,
) -> ContextSource:
    return ContextSource(
        type=type_,
        content=content,
        title=title,
        weight=weight,
        relevance=relevance,
        priority=priority,
        ttl=ttl,
        max_chars=max_chars,
        dedup_key=dedup_key,
        created_at=created_at if created_at is not None else 0.0,
    )


class TestContextSource:
    def test_validates_metadata(self):
        with pytest.raises(ValueError):
            _src(weight=-0.1)
        with pytest.raises(ValueError):
            _src(relevance=1.5)
        with pytest.raises(ValueError):
            _src(ttl=-1)
        with pytest.raises(ValueError):
            _src(max_chars=-1)

    def test_score_is_weight_times_relevance(self):
        assert _src(weight=2.0, relevance=0.5).score() == 1.0

    def test_expiry(self):
        src = _src(ttl=10)
        assert not src.is_expired(now=0.0)
        assert src.is_expired(now=11.0)
        assert not _src().is_expired(now=1e18)  # ttl=None 永不过期


class TestWeightedBudgetAllocator:
    def test_validates_params(self):
        with pytest.raises(ValueError):
            WeightedBudgetAllocator(keep_full_threshold=1.5)
        with pytest.raises(ValueError):
            WeightedBudgetAllocator(truncate_min_score=0.9)  # 高于全保留阈值
        with pytest.raises(ValueError):
            WeightedBudgetAllocator(min_truncate_chars=-1)

    def test_empty_sources(self):
        assert WeightedBudgetAllocator().allocate([], 1000) == []

    def test_filters_expired_and_blank(self):
        expired = _src(type_="m", content="旧", ttl=1)
        blank = _src(type_="m", content="   ")
        allocs = WeightedBudgetAllocator().allocate([expired, blank], 1000)
        assert allocs == []

    def test_keep_full_high_score(self):
        allocs = WeightedBudgetAllocator().allocate(
            [_src(content="A" * 500)], 1000
        )
        assert allocs[0].mode == MODE_KEEP_FULL
        assert allocs[0].char_limit == 500

    def test_keep_full_respects_max_chars(self):
        allocs = WeightedBudgetAllocator().allocate(
            [_src(content="A" * 500, max_chars=100)], 1000
        )
        assert allocs[0].mode == MODE_KEEP_FULL
        assert allocs[0].char_limit == 100

    def test_medium_score_truncated_to_share(self):
        # B 是唯一截断源：份额 = 全部剩余预算，但不超过可用长度
        b = _src(type_="memory", content="B" * 800, weight=0.7, relevance=0.6)
        allocs = WeightedBudgetAllocator().allocate([b], 400)
        assert allocs[0].mode == MODE_TRUNCATE
        assert allocs[0].char_limit == 400

    def test_low_score_dropped(self):
        low = _src(type_="m", content="L", weight=0.1, relevance=0.5)
        allocs = WeightedBudgetAllocator().allocate([low], 1000)
        assert allocs[0].mode == MODE_DROP
        assert "门槛" in allocs[0].reason

    def test_share_below_minimum_dropped(self):
        # 100 预算分给两个 0.15 分源：份额 50 < 下限 100 → 全部丢弃
        a = _src(type_="m", content="A" * 1000, weight=0.3, relevance=0.5)
        b = _src(type_="m", content="B" * 1000, weight=0.3, relevance=0.5)
        allocs = WeightedBudgetAllocator().allocate([a, b], 100)
        assert [x.mode for x in allocs] == [MODE_DROP, MODE_DROP]
        assert "下限" in allocs[0].reason

    def test_share_above_minimum_truncated(self):
        # 500 预算分给两个 0.15 分源：份额 250 ≥ 下限 → 截断保留
        a = _src(type_="m", content="A" * 1000, weight=0.3, relevance=0.5)
        b = _src(type_="m", content="B" * 1000, weight=0.3, relevance=0.5)
        allocs = WeightedBudgetAllocator().allocate([a, b], 500)
        assert [x.mode for x in allocs] == [MODE_TRUNCATE, MODE_TRUNCATE]
        assert sum(x.char_limit for x in allocs) == 500

    def test_budget_hard_bound(self):
        sources = [_src(type_=f"t{i}", content=str(i) * 3000) for i in range(8)]
        allocs = WeightedBudgetAllocator().allocate(sources, 1000)
        total = sum(a.char_limit for a in allocs)
        assert total <= 1000

    def test_degraded_keep_when_budget_short(self):
        # 全保留预算不足 → 降级截断池分享剩余（仍是分数最高者占大头）
        a = _src(type_="chapter", content="A" * 1000, weight=1.0, relevance=0.9)
        b = _src(type_="memory", content="B" * 1000, weight=0.7, relevance=0.6)
        allocs = WeightedBudgetAllocator().allocate([a, b], 500)
        by_type = {x.source.type: x for x in allocs}
        assert by_type["chapter"].mode == MODE_TRUNCATE
        assert by_type["memory"].mode == MODE_TRUNCATE
        assert by_type["chapter"].char_limit > by_type["memory"].char_limit

    def test_dedup_keeps_higher_priority(self):
        low = _src(content="低优先", priority=3, dedup_key="k")
        high = _src(content="高优先", priority=9, dedup_key="k")
        allocs = WeightedBudgetAllocator().allocate([low, high], 1000)
        assert len(allocs) == 1
        assert allocs[0].source is high

    def test_deterministic(self):
        sources = [
            _src(type_="a", content="A" * 700, weight=0.9, relevance=0.7),
            _src(type_="b", content="B" * 700, weight=0.5, relevance=0.5),
            _src(type_="c", content="C" * 700, weight=0.2, relevance=0.6),
        ]
        allocator = WeightedBudgetAllocator()
        first = allocator.allocate(sources, 800)
        second = allocator.allocate(sources, 800)
        assert [(a.mode, a.char_limit) for a in first] == [
            (a.mode, a.char_limit) for a in second
        ]

    def test_negative_budget_rejected(self):
        with pytest.raises(ValueError):
            WeightedBudgetAllocator().allocate([_src()], -1)

    def test_budget_hard_bound_with_capped_source(self):
        # P1 回归：小源封顶（份额>可用长度）+ 大源截断，总分配不得超预算
        # （修复前：封顶源的 surplus 叠加回流，总分配超出 total_chars）
        small = _src(type_="a", content="A" * 10, weight=0.5, relevance=0.5)
        big = _src(type_="b", content="B" * 10000, weight=0.5, relevance=0.5)
        allocs = WeightedBudgetAllocator().allocate([small, big], 1000)
        assert sum(a.char_limit for a in allocs) <= 1000
        assert any(a.source is small for a in allocs)
        assert any(a.source is big and a.char_limit > 0 for a in allocs)

    def test_pool_reflow_accumulates_not_overwrites(self):
        # P1 回归：封顶源释放预算触发第二轮时，未封顶源的份额必须**累加**
        # （修复前逐轮覆写：A 封顶 100 后，B/C 第二轮份额被更小值覆写，
        # 预算大量剩余却静默丢内容——硬上界断言不触发）
        a = _src(type_="a", content="A" * 100, weight=0.5, relevance=0.5)  # 0.25，封顶
        b = _src(type_="b", content="B" * 10000, weight=0.4, relevance=0.5)  # 0.20
        c = _src(type_="c", content="C" * 10000, weight=0.3, relevance=0.5)  # 0.15
        allocs = WeightedBudgetAllocator().allocate([a, b, c], 1000)
        by_type = {x.source.type: x for x in allocs}
        assert by_type["a"].char_limit == 100  # 封顶整源
        # 轮1 份额 333/250，轮2 份额 181/135 累加（修复前被覆写变小）
        assert by_type["b"].char_limit == 514
        assert by_type["c"].char_limit == 385
        assert sum(x.char_limit for x in allocs) == 999  # 预算回流无静默浪费


class TestContextAssembler:
    def test_empty_sources(self):
        result = ContextAssembler().assemble([], total_chars=100)
        assert result.text == ""
        assert result.used_chars == 0

    def test_title_block_format(self):
        result = ContextAssembler().assemble(
            [_src(title="标题", content="正文")], total_chars=1000
        )
        assert result.text == "【标题】\n正文"

    def test_plain_block_without_title(self):
        result = ContextAssembler().assemble([_src(content="正文")], total_chars=1000)
        assert result.text == "正文"

    def test_budget_hard_bound(self):
        sources = [_src(type_=f"t{i}", content="字" * 500, title=f"块{i}") for i in range(10)]
        result = ContextAssembler().assemble(sources, total_chars=1000)
        assert len(result.text) <= 1000

    def test_budget_exhausted_drops_tail_sources(self):
        sources = [_src(type_=f"t{i}", content="x" * 500, title=f"块{i}") for i in range(4)]
        result = ContextAssembler().assemble(sources, total_chars=1000)
        assert any(d.reason == "预算耗尽" for d in result.dropped)
        assert len(result.included) < 4

    def test_included_and_dropped_records(self):
        good = _src(type_="chapter", content="A" * 100)
        bad = _src(type_="memory", content="B", weight=0.1, relevance=0.1)
        result = ContextAssembler().assemble([good, bad], total_chars=1000)
        assert [(i.type, i.mode) for i in result.included] == [("chapter", MODE_KEEP_FULL)]
        assert result.dropped[0].type == "memory"

    def test_default_budget_used(self):
        result = ContextAssembler().assemble([_src(content="x" * 10000)])
        assert result.total_chars == 4000
        assert len(result.text) <= 4000

    def test_negative_budget_rejected(self):
        with pytest.raises(ValueError):
            ContextAssembler().assemble([_src()], total_chars=-1)


class _FakeFusionHook:
    def __init__(self, result):
        self.result = result
        self.calls = 0

    async def fuse(self, sources, *, instruction, budget_chars, context=None):
        self.calls += 1
        if callable(self.result):
            return self.result()
        return self.result


class TestFusionRegistry:
    def test_register_get_names(self):
        registry = FusionRegistry()
        hook = _FakeFusionHook("ok")
        registry.register("novel", hook)
        assert registry.get("novel") is hook
        assert registry.names == ("novel",)
        assert registry.get("missing") is None

    def test_register_overwrites_same_name(self):
        registry = FusionRegistry()
        registry.register("k", _FakeFusionHook("a"))
        registry.register("k", _FakeFusionHook("b"))
        assert registry.names == ("k",)

    def test_empty_name_rejected(self):
        with pytest.raises(ValueError):
            FusionRegistry().register("", _FakeFusionHook("a"))


class TestContextMixer:
    @pytest.mark.asyncio
    async def test_no_hook_deterministic(self):
        mixer = ContextMixer()
        result = await mixer.mix([_src(content="正文")], total_chars=100)
        assert result.text == "正文"
        assert result.fused is False

    @pytest.mark.asyncio
    async def test_fusion_hook_result_used(self):
        hook = _FakeFusionHook("融合产物")
        mixer = ContextMixer(fusion_hook=hook, fusion_instruction="深度融合")
        result = await mixer.mix([_src(content="正文")], total_chars=1000)
        assert result.text == "融合产物"
        assert result.fused is True
        assert hook.calls == 1

    @pytest.mark.asyncio
    async def test_fusion_none_falls_back(self):
        mixer = ContextMixer(fusion_hook=_FakeFusionHook(None))
        result = await mixer.mix([_src(content="正文")], total_chars=100)
        assert result.text == "正文"
        assert result.fused is False

    @pytest.mark.asyncio
    async def test_fusion_error_falls_back(self):
        def boom():
            raise RuntimeError("融合器故障")

        mixer = ContextMixer(fusion_hook=_FakeFusionHook(boom))
        result = await mixer.mix([_src(content="正文")], total_chars=100)
        assert result.text == "正文"
        assert result.fused is False

    @pytest.mark.asyncio
    async def test_fused_text_hard_capped(self):
        mixer = ContextMixer(fusion_hook=_FakeFusionHook("长" * 5000))
        result = await mixer.mix([_src()], total_chars=100)
        assert result.text == "长" * 100

    @pytest.mark.asyncio
    async def test_attach_fusion_at_runtime(self):
        mixer = ContextMixer()
        mixer.attach_fusion(_FakeFusionHook("后挂载"), instruction="候选融合")
        result = await mixer.mix([_src()], total_chars=100)
        assert result.text == "后挂载"
