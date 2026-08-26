"""证据口径收口单测：归因对称 / 先验隔离 / 双衰减数据驱动 / 实例粒度 /
失败分类分流的断言回归。

覆盖（口径断言段）：
- 归因对称（加权分摊）：失败事件整链可疑，惩罚按边成功史加权分摊到全
  路径边，失败结点入边额外 +1 诊断；5 结点路径 10 成功 1 失败后全链边
  按权重分摊、失败边评分显著回撤（成功膨胀回归）；
- 先验隔离（降权）：种子行带 origin=seed 且评分降权；首次真实成功后翻
  为 runtime、降权解除（先验假象不再主导）；
- 双衰减数据驱动：半衰期可经注入收紧/放宽，默认 30 保持行为兼容；
- 实例粒度（变体指纹维）：variant_hash 使同类型不同变体沉淀独立边证据；
- 失败归因分类：error 消息分类器按类分流，仅能力缺口类触发结点提案
  （环境/配置类失败不污染评审队列）。
"""
from __future__ import annotations

import pytest

from ink_engine.core.edge_evidence import (
    DECAY_HALF_DAYS,
    ORIGIN_RUNTIME,
    ORIGIN_SEED,
    EdgeEvidence,
    EdgeEvidenceStore,
    EdgeKey,
    edge_score,
    get_decay_half_days,
    set_decay_half_days,
    time_decay,
)
from ink_engine.core.graph import Graph, TerminateReason
from ink_engine.core.run_result import RunResult
from ink_engine.core.settle import (
    CAPABILITY_GAP_CATEGORIES,
    FAIL_CAT_MODEL,
    FAIL_CAT_NETWORK,
    FAIL_CAT_PERMISSION,
    FAIL_CAT_UNKNOWN,
    FAIL_CAT_VALIDATION,
    UPDATE_FAIL,
    EdgeEvidenceSettleHook,
    NodeProposalSettleHook,
    SettleContext,
    TraceStep,
    attribution_plan,
    classify_failure,
    node_identity,
)

NOW = 1_800_000_000.0


def _ev(s: int, f: int, *, origin: str = ORIGIN_RUNTIME, last_used: float | None = None) -> EdgeEvidence:
    key = EdgeKey(src_type="a", dst_type="b", context_domain="code")
    return EdgeEvidence(
        key=key,
        success_count=s,
        fail_count=f,
        origin=origin,
        created_at=NOW,
        last_used_at=last_used if last_used is not None else NOW,
    )


def _steps(*items: tuple[str, str]) -> tuple[TraceStep, ...]:
    return tuple(TraceStep(graph_path=(), node=node, status=status) for node, status in items)


def _ctx(steps, *, graph=None, error=None):
    """沉淀上下文：有 error = 错误收尾，否则正常回复（归因方向随判定）。"""
    return SettleContext(
        thread_id="t",
        round_id="r",
        trace_id="tr",
        domain="code",
        steps=steps,
        node_tokens={},
        graphs={(): graph} if graph is not None else {},
        result=RunResult(
            state={},
            reason=TerminateReason.ERROR if error is not None else TerminateReason.REPLY,
            error=error,
        ),
    )


def _five_node_graph() -> Graph:
    g = Graph(name="five", entry="n1")
    for n in ("n1", "n2", "n3", "n4", "n5"):
        g.add_node(n, lambda ctx: {})
    for a, b in (("n1", "n2"), ("n2", "n3"), ("n3", "n4"), ("n4", "n5")):
        g.add_edge(a, b)
    g.add_exit("n5")
    return g


def _start_mid_end_graph() -> Graph:
    g = Graph(name="sme", entry="start")
    g.add_node("start", lambda ctx: {})
    g.add_node("mid", lambda ctx: {})
    g.add_node("end", lambda ctx: {})
    g.add_edge("start", "mid")
    g.add_edge("mid", "end")
    g.add_exit("end")
    return g


# ── 先验隔离（降权）──

def test_seed_origin_downweighted_vs_runtime():
    """种子行 origin=seed 评分按 SEED_WEIGHT 降权，真实运行时全权。"""
    from ink_engine.core.edge_evidence import SEED_WEIGHT

    seed = _ev(6, 0, origin=ORIGIN_SEED)
    rt = _ev(6, 0, origin=ORIGIN_RUNTIME)
    sc_seed = edge_score(seed, now=NOW).score
    sc_rt = edge_score(rt, now=NOW).score
    assert sc_seed < sc_rt
    assert sc_seed == pytest.approx(sc_rt * SEED_WEIGHT)


async def test_seed_illusion_removed_after_real_success():
    """首次真实成功把种子行 origin 翻为 runtime，降权解除（先验假象不再主导）。"""
    store = EdgeEvidenceStore()
    key = EdgeKey(src_type="a", dst_type="b", context_domain="code")
    await store.put(
        EdgeEvidence(key=key, success_count=6, fail_count=1, origin=ORIGIN_SEED,
                     created_at=NOW, last_used_at=NOW)
    )
    before = await store.get(key)
    assert before.origin == ORIGIN_SEED
    score_before = edge_score(before, now=NOW).score
    await store.record_success(key, now=NOW)  # 真实成功 → origin 翻 runtime
    after = await store.get(key)
    assert after.origin == ORIGIN_RUNTIME
    score_after = edge_score(after, now=NOW).score
    # 真实成功后降权解除，评分回升到全权口径（先验假象不再主导）
    assert score_after > score_before
    await store.close()


# ── 双衰减数据驱动 ──

def test_decay_data_driven_and_default_kept():
    """半衰期可注入收紧，默认 30 保持行为兼容。"""
    assert get_decay_half_days() == DECAY_HALF_DAYS == 30.0
    key = EdgeKey(src_type="a", dst_type="b", context_domain="code")
    old = EdgeEvidence(key=key, success_count=30, fail_count=0,
                        created_at=NOW - 60 * 86400, last_used_at=NOW - 60 * 86400)
    recent = EdgeEvidence(key=key, success_count=2, fail_count=0,
                           created_at=NOW - 7 * 86400, last_used_at=NOW - 7 * 86400)
    set_decay_half_days(30)
    s_old = edge_score(old, now=NOW).score
    s_recent = edge_score(recent, now=NOW).score
    # 60 天前 30 次全成功 vs 上周 2 次观察档：半衰期口径下已拉开差距
    assert s_old != s_recent
    # 注入更短半衰期 → 旧证据折旧更猛，评分进一步压低（数据驱动可控）
    set_decay_half_days(10)
    s_old_tight = edge_score(old, now=NOW).score
    assert s_old_tight < s_old
    # 复位出厂默认，避免污染其它测试
    set_decay_half_days(30)
    assert time_decay(30.0) == pytest.approx(2.718281828459045 ** -1)


# ── 实例粒度（变体指纹维）──

async def test_variant_hash_isolates_evidence():
    """同 src/dst 不同类型变体沉淀独立边证据（旧行空值归类型级）。"""
    store = EdgeEvidenceStore()
    base = EdgeKey(src_type="a", dst_type="b", context_domain="code")
    v1 = EdgeKey(src_type="a", dst_type="b", context_domain="code", variant_hash="h1")
    v2 = EdgeKey(src_type="a", dst_type="b", context_domain="code", variant_hash="h2")
    await store.record_success(base)
    await store.record_success(v1)
    await store.record_failure(v2)
    assert (await store.get(base)).success_count == 1
    assert (await store.get(v1)).success_count == 1
    assert (await store.get(v2)).fail_count == 1
    # 三行互不共享
    assert len(await store.list_edges("code")) == 3
    await store.close()


def test_node_identity_extracts_variant_hash():
    """node_identity 透传节点配置的 variant_hash（空 = 类型级兼容）。"""
    g = Graph(name="v", entry="a")
    g.add_node_type("a", "a", {"variant_hash": "hA"})
    g.add_node_type("b", "b", {"variant_hash": "hB"})
    g.add_edge("a", "b")
    g.add_exit("b")
    assert node_identity(g, "a") == ("a", "1", "hA")
    assert node_identity(g, "b") == ("b", "1", "hB")


def test_attribution_plan_carries_variant_hash():
    """归因计划把目标结点变体指纹带入边主键（实例粒度）。"""
    g = Graph(name="v2", entry="a")
    g.add_node_type("a", "a", {"variant_hash": "hA"})
    g.add_node_type("b", "b", {"variant_hash": "hB"})
    g.add_edge("a", "b")
    g.add_exit("b")
    ctx = _ctx(_steps(("a", "success"), ("b", "success")), graph=g)
    plan = attribution_plan(ctx)
    assert len(plan) == 1
    assert plan[0].key.variant_hash == "hB"


# ── 归因对称（加权分摊）──

def test_weighted_failure_attribution_five_node():
    """5 结点路径、每条边 10 次成功背景下的 1 次失败：全链按权重分摊。

    权重 = 成功计数 + 1 = 11；失败结点入边额外 +1 诊断 = 12。
    """
    g = _five_node_graph()
    edges = [("n1", "n2"), ("n2", "n3"), ("n3", "n4"), ("n4", "n5")]
    index = {}
    for a, b in edges:
        k = EdgeKey(src_type=a, dst_type=b, context_domain="code")
        index[k] = EdgeEvidence(key=k, success_count=10, fail_count=0,
                                created_at=NOW, last_used_at=NOW)
    ctx = _ctx(_steps(("n1", "success"), ("n2", "success"), ("n3", "success"),
                      ("n4", "success"), ("n5", "failed")), graph=g)
    plan = attribution_plan(ctx, evidence_index=index)
    assert len(plan) == 4
    assert all(u.kind == UPDATE_FAIL for u in plan)
    by_dst = {u.key.dst_type: u for u in plan}
    for n in ("n2", "n3", "n4"):
        assert by_dst[n].delta == 11  # 基础加权分摊
    assert by_dst["n5"].delta == 12  # 失败结点入边 + 诊断


async def test_weighted_failure_regresses_score():
    """加权归因后失败边评分显著低于同级健康边（成功膨胀回归）。"""
    store = EdgeEvidenceStore()
    hook = EdgeEvidenceSettleHook(store)
    g = _five_node_graph()
    succ = _steps(("n1", "success"), ("n2", "success"), ("n3", "success"),
                  ("n4", "success"), ("n5", "success"))
    fail = _steps(("n1", "success"), ("n2", "success"), ("n3", "success"),
                  ("n4", "success"), ("n5", "failed"))
    for _ in range(10):
        await hook.settle(_ctx(succ, graph=g))
    await hook.settle(_ctx(fail, graph=g, error="model out of memory"))
    n45 = await store.get(EdgeKey(src_type="n4", dst_type="n5", context_domain="code"))
    n12 = await store.get(EdgeKey(src_type="n1", dst_type="n2", context_domain="code"))
    assert n45 is not None and n12 is not None
    assert n45.fail_count >= 11 and n12.fail_count >= 11
    # 失败信号按真实证据强度回撤：失败边评分低于未失败边
    assert edge_score(n45, now=NOW).score < edge_score(n12, now=NOW).score
    await store.close()


# ── 失败归因分类 ──

def test_classify_failure_categories():
    """error 消息 → 类别（permission/validation/network/model/unknown）。"""
    assert classify_failure("Permission denied: forbidden") == FAIL_CAT_PERMISSION
    assert classify_failure("schema validation invalid 400") == FAIL_CAT_VALIDATION
    assert classify_failure("connection timeout network 503") == FAIL_CAT_NETWORK
    assert classify_failure("model rate limit 429 context length") == FAIL_CAT_MODEL
    assert classify_failure("unexpected boom") == FAIL_CAT_UNKNOWN
    # 能力缺口类（才提案）集合
    assert FAIL_CAT_MODEL in CAPABILITY_GAP_CATEGORIES
    assert FAIL_CAT_UNKNOWN in CAPABILITY_GAP_CATEGORIES
    assert FAIL_CAT_PERMISSION not in CAPABILITY_GAP_CATEGORIES
    assert FAIL_CAT_NETWORK not in CAPABILITY_GAP_CATEGORIES


async def test_node_proposal_only_for_capability_gap():
    """失败分类分流：仅能力缺口类触发结点提案，环境/配置类不污染队列。"""
    store = EdgeEvidenceStore()
    sink: list[dict] = []
    hook = NodeProposalSettleHook(store, proposal_sink=sink.append)
    g = _start_mid_end_graph()
    key = EdgeKey(src_type="start", dst_type="mid", context_domain="code")
    # 累计 3 次失败（达提案阈值）但属权限类 → 不提案
    await store.record_failure(key)
    await store.record_failure(key)
    await store.record_failure(key)
    await hook.settle(_ctx(_steps(("start", "success"), ("mid", "failed")), graph=g,
                            error="Permission denied: forbidden"))
    assert hook.proposals == []
    # 能力缺口类（model）→ 提案且标注类别
    await hook.settle(_ctx(_steps(("start", "success"), ("mid", "failed")), graph=g,
                            error="model context length exceeded"))
    assert len(hook.proposals) == 1
    assert hook.proposals[0]["failure_category"] == FAIL_CAT_MODEL
    await store.close()
