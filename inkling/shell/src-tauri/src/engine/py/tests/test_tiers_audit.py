"""audit 三挡接线核验（W8.1-8.4 壳侧 Python）：挡位声明数据化装配注入 +
治理类 LLM 调用归因 audit 挡（缺省回落 main 链）+ tier_stats 含 audit。

覆盖：
- build_tier_chains 把 tiers.json 声明注入引擎 set_tier_names（声明即权威，
  tier_key("audit") 生效）；
- audit 挡未配链时 resolve_tier_chain 回落主挡位链（fail-open 语义）；
- review_pipeline 以 audit 挡归因（on_llm_call 记录 audit）；
- knowledge_domain.review_and_converge 归因 audit 挡。

无 pytest 依赖：`py test_tiers_audit.py`；亦兼容 pytest（函数名 test_*）。
"""

import asyncio
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_PY_DIR = os.path.dirname(_HERE)
if _PY_DIR not in sys.path:
    sys.path.insert(0, _PY_DIR)

from ink_engine.core.tiers import (
    TIER_NAMES,
    current_tier_names,
    set_tier_names,
)
from inkling_host.model_layers import (
    build_tier_chains,
    resolve_tier_chain,
)

_TIERS_AUDIT = {"tiers": ["main", "router", "audit"]}
_MAIN_CONFIG = {
    "main_config": {
        "adapter": "openai_compat",
        "model_id": "main",
        "base_url": "http://example.invalid/main",
    }
}


def _reset_tiers():
    set_tier_names(TIER_NAMES)


class _Reply:
    def __init__(self, content):
        self.content = content


class _FakeLLM:
    """评审/再生成桩：一次性返回达标分（0.9 ≥ 默认阈值 0.75，一轮收敛）。"""

    def __init__(self, adapter="openai_compat"):
        self.adapter = adapter

    async def ainvoke(self, messages, *, tools=None, params=None):
        return _Reply(
            '{"score": 0.9, "reason": "ok", "paragraphs": [], "uncertain_claims": []}'
        )

    async def astream(self, messages, *, tools=None, params=None):
        yield _Reply("")

    async def aclose(self) -> None:
        pass


def test_build_tier_chains_injects_declaration():
    _reset_tiers()
    try:
        chains = build_tier_chains(_TIERS_AUDIT, _MAIN_CONFIG)
        assert current_tier_names() == ("main", "router", "audit"), (
            "挡位声明应随 tiers.json 注入引擎（W8.1 数据化）"
        )
        assert set(chains) == {"main", "router", "audit"}
        assert chains["main"] is not None
        # 缺挡位配置回落 main_config（tiers.json fallback 语义）：audit 链
        # 实质承载主挡配置——治理类调用缺省走主挡位链（fail-open 不阻断）
        assert chains["router"] is not None, "router 缺配置回落 main_config"
        assert chains["audit"] is not None, "audit 缺配置回落 main_config"
        assert chains["audit"].configs[0].model_id == "main", (
            "audit 回落链应引用主挡配置"
        )
    finally:
        _reset_tiers()


def test_resolve_tier_chain_audit_falls_back_to_main():
    _reset_tiers()
    try:
        chains = build_tier_chains(_TIERS_AUDIT, _MAIN_CONFIG)
        chain = resolve_tier_chain(chains, "audit")
        assert chain is not None, "audit 缺省回落主挡位链（fail-open 语义）"
        assert chain.configs[0].model_id == "main"
        chain_router = resolve_tier_chain(chains, "router")
        assert chain_router is not None, "router 缺省同样回落 main 链"
        assert resolve_tier_chain(chains, "bogus") is not None, "未知挡回落 main"
    finally:
        _reset_tiers()


def test_review_pipeline_attributes_to_audit_tier():
    from inkling_host.review_pipeline import build_review_pipeline

    _reset_tiers()
    try:
        calls: list[str] = []
        pipeline = build_review_pipeline(
            _FakeLLM(),
            {"pass_threshold": 0.75, "max_rounds": 2},
            tier="audit",
            on_llm_call=calls.append,
        )
        assert pipeline is not None
        asyncio.run(pipeline(["候选文稿"]))
        assert "audit" in calls, f"评审 LLM 调用应归因 audit 挡，实际: {calls}"
        assert all(c == "audit" for c in calls)
    finally:
        _reset_tiers()


def test_knowledge_review_attributes_to_audit_tier():
    from inkling_host.knowledge_domain import IncubationDomain

    _reset_tiers()
    try:
        calls: list[str] = []

        class _Runtime:
            storage = None

        domain = IncubationDomain(
            _Runtime(),
            signals_data={},
            samples_data={},
            review_data={},
            on_llm_call=calls.append,
        )
        result = asyncio.run(domain.review_and_converge(_FakeLLM(), ["候选文稿"]))
        assert result is not None
        assert "audit" in calls, f"知识域评审应归因 audit 挡，实际: {calls}"
    finally:
        _reset_tiers()


def test_model_tier_configs_from_file_projection():
    """文件连接配置 → 挡位投影（main/router/audit 各自成链）。"""
    import json
    import tempfile

    from inkling_host.host import _model_tier_configs_from_file

    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
        with open(
            os.path.join(d, "model_connection.json"), "w", encoding="utf-8"
        ) as fh:
            json.dump(
                {
                    "base_url": "http://a/v1",
                    "provider_id": "openai_compat",
                    "main_model_id": "m1",
                    "router_model_id": "r1",
                    "audit_model_id": "a1",
                },
                fh,
            )
        configs = _model_tier_configs_from_file(d)
        assert set(configs) == {
            "main_config",
            "router_config",
            "audit_config",
        }
        assert configs["main_config"]["model_id"] == "m1"
        assert configs["router_config"]["model_id"] == "r1"
        assert configs["audit_config"]["model_id"] == "a1"
        assert configs["audit_config"]["adapter"] == "openai_compat"
    # 缺 base_url / data_dir 缺失 → 空映射
    assert _model_tier_configs_from_file(None) == {}


def test_reload_model_config_rebuilds_tier_chains():
    """model.reload 热重建挡位域：router/audit 文件配置即时生效。"""
    import json
    import tempfile

    from ink_engine.core.tiers import (
        current_tier_names,
        set_tier_names,
    )
    from inkling_host.host import InKlingHost

    _reset_tiers()
    try:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
            with open(
                os.path.join(d, "model_connection.json"), "w", encoding="utf-8"
            ) as fh:
                json.dump(
                    {
                        "base_url": "http://a/v1",
                        "main_model_id": "m1",
                        "router_model_id": "r1",
                        "audit_model_id": "a1",
                    },
                    fh,
                )
            host = InKlingHost(data_dir=d)
            host._tiers_data = {"tiers": ["main", "router", "audit"]}
            host._review_data = {"pass_threshold": 0.75}
            assert not host.tier_chains  # 装配前无链
            host.reload_model_config()
            assert current_tier_names() == ("main", "router", "audit")
            assert host.tier_chains["router"] is not None
            assert host.tier_chains["router"].configs[0].model_id == "r1"
            assert host.tier_chains["audit"] is not None
            assert host.tier_chains["audit"].configs[0].model_id == "a1"
            assert host.review_pipeline is not None
            assert host.incubation is None or host.incubation.distiller.chain is not None
    finally:
        _reset_tiers()


if __name__ == "__main__":
    for _fn in (
        test_build_tier_chains_injects_declaration,
        test_resolve_tier_chain_audit_falls_back_to_main,
        test_review_pipeline_attributes_to_audit_tier,
        test_knowledge_review_attributes_to_audit_tier,
        test_model_tier_configs_from_file_projection,
        test_reload_model_config_rebuilds_tier_chains,
    ):
        _fn()
        print(f"PASS {_fn.__name__}")
    print("tiers audit wiring: all pass")
