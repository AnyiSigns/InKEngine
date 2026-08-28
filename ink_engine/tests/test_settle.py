"""沉淀钩子单测：归因硬规则 + 提案/审计/指纹接口 + 引擎端到端。

覆盖（硬规则断言段）：
- 归因规则：失败只记失败结点入边 fail+1、上游边中性不记；成功才
  全边 success+1；成本每次执行归集 avg_cost；
- 失败点提案判据（N≥3 或入边失败率>0.4，单样本不判率）与契约草案
  生成（schema 声明而非代码）；
- 指纹缓存 upsert 接口 fail-closed（无闸门/无缓存 = 不入缓存）；
- 失败日志留痕审计 append-only；
- 钩子异常隔离（沉淀失败不阻断 run 结果交付）；
- 引擎端到端：成功 run → 全边 +1；失败 run → 只记失败结点入边。
"""
from __future__ import annotations

import pytest

from ink_engine.core.edge_evidence import EdgeEvidence, EdgeEvidenceStore, EdgeKey
from ink_engine.core.graph import Graph
from ink_engine.core.run_result import RunResult
from ink_engine.core.settle import (
    PROPOSAL_FAIL_RATE,
    PROPOSAL_MIN_FAILS,
    TRACE_FAILED,
    TRACE_SKIPPED,
    TRACE_SUCCESS,
    UPDATE_FAIL,
    UPDATE_SUCCESS,
    EdgeEvidenceSettleHook,
    FailureAuditSettleHook,
    FingerprintSettleHook,
    NodeProposalSettleHook,
    PoolGovernanceSettleHook,
    SettleContext,
    SettleHooks,
    TraceStep,
    attribution_plan,
    derive_traversals,
    draft_node_contract,
    node_identity,
    run_verdict,
    should_propose,
)
from tests.conftest import demo_linear_graph, make_engine

NOW = 1_800_000_000.0


class _StubGate:
    """闸门桩（QualityGate 协议形态：evaluate(ctx) -> bool）。"""

    def __init__(self, verdict: bool = True) -> None:
        self._verdict = verdict

    async def evaluate(self, ctx) -> bool:
        return self._verdict


def _steps(*items: tuple[str, str]) -> tuple[TraceStep, ...]:
    return tuple(
        TraceStep(graph_path=(), node=node, status=status) for node, status in items
    )


def _ctx(
    steps: tuple[TraceStep, ...],
    *,
    graph: Graph | None = None,
    tokens: dict | None = None,
    reason: str = "reply",
    interrupt=None,
    error: str | None = None,
) -> SettleContext:
    from ink_engine.core.graph import TerminateReason

    graph = graph or demo_linear_graph()
    return SettleContext(
        thread_id="t1",
        round_id="r1",
        trace_id="tr1",
        domain="code",
        steps=steps,
        node_tokens=tokens or {},
        graphs={(): graph},
        result=RunResult(
            state={},
            reason=reason if reason != "reply" else TerminateReason.REPLY,
            interrupt=interrupt,
            error=error,
        ),
    )


# ── 轨迹回放与归因（硬规则）──

def test_derive_traversals_only_graph_edges():
    """连续执行对无图边 = 不构成遍历（计划跳跃不产生证据）。"""
    g = demo_linear_graph()  # start → mid → end
    steps = _steps(("start", TRACE_SUCCESS), ("end", TRACE_SUCCESS))
    ctx = _ctx(steps, graph=g)
    assert derive_traversals(ctx) == ()  # start→end 无直连边


def test_attribution_success_all_edges():
    """成功才全边 success+1（路径全通才证明每条边有效）。"""
    steps = _steps(
        ("start", TRACE_SUCCESS),
        ("mid", TRACE_SUCCESS),
        ("end", TRACE_SUCCESS),
    )
    plan = attribution_plan(_ctx(steps))
    kinds = [u.kind for u in plan]
    assert kinds == [UPDATE_SUCCESS, UPDATE_SUCCESS]
    keys = [u.key for u in plan]
    assert keys[0].src_type == "start" and keys[0].dst_type == "mid"
    assert keys[1].src_type == "mid" and keys[1].dst_type == "end"


def test_attribution_failure_only_failed_incoming():
    """失败归因对称（加权分摊）：整链可疑，失败结点入边额外 +1 诊断。

    等权退化（无证据快照）时失败结点入边 = 基础 1 + 诊断 1 = 2，其余
    路径边各 1——失败信号不再被「只记失败结点入边」稀释。
    """
    steps = _steps(
        ("start", TRACE_SUCCESS),
        ("mid", TRACE_FAILED),
        # end 未执行（run 终止于失败）
    )
    plan = attribution_plan(_ctx(steps))
    assert len(plan) == 1
    assert plan[0].kind == UPDATE_FAIL
    assert plan[0].key.src_type == "start"
    assert plan[0].key.dst_type == "mid"
    assert plan[0].delta == 2  # 等权 1 + 失败结点入边诊断 1


def test_attribution_failure_upstream_neutral():
    """上游成功边不记 success（整链未全通，但按对称口径分摊失败）。

    等权退化时：失败结点入边（mid→end）额外 +1 诊断 = 2；上游成功边
    （start→mid）仅基础分摊 1——失败信号散布全链而非稀释于单边。
    """
    steps = _steps(
        ("start", TRACE_SUCCESS),
        ("mid", TRACE_SUCCESS),
        ("end", TRACE_FAILED),
    )
    plan = attribution_plan(_ctx(steps))
    assert len(plan) == 2
    assert all(u.kind == UPDATE_FAIL for u in plan)
    by_key = {u.key.dst_type: u for u in plan}
    assert by_key["end"].delta == 2  # 失败结点入边 + 诊断
    assert by_key["mid"].delta == 1  # 上游成功边仅基础分摊


def test_attribution_cost_carries_target_tokens():
    """成本每次执行归集：目标结点 token 计账随归因携带。"""
    steps = _steps(
        ("start", TRACE_SUCCESS),
        ("mid", TRACE_SUCCESS),
        ("end", TRACE_SUCCESS),
    )
    tokens = {((), "mid"): 100, ((), "end"): 250}
    plan = attribution_plan(_ctx(steps, tokens=tokens))
    assert plan[0].cost == 100.0  # start→mid 的 cost = mid 执行成本
    assert plan[1].cost == 250.0  # mid→end 的 cost = end 执行成本


def test_attribution_neutral_on_interrupt_and_error():
    """挂起/计划级错误/预算截断 = 中性不记（路径未走完无裁决）。"""
    from ink_engine.core.graph import TerminateReason

    steps = _steps(("start", TRACE_SUCCESS), ("mid", TRACE_SKIPPED))
    assert run_verdict(_ctx(steps)) == "neutral"
    assert attribution_plan(_ctx(steps)) == ()
    assert run_verdict(_ctx(steps, reason=TerminateReason.ERROR)) == "neutral"
    assert (
        run_verdict(
            _ctx(steps, reason=TerminateReason.BUDGET_EXCEEDED)
        )
        == "neutral"
    )


def test_node_identity_resolves_bindings():
    """结点身份解析：声明式绑定取类型名/契约版本；直挂取结点名+缺省。"""
    g = demo_linear_graph()
    assert node_identity(g, "start") == ("start", "1", "")
    assert node_identity(None, "x") == ("x", "1", "")
    # 绑定形态：NodeBinding 携带类型与契约版本
    g2 = Graph(name="typed", entry="t")
    from ink_engine.core.registry import NodeTypeRegistry

    reg = NodeTypeRegistry()
    reg.register("t1", lambda config: (lambda ctx: {"v": 1}))
    g2.add_node_type("t", "t1", {"contract_version": "3"})
    g2.resolve_types(reg)
    assert node_identity(g2, "t") == ("t1", "3", "")


def test_attribution_domain_key():
    """归因键永远携带 context_domain（按域聚合写死）。"""
    steps = _steps(
        ("start", TRACE_SUCCESS),
        ("mid", TRACE_SUCCESS),
        ("end", TRACE_SUCCESS),
    )
    plan = attribution_plan(_ctx(steps))
    assert all(u.key.context_domain == "code" for u in plan)


# ── 存储钩子集成 ──

async def test_edge_evidence_hook_applies_plan():
    """归因钩子落库：成功全边 +1，失败只记失败结点入边。"""
    store = EdgeEvidenceStore()
    hook = EdgeEvidenceSettleHook(store)
    # 成功 run
    await hook.settle(
        _ctx(
            _steps(
                ("start", TRACE_SUCCESS),
                ("mid", TRACE_SUCCESS),
                ("end", TRACE_SUCCESS),
            )
        )
    )
    e1 = await store.get(EdgeKey(src_type="start", dst_type="mid", context_domain="code"))
    e2 = await store.get(EdgeKey(src_type="mid", dst_type="end", context_domain="code"))
    assert e1 is not None and e1.success_count == 1
    assert e2 is not None and e2.success_count == 1
    # 失败 run：只记失败结点入边
    await hook.settle(
        _ctx(
            _steps(("start", TRACE_SUCCESS), ("mid", TRACE_FAILED)),
            reason="error",
            error="boom",
        )
    )
    e1 = await store.get(EdgeKey(src_type="start", dst_type="mid", context_domain="code"))
    # 加权分摊：失败前该边已有 1 次成功（权重 2），失败结点入边诊断 +1
    # → delta=3；失败信号按真实证据强度回撤，不再被成功膨胀稀释
    assert e1 is not None and e1.fail_count == 3 and e1.success_count == 1
    await store.close()


async def test_edge_evidence_hook_cost():
    """归因钩子成本：avg_cost 滑动均值随执行次数归集。"""
    store = EdgeEvidenceStore()
    hook = EdgeEvidenceSettleHook(store)
    steps = _steps(
        ("start", TRACE_SUCCESS),
        ("mid", TRACE_SUCCESS),
        ("end", TRACE_SUCCESS),
    )
    tokens = {((), "mid"): 100, ((), "end"): 100}
    await hook.settle(_ctx(steps, tokens=tokens))
    await hook.settle(_ctx(steps, tokens={((), "mid"): 300, ((), "end"): 300}))
    ev = await store.get(EdgeKey(src_type="start", dst_type="mid", context_domain="code"))
    assert ev is not None and ev.avg_cost == 200.0  # (100+300)/2
    await store.close()


# ── 失败点提案 ──

def test_should_propose_thresholds():
    """提案判据边界：N≥3 或失败率>0.4（≥2 样本），单次偶发不提案。"""
    assert not should_propose(1, 0)  # 单样本偶发失败不污染评审队列
    assert should_propose(1, 1)  # 2 样本失败率 0.5 > 0.4 → 提案
    assert should_propose(2, 0)
    assert not should_propose(2, 5)  # 2/7 ≈ 0.286 且 N<3 → 不提案
    assert should_propose(3, 100)  # 累计失败 N≥3 → 提案（成功率再高也累计）
    assert not should_propose(2, 10)  # 2/12 ≈ 0.167 → 不提案
    assert PROPOSAL_MIN_FAILS == 3
    assert PROPOSAL_FAIL_RATE == 0.4


def test_draft_node_contract_schema_declaration():
    """契约草案 = schema 声明（非代码）：input/output SchemaSpec 数据。"""
    draft = draft_node_contract("fixer", consumes=["code", "tests"], produces=["patch"])
    assert draft["node_type"] == "fixer"
    assert draft["input_schema"]["name"] == "fixer.input"
    fields = draft["input_schema"]["fields"]
    assert [f["name"] for f in fields] == ["code", "tests"]
    assert all(f["required"] is True for f in fields)
    assert draft["output_schema"]["fields"][0]["name"] == "patch"
    # 去重保序
    draft2 = draft_node_contract("x", consumes=["a", "a", "b"])
    assert [f["name"] for f in draft2["input_schema"]["fields"]] == ["a", "b"]


async def test_node_proposal_hook_records_drafts():
    """提案钩子：历史失败达到阈值才登记提案（契约草案，非代码）。"""
    store = EdgeEvidenceStore()
    sink_calls: list[dict] = []
    hook = NodeProposalSettleHook(store, proposal_sink=sink_calls.append)
    key = EdgeKey(src_type="start", dst_type="mid", context_domain="code")
    # 未达阈值：1 次失败 + 0 成功 → 不提案
    await hook.settle(_ctx(_steps(("start", TRACE_SUCCESS), ("mid", TRACE_FAILED)), reason="error"))
    assert hook.proposals == []
    # 累计第 3 次失败（N≥3）→ 提案
    await store.record_failure(key)
    await store.record_failure(key)
    await hook.settle(_ctx(_steps(("start", TRACE_SUCCESS), ("mid", TRACE_FAILED)), reason="error"))
    assert len(hook.proposals) == 1
    assert hook.proposals[0]["node_type"] == "mid"
    assert "input_schema" in hook.proposals[0]
    assert sink_calls == hook.proposals  # 回调与登记同源
    await store.close()


# ── 指纹缓存接口（fail-closed）──

class _FakeCache:
    def __init__(self):
        self.upserts: list[dict] = []

    async def upsert(self, fingerprint, **kw):
        self.upserts.append({"fingerprint": fingerprint, **kw})


class _FakeGate:
    def __init__(self, passed: bool = True):
        self.passed = passed

    async def evaluate(self, ctx):
        return self.passed


async def test_fingerprint_hook_fail_closed():
    """无闸门或无缓存 = fail-closed 不入缓存（高质量归纳前提不满足）。"""
    store = EdgeEvidenceStore()
    cache = _FakeCache()
    steps = _steps(
        ("start", TRACE_SUCCESS),
        ("mid", TRACE_SUCCESS),
        ("end", TRACE_SUCCESS),
    )
    no_gate = FingerprintSettleHook(cache=cache, store=store)
    await no_gate.settle(_ctx(steps))
    assert no_gate.attempts == [] and cache.upserts == []
    no_cache = FingerprintSettleHook(gate=_FakeGate(), store=store)
    await no_cache.settle(_ctx(steps))
    assert cache.upserts == []
    # 闸门拒绝 = 记录判定但不入库
    rejected = FingerprintSettleHook(cache=cache, gate=_FakeGate(False), store=store)
    await rejected.settle(_ctx(steps))
    assert len(rejected.attempts) == 1 and rejected.attempts[0]["gate_passed"] is False
    assert cache.upserts == []
    await store.close()


async def test_fingerprint_hook_upserts_when_gate_passes():
    """闸门通过 + 缓存注入 → upsert（指纹 = 图摘要，证据快照随附）。"""
    store = EdgeEvidenceStore()
    cache = _FakeCache()
    hook = FingerprintSettleHook(cache=cache, gate=_FakeGate(True), store=store)
    g = demo_linear_graph()
    await hook.settle(_ctx(_steps(("start", "success"), ("mid", "success")), graph=g))
    assert len(cache.upserts) == 1
    assert cache.upserts[0]["fingerprint"] == g.digest()
    assert cache.upserts[0]["gate_passed"] is True
    assert isinstance(cache.upserts[0]["evidence_snapshot"], list)
    # 失败 run 不入库
    await hook.settle(_ctx(_steps(("start", "success"), ("mid", "failed")), graph=g))
    assert len(cache.upserts) == 1
    await store.close()


# ── 失败审计 ──

async def test_failure_audit_append_only():
    """失败日志留痕审计：append-only 登记（含回调同源）。"""
    sink: list[dict] = []
    hook = FailureAuditSettleHook(sink=sink.append)
    await hook.settle(
        _ctx(
            _steps(("start", TRACE_SUCCESS), ("mid", TRACE_FAILED)),
            reason="error",
            error="节点执行失败",
        )
    )
    assert len(hook.records) == 1
    assert hook.records[0]["node"] == "mid"
    assert hook.records[0]["domain"] == "code"
    assert hook.records[0]["reason"] == "节点执行失败"
    assert sink == hook.records
    # 再次触发 = 追加不覆盖
    await hook.settle(
        _ctx(_steps(("start", TRACE_SUCCESS), ("end", TRACE_FAILED)), reason="error")
    )
    assert len(hook.records) == 2


# ── 注册体 ──

async def test_settle_hooks_run_and_isolation():
    """注册体按序触发；单钩子异常 = 记日志跳过，不阻断其余钩子。"""
    calls: list[str] = []

    class HookA:
        async def settle(self, ctx):
            calls.append("a")

    class HookB:
        async def settle(self, ctx):
            raise RuntimeError("钩子故障")

    class HookC:
        async def settle(self, ctx):
            calls.append("c")

    hooks = SettleHooks()
    hooks.register(HookA())
    hooks.register(HookB())
    hooks.register(HookC())
    errors = await hooks.run(_ctx(_steps(("start", TRACE_SUCCESS), ("mid", TRACE_SUCCESS))))
    assert calls == ["a", "c"]  # b 故障不阻断 c
    assert len(errors) == 1
    assert isinstance(errors[0], RuntimeError)


def test_settle_hooks_register_type_check():
    """注册类型校验：非协议实现显式拒绝。"""
    hooks = SettleHooks()
    with pytest.raises(TypeError):
        hooks.register("not-a-hook")  # type: ignore[arg-type]


# ── 引擎端到端（挂接形态验证）──

async def test_engine_end_to_end_success_run_records_edges():
    """端到端：成功 run → 沉淀钩子触发 → 全边 success+1。"""
    store = EdgeEvidenceStore()
    hooks = SettleHooks()
    hooks.register(EdgeEvidenceSettleHook(store))
    engine = make_engine(demo_linear_graph(), settle=hooks, domain="code")
    result = await engine.ainvoke({"want_yes": True}, thread_id="t-e2e-1")
    assert result.reason == "reply"
    e1 = await store.get(EdgeKey(src_type="start", dst_type="mid", context_domain="code"))
    e2 = await store.get(EdgeKey(src_type="mid", dst_type="end", context_domain="code"))
    assert e1 is not None and e1.success_count == 1
    assert e2 is not None and e2.success_count == 1
    await store.close()


async def test_engine_end_to_end_failure_run_records_only_failed_incoming():
    """端到端：失败 run → 只记失败结点入边 fail+1。"""
    store = EdgeEvidenceStore()
    hooks = SettleHooks()
    hooks.register(EdgeEvidenceSettleHook(store))

    async def boom(ctx):
        raise RuntimeError("炸了")

    g = Graph(name="fail", entry="start")
    g.add_node("start", lambda ctx: {"ok": True})
    g.add_node("boom", boom)
    g.add_node("end", lambda ctx: {"ok": True})
    g.add_edge("start", "boom")
    g.add_edge("boom", "end")
    g.add_exit("end")

    engine = make_engine(g, settle=hooks, domain="code")
    result = await engine.ainvoke({}, thread_id="t-e2e-2")
    assert result.reason == "error"
    failed = await store.get(EdgeKey(src_type="start", dst_type="boom", context_domain="code"))
    assert failed is not None and failed.fail_count == 2 and failed.success_count == 0
    # 上游 start 无入边；boom→end 未执行（终止于失败）→ 无记录
    assert await store.evidence_count("code") == 1
    await store.close()


async def test_engine_no_settle_zero_impact():
    """未注入沉淀钩子 = 关闭：run 行为零变化（默认形态）。"""
    engine = make_engine(demo_linear_graph(), domain="code")
    result = await engine.ainvoke({}, thread_id="t-none")
    assert result.reason == "reply"
    assert result.state.get("count") == 3


async def test_engine_account_usage_tokens():
    """usage 帧 → 结点执行边界 token 计账（纯算法归集）。"""

    async def spendy(ctx):
        ctx.account_usage({"total_tokens": 120})
        ctx.account_usage({"prompt_tokens": 30, "completion_tokens": 20})
        ctx.account_usage({"total_tokens": 0})  # 零值忽略
        return {"spent": True}

    g = Graph(name="cost", entry="spendy")
    g.add_node("spendy", spendy)
    g.add_exit("spendy")

    store = EdgeEvidenceStore()
    hooks = SettleHooks()
    hooks.register(EdgeEvidenceSettleHook(store))
    engine = make_engine(g, settle=hooks, domain="code")
    await engine.ainvoke({}, thread_id="t-cost")
    # 无入边（入口结点）→ 无边证据；但成本账应已归集
    assert engine._node_tokens.get(((), "spendy"), 0) == 170
    await store.close()


async def test_engine_loop_trace_counts_repeated_edges():
    """循环回路：重复遍历的边按次数归集（每轮成功全边 +1）。"""
    store = EdgeEvidenceStore()
    hooks = SettleHooks()
    hooks.register(EdgeEvidenceSettleHook(store))
    from tests.conftest import demo_loop_graph

    engine = make_engine(demo_loop_graph(), settle=hooks, domain="code")
    result = await engine.ainvoke({}, thread_id="t-loop")
    assert result.reason == "reply"
    loop_back = await store.get(
        EdgeKey(src_type="loop", dst_type="loop", context_domain="code")
    )
    assert loop_back is not None and loop_back.success_count == 2  # count 1→2→3 两次回指
    await store.close()


async def test_engine_spawn_instance_trace_merges():
    """嵌套实例轨迹并入父引擎：实例内部边同样沉淀（跨层连续）。"""
    store = EdgeEvidenceStore()
    hooks = SettleHooks()
    hooks.register(EdgeEvidenceSettleHook(store))

    sub = Graph(name="subtask", entry="sub_start")
    sub.add_node("sub_start", lambda ctx: {"done": False})
    sub.add_node("sub_end", lambda ctx: {"done": True})
    sub.add_edge("sub_start", "sub_end")
    sub.add_exit("sub_end")

    async def router(ctx):
        ctx.spawn(sub, {"seed": 1})
        return {}

    g = Graph(name="parent", entry="entry")
    g.add_node("entry", lambda ctx: {"v": 0})
    g.add_node("router", router)
    g.add_edge("entry", "router")
    g.add_exit("router")

    engine = make_engine(g, settle=hooks, domain="code")
    result = await engine.ainvoke({}, thread_id="t-spawn")
    assert result.reason == "reply"
    parent_edge = await store.get(
        EdgeKey(src_type="entry", dst_type="router", context_domain="code")
    )
    assert parent_edge is not None and parent_edge.success_count == 1
    sub_edge = await store.get(
        EdgeKey(src_type="sub_start", dst_type="sub_end", context_domain="code")
    )
    assert sub_edge is not None and sub_edge.success_count == 1
    await store.close()


# ── 推荐先验自动晋升 + 策略边对抗复审（自动生长机制双通道触发）──

def test_recommended_prior_eligible_thresholds():
    """晋升证据判据：N≥30 且成功率≥0.9（与信任档推导同一组常数）。"""
    from ink_engine.core.settle import recommended_prior_eligible

    assert recommended_prior_eligible(30, 0) is True  # p̂=(31/32)=0.969 ≥0.9
    assert recommended_prior_eligible(29, 0) is False  # N=29 不足
    assert recommended_prior_eligible(30, 10) is False  # p̂ 不足
    assert recommended_prior_eligible(27, 3) is False  # p̂=28/32=0.875 低于 0.9
    assert recommended_prior_eligible(28, 2) is True  # p̂=29/32=0.906 ≥0.9


async def test_recommended_prior_hook_promotes_and_dedupes():
    """晋升钩子：路径全通 + 全边达线 + 闸门 + canary → 晋升登记 + 审计。"""
    from ink_engine.core.settle import RecommendedPriorSettleHook

    store = EdgeEvidenceStore()
    # 预置两条边的高强度证据（N=30 全成功）
    for src, dst in (("start", "mid"), ("mid", "end")):
        await store.put(
            EdgeEvidence(
                key=EdgeKey(src_type=src, dst_type=dst, context_domain="code"),
                success_count=30,
                fail_count=0,
                created_at=NOW,
                last_used_at=NOW,
            )
        )
    gate = _StubGate(verdict=True)
    records: list[dict] = []
    hook = RecommendedPriorSettleHook(
        store, gate=gate, canary_ok=lambda ctx: True, sink=records.append
    )
    ctx = _ctx(
        _steps(
            ("start", TRACE_SUCCESS),
            ("mid", TRACE_SUCCESS),
            ("end", TRACE_SUCCESS),
        )
    )
    await hook.settle(ctx)
    assert len(hook.promotions) == 1
    promotion = hook.promotions[0]
    assert promotion["type"] == "recommended_prior_promotion"
    assert promotion["domain"] == "code"
    assert promotion["gate_passed"] is True
    assert len(promotion["edges"]) == 2
    assert records == [promotion]
    # 重复触发去重（同一路径不重复登记）
    await hook.settle(ctx)
    assert len(hook.promotions) == 1
    await store.close()


async def test_recommended_prior_hook_fail_closed_without_gate():
    """晋升钩子 fail-closed：无闸门注入 = 不晋升（高质量归纳前提不满足）。"""
    from ink_engine.core.settle import RecommendedPriorSettleHook

    store = EdgeEvidenceStore()
    for src, dst in (("start", "mid"), ("mid", "end")):
        await store.put(
            EdgeEvidence(
                key=EdgeKey(src_type=src, dst_type=dst, context_domain="code"),
                success_count=30,
                fail_count=0,
                created_at=NOW,
                last_used_at=NOW,
            )
        )
    hook = RecommendedPriorSettleHook(store, gate=None)
    ctx = _ctx(
        _steps(
            ("start", TRACE_SUCCESS),
            ("mid", TRACE_SUCCESS),
            ("end", TRACE_SUCCESS),
        )
    )
    await hook.settle(ctx)
    assert hook.promotions == []
    # 闸门拒绝同样不晋升
    gated = RecommendedPriorSettleHook(
        store, gate=_StubGate(verdict=False), canary_ok=lambda ctx: True
    )
    await gated.settle(ctx)
    assert gated.promotions == []
    await store.close()


async def test_recommended_prior_hook_rejects_weak_edges():
    """晋升钩子：任一遍历边未达晋升线 = 整条路径不晋升。"""
    from ink_engine.core.settle import RecommendedPriorSettleHook

    store = EdgeEvidenceStore()
    await store.put(
        EdgeEvidence(
            key=EdgeKey(src_type="start", dst_type="mid", context_domain="code"),
            success_count=30,
            fail_count=0,
            created_at=NOW,
            last_used_at=NOW,
        )
    )
    await store.put(
        EdgeEvidence(
            key=EdgeKey(src_type="mid", dst_type="end", context_domain="code"),
            success_count=3,
            fail_count=2,  # N=5 未达晋升线
            created_at=NOW,
            last_used_at=NOW,
        )
    )
    hook = RecommendedPriorSettleHook(store, gate=_StubGate(verdict=True))
    ctx = _ctx(
        _steps(
            ("start", TRACE_SUCCESS),
            ("mid", TRACE_SUCCESS),
            ("end", TRACE_SUCCESS),
        )
    )
    await hook.settle(ctx)
    assert hook.promotions == []
    await store.close()


def test_policy_edge_needs_review_predicates():
    """策略边复审判据：失败累计≥5 或域均值反超承诺（样本不足只按失败判）。"""
    from ink_engine.core.edge_evidence import EdgeEvidence, EdgeKey
    from ink_engine.core.settle import policy_edge_needs_review

    def edge(fail: int, success: int = 0, policy: bool = True) -> EdgeEvidence:
        return EdgeEvidence(
            key=EdgeKey(src_type="a", dst_type="b", context_domain="code"),
            success_count=success,
            fail_count=fail,
            policy=policy,
            created_at=NOW,
        )

    assert policy_edge_needs_review(edge(5), domain_average_p=None) == (
        True,
        "策略边失败累计 5 次 ≥ 阈值 5（对抗证据触发复审）",
    )
    assert policy_edge_needs_review(edge(4), domain_average_p=None)[0] is False
    # 域均值反超：策略边 p̂=9/10=0.833 < 域均值 0.9
    overtake = policy_edge_needs_review(edge(1, 9), domain_average_p=0.9)
    assert overtake[0] is True
    assert "域均值反超" in overtake[1]
    # 非策略边不触发（降级后不再重复提请）
    assert policy_edge_needs_review(edge(99, policy=False), domain_average_p=None)[0] is False


async def test_policy_edge_review_hook_downgrades():
    """复审钩子：失败累计超阈值 → 提请 L2 复审 + 复审前降级普通统计边。"""
    from ink_engine.core.settle import PolicyEdgeReviewSettleHook

    store = EdgeEvidenceStore()
    await store.put(
        EdgeEvidence(
            key=EdgeKey(src_type="start", dst_type="mid", context_domain="code"),
            success_count=30,
            fail_count=0,
            policy=True,
            created_at=NOW,
            last_used_at=NOW,
        )
    )
    await store.put(
        EdgeEvidence(
            key=EdgeKey(src_type="mid", dst_type="end", context_domain="code"),
            success_count=0,
            fail_count=6,  # 超阈值 5
            policy=True,
            created_at=NOW,
            last_used_at=NOW,
        )
    )
    records: list[dict] = []
    hook = PolicyEdgeReviewSettleHook(store, sink=records.append)
    ctx = _ctx(
        _steps(
            ("start", TRACE_SUCCESS),
            ("mid", TRACE_SUCCESS),
            ("end", TRACE_SUCCESS),
        )
    )
    await hook.settle(ctx)
    assert len(hook.reviews) == 1
    review = hook.reviews[0]
    assert review["type"] == "policy_edge_review_audit"
    assert review["review_tier"] == "l2"
    assert review["action"] == "downgraded_to_statistical"
    assert (review["src_type"], review["dst_type"]) == ("mid", "end")
    # 降级已落库：policy=False（不再 τ=1.0/豁免衰减）
    downgraded = await store.get(
        EdgeKey(src_type="mid", dst_type="end", context_domain="code")
    )
    assert downgraded is not None and downgraded.policy is False
    assert records == [review]
    # 未超阈值的策略边保持原状
    kept = await store.get(
        EdgeKey(src_type="start", dst_type="mid", context_domain="code")
    )
    assert kept is not None and kept.policy is True
    # 重复触发去重（降级后不再重复提请）
    await hook.settle(ctx)
    assert len(hook.reviews) == 1
    await store.close()


async def test_policy_edge_review_hook_domain_mean_overtake():
    """复审钩子：域证据均值反超策略边承诺 → 复审 + 降级。"""
    from ink_engine.core.settle import PolicyEdgeReviewSettleHook

    store = EdgeEvidenceStore()
    # 策略边成功率 0.5（1 成 1 败）
    await store.put(
        EdgeEvidence(
            key=EdgeKey(src_type="start", dst_type="mid", context_domain="code"),
            success_count=1,
            fail_count=1,
            policy=True,
            created_at=NOW,
            last_used_at=NOW,
        )
    )
    # 两条非策略边高成功率（域均值 = 0.92）
    for idx in range(2):
        await store.put(
            EdgeEvidence(
                key=EdgeKey(
                    src_type=f"s{idx}", dst_type=f"t{idx}", context_domain="code"
                ),
                success_count=30,
                fail_count=0,
                policy=False,
                created_at=NOW,
                last_used_at=NOW,
            )
        )
    hook = PolicyEdgeReviewSettleHook(store)
    ctx = _ctx(
        _steps(
            ("start", TRACE_SUCCESS),
            ("mid", TRACE_SUCCESS),
        )
    )
    await hook.settle(ctx)
    assert len(hook.reviews) == 1
    assert "域均值反超" in hook.reviews[0]["reason"]
    downgraded = await store.get(
        EdgeKey(src_type="start", dst_type="mid", context_domain="code")
    )
    assert downgraded is not None and downgraded.policy is False
    await store.close()


async def test_policy_edge_review_hook_incremental_untouched_not_scanned():
    """ENG1-9 增量面：未触达的策略边不评估（不做每 run 全量扫描）。

    旧实现每 run 全量 list_edges + O(N) 遍历；现只评估本 run 触达的
    策略边——未触达边即使失败累计超阈值也不触发（对抗证据来自被触达
    边的失败累积），触达后才按判据评估。
    """
    from ink_engine.core.settle import PolicyEdgeReviewSettleHook

    store = EdgeEvidenceStore()
    # 两条策略边：一条本 run 触达（健康），一条未触达（失败累计超阈值）
    await store.put(
        EdgeEvidence(
            key=EdgeKey(src_type="start", dst_type="mid", context_domain="code"),
            success_count=10,
            fail_count=0,
            policy=True,
            created_at=NOW,
            last_used_at=NOW,
        )
    )
    await store.put(
        EdgeEvidence(
            key=EdgeKey(src_type="ghost", dst_type="never", context_domain="code"),
            success_count=0,
            fail_count=99,
            policy=True,
            created_at=NOW,
            last_used_at=NOW,
        )
    )
    hook = PolicyEdgeReviewSettleHook(store)
    ctx = _ctx(
        _steps(
            ("start", TRACE_SUCCESS),
            ("mid", TRACE_SUCCESS),
        )
    )
    await hook.settle(ctx)
    assert hook.reviews == []  # 未触达的失败策略边不被扫描到
    # 触达该边后判据生效（失败累计 ≥5 → 复审 + 降级）
    ghost_graph = Graph(name="g2", entry="ghost")
    ghost_graph.add_node("ghost", lambda ctx: {})
    ghost_graph.add_node("never", lambda ctx: {})
    ghost_graph.add_edge("ghost", "never")
    ghost_graph.add_exit("never")
    ctx2 = _ctx(
        _steps(
            ("ghost", TRACE_SUCCESS),
            ("never", TRACE_SUCCESS),
        ),
        graph=ghost_graph,
    )
    await hook.settle(ctx2)
    assert len(hook.reviews) == 1
    assert (hook.reviews[0]["src_type"], hook.reviews[0]["dst_type"]) == (
        "ghost",
        "never",
    )
    await store.close()


async def test_policy_edge_review_hook_domain_average_rate_limited():
    """ENG1-9 限频面：域证据均值带缓存（scan_interval 内不重复全量扫描）。

    非策略边样本不变时，多次触达评估复用缓存的域均值（不每 run 全量
    list_edges 重算）；到达 scan_interval 后重算一次。
    """
    from ink_engine.core.settle import PolicyEdgeReviewSettleHook

    store = EdgeEvidenceStore()
    # 策略边成功率高于域均值（不触发复审，但每次触达都评估）
    await store.put(
        EdgeEvidence(
            key=EdgeKey(src_type="start", dst_type="mid", context_domain="code"),
            success_count=40,
            fail_count=0,
            policy=True,
            created_at=NOW,
            last_used_at=NOW,
        )
    )
    for idx in range(2):
        await store.put(
            EdgeEvidence(
                key=EdgeKey(
                    src_type=f"s{idx}", dst_type=f"t{idx}", context_domain="code"
                ),
                success_count=30,
                fail_count=0,
                policy=False,
                created_at=NOW,
                last_used_at=NOW,
            )
        )
    hook = PolicyEdgeReviewSettleHook(store, scan_interval=3)
    ctx = _ctx(
        _steps(
            ("start", TRACE_SUCCESS),
            ("mid", TRACE_SUCCESS),
        )
    )
    await hook.settle(ctx)  # 首次：计算并缓存域均值
    assert hook.reviews == []  # 策略边未反超，不复审
    assert hook._runs_since_refresh["code"] == 1
    await hook.settle(ctx)  # 缓存复用（runs 递增，不重算）
    assert hook.reviews == []
    assert hook._runs_since_refresh["code"] == 2
    await hook.settle(ctx)  # 缓存复用
    assert hook._runs_since_refresh["code"] == 3
    await hook.settle(ctx)  # 达 scan_interval：重算一次（runs 复位 1）
    assert hook._runs_since_refresh["code"] == 1
    await store.close()


async def test_recommended_prior_hook_dedup_persists_across_restart():
    """ENG1-18：晋升去重键可持久化恢复（重启后不再重复登记）。

    旧实现 _promoted 在进程内存，重启丢失 → 同一路径重复晋升登记
    （审计重复）；persisted_signatures 装配期恢复 + 记录携带 signature
    键（宿主幂等 upsert 依据）。
    """
    from ink_engine.core.settle import RecommendedPriorSettleHook

    store = EdgeEvidenceStore()
    for src, dst in (("start", "mid"), ("mid", "end")):
        await store.put(
            EdgeEvidence(
                key=EdgeKey(src_type=src, dst_type=dst, context_domain="code"),
                success_count=30,
                fail_count=0,
                created_at=NOW,
                last_used_at=NOW,
            )
        )
    persisted: set[tuple[str, ...]] = set()
    recorded: list[tuple[str, ...]] = []

    def persist(signature: tuple[str, ...]) -> None:
        persisted.add(signature)
        recorded.append(signature)

    hook = RecommendedPriorSettleHook(
        store,
        gate=_StubGate(verdict=True),
        canary_ok=lambda ctx: True,
        on_promoted=persist,
    )
    ctx = _ctx(
        _steps(
            ("start", TRACE_SUCCESS),
            ("mid", TRACE_SUCCESS),
            ("end", TRACE_SUCCESS),
        )
    )
    await hook.settle(ctx)
    assert len(hook.promotions) == 1
    assert len(persisted) == 1 and len(recorded) == 1
    signature = next(iter(persisted))
    assert hook.promotions[0]["signature"] == list(signature)  # 记录携带去重键
    # 「重启」= 新实例从持久化恢复：同路径不再重复登记
    restarted = RecommendedPriorSettleHook(
        store,
        gate=_StubGate(verdict=True),
        canary_ok=lambda ctx: True,
        persisted_signatures=persisted,
        on_promoted=persist,
    )
    await restarted.settle(ctx)
    assert restarted.promotions == []
    assert len(recorded) == 1  # 恢复后不再触发持久化回调
    # 无恢复（旧行为面）：仍会重复登记——持久化是宿主装配选择
    fresh = RecommendedPriorSettleHook(
        store, gate=_StubGate(verdict=True), canary_ok=lambda ctx: True
    )
    await fresh.settle(ctx)
    assert len(fresh.promotions) == 1
    await store.close()

# ── 池治理登记钩子 ──

def test_pool_governance_settle_hook_registerable():
    """PoolGovernanceSettleHook 可注册进 SettleHooks 链。"""
    from ink_engine.core.pool_governance import PoolGovernance

    gov = PoolGovernance()
    hook = PoolGovernanceSettleHook(gov)
    hooks = SettleHooks()
    hooks.register(hook)
    assert len(hooks.hooks) == 1
    assert hooks.hooks[0] is hook


@pytest.mark.asyncio
async def test_pool_governance_settle_hook_settle_is_noop():
    """PoolGovernanceSettleHook.settle 不报错（占位钩子）。"""
    import time

    from ink_engine.core.pool_governance import PoolGovernance

    gov = PoolGovernance()
    hook = PoolGovernanceSettleHook(gov)
    ctx = SettleContext(
        thread_id="t1",
        round_id="r1",
        trace_id="tr1",
        domain="default",
        steps=(TraceStep(graph_path=(), node="n", status=TRACE_SUCCESS),),
        node_tokens={},
        graphs={},
        result=RunResult(state={}, reason="reply"),
    )
    await hook.settle(ctx)
    # 钩子不执行判定，只占位
    assert len(gov.log) == 0
