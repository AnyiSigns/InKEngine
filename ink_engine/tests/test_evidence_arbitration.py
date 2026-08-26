"""记忆整合仲裁单测：行为优先级链路的整合语义断言。

仲裁链（代码化优先级，见 docs/evidence_arbitration.md）：
缓存短路 > 边证据 > 策略边 τ 档。本文件覆盖整合语义：
- 缓存未命中 → 边证据接管：同请求下边证据越强，组装评分越高
  （边证据是未命中时的裁决依据）；
- 证据漂移 → 重组装：缓存条目失效后，下次组装走证据驱动的重组装
  （非缓存短路路径），漂移信号落地为失效 + 重组；
- 策略边复审降级 → τ 豁免移除：复审降级后 policy=False，评分回落到
  统计档口径（τ=1.0 豁免不再生效）。
"""
from __future__ import annotations

from ink_engine.core.edge_evidence import (
    EdgeEvidence,
    EdgeEvidenceStore,
    EdgeKey,
    edge_score,
)
from ink_engine.core.fingerprint_cache import FingerprintCacheStore
from ink_engine.core.path_assembler import (
    CANDIDATE_SOURCE_ALGORITHM,
    CANDIDATE_SOURCE_CACHE,
    STATS_CACHE_HITS,
    STATS_CACHE_INVALIDATIONS,
    STATS_CACHE_MISSES,
)
from tests.test_fingerprint_cache import (
    DUMMY_NOW,
    _request,
    _request_key,
    make_assembler,
    make_registry,
)


async def test_cache_miss_falls_back_to_edge_evidence():
    """缓存未命中 → 边证据接管：证据越强评分越高（无缓存短路径）。"""
    registry = make_registry()
    evidence = EdgeEvidenceStore()
    cache = FingerprintCacheStore(now=DUMMY_NOW)
    assembler = make_assembler(registry, store=evidence, cache=cache)
    request = _request(("answer",))
    edge_key = EdgeKey(
        src_type="web_search", dst_type="answer_direct", context_domain="code"
    )
    # 弱证据（2 次成功）→ 未命中组装
    for _ in range(2):
        await evidence.record_success(edge_key, now=DUMMY_NOW)
    weak = await assembler.assemble(request)
    assert weak.stats[STATS_CACHE_MISSES] >= 1
    assert weak.candidates[0].source != CANDIDATE_SOURCE_CACHE
    # 强证据（30 次成功）→ 重新组装（同请求，缓存仍未命中）
    for _ in range(28):
        await evidence.record_success(edge_key, now=DUMMY_NOW)
    strong = await assembler.assemble(request)
    assert strong.stats[STATS_CACHE_MISSES] >= 1
    # 边证据接管：强证据候选分显著高于弱证据候选分
    assert strong.candidates[0].score > weak.candidates[0].score
    await evidence.close()
    await cache.close()


async def test_drift_triggers_reassembly():
    """证据漂移 → 失效 + 重组装（下次组装走证据驱动路径而非缓存短路）。"""
    registry = make_registry()
    evidence = EdgeEvidenceStore()
    cache = FingerprintCacheStore(now=DUMMY_NOW)
    assembler = make_assembler(registry, store=evidence, cache=cache)
    request = _request(("answer",))
    edge_key = EdgeKey(
        src_type="web_search", dst_type="answer_direct", context_domain="code"
    )
    for _ in range(30):
        await evidence.record_success(edge_key, now=DUMMY_NOW)
    first = await assembler.assemble(request)
    key = _request_key(request)
    # 沉淀侧写入缓存（settle hook 同源形态）
    snapshot = [e.to_dict() for e in (await evidence.list_edges("code"))]
    await cache.upsert(
        key,
        path=first.candidates[0].graph.to_dict(),
        evidence_snapshot=snapshot,
        model_id="",
        gate_passed=True,
        path_fingerprint=first.candidates[0].graph.digest(),
        domain="code",
    )
    hit = await assembler.assemble(request)
    assert hit.stats[STATS_CACHE_HITS] == 1  # 缓存短路生效
    # 证据漂移（差 ≥20% 且 N≥5）：10 失败追加
    for _ in range(10):
        await evidence.record_failure(edge_key, now=DUMMY_NOW)
    drifted = await assembler.assemble(request)
    assert drifted.stats[STATS_CACHE_INVALIDATIONS] == 1
    assert drifted.stats[STATS_CACHE_HITS] == 0
    assert drifted.candidates[0].source == CANDIDATE_SOURCE_ALGORITHM  # 重组装
    await evidence.close()
    await cache.close()


async def test_policy_edge_review_downgrade_removes_tau_exemption():
    """策略边复审降级 → τ 豁免移除：policy=False 后评分回落统计档口径。"""
    from ink_engine.core.graph import TerminateReason
    from ink_engine.core.run_result import RunResult
    from ink_engine.core.settle import PolicyEdgeReviewSettleHook, SettleContext, TraceStep

    store = EdgeEvidenceStore()
    key = EdgeKey(src_type="start", dst_type="mid", context_domain="code")
    await store.put(
        EdgeEvidence(
            key=key,
            success_count=0,
            fail_count=6,
            policy=True,
            created_at=DUMMY_NOW,
            last_used_at=DUMMY_NOW,
        )
    )
    before = await store.get(key)
    score_before = edge_score(before, now=DUMMY_NOW).score
    assert before.policy is True  # 策略边 τ=1.0 豁免
    # 复审钩子：失败累计 ≥5 → 降级提请 L2 + 落库 policy=False
    hook = PolicyEdgeReviewSettleHook(store)
    ctx = SettleContext(
        thread_id="t",
        round_id="r",
        trace_id="tr",
        domain="code",
        steps=(TraceStep(graph_path=(), node="start", status="success"),
               TraceStep(graph_path=(), node="mid", status="success")),
        node_tokens={},
        graphs={},
        result=RunResult(state={}, reason=TerminateReason.REPLY, error=None),
    )
    await hook.settle(ctx)
    after = await store.get(key)
    assert after.policy is False  # 降级已落库
    score_after = edge_score(after, now=DUMMY_NOW).score
    assert score_after < score_before  # τ 豁免移除，评分回落
    assert edge_score(after, now=DUMMY_NOW).tau != 1.0
    await store.close()


def test_arbitration_priority_chain_public_contract():
    """仲裁链公开契约：缓存命中 > 未命中走边证据 > 策略边 τ 档（锚点断言）。"""
    # 缓存短路语义：命中统计键与失效键齐备（路径组装器公开观察面）
    from ink_engine.core.path_assembler import (
        STATS_CACHE_HITS as H,
    )
    from ink_engine.core.path_assembler import (
        STATS_CACHE_INVALIDATIONS as I,
    )
    from ink_engine.core.path_assembler import (
        STATS_CACHE_MISSES as M,
    )

    assert {H, I, M} == {"cache_hits", "cache_invalidations", "cache_misses"}
    # 策略边 τ 豁免是评分公式的公开常数（降级即移除）
    from ink_engine.core.edge_evidence import TIER_PROMOTED, TIER_TAU

    assert TIER_TAU[TIER_PROMOTED] == 1.0
