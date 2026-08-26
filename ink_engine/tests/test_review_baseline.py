"""E-P11 评审域双轨收敛对比测试：core 确定性基线 vs 产品 LLM 评审实现。

双轨收敛（用户拍板 2026-08-26）：产品 LLM 评审权威实现 =
``inkling_host/review_pipeline.py``（LLMReviewer / LLMRegenerator，host
注入模型链）；core 侧 ``review.py`` 提供确定性基线参考实现
（DeterministicReviewer / DeterministicRegenerator / DeterministicWebVerifier）。

本文件断言：
- 确定性基线**同输入断言不漂移**（跑两遍产出恒等 + 锚定期望值），作为
  LLM 评审的回归基线；
- 基线可与引擎收敛策略（MaxRoundsConvergencePolicy）构成确定性收敛循环
  （两次运行结果完全一致）；
- 对比测试：产品权威实现满足 core 协议接口（runtime_checkable
  isinstance），且 LLM 评审失败 fail-open 中性分（与基线语义同源）。
"""
from __future__ import annotations

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_HOST_PY = _REPO_ROOT / "inkling/shell/src-tauri/src/engine/py"
if str(_HOST_PY) not in sys.path:
    sys.path.insert(0, str(_HOST_PY))

from inkling_host.review_pipeline import LLMRegenerator, LLMReviewer  # noqa: E402

from ink_engine.core.review import (  # noqa: E402
    NEUTRAL_SCORE,
    CandidateReview,
    DeterministicRegenerator,
    DeterministicReviewer,
    DeterministicWebVerifier,
    MaxRoundsConvergencePolicy,
    Regenerator,
    Reviewer,
    WebVerifier,
)


class TestDeterministicReviewer:
    async def test_same_input_no_drift(self):
        """同输入断言不漂移：两遍评审产出恒等（逐字段比对）。"""
        candidates = ["", "x" * 500, "x" * 300 + "\n" * 4, "x" * 500 + "\n" * 4]
        reviewer = DeterministicReviewer()
        first = await reviewer.review(candidates)
        second = await reviewer.review(candidates)
        assert first == second
        assert [r.candidate_index for r in first] == [0, 1, 2, 3]

    async def test_pinned_scores(self):
        """锚定期望分：长度分 60% + 结构分 40%，四舍五入 4 位小数。"""
        reviewer = DeterministicReviewer()
        reviews = await reviewer.review(["", "x" * 500, "x" * 300 + "\n" * 4, "x" * 500 + "\n" * 4])
        assert [r.score for r in reviews] == [0.0, 0.6, 0.7648, 1.0]
        assert [r.passed for r in reviews] == [False, False, True, True]
        assert all("确定性基线" in r.feedback for r in reviews)

    async def test_reviewer_protocol_conformance(self):
        assert isinstance(DeterministicReviewer(), Reviewer)

    async def test_context_ignored_but_accepted(self):
        reviewer = DeterministicReviewer()
        with_context = await reviewer.review(["x" * 500], context={"turn": 1})
        without = await reviewer.review(["x" * 500])
        assert with_context == without


class TestDeterministicRegenerator:
    async def test_same_input_no_drift_and_pinned(self):
        regen = DeterministicRegenerator()
        first = await regen.regenerate("原稿", "反馈意见")
        second = await regen.regenerate("原稿", "反馈意见")
        assert first == second == "原稿\n\n【确定性基线修订】反馈意见"

    async def test_empty_feedback_returns_candidate(self):
        regen = DeterministicRegenerator()
        assert await regen.regenerate("原稿", "") == "原稿"
        assert await regen.regenerate("原稿", "   ") == "原稿"

    async def test_regenerator_protocol_conformance(self):
        assert isinstance(DeterministicRegenerator(), Regenerator)


class TestDeterministicWebVerifier:
    async def test_same_input_no_drift_and_pinned(self):
        verifier = DeterministicWebVerifier()
        first = await verifier.verify("声明A")
        second = await verifier.verify("声明A")
        assert first == second == "【确定性基线验证】声明A（未触发真实联网验证，占位结论）"

    async def test_web_verifier_protocol_conformance(self):
        assert isinstance(DeterministicWebVerifier(), WebVerifier)


class TestBaselineConvergenceLoop:
    async def _run_loop(self, candidates: list[str]) -> list[tuple[list[CandidateReview], object, int]]:
        """确定性收敛循环（与 review_pipeline.converge_candidates 同构的骨架）。"""
        reviewer = DeterministicReviewer()
        regenerator = DeterministicRegenerator()
        policy = MaxRoundsConvergencePolicy()
        snapshots: list[tuple[list[CandidateReview], object, int]] = []
        rounds = 0
        while True:
            reviews = await reviewer.review(candidates)
            decision = policy.decide(reviews, round_no=rounds)
            snapshots.append((reviews, decision, rounds))
            if decision.converged or not decision.regenerate_indices:
                return snapshots
            for index in decision.regenerate_indices:
                candidates[index] = await regenerator.regenerate(
                    candidates[index], reviews[index].feedback
                )
            rounds += 1

    async def test_loop_deterministic_and_converges(self):
        """基线 + 引擎策略构成确定性收敛循环：两次运行结果完全一致且收敛。"""
        first = await self._run_loop(["x" * 500])
        second = await self._run_loop(["x" * 500])
        assert first == second
        assert first[-1][1].converged is True, "修订段追加换行后结构分提升应促成收敛"


class TestLLMTrackProtocolCompliance:
    async def test_llm_reviewer_satisfies_reviewer_protocol(self):
        """对比测试：产品权威 LLM 评审器满足 core Reviewer 协议。"""
        assert isinstance(LLMReviewer(None), Reviewer)

    async def test_llm_regenerator_satisfies_regenerator_protocol(self):
        assert isinstance(LLMRegenerator(None), Regenerator)

    async def test_llm_review_fails_open_neutral(self):
        """LLM 评审失败 → 中性分（passed=False），与基线同源不抛错。"""

        class _BrokenLLM:
            async def ainvoke(self, *args, **kwargs):
                raise RuntimeError("厂商故障")

        reviews = await LLMReviewer(_BrokenLLM()).review(["候选A", "候选B"])
        assert [r.score for r in reviews] == [NEUTRAL_SCORE, NEUTRAL_SCORE]
        assert all(r.passed is False for r in reviews)
