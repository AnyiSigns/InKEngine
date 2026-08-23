"""tiers.py 挡位声明数据化单测：装配注入 / 声明校验 / 未知回落不变。

覆盖：出厂默认双挡（TIER_NAMES/main/router）；set_tier_names 追加
audit 后 tier_key/resolve_tier_config/build_tier_chain/TierCallStats
全部随声明生效；未知挡位仍回落 main（行为不变）；声明校验（空/
重复/缺 main/空字符串显式拒绝）；恢复出厂声明。
"""
from __future__ import annotations

import pytest

from ink_engine.core.tiers import (
    TIER_NAMES,
    TierCallStats,
    build_tier_chain,
    current_tier_names,
    resolve_tier_config,
    set_tier_names,
    tier_key,
)

_AUDIT = ("main", "router", "audit")


@pytest.fixture(autouse=True)
def _restore_tiers():
    """每测试后恢复出厂声明（tiers 是模块级装配状态，跨测试复位）。"""
    yield
    set_tier_names(TIER_NAMES)


class TestDefaultDeclaration:
    def test_factory_default_double_tier(self):
        assert TIER_NAMES == ("main", "router")
        assert current_tier_names() == ("main", "router")

    def test_unknown_falls_back_to_main(self):
        assert tier_key("bogus") == "main"
        assert tier_key(None) == "main"


class TestInjection:
    def test_audit_tier_declared_and_used(self):
        set_tier_names(_AUDIT)
        assert current_tier_names() == _AUDIT
        assert tier_key("audit") == "audit"
        assert tier_key("bogus") == "main"  # 未知仍回落

    def test_resolve_tier_config_follows_declaration(self):
        set_tier_names(_AUDIT)
        cfg = {
            "main_config": {"model_id": "main"},
            "router_config": {"model_id": "router"},
            "audit_config": {"model_id": "audit"},
            "audit_fallback_configs": [{"model_id": "fb"}],
        }
        resolved = resolve_tier_config(cfg, "audit")
        assert resolved.tier == "audit"
        assert resolved.config == {"model_id": "audit"}
        assert resolved.fallbacks == ({"model_id": "fb"},)

    def test_build_tier_chain_follows_declaration(self):
        set_tier_names(_AUDIT)

        class _FakeLLM:
            adapter = "openai_compat"

            async def ainvoke(self, messages, *, tools=None, params=None):
                raise NotImplementedError

            async def astream(self, messages, *, tools=None, params=None):
                raise NotImplementedError
                yield

            async def aclose(self) -> None:
                pass

        chain = build_tier_chain(
            {
                "audit_config": {
                    "adapter": "openai_compat",
                    "model_id": "audit",
                    "base_url": "http://audit",
                }
            },
            "audit",
            create=lambda cfg: _FakeLLM(),
        )
        assert chain is not None
        assert chain.configs[0].model_id == "audit"

    def test_tier_call_stats_follows_declaration(self):
        set_tier_names(_AUDIT)
        stats = TierCallStats()
        stats.record("audit")
        stats.record("bogus")
        assert stats.snapshot() == {"audit": 1, "main": 1}

    def test_declaration_is_authoritative_replace(self):
        """声明即权威：整组替换（非增量追加），后注入者覆盖前注入者。"""
        set_tier_names(_AUDIT)
        set_tier_names(TIER_NAMES)
        assert current_tier_names() == ("main", "router")
        assert tier_key("audit") == "main"


class TestValidation:
    def test_empty_rejected(self):
        with pytest.raises(ValueError, match="不能为空"):
            set_tier_names([])
        with pytest.raises(ValueError, match="不能为空"):
            set_tier_names(())

    def test_duplicates_rejected(self):
        with pytest.raises(ValueError, match="重复"):
            set_tier_names(("main", "router", "main"))

    def test_missing_main_rejected(self):
        with pytest.raises(ValueError, match="回落锚点"):
            set_tier_names(("router", "audit"))

    def test_empty_string_rejected(self):
        with pytest.raises(ValueError, match="不能为空字符串"):
            set_tier_names(("main", ""))

    def test_invalid_declaration_keeps_previous_active(self):
        """非法声明不生效：当前声明保持原样（拒绝即不改状态）。"""
        set_tier_names(_AUDIT)
        with pytest.raises(ValueError):
            set_tier_names(()),
        assert current_tier_names() == _AUDIT
