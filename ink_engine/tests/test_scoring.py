"""加权打分器单测：配置数据形态/加权均值/双门槛判定/口径校验。

语义检查点：配置即数据（维度+权重+达标线可序列化，构造期校验）；
总分 = 加权均值（按权重归一，确定性可断言）；维度达标线与总分门槛
独立判定；未知/缺失维度 = 口径错误显式拒绝（不静默忽略——调参基准
失真会让权重学习失效）。
"""
from __future__ import annotations

import pytest

from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.scoring import (
    DimensionScore,
    ScoreDimension,
    ScoringConfig,
    WeightedScorer,
)


def _config() -> ScoringConfig:
    return ScoringConfig(
        dimensions=(
            ScoreDimension(name="plot", weight=2.0, threshold=0.6),
            ScoreDimension(name="style", weight=1.0, threshold=0.5),
        ),
        overall_threshold=0.7,
    )


def test_scoring_config_round_trip():
    """打分配置序列化 → 重建：维度/权重/达标线完整还原。"""
    rebuilt = ScoringConfig.from_dict(_config().to_dict())
    assert [d.name for d in rebuilt.dimensions] == ["plot", "style"]
    assert rebuilt.dimensions[0].weight == 2.0
    assert rebuilt.dimensions[0].threshold == 0.6
    assert rebuilt.overall_threshold == 0.7
    # 缺省字段（全维度无达标线/无总分门槛）最小形态往返
    minimal = ScoringConfig(dimensions=(ScoreDimension(name="a"),))
    assert ScoringConfig.from_dict(minimal.to_dict()).overall_threshold is None
    assert ScoringConfig.from_dict(minimal.to_dict()).dimensions[0].threshold is None


def test_scoring_config_rejects_invalid():
    """配置类型闸门：权重非正/达标线越界/维度名重复 → 构造期拒绝。"""
    with pytest.raises(GraphDefinitionError, match="权重必须为正"):
        ScoringConfig.from_dict({"dimensions": [{"name": "a", "weight": 0}]})
    with pytest.raises(GraphDefinitionError, match=r"\[0, 1\]"):
        ScoringConfig.from_dict({"dimensions": [{"name": "a", "threshold": 1.5}]})
    with pytest.raises(GraphDefinitionError, match="重复"):
        ScoringConfig.from_dict(
            {"dimensions": [{"name": "a"}, {"name": "a"}]}
        )
    with pytest.raises(GraphDefinitionError, match=r"\[0, 1\]"):
        ScoringConfig.from_dict(
            {"dimensions": [{"name": "a"}], "overall_threshold": 2}
        )


def test_weighted_mean_math():
    """加权均值：total = Σ(score×weight)/Σ(weight)（确定性可断言）。"""
    scorer = WeightedScorer(_config())
    result = scorer.score({"plot": 0.8, "style": 0.6})
    assert result.total == pytest.approx((0.8 * 2 + 0.6 * 1) / 3)
    # 权重更大的维度对总分影响更大
    low_plot = scorer.score({"plot": 0.2, "style": 1.0})
    assert low_plot.total < result.total


def test_overall_threshold_gate():
    """总分门槛：低于达标线 passed=False，达到即通过。"""
    scorer = WeightedScorer(_config())
    assert scorer.score({"plot": 0.8, "style": 0.6}).passed is True  # 0.733 >= 0.7
    assert scorer.score({"plot": 0.6, "style": 0.6}).passed is False  # 0.6 < 0.7
    # 未配置总分达标线 = 恒通过
    no_gate = WeightedScorer(ScoringConfig(dimensions=(ScoreDimension(name="a"),)))
    assert no_gate.score({"a": 0.1}).passed is True


def test_dimension_threshold_flags_failing():
    """维度达标线：低于自身达标线的维度计入 failing_dimensions。"""
    scorer = WeightedScorer(_config())
    result = scorer.score({"plot": 0.5, "style": 0.9})  # plot 0.5 < 0.6
    assert [d.name for d in result.failing_dimensions] == ["plot"]
    assert result.passed is False  # 总分 0.633 < 0.7，与维度门槛独立判定
    # 全维度达标 → failing 为空
    assert scorer.score({"plot": 0.8, "style": 0.6}).failing_dimensions == ()


def test_dimension_score_notes_carried():
    """DimensionScore 的 note 随结果留痕（评估明细可审计）。"""
    scorer = WeightedScorer(_config())
    result = scorer.score(
        [
            DimensionScore(name="plot", score=0.8, note="主线完整"),
            DimensionScore(name="style", score=0.6, note="文风稳定"),
        ]
    )
    assert result.scores[0].note == "主线完整"
    assert result.scores[1].note == "文风稳定"


def test_missing_and_unknown_dimension_rejected():
    """口径校验：缺失维度/未知维度显式拒绝（不静默按 0 分/忽略）。"""
    scorer = WeightedScorer(_config())
    with pytest.raises(ValueError, match="未提供维度 plot"):
        scorer.score({"style": 0.9})
    with pytest.raises(ValueError, match="得分必须在"):
        scorer.score({"plot": 2.0, "style": 0.5})
    # 评估侧多出配置外维度同样拒绝（口径漂移双向拦截）
    with pytest.raises(ValueError, match="未知打分维度"):
        scorer.score({"plot": 0.8, "style": 0.5, "extra": 0.9})


def test_score_result_serializable():
    """打分结果可序列化（总分/达标/逐维度明细/不达标维度）。"""
    scorer = WeightedScorer(_config())
    result = scorer.score({"plot": 0.5, "style": 0.9})
    data = result.to_dict()
    assert data["passed"] is False  # 总分 0.633 < 0.7
    assert data["failing_dimensions"] == ["plot"]
    assert len(data["scores"]) == 2
    assert data["scores"][0]["name"] == "plot"
    assert 0.0 <= data["total"] <= 1.0


def test_empty_config_returns_zero_total():
    """空维度配置：总分 0、恒通过（无门槛时）——合法边界不崩溃。"""
    scorer = WeightedScorer(ScoringConfig(dimensions=()))
    result = scorer.score({})
    assert result.total == 0.0
    assert result.passed is True
    assert result.scores == ()
