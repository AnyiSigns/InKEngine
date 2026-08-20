"""core/tiers.py 测试：挡位配置解析、按挡位建链、调用统计钩子。"""
from __future__ import annotations

from ink_engine.core.tiers import (
    TIER_NAMES,
    TierCallStats,
    build_tier_chain,
    resolve_tier_config,
    tier_key,
)


def _model_config(**kw) -> dict:
    cfg = {
        "main_config": {"adapter": "openai_compat", "model_id": "main", "base_url": "http://m"},
        "router_config": {"adapter": "openai_compat", "model_id": "router", "base_url": "http://r"},
    }
    cfg.update(kw)
    return cfg


class TestTierKey:
    def test_known_tiers_passthrough(self):
        for tier in ("main", "router", "tool", "audit"):
            assert tier_key(tier) == tier

    def test_unknown_and_none_fall_back_to_main(self):
        assert tier_key("bogus") == "main"
        assert tier_key(None) == "main"

    def test_tier_names(self):
        assert TIER_NAMES == ("main", "router", "tool", "audit")


class TestResolveTierConfig:
    def test_uses_tier_config(self):
        tc = resolve_tier_config(_model_config(), "router")
        assert tc.tier == "router"
        assert tc.config == _model_config()["router_config"]

    def test_falls_back_to_main_when_tier_missing(self):
        tc = resolve_tier_config(_model_config(), "tool")
        assert tc.config == _model_config()["main_config"]

    def test_unknown_tier_resolves_to_main(self):
        tc = resolve_tier_config(_model_config(), "bogus")
        assert tc.tier == "main"

    def test_top_level_fallbacks(self):
        cfg = _model_config(tool_fallback_configs=[{"model_id": "fb1"}])
        tc = resolve_tier_config(cfg, "tool")
        assert tc.fallbacks == ({"model_id": "fb1"},)

    def test_legacy_nested_fallbacks(self):
        cfg = _model_config(
            tool_config={
                "adapter": "openai_compat",
                "model_id": "tool",
                "base_url": "http://t",
                "fallback_configs": [{"model_id": "fb1"}],
            }
        )
        tc = resolve_tier_config(cfg, "tool")
        assert tc.config["model_id"] == "tool"
        assert tc.fallbacks == ({"model_id": "fb1"},)

    def test_no_config_returns_none(self):
        tc = resolve_tier_config({}, "main")
        assert tc.config is None
        assert tc.fallbacks == ()
        assert resolve_tier_config(None, "main").config is None


class TestBuildTierChain:
    def test_builds_chain_from_config(self):
        chain = build_tier_chain(_model_config(), "router", create=_FakeCreate())
        assert chain is not None

    def test_missing_config_returns_none(self):
        assert build_tier_chain({}, "main") is None
        assert build_tier_chain(None, "main") is None


class TestTierCallStats:
    def test_records_by_tier(self):
        stats = TierCallStats()
        stats.record("router")
        stats.record("main", 3)
        stats.record("tool")
        assert stats.snapshot() == {"router": 1, "main": 3, "tool": 1}

    def test_unknown_tier_normalized(self):
        stats = TierCallStats()
        stats.record("bogus")
        assert stats.snapshot() == {"main": 1}

    def test_non_positive_count_ignored(self):
        stats = TierCallStats()
        stats.record("main", 0)
        stats.record("main", -1)
        assert stats.snapshot() == {}

    def test_reset(self):
        stats = TierCallStats()
        stats.record("main")
        stats.reset()
        assert stats.snapshot() == {}

    def test_merge(self):
        a, b = TierCallStats(), TierCallStats()
        a.record("main", 2)
        b.record("router", 1)
        b.record("main", 1)
        a += b
        assert a.snapshot() == {"main": 3, "router": 1}


class _FakeCreate:
    """注入建链工厂：返回假模型（仅验证链构建，不真正调用）。"""

    def __call__(self, config):
        return _FakeLLM()


class _FakeLLM:
    adapter = "openai_compat"

    async def ainvoke(self, messages, *, tools=None, params=None):
        raise NotImplementedError

    async def astream(self, messages, *, tools=None, params=None):
        raise NotImplementedError
        yield

    async def aclose(self) -> None:
        pass
