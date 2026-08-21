"""模型层装配：tiers.json 四挡位按挡位建链 + 缺省回退（PLAN §6 M3）。

引擎机制（core.tiers）：tier_key 未知挡位回落 main；resolve_tier_config
缺挡位配置回落 main_config；build_tier_chain 复用重试/备用链。
本模块把 tiers.json（挡位声明 + 缺省回退语义）与宿主注入的实际模型
连接配置（base_url/模型/密钥引用归宿主职责）装配成四挡位链。
"""
from __future__ import annotations

from typing import Any

from ink_engine.core.tiers import TierCallStats, build_tier_chain, tier_key

# 缺省回退挡位（tiers.json fallback.unknown_tier_falls_to 的引擎常量映射）
_DEFAULT_TIER = "main"


def build_tier_chains(
    tiers_data: dict[str, Any],
    model_config: dict[str, Any],
    *,
    create: Any = None,
    retry: Any = None,
) -> dict[str, Any]:
    """tiers.json 挡位清单 → 每挡位一条模型链（配置缺失 = 该挡位 None）。

    宿主注入的 model_config 含实际连接配置（挡位键形态与引擎
    resolve_tier_config 对齐：``<tier>_config`` + ``<tier>_fallback_configs``）；
    未配置的挡位返回 None——调用方按缺省回退取主挡位链。
    """
    chains: dict[str, Any] = {}
    for tier in tiers_data.get("tiers") or ():
        chains[tier] = build_tier_chain(
            model_config, tier, create=create, retry=retry
        )
    return chains


def resolve_tier_chain(
    chains: dict[str, Any],
    tier: str | None,
    *,
    default_tier: str = _DEFAULT_TIER,
) -> Any:
    """按挡位取链；未知挡位或缺省回退（fallback 语义与 tiers.json 一致）。

    规则：
    1. 未知挡位名 → 归一为主挡位（tier_key 语义，防拼写错误静默换挡）；
    2. 该挡位未建链（配置缺失）→ 回落主挡位链；
    3. 主挡位也未建链 → None（调用方按配置缺失兜底，与引擎节点
       容错语义一致）。
    """
    key = tier if tier in chains else tier_key(tier)
    chain = chains.get(key)
    if chain is None and key != default_tier:
        chain = chains.get(default_tier)
    return chain


def make_tier_stats() -> TierCallStats:
    """挡位调用统计钩子（回合级观测：llm_calls_by_tier 汇总）。"""
    return TierCallStats()


__all__ = [
    "build_tier_chains",
    "make_tier_stats",
    "resolve_tier_chain",
]
