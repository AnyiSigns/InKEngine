"""族 17：自适应调优与挡位（test_17_tuning.py）｜core/tuning + core/tiers。

- 回合指标聚合（失败率/评审分/收敛轮数/挡位调用）；参数快照落库（memory）
- 低分反馈降权生效（重跑断言参数变化）；调参不改变历史推演可回放性
  （快照重算）
- 挡位链（router/tool/main/audit）真实调用统计 + 按挡位建链

`real` 标记 = 真实 LLM 调用（族门禁②）；其余为确定性机制用例（零费用）。
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.live

from ink_engine.core.knowledge_gate import KnowledgeGate  # noqa: E402
from ink_engine.core.llm.messages import user  # noqa: E402
from ink_engine.core.rules import FixtureCase, FixtureSet  # noqa: E402
from ink_engine.core.tiers import (  # noqa: E402
    TIER_NAMES,
    TierCallStats,
    build_tier_chain,
    tier_key,
)
from ink_engine.core.tuning import (  # noqa: E402
    MIN_WEIGHT,
    MetaTuner,
    ParameterSnapshot,
    ParamRegressionExecutor,
    TunableParams,
    TurnMetrics,
)


def _model_config(**kw) -> dict:
    cfg = {
        "main_config": {"adapter": "openai_compat", "model_id": "main", "base_url": "http://m"},
        "router_config": {"adapter": "openai_compat", "model_id": "router", "base_url": "http://r"},
        "tool_config": {"adapter": "openai_compat", "model_id": "tool", "base_url": "http://t"},
        "audit_config": {"adapter": "openai_compat", "model_id": "audit", "base_url": "http://a"},
    }
    cfg.update(kw)
    return cfg


class _FakeLLM:
    adapter = "openai_compat"

    async def ainvoke(self, messages, *, tools=None, params=None):
        raise NotImplementedError

    async def astream(self, messages, *, tools=None, params=None):
        raise NotImplementedError
        yield

    async def aclose(self) -> None:
        pass


def _fake_create(config):
    return _FakeLLM()


def _param_fixtures(*, weight_min: float = MIN_WEIGHT) -> FixtureSet:
    return FixtureSet(
        name="param-regression",
        cases=(
            FixtureCase(
                id="weight_floor",
                data={
                    "bounds": {
                        "weights": {"min": weight_min, "max": 1.0},
                        "thresholds": {"min": 0.0, "max": 10.0},
                    }
                },
                expected_pass=True,
                description="条目全部参数须落在声明边界内",
            ),
            FixtureCase(
                id="threshold_floor",
                data={
                    "bounds": {
                        "weights": {"min": 0.0, "max": 1.0},
                        "thresholds": {"min": 0.9, "max": 10.0},
                    }
                },
                expected_pass=False,
                description="条目阈值须存在低于 0.9 的越界值（0.6 触发）",
            ),
        ),
    )


# ----------------------------------------------------------------------
# 回合指标聚合
# ----------------------------------------------------------------------


def test_tuning_metrics_aggregation():
    metrics = TurnMetrics()
    metrics.record_turn()
    metrics.record_turn(failed=True, error="超时")
    metrics.record_review(0.8)
    metrics.record_review(0.6)
    metrics.record_convergence(2)
    metrics.record_convergence(4)
    metrics.record_llm_calls({"main": 3, "router": 1})
    metrics.record_llm_calls({"main": 2})
    assert metrics.failure_rate == 0.5
    assert metrics.avg_review_score == 0.7
    assert metrics.llm_calls_by_tier == {"main": 5, "router": 1}
    assert metrics.last_error == "超时"


def test_tuning_metrics_snapshot_roundtrip():
    metrics = TurnMetrics()
    metrics.record_turn(failed=True)
    metrics.record_review(0.9)
    rebuilt = TurnMetrics.from_snapshot(metrics.snapshot())
    assert rebuilt.failure_rate == 1.0
    assert rebuilt.avg_review_score == 0.9


# ----------------------------------------------------------------------
# 参数快照落库 + 调参可回放性
# ----------------------------------------------------------------------


def test_tuning_parameter_snapshot_roundtrip():
    snapshot = ParameterSnapshot(
        rule_version="rules-v3",
        params=TunableParams(
            divergence_width=4,
            weights={"质量": 0.7, "一致性": 0.3},
            thresholds={"pass": 0.6},
        ),
    )
    rebuilt = ParameterSnapshot.from_dict(snapshot.to_dict())
    assert rebuilt.rule_version == "rules-v3"
    assert rebuilt.params.weights == {"质量": 0.7, "一致性": 0.3}
    assert rebuilt.params.thresholds == {"pass": 0.6}


async def test_tuning_parameter_snapshot_persist(memory_storage):
    """参数快照经 sink 落库（memory）→ 读回还原一致（回归通过后落库）。"""
    sinks: list[ParameterSnapshot] = []

    def collector(snapshot: ParameterSnapshot) -> None:
        sinks.append(snapshot)

    params = TunableParams(weights={"A": 0.5, "B": 0.5}, thresholds={"pass": 0.6})
    gate = KnowledgeGate(l2_executor=ParamRegressionExecutor())
    tuner = MetaTuner(snapshot_sink=collector)
    result = await tuner.tune_with_regression(
        params,
        TurnMetrics(),
        _param_fixtures(),
        feedback={"B": 0.1},
        rule_version="rules-e2e",
        gate=gate,
    )
    assert result.snapshot is not None
    assert len(sinks) == 1  # sink 收到落库快照
    # sink 落库：写存储并读回
    await memory_storage.put_record("tuning_snapshots", "snap-1", sinks[0].to_dict())
    data = await memory_storage.get_record("tuning_snapshots", "snap-1")
    assert data is not None
    restored = ParameterSnapshot.from_dict(data)
    assert restored.rule_version == "rules-e2e"
    assert restored.params.weights["B"] < 0.5  # 降权已落库


def test_tuning_low_score_feedback_decay_on_rerun():
    """低分反馈降权生效：重跑断言参数变化（劣质维度权重下降）。"""
    params = TunableParams(weights={"质量": 0.7, "一致性": 0.3})
    tuner = MetaTuner()
    first = tuner.tune(params, TurnMetrics(), feedback={"一致性": 0.2})
    assert first.params.weights["一致性"] < 0.3
    # 重跑以新参数为基线 → 再次降权（参数逐轮演化）
    second = tuner.tune(first.params, TurnMetrics(), feedback={"一致性": 0.1})
    assert second.params.weights["一致性"] < first.params.weights["一致性"]
    assert second.params.weights["质量"] == 0.7  # 未反馈维度不动


def test_tuning_snapshot_replayable_after_tune():
    """调参不改变历史推演可回放性：快照重算 = 当时标尺冻结。"""
    params = TunableParams(weights={"A": 0.8, "B": 0.5}, thresholds={"pass": 0.6})
    result = MetaTuner().tune(
        params, TurnMetrics(), feedback={"B": 0.1}, rule_version="rules-v9"
    )
    assert result.snapshot is not None
    # 历史推演按快照重算：快照冻结当时标尺 = 调参产物，round-trip 无损
    assert result.snapshot.params == result.params
    replayed = ParameterSnapshot.from_dict(result.snapshot.to_dict())
    assert replayed.params == result.params
    # 同基线确定性可复算：重跑得到同一产物（标尺不动 → 结果可复现）
    again = MetaTuner().tune(
        params, TurnMetrics(), feedback={"B": 0.1}, rule_version="rules-v9"
    )
    assert again.params == result.params


def test_tuning_high_failure_rate_raises_retry():
    metrics = TurnMetrics()
    metrics.record_turn(failed=True)
    metrics.record_turn(failed=True)
    result = MetaTuner().tune(TunableParams(retry_budget=1), metrics)
    assert result.params.retry_budget >= 2
    assert result.params.web_verify_threshold < 0.5


def test_tuning_slow_convergence_widens_divergence():
    metrics = TurnMetrics()
    metrics.record_convergence(3)
    metrics.record_convergence(4)
    result = MetaTuner().tune(TunableParams(divergence_width=3), metrics)
    assert result.params.divergence_width == 4


# ----------------------------------------------------------------------
# 挡位链：按挡位建链 + 真实调用统计
# ----------------------------------------------------------------------


def test_tier_build_chain_all_tiers():
    for tier in TIER_NAMES:
        chain = build_tier_chain(_model_config(), tier, create=_fake_create)
        assert chain is not None
    # 未知/缺配置回落：返回 None（调用方按配置缺失兜底）
    assert build_tier_chain({}, "main") is None
    assert build_tier_chain(None, "main") is None


def test_tier_key_normalization():
    for tier in ("main", "router", "tool", "audit"):
        assert tier_key(tier) == tier
    assert tier_key("bogus") == "main"
    assert tier_key(None) == "main"


def test_tier_call_stats_and_metrics_merge():
    """挡位真实调用统计：逐挡位记录 → 汇入回合指标 llm_calls_by_tier。"""
    stats = TierCallStats()
    stats.record("router")
    stats.record("main", 3)
    stats.record("tool")
    stats.record("audit")
    stats.record("bogus")  # 归一为 main
    assert stats.snapshot() == {"router": 1, "main": 4, "tool": 1, "audit": 1}
    metrics = TurnMetrics()
    metrics.record_llm_calls(stats.snapshot())
    assert metrics.llm_calls_by_tier == {"router": 1, "main": 4, "tool": 1, "audit": 1}


def test_tier_chain_stats_merge_across_subgraphs():
    a, b = TierCallStats(), TierCallStats()
    a.record("main", 2)
    b.record("router", 1)
    b.record("main", 1)
    a += b
    assert a.snapshot() == {"main": 3, "router": 1}


# ----------------------------------------------------------------------
# real：真实 LLM 回合产出评分 → 指标聚合 → 低分降权 → 快照落库
# ----------------------------------------------------------------------


@pytest.mark.real
async def test_real_tuning_round_scores_and_snapshots(live_llm, memory_storage):
    """真实 LLM 回合产出评分 → 回合指标聚合 → 低分反馈降权生效 →
    参数快照落库（memory）断言。"""
    answer = await live_llm.ainvoke([user("请用一句话解释什么是知识库。")])
    assert isinstance(answer.content, str) and answer.content.strip()

    rating_raw = await live_llm.ainvoke(
        [user(f"请给下面这段文字的质量打分，只回复 0 到 1 之间的数字：{answer.content}")]
    )
    rating_text = rating_raw.content or "0.2"
    try:
        score = float("".join(c for c in rating_text if c.isdigit() or c == "."))
    except ValueError:
        score = 0.2

    metrics = TurnMetrics()
    metrics.record_turn()
    metrics.record_review(score)

    params = TunableParams(weights={"质量": 0.8})
    tuner = MetaTuner()
    result = tuner.tune(params, metrics, feedback={"质量": score}, rule_version="rules-live")
    # 低分反馈降权生效（重跑断言参数变化）
    if score < 0.5:
        assert result.params.weights["质量"] < 0.8
    else:
        assert result.params.weights["质量"] > 0.8
    assert result.changes  # 评分偏离阈值 → 参数确实变化

    # 参数快照落库（memory）→ 读回还原
    assert result.snapshot is not None
    await memory_storage.put_record(
        "tuning_snapshots", "live-1", result.snapshot.to_dict()
    )
    data = await memory_storage.get_record("tuning_snapshots", "live-1")
    assert data is not None
    restored = ParameterSnapshot.from_dict(data)
    assert restored.rule_version == "rules-live"
    assert restored.params.weights["质量"] == result.params.weights["质量"]
