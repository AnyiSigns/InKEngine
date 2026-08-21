"""模型层装配 e2e：tiers.json 四挡位按挡位建链 + 缺省回退。

引擎机制（core.tiers）：tier_key 未知回落 main；resolve_tier_config
缺挡位配置回落 main_config；build_tier_chain 复用重试/备用链。
本模块钉住：四挡位各建一条链（stub 工厂注入）、未知挡位归一、缺
挡位配置回落主挡位、调用统计钩子。
"""
from __future__ import annotations

from typing import Any

from conftest import StubLLM, load_seed

from host.model_layers import (
    build_tier_chains,
    make_tier_stats,
    resolve_tier_chain,
)

TIERS = load_seed("tiers.json")

# 宿主注入的实际模型连接配置（tiers.json requires_user_config 的落点：
# 挡位配置键与引擎 resolve_tier_config 对齐，stub 不发起真实请求）
_MODEL_CONFIG: dict[str, Any] = {
    "router_config": {
        "adapter": "stub", "model_id": "router-model", "base_url": "http://stub.local",
    },
    "tool_config": {
        "adapter": "stub", "model_id": "tool-model", "base_url": "http://stub.local",
    },
    "main_config": {
        "adapter": "stub", "model_id": "main-model", "base_url": "http://stub.local",
    },
    "audit_config": {
        "adapter": "stub", "model_id": "audit-model", "base_url": "http://stub.local",
    },
}


def _create(cfg: Any) -> StubLLM:
    """stub 适配器工厂注入（ModelChain create 参数，离线确定性）。"""
    return StubLLM(cfg)


def test_four_tiers_chains_built():
    """tiers.json 四挡位（router/tool/main/audit）各建一条链。"""
    chains = build_tier_chains(TIERS, _MODEL_CONFIG, create=_create)
    assert set(chains) == {"router", "tool", "main", "audit"}
    for tier, chain in chains.items():
        assert chain is not None, f"挡位未建链: {tier}"
        assert chain.configs[0].model_id == f"{tier}-model"


def test_unknown_tier_falls_back_to_main():
    """未知挡位归一回落 main（tier_key 语义，防拼写错误静默换挡）。"""
    chains = build_tier_chains(TIERS, _MODEL_CONFIG, create=_create)
    chain = resolve_tier_chain(chains, "bogus_tier")
    assert chain is not None
    assert chain.configs[0].model_id == "main-model"
    assert resolve_tier_chain(chains, None) is chains["main"]


def test_missing_tier_config_falls_back_to_main_config():
    """缺挡位配置：该挡位链按 main_config 建（resolve_tier_config 回落语义）。"""
    sparse = {"main_config": dict(_MODEL_CONFIG["main_config"])}
    chains = build_tier_chains(TIERS, sparse, create=_create)
    for tier in ("router", "tool", "audit", "main"):
        assert chains[tier] is not None
        assert chains[tier].configs[0].model_id == "main-model"
    # 全缺配置 = 无链（调用方按配置缺失兜底，与引擎节点容错语义一致）
    empty = build_tier_chains(TIERS, {}, create=_create)
    assert empty["main"] is None
    assert resolve_tier_chain(empty, "router") is None


def test_tier_call_stats_observability():
    """挡位调用统计钩子：按挡位累加 + 快照 + 合并（回合级观测）。"""
    stats = make_tier_stats()
    stats.record("router", 2)
    stats.record("main", 1)
    stats.record("bogus", 3)  # 未知挡位归一 main
    snapshot = stats.snapshot()
    assert snapshot == {"router": 2, "main": 4}
    other = make_tier_stats()
    other.record("audit", 1)
    stats += other
    assert stats.snapshot()["audit"] == 1
    stats.reset()
    assert stats.snapshot() == {}


async def test_stub_chain_streaming_deterministic():
    """stub 链流式调用确定性（离线全链路 e2e 的模型层底座）。"""
    from ink_engine.core.llm.messages import user

    chains = build_tier_chains(TIERS, _MODEL_CONFIG, create=_create)
    chain = chains["main"]
    chunks = []
    async for chunk in chain.astream([user("研究墨引擎机制")], tools=None, params=None):
        if chunk.token:
            chunks.append(chunk.token)
    assert chunks  # 流式产出
    result = await chain.ainvoke([user("研究墨引擎机制")], tools=None, params=None)
    assert isinstance(result.content, str)
