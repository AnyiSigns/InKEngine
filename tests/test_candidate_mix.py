"""novel_harness/candidate_mix.py 测试：段落切分与跨候选取段落组装。"""
from __future__ import annotations

import pytest

from ink_engine.components.review import CandidateReview, ParagraphScore
from ink_engine.novel_harness.candidate_mix import (
    MixedCandidate,
    ParagraphSource,
    build_mixed_candidate,
    split_paragraphs,
)


def _review(index: int, scores: list[float], passed: bool = True) -> CandidateReview:
    return CandidateReview(
        candidate_index=index,
        score=(sum(scores) / len(scores)) if scores else 0.0,
        passed=passed,
        paragraphs=tuple(
            ParagraphScore(index, i, s) for i, s in enumerate(scores)
        ),
    )


class TestSplitParagraphs:
    def test_empty(self):
        assert split_paragraphs("") == []
        assert split_paragraphs(None) == []

    def test_blank_only(self):
        assert split_paragraphs(" \n\n  \n") == []

    def test_splits_on_blank_line_keeps_inner_newlines(self):
        text = "第一段\n换行继续。\n\n第二段。"
        assert split_paragraphs(text) == ["第一段\n换行继续。", "第二段。"]

    def test_strips_whitespace(self):
        assert split_paragraphs("  a  \n\n  b  ") == ["a", "b"]


class TestBuildMixedCandidate:
    def test_needs_two_candidates(self):
        reviews = [_review(0, [0.9])]
        assert build_mixed_candidate(["only"], reviews) is None

    def test_needs_reviews(self):
        assert build_mixed_candidate(["a", "b"], []) is None

    def test_picks_best_paragraph_per_slot(self):
        # 候选 0：段0=0.9、段1=0.4；候选 1：段0=0.6、段1=0.8
        # 混合稿 = 候选0段0 + 候选1段1
        candidates = ["A开头\n\nA结尾", "B开头\n\nB结尾"]
        reviews = [_review(0, [0.9, 0.4]), _review(1, [0.6, 0.8])]
        mixed = build_mixed_candidate(candidates, reviews)
        assert isinstance(mixed, MixedCandidate)
        assert mixed.text == "A开头\n\nB结尾"
        assert mixed.sources == [
            ParagraphSource(candidate_index=0, paragraph_index=0),
            ParagraphSource(candidate_index=1, paragraph_index=1),
        ]

    def test_handles_uneven_paragraph_counts(self):
        # 候选 0 有三段，候选 1 只有两段：段2 只能取候选0
        candidates = ["p0\n\np1\n\np2", "q0\n\nq1"]
        reviews = [_review(0, [0.9, 0.4, 0.7]), _review(1, [0.5, 0.6])]
        mixed = build_mixed_candidate(candidates, reviews)
        assert mixed.text == "p0\n\nq1\n\np2"

    def test_min_score_drops_paragraphs(self):
        candidates = ["A开头\n\nA烂段", "B开头\n\nB结尾"]
        reviews = [_review(0, [0.9, 0.1]), _review(1, [0.6, 0.8])]
        mixed = build_mixed_candidate(
            candidates, reviews, min_paragraph_score=0.5
        )
        # 段0 取候选0（0.9），段1 因候选0的0.1 < 0.5 被丢弃，取候选1（0.8）
        assert mixed.text == "A开头\n\nB结尾"

    def test_score_averages_picked_paragraphs(self):
        candidates = ["A开头\n\nA结尾", "B开头\n\nB结尾"]
        reviews = [_review(0, [0.9, 0.4]), _review(1, [0.6, 0.8])]
        mixed = build_mixed_candidate(candidates, reviews)
        assert mixed.score == pytest.approx((0.9 + 0.8) / 2)

    def test_rejects_missing_review_index(self):
        # 候选下标与评审不对齐：拒绝混合（防错位拼接）
        candidates = ["a", "b"]
        reviews = [_review(0, [0.9])]
        assert build_mixed_candidate(candidates, reviews) is None

    def test_missing_paragraph_review_does_not_compete(self):
        # 候选1 无段落级评分：不参与段位择优，段1 取候选0（0.4）
        candidates = ["A开头\n\nA结尾", "B开头\n\nB结尾"]
        reviews = [_review(0, [0.9, 0.4]), _review(1, [])]  # 空段落评分
        mixed = build_mixed_candidate(candidates, reviews)
        assert mixed.text == "A开头\n\nA结尾"

    def test_no_scored_slot_falls_back_to_first_candidate(self):
        # 某段位所有候选都无评分：退回首个候选该段（内容不丢）
        candidates = ["A开头\n\nA结尾", "B开头\n\nB结尾"]
        reviews = [_review(0, []), _review(1, [])]
        mixed = build_mixed_candidate(candidates, reviews)
        assert mixed.text == "A开头\n\nA结尾"
