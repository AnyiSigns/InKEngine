"""边证据存储单测：评分公式硬规则断言 + 存储归集语义。

覆盖（硬规则断言段）：
- 评分公式单调性：成功率↑样本↑→分↑；衰减↑→分↓；τ 档位序
  0.6<0.8<1.0；零证据边权重 1/9；确定性 tie-break；
- 信任档推导边界（N=7/8、p̂=0.7 边界、N=29/30）；
- 多径判据边界（N=4 vs N=5、分差 0.15）；
- 冷启动指数边界（0.3）；
- 跨域聚合隔离（不做跨域平均）；
- 契约版本失效（升版后旧键不命中）；
- avg_cost 归集正确性（滑动均值）；
- 种子路径导入（出厂数据通道）。
"""
from __future__ import annotations

import math

import pytest

from ink_engine.core.edge_evidence import (
    EXPLORATION_INDEX_THRESHOLD,
    MULTIPATH_GAP,
    TIER_OBSERVING,
    TIER_PROMOTED,
    TIER_REGULAR,
    TIER_TAU,
    ZERO_EVIDENCE_WEIGHT,
    EdgeEvidence,
    EdgeEvidenceStore,
    EdgeKey,
    cold_start_index,
    derive_edge_tier,
    downgrade_edge_tier,
    edge_score,
    import_seed_paths,
    is_exploration_mode,
    laplace_success,
    multi_path_trigger,
    rank_candidates,
    sample_weight,
    time_decay,
    zero_evidence_score,
)

NOW = 1_800_000_000.0


def _evidence(
    s: int,
    f: int,
    *,
    cost: float = 0.0,
    domain: str = "code",
    last_used: float | None = None,
    policy: bool = False,
) -> EdgeEvidence:
    key = EdgeKey(src_type="a", dst_type="b", context_domain=domain)
    return EdgeEvidence(
        key=key,
        success_count=s,
        fail_count=f,
        avg_cost=cost,
        policy=policy,
        last_used_at=last_used if last_used is not None else NOW,
        created_at=NOW,
    )


# ── 评分公式单调性（硬规则）──

def test_score_increases_with_success_rate():
    """成功率↑（同样本量）→ 分↑（拉普拉斯平滑单调）。"""
    low = edge_score(_evidence(4, 4), now=NOW).score
    high = edge_score(_evidence(6, 2), now=NOW).score
    assert high > low


def test_score_increases_with_sample_size():
    """样本↑（同成功率）→ 分↑（样本量加权半饱和）。"""
    s1 = edge_score(_evidence(2, 0), now=NOW).score
    s2 = edge_score(_evidence(8, 0), now=NOW).score
    s3 = edge_score(_evidence(30, 0), now=NOW).score
    assert s2 > s1 and s3 > s2


def test_score_decreases_with_age():
    """衰减↑（age 增大）→ 分↓（30 天半衰期）。"""
    fresh = edge_score(_evidence(10, 0, last_used=NOW), now=NOW).score
    old = edge_score(_evidence(10, 0, last_used=NOW - 60 * 86400), now=NOW).score
    assert old < fresh


def test_policy_edge_exempts_decay():
    """策略边豁免时间衰减（d(t) 恒 1.0，评分不随 age 下降）。"""
    policy_old = edge_score(_evidence(10, 0, policy=True, last_used=NOW - 365 * 86400), now=NOW)
    policy_fresh = edge_score(_evidence(10, 0, policy=True, last_used=NOW), now=NOW)
    assert policy_old.decay == 1.0
    assert policy_old.score == policy_fresh.score


def test_tier_tau_ordering():
    """τ 档位序 0.6 < 0.8 < 1.0（观察/常规/转正）。"""
    taus = [TIER_TAU[t] for t in (TIER_OBSERVING, TIER_REGULAR, TIER_PROMOTED)]
    assert taus == sorted(taus)
    assert taus == [0.6, 0.8, 1.0]
    assert TIER_TAU[TIER_OBSERVING] < TIER_TAU[TIER_REGULAR] < TIER_TAU[TIER_PROMOTED]


def test_zero_evidence_weight_floor():
    """零证据边权重 = 1/9 先验下界（w_n），评分取先验下界常数。"""
    assert sample_weight(0) == pytest.approx(ZERO_EVIDENCE_WEIGHT)
    assert zero_evidence_score() == pytest.approx(
        laplace_success(0, 0) * ZERO_EVIDENCE_WEIGHT * 1.0 * TIER_TAU[TIER_OBSERVING]
    )
    assert zero_evidence_score() == pytest.approx(1 / 30)


def test_decay_half_life():
    """30 天半衰期：age=30 天 → d(t) ≈ 1/e。"""
    assert time_decay(30.0) == pytest.approx(math.exp(-1.0))
    assert time_decay(0.0) == 1.0
    assert time_decay(30.0, exempt=True) == 1.0


def test_deterministic_tie_break():
    """确定性 tie-break：(score 降序, avg_cost 升序, dst_type 字典序)。"""
    key = EdgeKey(src_type="a", dst_type="b", context_domain="code")
    e1 = EdgeEvidence(key=key, success_count=10, fail_count=0, avg_cost=5.0, last_used_at=NOW, created_at=NOW)
    key2 = EdgeKey(src_type="a", dst_type="b2", context_domain="code")
    e2 = EdgeEvidence(key=key2, success_count=10, fail_count=0, avg_cost=1.0, last_used_at=NOW, created_at=NOW)
    key3 = EdgeKey(src_type="a", dst_type="c", context_domain="code")
    e3 = EdgeEvidence(key=key3, success_count=10, fail_count=0, avg_cost=1.0, last_used_at=NOW, created_at=NOW)
    ranked = rank_candidates([e1, e2, e3], now=NOW)
    # 同分：avg_cost 升序 → b2（1.0）先于 b（5.0）；同成本同分 → 字典序
    assert [e.dst_type for e in ranked] == ["b2", "c", "b"]
    # 重复排序结果一致（确定性）
    assert [e.dst_type for e in rank_candidates([e1, e3, e2], now=NOW)] == [
        "b2",
        "c",
        "b",
    ]


def test_tie_break_score_desc_first():
    """分数降序优先于成本/字典序。"""
    key = EdgeKey(src_type="a", dst_type="b", context_domain="code")
    strong = EdgeEvidence(key=key, success_count=50, fail_count=0, avg_cost=100.0, last_used_at=NOW, created_at=NOW)
    key2 = EdgeKey(src_type="a", dst_type="c", context_domain="code")
    weak = EdgeEvidence(key=key2, success_count=1, fail_count=5, avg_cost=0.0, last_used_at=NOW, created_at=NOW)
    ranked = rank_candidates([weak, strong], now=NOW)
    assert ranked[0] is strong


# ── 信任档推导边界 ──

def test_tier_boundaries():
    """信任档推导边界：N=7/8、p̂=0.7、N=29/30、p̂=0.9。"""
    # N=7 观察（无论成功率多高）
    assert derive_edge_tier(7, 0) == TIER_OBSERVING
    # N=8 且 p̂≥0.7 → 常规（p̂(6,2)=0.7 恰为边界）
    assert derive_edge_tier(6, 2) == TIER_REGULAR
    assert laplace_success(6, 2) == pytest.approx(0.7)
    # N=8 但 p̂<0.7 → 仍观察
    assert derive_edge_tier(5, 3) == TIER_OBSERVING
    # N=29 且 p̂=0.9 → 常规（未到转正线）
    assert derive_edge_tier(26, 3) == TIER_REGULAR
    # N=30 且 p̂≥0.9 → 转正（p̂(27,3)=0.875 < 0.9；p̂(28,2)=0.906 ≥ 0.9）
    assert derive_edge_tier(26, 4) == TIER_REGULAR  # N=30 但 p̂=0.843
    assert derive_edge_tier(28, 2) == TIER_PROMOTED  # N=30 且 p̂=0.906
    # 转正后即使后续失败率回落仍按 N 累积判定（N≥30 且 p̂≥0.9 才维持）
    assert derive_edge_tier(28, 2) == TIER_PROMOTED


def test_tier_auto_promotion_no_approval():
    """纯算法自动晋级：统计满足即升档，无审批介入（函数无状态）。"""
    assert derive_edge_tier(28, 2) == TIER_PROMOTED
    assert TIER_TAU[derive_edge_tier(28, 2)] == 1.0


# ── 多径触发判据边界 ──

def _candidate(s: int, f: int, *, name: str = "b") -> EdgeEvidence:
    key = EdgeKey(src_type="a", dst_type=name, context_domain="code")
    return EdgeEvidence(
        key=key, success_count=s, fail_count=f, last_used_at=NOW, created_at=NOW
    )


def test_multipath_trigger_insufficient_samples():
    """N<5（top-1 或 top-2）→ 触发（样本不足）。"""
    assert multi_path_trigger(_candidate(2, 2), _candidate(1, 1), now=NOW)  # N=4
    assert multi_path_trigger(_candidate(4, 0), _candidate(2, 1), now=NOW)  # top2 N=3
    assert multi_path_trigger(_candidate(1, 0), _candidate(4, 0), now=NOW)  # top1 N=1


def test_multipath_trigger_missing_candidates():
    """候选不足两条（零条/一条）→ 触发（样本不足）。"""
    assert multi_path_trigger(None, None, now=NOW)
    assert multi_path_trigger(_candidate(5, 0), None, now=NOW)


def test_multipath_trigger_gap_boundary():
    """分差 0.15 边界：N≥5 且分差≥0.15 → 绝不触发；<0.15 → 触发。"""
    # 构造 top1/top2：同成功率、样本 5 vs 5、同成本 → 分差 = 0（<0.15）
    assert multi_path_trigger(_candidate(5, 0), _candidate(5, 0), now=NOW)
    # 构造分差恰 ≥0.15：top1 高样本高成功率 vs top2 低样本
    strong = _candidate(30, 0)
    weak = _candidate(5, 0)
    gap = edge_score(strong, now=NOW).score - edge_score(weak, now=NOW).score
    assert gap >= MULTIPATH_GAP
    assert not multi_path_trigger(strong, weak, now=NOW)
    # 分差略低于 0.15：构造同成功率样本接近 → 触发
    close1 = _candidate(5, 1)
    close2 = _candidate(6, 1)
    gap2 = edge_score(close1, now=NOW).score - edge_score(close2, now=NOW).score
    assert gap2 < MULTIPATH_GAP
    assert multi_path_trigger(close1, close2, now=NOW)


def test_multipath_trigger_n_boundary():
    """N=4 vs N=5 边界：N=4 必触发，N=5 且证据强绝不触发。"""
    assert multi_path_trigger(_candidate(4, 0), _candidate(4, 0), now=NOW)
    assert not multi_path_trigger(_candidate(5, 0), _candidate(30, 0), now=NOW)


# ── 冷启动指数边界 ──

def test_cold_start_boundaries():
    """冷启动指数边界：<0.3 = 探索模式；0.3 = 成熟模式。"""
    assert cold_start_index(0, 10) == 0.0
    assert cold_start_index(2, 10) == 0.2
    assert is_exploration_mode(0.299)
    assert not is_exploration_mode(0.3)
    assert not is_exploration_mode(0.9)
    assert EXPLORATION_INDEX_THRESHOLD == 0.3
    # 候选为 0 → 按 0 处理（探索）
    assert cold_start_index(0, 0) == 0.0
    assert is_exploration_mode(cold_start_index(0, 0))
    # 有证据边数超过候选数 → 封顶 1.0
    assert cold_start_index(12, 10) == 1.0


# ── 存储语义（sqlite）──

async def test_store_record_and_get():
    """成功/失败归集 + 读取（契约版本入键）。"""
    store = EdgeEvidenceStore()
    key = EdgeKey(src_type="a", dst_type="b", context_domain="code")
    assert await store.get(key) is None
    await store.record_success(key, cost=100.0, now=NOW)
    ev = await store.get(key)
    assert ev is not None and ev.success_count == 1 and ev.fail_count == 0
    await store.record_failure(key, cost=200.0, now=NOW + 1)
    ev = await store.get(key)
    assert ev is not None and ev.success_count == 1 and ev.fail_count == 1
    await store.close()


async def test_avg_cost_sliding_mean():
    """avg_cost 滑动均值：按已记录样本数加权（纯算法归集）。"""
    store = EdgeEvidenceStore()
    key = EdgeKey(src_type="a", dst_type="b", context_domain="code")
    await store.record_success(key, cost=100.0)
    await store.record_success(key, cost=200.0)
    ev = await store.get(key)
    assert ev is not None and ev.avg_cost == pytest.approx(150.0)
    # 成本缺省 = 不改变均值
    await store.record_success(key)
    ev = await store.get(key)
    assert ev is not None and ev.avg_cost == pytest.approx(150.0)
    await store.close()


async def test_avg_cost_sliding_mean_delta_roundtrip():
    """avg_cost 滑动均值按 delta 加权：delta>1 归集与分次归集等价（ENG9b-3）。

    旧实现恒用 (old_avg*old_n + cost)/(old_n+1)，delta=3 的加权归集被错误
    稀释；新实现 (old_avg*old_n + cost*delta)/(old_n+delta) 使一次 delta=3
    归集与 3 次 delta=1 归集得到相同均值（round-trip 一致）。
    """
    key = EdgeKey(src_type="a", dst_type="b", context_domain="code")

    batched = EdgeEvidenceStore()
    await batched.record_success(key, cost=100.0, delta=1)
    await batched.record_success(key, cost=200.0, delta=3)
    batched_ev = await batched.get(key)
    assert batched_ev is not None and batched_ev.success_count == 4
    assert batched_ev.avg_cost == pytest.approx(175.0)  # (100*1 + 200*3)/4

    sequential = EdgeEvidenceStore()
    await sequential.record_success(key, cost=100.0, delta=1)
    for _ in range(3):
        await sequential.record_success(key, cost=200.0, delta=1)
    seq_ev = await sequential.get(key)
    assert seq_ev is not None and seq_ev.success_count == 4
    assert seq_ev.avg_cost == pytest.approx(175.0)

    # delta=0（仅更新时间戳/成本不归集）不改写均值
    await batched.record_success(key, cost=999.0, delta=0)
    after = await batched.get(key)
    assert after is not None and after.avg_cost == pytest.approx(175.0)

    await batched.close()
    await sequential.close()


async def test_domain_isolation():
    """跨域聚合隔离：同边不同域互不影响（不做跨域平均）。"""
    store = EdgeEvidenceStore()
    code = EdgeKey(src_type="a", dst_type="b", context_domain="code")
    docs = EdgeKey(src_type="a", dst_type="b", context_domain="docs")
    await store.record_success(code, cost=50.0)
    await store.record_success(docs, cost=900.0)
    code_ev = await store.get(code)
    docs_ev = await store.get(docs)
    assert code_ev is not None and docs_ev is not None
    assert code_ev.success_count == 1 and docs_ev.success_count == 1
    assert code_ev.avg_cost == pytest.approx(50.0)
    assert docs_ev.avg_cost == pytest.approx(900.0)
    assert await store.evidence_count() == 2
    assert await store.evidence_count("code") == 1
    assert len(await store.list_edges("code")) == 1
    assert len(await store.list_edges("docs")) == 1
    await store.close()


async def test_contract_version_key_eviction():
    """契约版本失效：升版后旧键不命中（新版本冷启动）。"""
    store = EdgeEvidenceStore()
    old = EdgeKey(
        src_type="a",
        dst_type="b",
        src_contract_version="1",
        dst_contract_version="1",
        context_domain="code",
    )
    new = EdgeKey(
        src_type="a",
        dst_type="b",
        src_contract_version="2",
        dst_contract_version="1",
        context_domain="code",
    )
    await store.record_success(old)
    assert (await store.get(old)) is not None
    assert await store.get(new) is None  # 升版自然冷启动，旧统计不误导
    await store.record_success(new)
    new_ev = await store.get(new)
    assert new_ev is not None and new_ev.success_count == 1
    old_ev = await store.get(old)
    assert old_ev is not None and old_ev.success_count == 1  # 旧行保留不覆盖
    await store.close()


async def test_seed_paths_import():
    """种子路径导入：初始化边证据；已存在行不覆盖（运行统计是事实）。"""
    store = EdgeEvidenceStore()
    seeds = [
        {
            "src_type": "a",
            "dst_type": "b",
            "context_domain": "code",
            "success_count": 30,
            "fail_count": 2,
        },
        {
            "src_type": "b",
            "dst_type": "c",
            "context_domain": "code",
            "success_count": 10,
            "fail_count": 0,
            "policy": True,
        },
    ]
    written = await import_seed_paths(store, seeds)
    assert written == 2
    seed_ev = await store.get(
        EdgeKey(src_type="a", dst_type="b", context_domain="code")
    )
    assert seed_ev is not None and seed_ev.success_count == 30
    # 运行期证据在先：同键不覆盖
    key = EdgeKey(src_type="b", dst_type="c", context_domain="code")
    await store.record_success(key)
    again = await import_seed_paths(store, seeds)
    assert again == 0
    ev = await store.get(key)
    assert ev is not None and ev.success_count == 11  # 种子 10 + 运行 1，种子未覆盖
    assert ev.policy is True  # 策略边声明随种子保留
    await store.close()


async def test_evidence_scoring_from_store():
    """存储行 → 评分（信任档/评分公式全链路）。"""
    store = EdgeEvidenceStore()
    key = EdgeKey(src_type="a", dst_type="b", context_domain="code")
    for _ in range(28):
        await store.record_success(key)
    for _ in range(2):
        await store.record_failure(key)
    ev = await store.get(key)
    assert ev is not None
    assert derive_edge_tier(ev.success_count, ev.fail_count) == TIER_PROMOTED
    score = edge_score(ev, now=NOW)
    assert score.tau == 1.0
    assert score.p == pytest.approx(laplace_success(28, 2))
    await store.close()


async def test_downgrade_edge_tier_promoted_target_lands_on_promoted():
    """降级到 promoted 的目标计数改写后推导档 = promoted（ENG9b-2 修复）。

    修复点：``_TIER_TARGET_COUNTS[promoted]`` 由 (30,3) 改为 (35,3)。旧值
    p̂=(31)/(35)=0.886 < 0.9 → derive_edge_tier 落 regular——「降级到 promoted」
    的目标计数本身不满足转正推导线（永远达不到）；新值 p̂=(36)/(40)=0.9 恰好
    过线 → 改写计数即落转正档。
    """
    from ink_engine.core.edge_evidence import _TIER_TARGET_COUNTS

    target_s, target_f = _TIER_TARGET_COUNTS[TIER_PROMOTED]
    # 目标计数形态必须满足转正推导线（N≥30 且 p̂≥0.9）——回归基线断言
    assert laplace_success(target_s, target_f) >= 0.9
    assert target_s + target_f >= 30
    assert derive_edge_tier(target_s, target_f) == TIER_PROMOTED

    # 端到端：当前证据即转正计数形态时，降级 op 到 promoted 推导档保持 promoted
    store = EdgeEvidenceStore(":memory:")
    key = EdgeKey(src_type="a", dst_type="b", context_domain="default")
    await store.put(
        EdgeEvidence(key=key, success_count=target_s, fail_count=target_f, avg_cost=1.5)
    )
    res = await downgrade_edge_tier(store, key, target_tier=TIER_PROMOTED, storage=None)
    assert res["from_tier"] == TIER_PROMOTED
    assert res["to_tier"] == TIER_PROMOTED
    after = await store.get(key)
    assert after is not None
    assert derive_edge_tier(after.success_count, after.fail_count) == TIER_PROMOTED
    assert after.avg_cost == pytest.approx(1.5)  # 保留原成本/时间戳
    await store.close()
