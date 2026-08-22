"""评审-收敛管线 e2e（引擎 core.review 机制 + review.json 数据驱动）。

- 收敛：达标候选首轮收敛（accepted 单候选）；
- 硬护栏：恒不达标 → 轮次上限（max_rounds）超限呈交现状；
- fail-open：评审器异常/坏 JSON → 中性分（不抛错，不阻断主流程）；
- 装配：host.review_pipeline 由模型配置组装；无模型 = None（无评审）。
"""
from __future__ import annotations

from conftest import SEED_ROOT, StubLLM

from host.host import boot_inkling
from host.review_pipeline import converge_candidates, LLMReviewer

_REVIEW_DATA = {
    "dimensions": [{"name": "citation_quality", "weight": 0.35, "note": "引用质量"}],
    "pass_threshold": 0.75,
    "max_rounds": 2,
    "beam_width": 1,
    "neutral_score": 0.5,
    "web_verify": {"enabled": True, "hook": "web_verifier"},
}

_JSON_PASS = '{"score": 0.95, "reason": "达标", "paragraphs": [], "uncertain_claims": []}'
_JSON_FAIL = '{"score": 0.4, "reason": "不达标", "paragraphs": [], "uncertain_claims": ["存疑声明"]}'


async def test_review_converge_first_round():
    """达标候选首轮收敛：accepted 单候选，无再生成轮次。"""
    llm = StubLLM(script={"你是评审器": {"reply": _JSON_PASS}})
    result = await converge_candidates(llm, _REVIEW_DATA, ["候选文稿"])
    assert result.converged
    assert result.rounds == 0
    assert result.reviews[0].passed
    assert result.best_index == 0
    assert result.candidates[0] == "候选文稿"


async def test_review_hard_cap_submits_on_rounds_limit():
    """恒不达标 → 轮次上限（max_rounds=2）超限呈交现状（converged=False）。"""
    llm = StubLLM(script={"你是评审器": {"reply": _JSON_FAIL}})
    result = await converge_candidates(llm, _REVIEW_DATA, ["候选文稿"])
    assert not result.converged
    assert result.rounds == 2  # 两轮再生成后达上限
    assert any("轮次上限" in n for n in result.notes)
    assert result.reviews[-1].score == 0.4


async def test_review_fail_open_on_bad_json():
    """评审器坏 JSON/异常 → 中性分 fail-open（不抛错，passed=False）。"""
    llm = StubLLM(script={"你是评审器": {"reply": "没有 JSON?"}})
    result = await converge_candidates(llm, _REVIEW_DATA, ["候选文稿"])
    assert not result.converged
    assert result.reviews[-1].score == 0.5
    assert not result.reviews[-1].passed


async def test_reviewer_dimensions_injected_and_neutral_on_error():
    """评审器提示含维度权重；评审异常回中性分。"""
    llm = StubLLM(default_reply="xxx")
    reviewer = LLMReviewer(llm, dimensions=_REVIEW_DATA["dimensions"])
    reviews = await reviewer.review(["文稿"], context=None)
    assert len(reviews) == 1
    assert reviews[0].score == 0.5
    assert not reviews[0].passed
    assert llm.call_count == 1  # prompt 注入（dimensions 渲染进消息）


async def test_host_builds_review_pipeline_when_llm_configured():
    """宿主装配：模型存在 → host.review_pipeline 就绪；无模型 → None。"""
    runtime, host, _mount = await boot_inkling(
        SEED_ROOT, llm=StubLLM(script={"你是评审器": {"reply": _JSON_PASS}})
    )
    try:
        assert host.review_pipeline is not None
        result = await host.review_pipeline(["候选文稿"])
        assert result.converged
    finally:
        await runtime.stop()
        await host.close()

    runtime2, host2, _mount2 = await boot_inkling(SEED_ROOT, llm=None)
    try:
        assert host2.review_pipeline is None  # 无模型 = 无评审（fail-open）
    finally:
        await runtime2.stop()
        await host2.close()


async def test_incubation_review_and_converge_entrypoint():
    """孵化域入口：review_and_converge（review.json 数据驱动）联通。"""
    runtime, host, _mount = await boot_inkling(
        SEED_ROOT, llm=StubLLM(script={"你是评审器": {"reply": _JSON_PASS}})
    )
    try:
        result = await host.incubation.review_and_converge(
            runtime.engine_llm, ["孵化候选文稿"], context={"kind": "insight"}
        )
        assert result.converged
        assert result.reviews[0].passed
    finally:
        await runtime.stop()
        await host.close()
