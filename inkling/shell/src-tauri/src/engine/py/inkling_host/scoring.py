"""评审打分配置映射：review.json → :class:`ScoringConfig`（配置真源读取）。

批 6e P6 死簇清理后本模块只保留数据映射段：``build_review_scorer`` /
``dimension_scorer_with_facts``（无运行时调用方）与 recipe_loader 的
``map_review_scorer`` 已删除；推演分支评估由引擎侧 simulation/
scoring 直接装配，宿主不再持有打分器副本。
"""
from __future__ import annotations

from typing import Any

from ink_engine.core.scoring import ScoreDimension, ScoringConfig


def build_review_scoring_config(review_data: dict[str, Any]) -> ScoringConfig:
    """review.json → ScoringConfig（维度/权重/通过阈值）。"""
    dimensions = tuple(
        ScoreDimension(name=str(dim["name"]), weight=float(dim["weight"]))
        for dim in review_data.get("dimensions") or ()
    )
    return ScoringConfig(
        dimensions=dimensions,
        overall_threshold=float(review_data["pass_threshold"]),
    )


__all__ = ["build_review_scoring_config"]
