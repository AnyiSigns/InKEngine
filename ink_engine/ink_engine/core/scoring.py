"""加权打分器（维度 + 权重 + 阈值配置，纯确定性机制）。

核声明式化的打分环节：评审打分/校验判定「维度权重阈值」全部配置化——
配置即数据（:class:`ScoringConfig` 可序列化，随补丁链版本化/回退；
自适应调优直接改写权重/阈值数据，机制不变）。

语义：

- :class:`ScoreDimension`：一个打分维度（名称 + 权重 + 可选达标线）；
- :class:`ScoringConfig`：维度集合 + 总分达标线（配置校验在构造期暴露）；
- :class:`WeightedScorer`：加权均值打分（按权重归一，0-1 区间）+ 维度
  达标判定 + 总分门槛判定——纯函数式，无状态，可作模块级单例。

与评审-收敛原语（components/review）的关系：评审器产出的质量分是
「怎么评」（领域策略），打分器产出的总分/达标判定是「怎么算」（机制）。
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .exceptions import GraphDefinitionError


@dataclass(frozen=True, slots=True)
class ScoreDimension:
    """一个打分维度（配置数据）。

    Attributes:
        name: 维度名（配置内唯一）。
        weight: 权重（>0；加权均值的归一依据）。
        threshold: 维度达标线（0-1；低于 = 该维度不达标，None = 不判定）。
    """

    name: str
    weight: float = 1.0
    threshold: float | None = None

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {"name": self.name, "weight": self.weight}
        if self.threshold is not None:
            data["threshold"] = self.threshold
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ScoreDimension:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"打分维度声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        name = data.get("name")
        if not name or not isinstance(name, str):
            raise GraphDefinitionError("打分维度缺 name（字符串）")
        weight = float(data.get("weight", 1.0))
        if weight <= 0:
            raise GraphDefinitionError(f"维度 {name} 的权重必须为正: {weight}")
        threshold = data.get("threshold")
        if threshold is not None:
            threshold = float(threshold)
            if threshold < 0 or threshold > 1:
                raise GraphDefinitionError(
                    f"维度 {name} 的达标线必须在 [0, 1] 内: {threshold}"
                )
        return cls(name=name, weight=weight, threshold=threshold)


@dataclass(frozen=True, slots=True)
class ScoringConfig:
    """打分配置（维度 + 权重 + 达标线，可序列化数据形态）。

    Attributes:
        dimensions: 打分维度序列（名称唯一，构造期校验）。
        overall_threshold: 总分达标线（0-1；None = 不做总分门槛判定）。
    """

    dimensions: tuple[ScoreDimension, ...] = ()
    overall_threshold: float | None = None

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "dimensions": [dim.to_dict() for dim in self.dimensions]
        }
        if self.overall_threshold is not None:
            data["overall_threshold"] = self.overall_threshold
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ScoringConfig:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"打分配置声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        raw_dimensions = data.get("dimensions") or ()
        if not isinstance(raw_dimensions, (list, tuple)):
            raise GraphDefinitionError("打分配置的 dimensions 须为清单")
        dimensions = tuple(ScoreDimension.from_dict(raw) for raw in raw_dimensions)
        names = [dim.name for dim in dimensions]
        if len(names) != len(set(names)):
            raise GraphDefinitionError(f"打分维度名重复: {names}")
        threshold = data.get("overall_threshold")
        if threshold is not None:
            threshold = float(threshold)
            if threshold < 0 or threshold > 1:
                raise GraphDefinitionError(
                    f"总分达标线必须在 [0, 1] 内: {threshold}"
                )
        return cls(dimensions=dimensions, overall_threshold=threshold)


@dataclass(frozen=True, slots=True)
class DimensionScore:
    """单个维度的实际得分（评估输入，0-1）。"""

    name: str
    score: float
    note: str = ""


@dataclass(frozen=True, slots=True)
class ScoreResult:
    """一次加权打分的结果（总分 + 达标判定 + 逐维度明细，可审计）。

    Attributes:
        total: 加权均值总分（0-1；缺失维度按 0 计，未提供明细可查）。
        passed: 总分是否达标（未配置总分达标线时 = True）。
        scores: 逐维度得分（含缺失维度的 0 分占位与 note 说明）。
        failing_dimensions: 低于各自达标线的维度（未配置维度达标线 = 空）。
    """

    total: float
    passed: bool
    scores: tuple[DimensionScore, ...] = ()
    failing_dimensions: tuple[DimensionScore, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "total": self.total,
            "passed": self.passed,
            "scores": [
                {"name": s.name, "score": s.score, "note": s.note}
                for s in self.scores
            ],
            "failing_dimensions": [s.name for s in self.failing_dimensions],
        }


class WeightedScorer:
    """加权打分器：维度得分 → 加权均值总分 + 双门槛判定。

    计算语义（确定性，可断言）：
    1. 加权均值：total = Σ(score_i × weight_i) / Σ(weight_i)；
    2. 维度门槛：得分低于该维度达标线 → 计入 failing_dimensions；
    3. 总分门槛：total >= overall_threshold 才 passed（未配置 = 恒通过）。

    配置即数据（:class:`ScoringConfig`）；权重/达标线随反馈学习演化
    （调参直接换配置数据，本机制无状态不变）。
    """

    def __init__(self, config: ScoringConfig) -> None:
        self.config = config
        # 维度达标线预建索引（逐维度查表 O(1)，避免每次打分 O(n²) 重扫）
        self._thresholds: dict[str, float | None] = {
            dim.name: dim.threshold for dim in config.dimensions
        }

    def score(
        self,
        dimension_scores: Mapping[str, float] | Sequence[DimensionScore],
    ) -> ScoreResult:
        """按配置对维度得分打分。

        Args:
            dimension_scores: 维度名 → 得分（0-1）或
                :class:`DimensionScore` 序列（note 随结果留痕）。

        Raises:
            ValueError: 未知维度名（配置与实际评分口径不一致，宁可报错
                不静默忽略——口径漂移会让调参基准失真）。
        """
        if isinstance(dimension_scores, Mapping):
            raw: dict[str, DimensionScore] = {
                name: DimensionScore(name=name, score=float(value))
                for name, value in dimension_scores.items()
            }
        else:
            raw = {ds.name: ds for ds in dimension_scores}
        configured = {d.name for d in self.config.dimensions}
        unknown = sorted(set(raw) - configured)
        if unknown:
            raise ValueError(
                f"未知打分维度: {unknown}（配置 {sorted(configured)}）"
            )
        scores: list[DimensionScore] = []
        weighted_sum = 0.0
        weight_sum = 0.0
        for dimension in self.config.dimensions:
            actual = raw.get(dimension.name)
            if actual is None:
                raise ValueError(
                    f"未提供维度 {dimension.name} 的得分（配置 "
                    f"{sorted(configured)}）"
                )
            score = actual.score
            if score < 0 or score > 1:
                raise ValueError(
                    f"维度 {dimension.name} 得分必须在 [0, 1] 内: {score}"
                )
            scores.append(actual)
            weighted_sum += score * dimension.weight
            weight_sum += dimension.weight
        failing = tuple(
            ds for ds in scores if self._below_threshold(ds)
        )
        total = weighted_sum / weight_sum if weight_sum else 0.0
        passed = (
            self.config.overall_threshold is None
            or total >= self.config.overall_threshold
        )
        return ScoreResult(
            total=total,
            passed=passed,
            scores=tuple(scores),
            failing_dimensions=failing,
        )

    def _below_threshold(self, dimension_score: DimensionScore) -> bool:
        """维度得分是否低于该维度达标线（未配置达标线 = 恒达标）。"""
        threshold = self._thresholds.get(dimension_score.name)
        return threshold is not None and dimension_score.score < threshold


__all__ = [
    "DimensionScore",
    "ScoreDimension",
    "ScoreResult",
    "ScoringConfig",
    "WeightedScorer",
]
