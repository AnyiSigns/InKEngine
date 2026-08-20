"""自适应调优单测：回合指标聚合 / 参数快照 / 低分反馈降权。

语义检查点：
- TurnMetrics 聚合失败率/评审分/收敛轮数/挡位调用，快照可还原；
- ParameterSnapshot 随评估记录落库（规则版本 + 权重快照——推演回放
  按快照重算，避免「标尺在动」）；
- 模拟低分反馈 → 维度权重自动下调 → 评审评分随权重调整变化符合预期
  （基准断言：劣质维度降权后总分抬升）；
- 失败率/收敛轮数驱动的机制参数调整（重试预算/web 阈值/探索宽度）。
"""
from __future__ import annotations

import pytest

from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.knowledge_gate import KnowledgeGate
from ink_engine.core.knowledge_set import KnowledgeEntry
from ink_engine.core.rules import FixtureCase, FixtureSet
from ink_engine.core.scoring import ScoreDimension, ScoringConfig, WeightedScorer
from ink_engine.core.tuning import (
    MIN_WEIGHT,
    MetaTuner,
    ParameterSnapshot,
    ParamRegressionExecutor,
    TunableParams,
    TurnMetrics,
)

# ── TurnMetrics ──


def test_turn_metrics_aggregation():
    """回合指标聚合：失败率/评审分/收敛轮数/挡位调用。"""
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


def test_turn_metrics_no_turns_no_division():
    """无回合 = 失败率 0（不除零）。"""
    metrics = TurnMetrics()
    assert metrics.failure_rate == 0.0
    assert metrics.avg_review_score == 0.0


def test_turn_metrics_snapshot_roundtrip():
    """指标快照可还原（评估记录落库/回放契约）。"""
    metrics = TurnMetrics()
    metrics.record_turn(failed=True)
    metrics.record_review(0.9)
    snapshot = metrics.snapshot()
    rebuilt = TurnMetrics.from_snapshot(snapshot)
    assert rebuilt.failure_rate == 1.0
    assert rebuilt.avg_review_score == 0.9


def test_turn_metrics_invalid_review_rejected():
    """评审分越界拒绝（口径防线）。"""
    metrics = TurnMetrics()
    with pytest.raises(GraphDefinitionError, match="评审分"):
        metrics.record_review(1.5)


# ── ParameterSnapshot ──


def test_parameter_snapshot_roundtrip():
    """参数快照序列化 round-trip（规则版本 + 权重冻结）。"""
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
    assert rebuilt.params.divergence_width == 4
    assert rebuilt.params.weights == {"质量": 0.7, "一致性": 0.3}
    assert rebuilt.params.thresholds == {"pass": 0.6}


def test_parameter_snapshot_invalid_rejected():
    """非法快照（缺 params）拒绝。"""
    with pytest.raises(GraphDefinitionError, match="参数快照"):
        ParameterSnapshot.from_dict({"rule_version": "v1"})


def test_tunable_params_roundtrip():
    """可调参数集合序列化 round-trip。"""
    params = TunableParams(
        divergence_width=5, retry_budget=2, web_verify_threshold=0.4,
        weights={"a": 0.6}, thresholds={"t": 0.3},
    )
    rebuilt = TunableParams.from_dict(params.to_dict())
    assert rebuilt == params


# ── 低分反馈降权（基准：评审评分随权重调整变化）──


def _scorer(weights: dict[str, float]) -> WeightedScorer:
    return WeightedScorer(
        ScoringConfig(
            dimensions=tuple(
                ScoreDimension(name=name, weight=weight) for name, weight in weights.items()
            )
        )
    )


def test_low_score_feedback_decays_weight():
    """模拟低分反馈 → 权重自动下调（劣质维度降权）。"""
    params = TunableParams(weights={"质量": 0.7, "一致性": 0.3})
    metrics = TurnMetrics()
    result = MetaTuner().tune(params, metrics, feedback={"一致性": 0.2})
    assert result.params.weights["一致性"] < 0.3  # 低分维度降权
    assert result.params.weights["质量"] == 0.7  # 未反馈维度不动
    assert any("降权" in change for change in result.changes)


def test_review_score_changes_with_weight_adjustment():
    """基准：评审评分随权重调整变化符合预期。

    维度 A 得分高、维度 B 得分低——B 低分反馈降权后，总分应抬升
    （劣质维度主导减弱），且基准断言可复算。
    """
    params = TunableParams(weights={"A": 0.5, "B": 0.5})
    metrics = TurnMetrics()
    tuned = MetaTuner().tune(params, metrics, feedback={"B": 0.2})
    scorer_before = _scorer(params.weights)
    scorer_after = _scorer(tuned.params.weights)
    before = scorer_before.score({"A": 0.9, "B": 0.1}).total
    after = scorer_after.score({"A": 0.9, "B": 0.1}).total
    assert after > before  # B 降权 → 低分拖累减弱 → 总分抬升
    assert before == 0.5
    assert after > 0.5
    # 确定性：同输入同输出（可断言、可回归）
    assert scorer_after.score({"A": 0.9, "B": 0.1}).total == after


def test_high_score_feedback_gains_weight():
    """高分反馈升权（正向强化）。"""
    params = TunableParams(weights={"A": 0.5})
    result = MetaTuner().tune(params, TurnMetrics(), feedback={"A": 0.9})
    assert result.params.weights["A"] > 0.5


def test_weight_floor_protected():
    """降权下限保护（维度不因反馈被降没）。"""
    params = TunableParams(weights={"A": 0.15})
    result = MetaTuner().tune(params, TurnMetrics(), feedback={"A": 0.0})
    assert result.params.weights["A"] >= 0.1


def test_weight_cap_protected():
    """升权上限保护（维度不因反馈失衡主导——上界与回归边界同口径）。"""
    params = TunableParams(weights={"A": 0.9})
    result = MetaTuner().tune(params, TurnMetrics(), feedback={"A": 1.0})
    assert result.params.weights["A"] <= 1.0
    # 连续高分反馈多次仍不越界
    for _ in range(10):
        result = MetaTuner().tune(
            result.params, TurnMetrics(), feedback={"A": 1.0}
        )
    assert result.params.weights["A"] <= 1.0


def test_out_of_bounds_weights_repaired_before_tuning():
    """历史遗留越界权重在调参入口收敛到边界（不阻塞后续调参）。"""
    params = TunableParams(weights={"A": 5.0, "B": 0.5})
    result = MetaTuner().tune(params, TurnMetrics(), feedback={"B": 0.9})
    assert result.params.weights["A"] == 1.0  # 越上限收敛
    assert result.params.weights["B"] > 0.5  # 正常维度照常调整
    assert any("越上限" in change for change in result.changes)


def test_negative_llm_calls_ignored():
    """挡位调用统计非正计数不并入（观测噪声与清零信号过滤）。"""
    metrics = TurnMetrics()
    metrics.record_llm_calls({"main": 5})
    metrics.record_llm_calls({"main": -10})
    assert metrics.llm_calls_by_tier == {"main": 5}


def test_metrics_window_bounded():
    """指标窗口有界：长跑留痕只保留近期窗口（防无限膨胀）。"""
    metrics = TurnMetrics()
    for _ in range(1200):
        metrics.record_review(0.5)
        metrics.record_convergence(1)
    assert len(metrics.review_scores) <= 600
    assert len(metrics.convergence_rounds) <= 600


def test_unknown_dimension_feedback_ignored():
    """未知维度反馈不调整（口径漂移由配置侧修复，不静默增删）。"""
    params = TunableParams(weights={"A": 0.5})
    result = MetaTuner().tune(params, TurnMetrics(), feedback={"幽灵维度": 0.1})
    assert result.params.weights == {"A": 0.5}
    assert result.changes == ()


# ── 执行统计驱动的机制参数调整 ──


def test_high_failure_rate_raises_retry_budget():
    """失败率偏高 → 重试预算上调 + web 验证阈值下调。"""
    metrics = TurnMetrics()
    metrics.record_turn(failed=True)
    metrics.record_turn(failed=True)
    result = MetaTuner().tune(TunableParams(retry_budget=1), metrics)
    assert result.params.retry_budget >= 2
    assert result.params.web_verify_threshold < 0.5


def test_low_failure_rate_reverts_retry_budget():
    """失败率偏低 → 重试预算回落（省成本）。"""
    metrics = TurnMetrics()
    metrics.record_turn()
    result = MetaTuner().tune(TunableParams(retry_budget=2), metrics)
    assert result.params.retry_budget == 1


def test_slow_convergence_widens_divergence():
    """平均收敛轮数偏高 → 发散宽度加宽（探索更多候选）。"""
    metrics = TurnMetrics()
    metrics.record_convergence(3)
    metrics.record_convergence(4)
    result = MetaTuner().tune(TunableParams(divergence_width=3), metrics)
    assert result.params.divergence_width == 4


def test_fast_convergence_narrows_divergence():
    """平均收敛轮数偏低 → 发散宽度收窄（收敛更快）。"""
    metrics = TurnMetrics()
    metrics.record_convergence(1)
    metrics.record_convergence(1)
    result = MetaTuner().tune(TunableParams(divergence_width=3), metrics)
    assert result.params.divergence_width == 2


def test_no_change_returns_same_params():
    """无指标驱动变化时返回原参数（changes 空，不空转调参）。"""
    metrics = TurnMetrics()
    result = MetaTuner().tune(TunableParams(retry_budget=1), metrics)
    assert result.params.retry_budget == 1
    assert result.changes == ()


def test_snapshot_attached_when_rule_version_provided():
    """提供规则版本时快照随调参结果落库（回放语义）。"""
    result = MetaTuner().tune(
        TunableParams(weights={"A": 0.5}),
        TurnMetrics(),
        feedback={"A": 0.1},
        rule_version="rules-v7",
    )
    assert result.snapshot is not None
    assert result.snapshot.rule_version == "rules-v7"
    assert result.snapshot.params.weights["A"] < 0.5


def test_snapshot_absent_without_rule_version():
    """未提供规则版本 = 快照不落（调用方按需决定回放语义）。"""
    result = MetaTuner().tune(TunableParams(), TurnMetrics())
    assert result.snapshot is None


# ── 参数变更过 L2 效果评估回归（M7 接线）──


def _param_fixtures(*, weight_min: float = MIN_WEIGHT) -> FixtureSet:
    """参数回归样例：逐用例 = 对条目参数的一条契约断言。

    - weight_floor（expected_pass=True）：条目全部权重须落在声明边界内
      （下限 = 调参下限保护的可收紧版本）；
    - threshold_floor（expected_pass=False）：条目阈值须存在低于下限的
      越界值（本例 pass=0.6 < 0.9 —— 拒绝契约成立，防回归样例失真）。
    """
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


def _params_entry(**overrides) -> KnowledgeEntry:
    data = {
        "weights": {"A": 0.5, "B": 0.5},
        "thresholds": {"pass": 0.6},
        "divergence_width": 3,
        "retry_budget": 1,
        "web_verify_threshold": 0.5,
    }
    data.update(overrides)
    return KnowledgeEntry(
        id="tune-1", level="work", kind="weight", data=data, source="model"
    )


async def test_param_regression_executor_bounds():
    """参数回归执行器：越界参数被样例拦截（fixture 语义与样例库同构）。"""
    executor = ParamRegressionExecutor()
    ok = await executor.run(_params_entry(), _param_fixtures())
    assert ok.passed
    assert ok.accuracy == 1.0

    bad = await executor.run(
        _params_entry(weights={"A": 0.5, "B": 0.05}), _param_fixtures()
    )
    assert not bad.passed
    assert any("越界" in r.reason for r in bad.fixture_results)


async def test_tune_with_regression_rejects_out_of_bounds():
    """M7 接线：调参变更过 L2 回归——越界变更被拒绝（回退原参数）。"""
    params = TunableParams(weights={"A": 0.5, "B": 0.15}, thresholds={"pass": 0.6})
    metrics = TurnMetrics()
    gate = KnowledgeGate(l2_executor=ParamRegressionExecutor())
    result = await MetaTuner().tune_with_regression(
        params,
        metrics,
        _param_fixtures(weight_min=0.2),  # 边界高于调参下限保护
        feedback={"B": 0.0},  # 低分降权 → B 权重跌破 0.2 边界
        gate=gate,
    )
    assert result.changes == ()  # 变更被拒绝
    assert result.params.weights == {"A": 0.5, "B": 0.15}  # 回落原参数
    assert "回归未通过" in result.note


async def test_tune_with_regression_accepts_within_bounds():
    """M7 接线：边界内变更过回归 → 新参数生效（快照随落库）。"""
    params = TunableParams(weights={"A": 0.5, "B": 0.5}, thresholds={"pass": 0.6})
    metrics = TurnMetrics()
    gate = KnowledgeGate(l2_executor=ParamRegressionExecutor())
    result = await MetaTuner().tune_with_regression(
        params,
        metrics,
        _param_fixtures(),  # 默认边界 = 调参下限保护，降权不会跌破
        feedback={"B": 0.1},
        rule_version="rules-v9",
        gate=gate,
    )
    assert result.params.weights["B"] < 0.5  # 降权生效
    assert result.snapshot is not None  # 回归通过的变更随快照落库
    assert result.note == ""


async def test_tune_with_regression_persists_params_to_knowledge_set():
    """调参结果回写知识集：回归通过后参数条目更新（与知识孵化闭环）。"""
    from ink_engine.core.knowledge_set import KnowledgeSet, seed_knowledge_set
    from ink_engine.core.seeds import GENERAL_WEIGHTS_SEED_ID, build_general_seed_entries

    ks = KnowledgeSet("u1")
    seed_knowledge_set(ks, build_general_seed_entries())
    gate = KnowledgeGate(l2_executor=ParamRegressionExecutor())
    tuner = MetaTuner(knowledge_set=ks)
    params = TunableParams(
        weights={"quality": 0.5, "consistency": 0.5},
        thresholds={"pass": 0.6},
    )
    result = await tuner.tune_with_regression(
        params,
        TurnMetrics(),
        _param_fixtures(),
        feedback={"quality": 1.0},  # 高分升权
        rule_version="rules-v9",
        gate=gate,
    )
    assert result.params.weights["quality"] > 0.5
    # 参数条目已回写：下次调参从条目读回基线
    persisted = ks.get(GENERAL_WEIGHTS_SEED_ID)
    assert persisted is not None
    assert persisted.data["weights"]["quality"] > 0.5
    loaded = MetaTuner.load_params(ks)
    assert loaded.weights["quality"] > 0.5
    assert loaded.thresholds == {"pass": 0.6}


def test_load_params_falls_back_to_defaults():
    """参数基线读回：无参数条目时回落引擎默认（缺省可开箱）。"""
    from ink_engine.core.knowledge_set import KnowledgeSet

    ks = KnowledgeSet("u1")
    loaded = MetaTuner.load_params(ks)
    assert loaded.divergence_width == 3
    assert loaded.retry_budget == 1


async def test_tune_with_regression_skips_when_no_change():
    """无参数变化 = 不空转回归（无变更无需评估）。"""
    gate = KnowledgeGate(l2_executor=ParamRegressionExecutor())
    result = await MetaTuner().tune_with_regression(
        TunableParams(retry_budget=1),
        TurnMetrics(),
        _param_fixtures(),
        gate=gate,
    )
    assert result.changes == ()
    assert result.note == ""


async def test_tune_with_regression_host_gate_injected():
    """依赖注入：宿主自定义闸门（自定义回归执行器）参与接线。"""
    from ink_engine.core.knowledge_gate import GateL2Result

    class HostGate(KnowledgeGate):
        async def check_l2(self, entry, fixtures, *, regression=None):
            # 宿主语义示例：回归判定完全由宿主执行器接管
            return GateL2Result(passed=True)

    gate = HostGate()
    params = TunableParams(weights={"A": 0.6, "B": 0.6})
    result = await MetaTuner().tune_with_regression(
        params,
        TurnMetrics(),
        _param_fixtures(),
        feedback={"A": 0.0, "B": 0.0},
        gate=gate,
    )
    assert result.params.weights["A"] < 0.6  # 变更经宿主闸门生效
    assert result.note == ""


def test_tune_no_spurious_changes_at_bounds():
    """边界封顶不产生虚假变更说明（无实际变化不 append）。"""
    metrics = TurnMetrics()
    metrics.record_turn(failed=True)
    metrics.record_turn(failed=True)  # 失败率 = 1.0（高位驱动）
    # 重试预算已保底、web 阈值已封底 → 不再产生「变更」
    params = TunableParams(retry_budget=2, web_verify_threshold=0.1)
    result = MetaTuner().tune(params, metrics)
    assert result.changes == ()  # 修复前会空转 append 两条变更说明
    assert result.params.retry_budget == 2
    assert result.params.web_verify_threshold == 0.1


async def test_snapshot_sink_invoked_on_regression_pass():
    """参数快照落库集成点：回归通过 → sink 收到快照；拒绝 → 不收。"""
    sinks: list = []

    def collector(snapshot):
        sinks.append(snapshot)

    params = TunableParams(weights={"A": 0.5, "B": 0.5}, thresholds={"pass": 0.6})
    metrics = TurnMetrics()
    gate = KnowledgeGate(l2_executor=ParamRegressionExecutor())
    tuner = MetaTuner(snapshot_sink=collector)

    # 回归通过 → 快照经 sink 落库（回放/审计按快照重算）
    ok = await tuner.tune_with_regression(
        params,
        metrics,
        _param_fixtures(),
        feedback={"B": 0.1},
        rule_version="rules-v9",
        gate=gate,
    )
    assert ok.snapshot is not None
    assert len(sinks) == 1
    assert sinks[0].rule_version == "rules-v9"

    # 回归被拒 → 变更不生效，快照不落库
    rejected = await tuner.tune_with_regression(
        params,
        metrics,
        _param_fixtures(weight_min=0.5),  # B 降权 0.45 < 0.5 → 越界拒绝
        feedback={"B": 0.0},
        rule_version="rules-v10",
        gate=gate,
    )
    assert rejected.changes == ()
    assert len(sinks) == 1  # sink 未收到被拒变更的快照
