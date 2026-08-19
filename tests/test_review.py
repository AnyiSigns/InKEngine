"""components/review.py 测试：评审-收敛原语的接口、数据类与默认策略。"""
from __future__ import annotations

import pytest

from ink_engine.core.review import (
    NEUTRAL_SCORE,
    CandidateReview,
    MaxRoundsConvergencePolicy,
)


def _review(index: int, score: float, *, passed: bool | None = None) -> CandidateReview:
    return CandidateReview(
        candidate_index=index,
        score=score,
        passed=passed if passed is not None else score >= 0.75,
    )


class TestCandidateReview:
    def test_frozen_fields(self):
        from dataclasses import FrozenInstanceError

        r = _review(0, 0.8)
        with pytest.raises(FrozenInstanceError):
            r.score = 0.9

    def test_paragraphs_default_empty(self):
        assert _review(0, 0.8).paragraphs == ()


class TestMaxRoundsConvergencePolicy:
    def test_validates_arguments(self):
        with pytest.raises(ValueError):
            MaxRoundsConvergencePolicy(threshold=1.5)
        with pytest.raises(ValueError):
            MaxRoundsConvergencePolicy(beam=0)
        with pytest.raises(ValueError):
            MaxRoundsConvergencePolicy(max_rounds=-1)

    def test_empty_reviews_not_converged(self):
        """空评审集 = 无候选可判定：收敛失败（修复前误判 converged=True，
        调用方按收敛取候选会拿到空集崩溃——与评审器异常分支同语义）。"""
        decision = MaxRoundsConvergencePolicy().decide([], round_no=0)
        assert decision.converged is False
        assert decision.accepted_indices == ()
        assert decision.regenerate_indices == ()
        assert decision.notes

    def test_threshold_is_policy_second_gate(self):
        """策略 threshold 真实生效：评审器 passed 但分数低于策略门槛不收敛。"""
        policy = MaxRoundsConvergencePolicy(threshold=0.9)
        reviews = [_review(0, 0.8)]  # 评审器 0.75 判 passed，但未达策略 0.9
        decision = policy.decide(reviews, round_no=0)
        assert decision.converged is False
        assert decision.regenerate_indices == (0,)
        # 默认门槛（0.75）下 0.8 收敛
        decision2 = MaxRoundsConvergencePolicy().decide(reviews, round_no=0)
        assert decision2.converged is True
        assert decision2.accepted_indices == (0,)

    def test_passed_candidate_converges_with_best(self):
        policy = MaxRoundsConvergencePolicy()
        reviews = [_review(0, 0.6), _review(1, 0.9), _review(2, 0.85)]
        decision = policy.decide(reviews, round_no=0)
        assert decision.converged is True
        assert decision.accepted_indices == (1,)

    def test_no_passed_at_round_zero_selects_beam(self):
        policy = MaxRoundsConvergencePolicy(beam=2, max_rounds=3)
        reviews = [_review(0, 0.5), _review(1, 0.7), _review(2, 0.3)]
        decision = policy.decide(reviews, round_no=0)
        assert decision.converged is False
        assert decision.regenerate_indices == (1, 0)  # 分数降序前 2

    def test_no_passed_at_max_rounds_stops(self):
        policy = MaxRoundsConvergencePolicy(beam=1, max_rounds=2)
        reviews = [_review(0, 0.5)]
        decision = policy.decide(reviews, round_no=2)
        assert decision.converged is False
        assert decision.regenerate_indices == ()
        assert "上限" in decision.notes[0]

    def test_default_threshold_and_rounds(self):
        policy = MaxRoundsConvergencePolicy()
        assert policy.threshold == 0.75
        assert policy.max_rounds == 2
        assert policy.beam == 1


class TestNeutralScore:
    def test_neutral_not_passed(self):
        review = _review(0, NEUTRAL_SCORE)
        assert review.passed is False
