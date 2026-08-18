"""模型分层挡位原语（D5：挡位配置模型 / 按挡位建链 / 调用统计钩子）。

模型分层：router/tool/main/audit 四挡位（轻量/中等/主/审计）按场景分配——
路由决策用轻量挡，正文生成用主挡，审计用审计挡。**组 → 挡位映射**属宿主
业务语义（TextForge 的 ``GROUP_MODEL_TIER``），引擎只提供机制：

- :func:`tier_key`：挡位名 → 配置键前缀（未知/缺省回落 main）；
- :func:`resolve_tier_config`：从用户模型配置解析单挡位的「主配置 + 备用列表」；
- :func:`build_tier_chain`：按挡位构建 ``ModelChain``（复用 E2 重试/备用链）；
- :class:`TierCallStats`：挡位调用统计钩子（``llm_calls_by_tier`` 观测）。

配置形态（与 E3 对齐）：``model_config`` 为 dict，挡位配置键 =
``f"{tier}_config"``（缺省回退 ``main_config``），备用链键 =
``f"{tier}_fallback_configs"``（兼容历史嵌套 ``fallback_configs``）。

依赖注入：``build_tier_chain`` 的 ``create`` / ``retry`` 可注入（测试用假
模型 / 自定义重试），默认走引擎 ``create_llm`` + 标准重试。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# 挡位枚举（与 ModelFactory 实例属性名对齐：main/router/tool/audit）
TIER_NAMES: tuple[str, ...] = ("main", "router", "tool", "audit")

# 未知挡位的回落：任何未知/None 挡位按主挡位处理（配置兜底语义）
_DEFAULT_TIER = "main"


def tier_key(tier: str | None) -> str:
    """挡位名 → 配置键前缀；未知或 None 回落 main（防拼写错误静默换挡）。"""
    return tier if tier in TIER_NAMES else _DEFAULT_TIER


@dataclass(frozen=True, slots=True)
class TierConfig:
    """单挡位的模型配置形态。

    Attributes:
        tier: 归一化后的挡位名（未知已回落 main）。
        config: 主配置 dict；None = 该挡位无配置（调用方走错误兜底）。
        fallbacks: 备用配置列表（与主配置同形态，ModelChain 备用链）。
    """

    tier: str
    config: dict[str, Any] | None
    fallbacks: tuple[dict[str, Any], ...]


def resolve_tier_config(
    model_config: dict[str, Any] | None,
    tier: str | None,
) -> TierConfig:
    """从用户模型配置解析指定挡位的配置形态（纯函数，可单测）。

    解析规则（与宿主 `_build_tier_chain` 原语义一致，单点维护）：
    1. 主配置 = ``f"{tier}_config"``，缺省回退 ``main_config``；
    2. 备用列表 = ``f"{tier}_fallback_configs"``，兼容历史嵌套
       ``config["fallback_configs"]``；
    3. 全部缺失 → ``config=None``（调用方按无配置处理，不抛错）。
    """
    key = tier_key(tier)
    cfg = (
        (model_config or {}).get(f"{key}_config")
        or (model_config or {}).get("main_config")
        or {}
    )
    fallbacks = (
        (model_config or {}).get(f"{key}_fallback_configs")
        or cfg.get("fallback_configs")
        or []
    )
    return TierConfig(
        tier=key,
        config=cfg or None,
        fallbacks=tuple(fallbacks or ()),
    )


def build_tier_chain(
    model_config: dict[str, Any] | None,
    tier: str | None = None,
    *,
    create: Any = None,
    retry: Any = None,
):
    """按挡位构建模型链（主配置 + 备用链）；配置缺失返回 None。

    Args:
        model_config: 用户模型配置字典（可含挡位主配置与备用列表）。
        tier: 挡位名（router/tool/main/audit；未知回落 main）。
        create: 适配器工厂注入（默认引擎 create_llm；测试注入假模型）。
        retry: 重试策略注入（默认引擎标准重试）。

    Returns:
        ``ModelChain`` 实例；该挡位与主挡位均无配置时返回 None
        （调用方按配置缺失兜底，与引擎节点容错语义一致）。
    """
    from ink_engine.core.llm.fallback import ModelChain

    resolved = resolve_tier_config(model_config, tier)
    if not resolved.config:
        return None
    return ModelChain(
        [resolved.config, *resolved.fallbacks],
        create=create,
        retry=retry,
    )


class TierCallStats:
    """挡位调用统计钩子：按挡位累加 LLM 调用次数，供回合级观测。

    用法（宿主回合收尾）：每次按挡位发起调用后 ``record(tier)``，
    回合结束 ``snapshot()`` 汇入 ``turn_metrics.llm_calls_by_tier``。
    线程安全：单回合单执行流内使用（与引擎执行语义一致，无锁）。
    """

    def __init__(self) -> None:
        self._counts: dict[str, int] = {}

    def record(self, tier: str | None, count: int = 1) -> None:
        """累加一次（或多次）某挡位的调用数；未知挡位归一后记录。"""
        if count <= 0:
            return
        key = tier_key(tier)
        self._counts[key] = self._counts.get(key, 0) + count

    def snapshot(self) -> dict[str, int]:
        """当前计数快照（{挡位: 次数}，未调用过的挡位不出现）。"""
        return dict(self._counts)

    def reset(self) -> None:
        """清零（新回合复用实例时调用）。"""
        self._counts.clear()

    def __iadd__(self, other: TierCallStats) -> TierCallStats:
        """合并另一实例的计数（嵌套图/子图回流场景汇总）。"""
        for tier, count in other._counts.items():
            self._counts[tier] = self._counts.get(tier, 0) + count
        return self


__all__ = [
    "TIER_NAMES",
    "TierCallStats",
    "TierConfig",
    "build_tier_chain",
    "resolve_tier_config",
    "tier_key",
]
