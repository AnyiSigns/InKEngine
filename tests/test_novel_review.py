"""novel_harness/review.py 测试：评审器解析、LLM 评审/再生成、评审-收敛循环。"""
from __future__ import annotations

import json

import pytest

from ink_engine.components.review import (
    NEUTRAL_SCORE,
    MaxRoundsConvergencePolicy,
)
from ink_engine.novel_harness.review import (
    NovelRegenerator,
    NovelReviewer,
    parse_review_output,
    run_review_convergence,
)


class _FakeLLM:
    """可编程假模型：按脚本返回答案，供评审器/再生器注入。"""

    def __init__(self, script: list | None = None, fail_with: Exception | None = None):
        self.script = list(script or [])
        self.fail_with = fail_with
        self.calls: list = []

    async def ainvoke(self, messages, **kwargs):
        self.calls.append(messages)
        if self.fail_with is not None:
            raise self.fail_with
        return _FakeResult(self.script.pop(0) if self.script else "")


class _FakeResult:
    def __init__(self, content: str):
        self.content = content


def _review_json(paragraph_scores: list[tuple[int, float]], feedback="", claims=None) -> str:
    return json.dumps(
        {
            "paragraphs": [
                {"index": i, "score": s, "reason": "ok"} for i, s in paragraph_scores
            ],
            "feedback": feedback,
            "uncertain_claims": claims or [],
        },
        ensure_ascii=False,
    )


class TestParseReviewOutput:
    def test_parses_full_json(self):
        review = parse_review_output(
            2, _review_json([(0, 8), (1, 6)], feedback="推进更紧凑", claims=["XX 年代"]), threshold=0.75
        )
        assert review.candidate_index == 2
        assert review.score == pytest.approx(0.7)
        assert review.passed is False
        assert review.feedback == "推进更紧凑"
        assert [(p.paragraph_index, p.score) for p in review.paragraphs] == [(0, 0.8), (1, 0.6)]
        assert review.uncertain_claims == ("XX 年代",)

    def test_scores_above_threshold_pass(self):
        review = parse_review_output(0, _review_json([(0, 9), (1, 8)]), threshold=0.75)
        assert review.passed is True

    def test_unparseable_is_neutral(self):
        review = parse_review_output(1, "这个正文写得还行", threshold=0.75)
        assert review.score == NEUTRAL_SCORE
        assert review.passed is False
        assert "未" in review.feedback

    def test_empty_input_neutral(self):
        review = parse_review_output(0, "", threshold=0.75)
        assert review.score == NEUTRAL_SCORE
        assert review.passed is False

    def test_no_paragraphs_neutral_score(self):
        review = parse_review_output(0, '{"paragraphs": [], "feedback": "无段落"}', threshold=0.75)
        assert review.score == NEUTRAL_SCORE
        assert review.passed is False

    def test_clamps_scores_to_01(self):
        review = parse_review_output(0, _review_json([(0, 15)]), threshold=0.75)
        assert review.paragraphs[0].score == 1.0

    def test_claims_capped(self):
        claims = [f"claim{i}" for i in range(50)]
        review = parse_review_output(0, _review_json([(0, 8)], claims=claims), threshold=0.75)
        assert len(review.uncertain_claims) <= 10


class TestNovelReviewer:
    def test_reviews_each_candidate(self):
        llm = _FakeLLM(
            [
                _review_json([(0, 8)]),
                _review_json([(0, 5)]),
            ]
        )
        reviewer = NovelReviewer(llm)
        reviews = asyncio_run(reviewer.review(["第一段", "另一个"]))
        assert len(reviews) == 2
        assert reviews[0].candidate_index == 0
        assert reviews[1].candidate_index == 1
        assert len(llm.calls) == 2

    def test_llm_failure_returns_neutral(self):
        llm = _FakeLLM(fail_with=RuntimeError("boom"))
        reviewer = NovelReviewer(llm)
        reviews = asyncio_run(reviewer.review(["正文"]))
        assert reviews[0].score == NEUTRAL_SCORE
        assert reviews[0].passed is False
        assert "失败" in reviews[0].feedback

    def test_empty_candidate_returns_neutral(self):
        reviewer = NovelReviewer(_FakeLLM())
        reviews = asyncio_run(reviewer.review(["  "]))
        assert reviews[0].passed is False
        assert llm_calls(reviewer) == 0

    def test_prompt_contains_paragraphs(self):
        llm = _FakeLLM([_review_json([(0, 8)])])
        reviewer = NovelReviewer(llm)
        asyncio_run(reviewer.review(["第一段\n\n第二段"]))
        prompt = str(llm.calls[0][0].content)
        assert "【段落 0】" in prompt
        assert "【段落 1】" in prompt

    def test_web_verification_injected_into_prompt(self):
        llm = _FakeLLM([_review_json([(0, 8)])])
        reviewer = NovelReviewer(llm)
        asyncio_run(
            reviewer.review(
                ["正文"],
                context={"web_verifications": ["声明：X\n核实：Y 成立"]},
            )
        )
        prompt = str(llm.calls[0][0].content)
        assert "外部验证结果" in prompt
        assert "Y 成立" in prompt


class TestNovelRegenerator:
    def test_regenerates_with_feedback(self):
        llm = _FakeLLM(["改进后的正文"])
        regen = NovelRegenerator(llm)
        out = asyncio_run(regen.regenerate("原正文", "请改进"))
        assert out == "改进后的正文"

    def test_failure_keeps_original(self):
        llm = _FakeLLM(fail_with=RuntimeError("boom"))
        regen = NovelRegenerator(llm)
        out = asyncio_run(regen.regenerate("原正文", "请改进"))
        assert out == "原正文"

    def test_empty_output_keeps_original(self):
        regen = NovelRegenerator(_FakeLLM(["  "]))
        out = asyncio_run(regen.regenerate("原正文", "请改进"))
        assert out == "原正文"


class TestRunReviewConvergence:
    def test_converges_on_passing_round(self):
        llm = _FakeLLM([_review_json([(0, 9)])])  # 首个候选即达标
        result = asyncio_run(
            run_review_convergence(
                ["达标正文"],
                reviewer=NovelReviewer(llm),
                regenerator=NovelRegenerator(_FakeLLM()),
            )
        )
        assert result.converged is True
        assert result.candidates == ["达标正文"]
        assert result.rounds == 0
        assert len(llm.calls) == 1

    def test_regenerates_until_converged(self):
        # 首轮评审：不达标（0.5）→ 再生成；第二轮评审两个候选
        # （原候选 0 仍低分，改进版候选 1 达标）→ 收敛取改进版
        llm = _FakeLLM(
            [
                _review_json([(0, 5)], feedback="不紧凑"),
                _review_json([(0, 4)]),
                _review_json([(1, 9)], feedback="已改进"),
            ]
        )
        regen_llm = _FakeLLM(["改进版正文"])
        result = asyncio_run(
            run_review_convergence(
                ["初稿"],
                reviewer=NovelReviewer(llm),
                regenerator=NovelRegenerator(regen_llm),
            )
        )
        assert result.converged is True
        assert result.rounds == 1
        assert result.candidates == ["改进版正文"]
        assert len(llm.calls) == 3  # 首轮 1 + 第二轮 2（逐候选评审）
        assert len(regen_llm.calls) == 1
        assert result.history[0].regenerated == ("改进版正文",)

    def test_stops_at_max_rounds_with_opinion(self):
        policy = MaxRoundsConvergencePolicy(beam=1, max_rounds=1)
        # 首轮不达标 → 再生成 → 第二轮评审原候选与改进版均不达标 → 达上限停止
        llm = _FakeLLM(
            [
                _review_json([(0, 5)], feedback="改进A"),
                _review_json([(0, 4)]),
                _review_json([(1, 5)], feedback="改进B"),
            ]
        )
        regen_llm = _FakeLLM(["改进1"])
        result = asyncio_run(
            run_review_convergence(
                ["初稿"],
                reviewer=NovelReviewer(llm),
                regenerator=NovelRegenerator(regen_llm),
                policy=policy,
            )
        )
        assert result.converged is False
        assert result.rounds == 1
        assert any("上限" in note for note in result.notes)
        # 超限呈交现状：候选集 = 原候选 + 再生成产物（供人类裁决）
        assert "初稿" in result.candidates
        assert "改进1" in result.candidates
        assert len(llm.calls) == 3

    def test_reviewer_failure_returns_original(self):
        async def _exploding_reviewer(candidates, *, context=None):
            raise RuntimeError("boom")

        result = asyncio_run(
            run_review_convergence(
                ["正文"],
                reviewer=_exploding_reviewer,
                regenerator=NovelRegenerator(_FakeLLM()),
            )
        )
        assert result.converged is False
        assert result.candidates == ["正文"]
        assert any("评审失败" in note for note in result.notes)

    def test_llm_review_failure_degrades_to_neutral(self):
        # 评审器 LLM 失败 → 中性分（passed=False）→ 策略再生成 → 收敛或达上限
        reviewer = NovelReviewer(_FakeLLM(fail_with=RuntimeError("boom")))
        result = asyncio_run(
            run_review_convergence(
                ["正文"],
                reviewer=reviewer,
                regenerator=NovelRegenerator(_FakeLLM()),
                policy=MaxRoundsConvergencePolicy(beam=1, max_rounds=1),
            )
        )
        assert result.converged is False
        assert "正文" in result.candidates
        assert result.reviews[0].passed is False

    def test_regenerator_failure_keeps_original_and_continues(self):
        # 再生成失败（保持原候选）→ 下一轮评审原候选仍不达标 → 达上限停止
        policy = MaxRoundsConvergencePolicy(beam=1, max_rounds=1)
        llm = _FakeLLM(
            [
                _review_json([(0, 5)]),
                _review_json([(0, 5)]),
            ]
        )
        result = asyncio_run(
            run_review_convergence(
                ["正文"],
                reviewer=NovelReviewer(llm),
                regenerator=NovelRegenerator(_FakeLLM(fail_with=RuntimeError("boom"))),
                policy=policy,
            )
        )
        assert result.converged is False
        assert "正文" in result.candidates

    def test_web_verifier_claims_flow_into_next_review(self):
        # 首轮评审带存疑声明 → web 验证结果注入第二轮评审 prompt
        llm = _FakeLLM(
            [
                _review_json([(0, 5)], claims=["长城始建于？"]),
                _review_json([(0, 9)]),
            ]
        )

        class _Verifier:
            async def verify(self, claim, *, context=None):
                return "秦始皇时期已存在长城雏形"

        result = asyncio_run(
            run_review_convergence(
                ["正文"],
                reviewer=NovelReviewer(llm),
                regenerator=NovelRegenerator(_FakeLLM(["改进版"])),
                web_verifier=_Verifier(),
            )
        )
        assert result.converged is True
        # 第二轮评审 prompt 含验证结果
        prompt = str(llm.calls[1][0].content)
        assert "外部验证结果" in prompt
        assert "长城雏形" in prompt

    def test_web_verifier_accepts_bare_callable(self):
        llm = _FakeLLM(
            [
                _review_json([(0, 5)], claims=["某史实"]),
                _review_json([(0, 9)]),
            ]
        )

        async def _bare_verify(claim, *, context=None):
            return "核实无误"

        result = asyncio_run(
            run_review_convergence(
                ["正文"],
                reviewer=NovelReviewer(llm),
                regenerator=NovelRegenerator(_FakeLLM(["改进版"])),
                web_verifier=_bare_verify,
            )
        )
        assert result.converged is True
        prompt = str(llm.calls[1][0].content)
        assert "核实无误" in prompt


def asyncio_run(coro):
    import asyncio

    return asyncio.run(coro)


def llm_calls(reviewer: NovelReviewer) -> int:
    return len(reviewer._llm.calls)
