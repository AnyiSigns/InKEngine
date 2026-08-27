"""模型分层挡位原语（挡位配置模型 / 按挡位建链 / 调用统计钩子）。

模型分层：router/main 双挡位（轻量/主）按场景分配——
路由决策用轻量挡，内容生成用主挡。**组 → 挡位映射**属宿主
业务语义（TextForge 的 ``GROUP_MODEL_TIER``），引擎只提供机制：

- :func:`tier_key`：挡位名 → 配置键前缀（未知/缺省回落 main）；
- :func:`resolve_tier_config`：从用户模型配置解析单挡位的「主配置 + 备用列表」；
- :func:`build_tier_chain`：按挡位构建 ``ModelChain``（复用重试/备用链）；
- :class:`TierCallStats`：挡位调用统计钩子（``llm_calls_by_tier`` 观测）。

配置形态：``model_config`` 为 dict，挡位配置键 =
``f"{tier}_config"``（缺省回退 ``main_config``），备用链键 =
``f"{tier}_fallback_configs"``（兼容历史嵌套 ``fallback_configs``）。

依赖注入：``build_tier_chain`` 的 ``create`` / ``retry`` 可注入（测试用假
模型 / 自定义重试），默认走引擎 ``create_llm`` + 标准重试。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# 默认挡位声明（装配注入前的出厂形态：main/router 双挡；tiers.json
# 等外部声明经 set_tier_names 装配注入——策略选择随数据声明演化）
TIER_NAMES: tuple[str, ...] = ("main", "router")

# 生效中的挡位声明（数据驱动：tier_key/resolve_tier_config/统计
# 全部读此值；默认 = 出厂双挡，未知挡位回落 main 行为不变）
_ACTIVE_TIER_NAMES: tuple[str, ...] = TIER_NAMES

# 未知挡位的回落：任何未知/None 挡位按主挡位处理（配置兜底语义）
_DEFAULT_TIER = "main"


def current_tier_names() -> tuple[str, ...]:
    """当前生效的挡位声明（观察侧；装配注入后立即反映）。"""
    return _ACTIVE_TIER_NAMES


def set_tier_names(names: Any) -> None:
    """装配注入：以数据声明挡位集合（tiers.json 等外部配置读取后调用）。

    声明即权威（整组替换，不做增量追加——配置方看到的就是生效的）；
    ``main`` 必须存在（未知挡位回落锚点，缺失会被坏配置静默换挡）；
    校验直过，非法声明显式拒绝。

    Args:
        names: 挡位名序列（如 ("main", "router", "audit")）。

    Raises:
        ValueError: 空/重复/空字符串/缺 main。
    """
    global _ACTIVE_TIER_NAMES
    normalized = tuple(str(name) for name in names)
    if not normalized:
        raise ValueError("挡位声明不能为空（至少须含 main）")
    if len(set(normalized)) != len(normalized):
        raise ValueError(f"挡位声明含重复项: {normalized}")
    if any(not name for name in normalized):
        raise ValueError("挡位名不能为空字符串")
    if _DEFAULT_TIER not in normalized:
        raise ValueError(f"挡位声明缺回落锚点 {_DEFAULT_TIER!r}: {normalized}")
    _ACTIVE_TIER_NAMES = normalized


def tier_key(tier: str | None) -> str:
    """挡位名 → 配置键前缀；未知或 None 回落 main（防拼写错误静默换挡）。"""
    return tier if tier in _ACTIVE_TIER_NAMES else _DEFAULT_TIER


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
    cfg_map = model_config or {}
    # 显式空配置与缺失区分（ENG3-11）：``or`` 回退会把显式空配置
    # ``{f"{key}_config": {}}`` 误当缺失而回落主挡位——空配置 = 该挡位
    # 显式声明无配置（config=None，调用方按无配置兜底），不回落
    cfg = cfg_map.get(f"{key}_config")
    if cfg is None:
        cfg = cfg_map.get("main_config")
    if cfg is None:
        cfg = {}
    tier_fallbacks = cfg_map.get(f"{key}_fallback_configs")
    if tier_fallbacks is None:
        tier_fallbacks = cfg.get("fallback_configs")
    fallbacks = tier_fallbacks if tier_fallbacks is not None else []
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
    "current_tier_names",
    "resolve_tier_config",
    "set_tier_names",
    "tier_key",
]
