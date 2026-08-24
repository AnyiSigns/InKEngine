"""多径执行 + 汇流裁决（Junction）单测：触发/预算/裁决三断言/归因/中断。

覆盖（按任务矩阵）：
- 单元：成本核算公式断言（B×(1+(k-1)ρ)）、预算预检 fail-closed
  （无维度放行/查询故障拒绝/余量不足拒绝）、触发判据边界（N=5 与
  分差 0.15 等值不触发——判据复用 edge_evidence，此处钉边界断言）；
- 汇流裁决三断言：同构择优（注入 QualityGate 分胜负）、无闸门降级链
  （信任档 → 成本）、异构合成（LLM 合成源 stub 注入）；
- 归因规则：成功全边 +1 / 失败只记失败结点入边（不毒化上游）；
- 集成（stub 行为结点）：组装 → 多径 → 汇流 → 沉淀闭环；证据落库断言；
- 中断语义：分支内挂起 → 调用方挂起卡 + checkpoint 保留 → 注入重入续跑；
  取消（abort 语义）后子链保留、重跑收口；
- 硬规则：预算不足不触发（降级单径 + 审计注明）、k=3 高风险边界
  （max_safety_tier≥1 放行）、审计事件落留痕、flag=False 零生效；
- Junction 节点类型：注册表内建注册/执行（数据形态支流清单）。
"""
from __future__ import annotations

import asyncio
from typing import Any

import pytest
from conftest import demo_linear_graph, make_engine

from ink_engine.core.budget import BudgetPolicy, BudgetRemaining
from ink_engine.core.contracts import (
    BOOT_KEY_MULTIPATH_ENABLED,
    PathAssemblyConfig,
    PathAssemblyFlags,
)
from ink_engine.core.edge_evidence import (
    EdgeEvidence,
    EdgeEvidenceStore,
    EdgeKey,
    multi_path_trigger,
)
from ink_engine.core.event_types import EVENT_AUDIT_JUNCTION
from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.graph import Graph
from ink_engine.core.interrupt import InterruptSignal
from ink_engine.core.multipath import (
    DEFAULT_MULTIPATH_K,
    JUNCTION_BRANCHES_STATE_KEY,
    JUNCTION_TYPE,
    MODE_NONE,
    MODE_QUALITY_GATE,
    MODE_SYNTHETIC,
    MODE_TIER,
    UPDATE_FAIL,
    UPDATE_SUCCESS,
    BudgetView,
    ChainEvidence,
    JunctionBranch,
    JunctionEvidenceUpdate,
    JunctionExecutor,
    MultiPathConfig,
    MultipathRunner,
    apply_junction_updates,
    branches_are_homogeneous,
    chain_evidence,
    check_multipath_budget,
    junction_verdict,
    multipath_branch_thread,
    multipath_budget_required,
    multipath_config_from_flags,
    plan_junction_updates,
    register_junction_node,
)
from ink_engine.core.path_assembler import (
    AssemblyRequest,
    PathAssembler,
)
from ink_engine.core.registry import GraphRegistries, NodeTypeRegistry
from ink_engine.core.schema_validator import (
    FIELD_STRING,
    SchemaField,
    SchemaSpec,
)

DUMMY_NOW = 1_800_000_000.0
DOMAIN = "code"
ENTRY = ("user_query",)

# 多径测试池：3 条平行答案支流（同构：收尾字段均为 answer；确定性序）
MP_POOL: tuple[tuple[str, tuple[str, ...], tuple[str, ...]], ...] = (
    ("intent_parse", (), ("intent", "domains")),
    ("domain_router", ("intent",), ("spec", "query")),
    ("web_search", ("query",), ("search_results",)),
    ("answer_direct", ("search_results",), ("answer",)),
    ("answer_direct_2", ("search_results",), ("answer",)),
    ("answer_direct_3", ("search_results",), ("answer",)),
)

# 结点行为（执行期产出固定的字段增量；供裁决/闸门辨别支流身份）
DEFAULT_VALUES: dict[str, dict] = {
    "intent_parse": {"intent": "ip", "domains": "d"},
    "domain_router": {"spec": "spec", "query": "q"},
    "web_search": {"search_results": "sr"},
    "answer_direct": {"answer": "A"},
    "answer_direct_2": {"answer": "B"},
    "answer_direct_3": {"answer": "C"},
}


def _field(name: str) -> SchemaField:
    return SchemaField(name=name, required=True, kind=FIELD_STRING)


def _spec(name: str, *names: str) -> SchemaSpec:
    return SchemaSpec(name=name, fields=tuple(_field(n) for n in names))


def _contract(inputs: tuple[str, ...], outputs: tuple[str, ...]):
    from ink_engine.core.contracts import NodeContract

    return NodeContract(
        input_schema=_spec("in", *inputs),
        output_schema=_spec("out", *outputs),
        safety_tier=0,
        version=1,
    )


def make_behavior_registry(
    pool_specs: tuple[tuple[str, tuple[str, ...], tuple[str, ...]], ...] = MP_POOL,
    *,
    values: dict[str, dict] | None = None,
    interrupt_types: set[str] | None = None,
    slow_types: set[str] | None = None,
    fail_types: set[str] | None = None,
) -> NodeTypeRegistry:
    """行为注册表：结点执行产出固定值（供裁决/闸门断言），可插中断/慢/失败结点。"""
    registry = NodeTypeRegistry()
    vals = dict(DEFAULT_VALUES)
    if values:
        vals.update(values)
    interrupts = interrupt_types or set()
    slows = slow_types or set()
    fails = fail_types or set()

    def factory(config, *_args, _t=None):
        async def node(ctx):
            if _t in fails:
                raise RuntimeError(f"结点 {_t} 执行失败（测试注入）")
            if _t in interrupts:
                value = await ctx.interrupt("test.gate", {"tier": _t, "q": "?"})
                return {"intent": value, "domains": "d"}
            if _t in slows:
                await asyncio.sleep(0.15)
            return dict(vals.get(_t, {})) if _t else {}

        return node

    for type_name, inputs, outputs in pool_specs:
        registry.register(
            type_name,
            lambda config, _t=type_name: factory(config, _t=_t),
            contract=_contract(inputs, outputs),
        )
    return registry


def make_request(top_k: int = 3, *, tier: int = 0, domain: str = DOMAIN) -> AssemblyRequest:
    return AssemblyRequest(
        goal_schema=_spec("goal", "answer"),
        entry_fields=ENTRY,
        domain=domain,
        max_safety_tier=tier,
        top_k=top_k,
    )


async def make_candidates(
    registry: NodeTypeRegistry,
    store: EdgeEvidenceStore | None,
    *,
    top_k: int = 3,
    tier: int = 0,
):
    assembler = PathAssembler(
        registry=registry, evidence_store=store, config=PathAssemblyConfig(enabled=True)
    )
    result = await assembler.assemble(make_request(top_k=top_k, tier=tier))
    assert not result.is_empty, "测试池目标未解出（构造问题）"
    return result.candidates


def make_parent_engine(registry: NodeTypeRegistry, storage, transports):
    engine = make_engine(
        demo_linear_graph(),
        storage=storage,
        transports=transports,
        registries=GraphRegistries(nodes=registry),
    )
    return engine


def make_runner(engine, *, store=None, config=None, sink=None):
    return MultipathRunner(
        engine,
        evidence_store=store,
        config=config or MultiPathConfig(enabled=True),
        sink=sink,
        now=DUMMY_NOW,
    )


class StubGate:
    """质量闸门 stub（judge 按产物内容判定；记录调用）。"""

    def __init__(self, predicate):
        self._predicate = predicate
        self.calls: list[tuple[str, dict]] = []

    def judge(self, domain: str, artifact: dict) -> bool:
        self.calls.append((domain, dict(artifact)))
        return bool(self._predicate(dict(artifact)))


class StubSynth:
    """异构合成源 stub（返回固定合成产物；记录上下文）。"""

    def __init__(self, selection: dict | None = None):
        self.selection = selection if selection is not None else {"answer": "synth"}
        self.calls = []

    async def synthesize(self, context):
        self.calls.append(context)
        return self.selection


class StubBudgetPolicy(BudgetPolicy):
    """预算策略 stub（实现 remaining 只读查询 + 恒定余量）。"""

    def __init__(self, remaining: float, unavailable: bool = False):
        self.remaining = remaining
        self.unavailable = unavailable

    async def check(self, ctx) -> None:
        return None

    async def remaining(self, ctx) -> BudgetRemaining:
        return BudgetRemaining(
            policy="tokens",
            limit=1000.0,
            used=999.0 - self.remaining,
            remaining=self.remaining,
            unavailable=self.unavailable,
        )


def _branch(
    index: int,
    *,
    overlay: dict,
    terminal_fields: tuple[str, ...] = ("answer",),
    evidence: ChainEvidence | None = None,
    edges=None,
) -> JunctionBranch:
    from ink_engine.core.multipath import EdgeRef

    refs = edges or (
        EdgeRef("web_search", f"answer_direct_{index}", "1", "1")
        if index else EdgeRef("web_search", "answer_direct", "1", "1"),
    )
    return JunctionBranch(
        index=index,
        chain=("intent_parse", "domain_router", "web_search", f"t{index}"),
        overlay=overlay,
        terminal_fields=terminal_fields,
        edge_refs=(refs,) if not isinstance(refs, tuple) else refs,
        evidence=evidence,
    )


# ── 单元：成本核算公式 + 配置校验 + 预算预检 ──────────────────────

def test_rho_cost_formula():
    """ρ 成本核算断言：B×(1+(k-1)×ρ)；k=1 恒等于 B。"""
    assert multipath_budget_required(100.0, 1, rho=0.3) == pytest.approx(100.0)
    assert multipath_budget_required(100.0, 2, rho=0.3) == pytest.approx(130.0)
    assert multipath_budget_required(100.0, 3, rho=0.3) == pytest.approx(160.0)
    # ρ 上界（无缓存）与下界（前缀命中理想情形）
    assert multipath_budget_required(100.0, 3, rho=1.0) == pytest.approx(300.0)
    assert multipath_budget_required(100.0, 2, rho=0.2) == pytest.approx(120.0)


def test_config_validation():
    """配置校验：ρ 越界/径数非法显式拒绝（命名精确无魔法数字）。"""
    MultiPathConfig(enabled=True)  # 默认合法
    with pytest.raises(GraphDefinitionError):
        MultiPathConfig(shared_rho=0.1)
    with pytest.raises(GraphDefinitionError):
        MultiPathConfig(shared_rho=1.5)
    with pytest.raises(GraphDefinitionError):
        MultiPathConfig(default_k=0)
    with pytest.raises(GraphDefinitionError):
        MultiPathConfig(default_k=3, max_k=2)
    cfg = MultiPathConfig.from_dict(MultiPathConfig(enabled=True).to_dict())
    assert cfg.enabled is True and cfg.default_k == DEFAULT_MULTIPATH_K


def test_budget_precheck_fail_closed():
    """预算预检 fail-closed：无维度放行；查询故障拒绝；余量不足拒绝。"""
    ok, note = check_multipath_budget((), 100.0, 2, rho=0.3)
    assert ok and "未启用预算语义" in note
    ok, _ = check_multipath_budget(
        (BudgetRemaining("tokens", 1000, 999 - 500, 500),), 100.0, 2, rho=0.3
    )
    assert ok
    ok, note = check_multipath_budget(
        (BudgetRemaining("tokens", 1000, 0, 100.0),), 100.0, 2, rho=0.3
    )
    assert not ok and "预算预检拒绝" in note
    ok, note = check_multipath_budget(
        (BudgetRemaining("tokens", 1000, 0, 0, unavailable=True),), 100.0, 2
    )
    assert not ok and "不可确定" in note


def test_multipath_trigger_gap_exact_boundary():
    """触发判据边界：N=5 时按真实分差判定（<0.15 触发，≥0.15 不触发）。"""
    from ink_engine.core.edge_evidence import edge_score

    def candidate(success: int, fail: int):
        return EdgeEvidence(
            key=EdgeKey("web_search", "answer_direct", context_domain=DOMAIN),
            success_count=success,
            fail_count=fail,
            avg_cost=0.0,
            last_used_at=DUMMY_NOW,
            created_at=DUMMY_NOW,
        )

    def gap_of(a, b):
        return abs(
            edge_score(a, now=DUMMY_NOW).score - edge_score(b, now=DUMMY_NOW).score
        )

    # N=5 双侧：分差小（方差高） → 触发；分差大（证据分化） → 不触发
    close_low = candidate(5, 0)
    close_high = candidate(1, 4)
    assert gap_of(close_low, close_high) < 0.15
    assert multi_path_trigger(close_low, close_high, now=DUMMY_NOW)
    far_low = candidate(0, 5)
    assert gap_of(close_low, far_low) >= 0.15
    assert not multi_path_trigger(close_low, far_low, now=DUMMY_NOW)


# ── 单元：汇流裁决三断言 ──────────────────────────────────────────

def test_junction_homogeneous_and_heterogeneous_detection():
    """同构判定：收尾字段集一致 = 同构；不一致 = 异构。"""
    same = [
        _branch(i, overlay={"answer": "x"}, terminal_fields=("answer",))
        for i in range(2)
    ]
    assert branches_are_homogeneous(same)
    diff = [
        _branch(0, overlay={"answer": "x"}, terminal_fields=("answer",)),
        _branch(1, overlay={"doc": "y"}, terminal_fields=("doc",)),
    ]
    assert not branches_are_homogeneous(diff)


async def test_junction_quality_gate_decides_winner():
    """同构择优（闸门过者胜）：过关支流胜出，理由/败者留痕。"""
    branches = [_branch(i, overlay={"answer": v}) for i, v in enumerate(("A", "B"))]
    gate = StubGate(lambda artifact: artifact.get("answer") == "B")
    verdict = await junction_verdict(
        branches, domain=DOMAIN, quality_gate=gate
    )
    assert verdict.mode == MODE_QUALITY_GATE
    assert verdict.winner == 1
    assert verdict.selection == {"answer": "B"}
    assert verdict.losers == (0,)
    assert len(gate.calls) == 2
    assert any("质量闸门过者胜" in r for r in verdict.reasons)


async def test_junction_no_gate_degrades_tier_then_cost():
    """无闸门降级链：信任档（证据均值推导）优先，再比成本。"""
    regular_expensive = ChainEvidence(
        edges=1, evidenced=1, success_total=8, fail_total=0, cost_total=100.0
    )
    observing_cheap = ChainEvidence(
        edges=1, evidenced=1, success_total=3, fail_total=2, cost_total=1.0
    )
    branches = [
        _branch(0, overlay={"answer": "A"}, evidence=regular_expensive),
        _branch(1, overlay={"answer": "B"}, evidence=observing_cheap),
    ]
    verdict = await junction_verdict(branches, domain=DOMAIN)
    assert verdict.mode == MODE_TIER
    assert verdict.winner == 0  # 信任档优先（常规 > 观察），成本不顶档
    # 同档比成本：常规档内部成本低者胜（确定性）
    tie = [
        _branch(
            0,
            overlay={"answer": "A"},
            evidence=ChainEvidence(
                edges=1, evidenced=1, success_total=9, fail_total=1,
                cost_total=900.0,
            ),
        ),
        _branch(
            1,
            overlay={"answer": "B"},
            evidence=ChainEvidence(
                edges=1, evidenced=1, success_total=9, fail_total=1,
                cost_total=1.0,
            ),
        ),
    ]
    verdict = await junction_verdict(tie, domain=DOMAIN)
    assert verdict.winner == 1
    assert any("比成本" in r for r in verdict.reasons)


async def test_junction_heterogeneous_synthesizes():
    """异构输出：LLM 合成（stub 源）；无源降级信任档。"""
    branches = [
        _branch(0, overlay={"answer": "A"}, terminal_fields=("answer",)),
        _branch(1, overlay={"doc": "D"}, terminal_fields=("doc",)),
    ]
    synth = StubSynth(selection={"answer": "merged", "doc": "merged"})
    verdict = await junction_verdict(
        branches, domain=DOMAIN, synth_provider=synth
    )
    assert verdict.mode == MODE_SYNTHETIC
    assert verdict.winner is None
    assert verdict.selection == {"answer": "merged", "doc": "merged"}
    assert len(synth.calls) == 1
    assert synth.calls[0].domain == DOMAIN
    # 无合成源 → 降级信任档（同信任档比成本 → 序号）
    verdict = await junction_verdict(branches, domain=DOMAIN)
    assert verdict.mode == MODE_TIER
    assert verdict.winner is not None
    assert any("未注入合成源" in r for r in verdict.reasons)


# ── 单元：归因规则（失败只记失败结点入边）─────────────────────────

async def test_attribution_failure_only_tail_failed_node_incoming_edge():
    """归因规则：候选链失败只记收尾结点入边；胜者全边成功。"""
    from ink_engine.core.multipath import EdgeRef

    winner = JunctionBranch(
        index=0,
        chain=("a", "b", "c"),
        overlay={"answer": "A"},
        terminal_fields=("answer",),
        edge_refs=(EdgeRef("a", "b", "1", "1"), EdgeRef("b", "c", "1", "1")),
    )
    loser = JunctionBranch(
        index=1,
        chain=("a", "b", "d"),
        overlay={"answer": "B"},
        terminal_fields=("answer",),
        edge_refs=(EdgeRef("a", "b", "1", "1"), EdgeRef("b", "d", "1", "1")),
    )
    verdict = await junction_verdict((winner, loser), domain=DOMAIN)
    assert verdict.winner == 0
    updates = plan_junction_updates(verdict, (winner, loser), domain=DOMAIN)
    kinds = {(u.key.src_type, u.key.dst_type, u.kind) for u in updates}
    # 胜者：全边成功（a→b 与 b→c 各 +1）
    assert ("a", "b", UPDATE_SUCCESS) in kinds
    assert ("b", "c", UPDATE_SUCCESS) in kinds
    # 败者：只记失败结点入边（b→d 失败 +1），上游边 a→b 无失败记录
    assert ("b", "d", UPDATE_FAIL) in kinds
    assert not any(u.kind == UPDATE_FAIL and u.key.src_type == "a" for u in updates)
    assert len([u for u in updates if u.kind == UPDATE_FAIL]) == 1


async def test_apply_junction_updates_roundtrip():
    """证据更新落库：success/fail 各自归集（可断言计数）。"""
    store = EdgeEvidenceStore(":memory:")
    updates = (
        JunctionEvidenceUpdate(
            EdgeKey("a", "b", context_domain=DOMAIN), UPDATE_SUCCESS
        ),
        JunctionEvidenceUpdate(
            EdgeKey("b", "c", context_domain=DOMAIN), UPDATE_FAIL
        ),
    )
    applied = await apply_junction_updates(store, updates, now=DUMMY_NOW)
    assert applied == 2
    row = await store.get(EdgeKey("a", "b", context_domain=DOMAIN))
    assert row is not None and row.success_count == 1 and row.fail_count == 0
    row = await store.get(EdgeKey("b", "c", context_domain=DOMAIN))
    assert row is not None and row.fail_count == 1
    await store.close()


# ── 集成：组装 → 多径 → 汇流 → 沉淀闭环 ───────────────────────────

async def test_integration_assemble_multipath_junction_settle(memory_storage):
    """集成闭环：组装候选 → 多径执行 → 汇流裁决 → 证据沉淀 + 审计落留痕。"""
    registry = make_behavior_registry()
    store = EdgeEvidenceStore(":memory:")
    candidates = await make_candidates(registry, store, top_k=2)
    from ink_engine.core.events import CollectorTransport

    collector = CollectorTransport()
    engine = make_parent_engine(registry, memory_storage, [collector])
    sink_records: list[dict[str, Any]] = []
    runner = make_runner(engine, store=store, sink=sink_records.append)
    result = await runner.run(
        make_request(top_k=2),
        candidates,
        entry_state={"user_query": "帮我回答"},
        thread_id="t-mp-1",
        round_id="r1",
        trace_id="trace-mp-1",
    )
    assert result.triggered is True
    assert result.k == 2
    assert result.verdict is not None
    assert result.verdict.mode == MODE_TIER  # 零证据 = 同档比成本（都 0）→ 序号
    assert result.verdict.winner == 0
    # 证据沉淀：胜者链全边 +1；败者只记收尾入边失败
    winner_edges = [
        ("intent_parse", "domain_router"),
        ("domain_router", "web_search"),
        ("web_search", "answer_direct"),
    ]
    for src, dst in winner_edges:
        row = await store.get(EdgeKey(src, dst, context_domain=DOMAIN))
        assert row is not None and row.success_count == 1, (src, dst)
        assert row.fail_count == 0, (src, dst)
    loser_tail = await store.get(
        EdgeKey("web_search", "answer_direct_2", context_domain=DOMAIN)
    )
    assert loser_tail is not None and loser_tail.fail_count == 1
    assert loser_tail.success_count == 0
    # 审计落留痕：junction 事件类型 + 胜者/败者/理由
    verdict_records = [
        r for r in sink_records if r.get("type") == EVENT_AUDIT_JUNCTION
    ]
    assert verdict_records, "汇流裁决审计留痕缺失"
    record = verdict_records[0]
    assert record["winner"] == 0
    assert record["losers"] == [1]
    assert record["mode"] == MODE_TIER
    assert record["reasons"]
    assert result.thread_ids == {
        0: multipath_branch_thread("t-mp-1", 0),
        1: multipath_branch_thread("t-mp-1", 1),
    }
    await store.close()


async def test_integration_quality_gate_winner(memory_storage):
    """集成：注入闸门 → 过者胜（winner 按闸门判定而非证据）。"""
    registry = make_behavior_registry()
    store = EdgeEvidenceStore(":memory:")
    candidates = await make_candidates(registry, store, top_k=2)
    engine = make_parent_engine(registry, memory_storage, [])
    runner = make_runner(engine, store=store)
    gate = StubGate(lambda artifact: artifact.get("answer") == "B")
    result = await runner.run(
        make_request(top_k=2),
        candidates,
        entry_state={"user_query": "q"},
        thread_id="t-mp-2",
        quality_gate=gate,
    )
    assert result.verdict is not None
    assert result.verdict.mode == MODE_QUALITY_GATE
    assert result.verdict.winner == 1
    assert len(gate.calls) == 2
    await store.close()


# ── 硬规则：预算不足不触发 / k=3 高风险边界 / 全败语义 ────────────

async def test_all_branches_fail_fallbacks(memory_storage):
    """全败语义：无合成源 → MODE_NONE（负样例只记收尾入边）；有源 → 合成信号。"""
    registry = make_behavior_registry(
        fail_types={"answer_direct", "answer_direct_2"}
    )
    store = EdgeEvidenceStore(":memory:")
    candidates = await make_candidates(registry, store, top_k=2)
    engine = make_parent_engine(registry, memory_storage, [])
    runner = make_runner(engine, store=store)
    result = await runner.run(
        make_request(top_k=2),
        candidates,
        entry_state={"user_query": "q"},
        thread_id="t-mp-fail",
    )
    assert result.triggered is True
    assert result.verdict is not None
    assert result.verdict.mode == MODE_NONE
    assert result.verdict.winner is None
    assert result.verdict.losers == (0, 1)
    # 负样例：两条支流收尾入边失败 +1（只记失败结点入边）
    tail_0 = await store.get(
        EdgeKey("web_search", "answer_direct", context_domain=DOMAIN)
    )
    tail_1 = await store.get(
        EdgeKey("web_search", "answer_direct_2", context_domain=DOMAIN)
    )
    assert tail_0 is not None and tail_0.fail_count == 1
    assert tail_1 is not None and tail_1.fail_count == 1
    upstream = await store.get(
        EdgeKey("domain_router", "web_search", context_domain=DOMAIN)
    )
    assert upstream is None  # 上游中性不记（无成败更新）
    # 注入合成源：全败 → 合成信号
    synth = StubSynth(selection={"answer": "merged"})
    result = await runner.run(
        make_request(top_k=2),
        candidates,
        entry_state={"user_query": "q"},
        thread_id="t-mp-fail",
        synth_provider=synth,
    )
    assert result.verdict is not None
    assert result.verdict.mode == MODE_SYNTHETIC
    assert result.verdict.selection == {"answer": "merged"}
    await store.close()


async def test_budget_insufficient_degrades_to_single_path(memory_storage):
    """硬规则：预算余量不足 → 不触发多径，降级单径执行 + 审计注明。"""
    registry = make_behavior_registry()
    store = EdgeEvidenceStore(":memory:")
    candidates = await make_candidates(registry, store, top_k=2)
    # 主候选链证据成本：确保基础成本非零（B = 链边 avg_cost 合计）
    from ink_engine.core.multipath import chain_edge_refs

    refs = chain_edge_refs(candidates[0])
    for ref in refs:
        await store.put(
            EdgeEvidence(
                key=ref.evidence_key(DOMAIN),
                success_count=10,
                fail_count=0,
                avg_cost=100.0,
                last_used_at=DUMMY_NOW,
                created_at=DUMMY_NOW,
            )
        )
    base = chain_evidence(candidates[0], await _evidence_map(store)).cost_estimate
    assert base > 0
    engine = make_parent_engine(registry, memory_storage, [])
    runner = make_runner(engine, store=store)
    result = await runner.run(
        make_request(top_k=2),
        candidates,
        entry_state={"user_query": "q"},
        thread_id="t-mp-3",
        budget_remaining=(
            BudgetRemaining("tokens", 1000, 999 - 50, 50.0),
        ),
    )
    assert result.triggered is False
    assert result.k == 1
    assert "预算预检拒绝" in (result.degraded_reason or "")
    assert result.budget_passed is False
    audit_run = [r for r in result.audit if "triggered" in r]
    assert audit_run and audit_run[0].get("budget_passed") is False
    # 单径仍执行：一条支流（主径）
    assert len(result.branches) == 1
    await store.close()


async def test_k3_gated_by_high_risk_tier(memory_storage):
    """硬规则：k=3 仅高风险（max_safety_tier≥1）放行；否则降为 2 并注明。"""
    registry = make_behavior_registry()
    store = EdgeEvidenceStore(":memory:")
    candidates = await make_candidates(registry, store, top_k=3)
    assert len(candidates) >= 3
    engine = make_parent_engine(registry, memory_storage, [])
    runner = make_runner(engine, store=store)
    low = await runner.run(
        make_request(top_k=3, tier=0),
        candidates,
        entry_state={"user_query": "q"},
        thread_id="t-mp-4",
        k=3,
    )
    assert low.k == 2
    assert "高风险" in (low.degraded_reason or "")
    high = await runner.run(
        make_request(top_k=3, tier=1),
        candidates,
        entry_state={"user_query": "q"},
        thread_id="t-mp-4",
        k=3,
    )
    assert high.k == 3
    assert high.triggered is True
    assert high.verdict is not None
    assert high.verdict.winner is not None
    await store.close()


# ── 中断语义：挂起重入 + checkpoint 保留 / 取消后可续 ─────────────

async def test_multipath_interrupt_suspend_and_resume(memory_storage):
    """中断语义：支流内挂起 → 提升为调用方挂起卡（checkpoint 保留）→
    注入重入后从子链尾续跑（已跑轨迹保留可回溯）。"""
    registry = make_behavior_registry(
        interrupt_types={"answer_direct"}
    )
    store = EdgeEvidenceStore(":memory:")
    candidates = await make_candidates(registry, store, top_k=2)
    engine = make_parent_engine(registry, memory_storage, [])
    runner = make_runner(engine, store=store)
    with pytest.raises(InterruptSignal):
        await runner.run(
            make_request(top_k=2),
            candidates,
            entry_state={"user_query": "q"},
            thread_id="t-mp-i",
            round_id="r1",
        )
    # 挂起卡保留：支流 0 链尾 = 中断 checkpoint（可回溯/可换选）
    last = await memory_storage.get_latest_checkpoint("t-mp-i:multipath:0")
    assert last is not None
    assert last.reason == "interrupted"
    assert last.interrupt is not None and last.interrupt.key == "test.gate"
    # 注入重入：从自身链尾续跑（中断结点重入消费注入值）
    result = await runner.run(
        make_request(top_k=2),
        candidates,
        entry_state={"user_query": "q"},
        thread_id="t-mp-i",
        round_id="r1",
        inject={"test.gate": "injected"},
    )
    assert result.triggered is True
    assert result.verdict is not None
    assert result.verdict.winner is not None
    # 重入后的产物含注入值（中断结点重跑完成）
    winner_branch = next(
        b for b in result.branches if b.index == result.verdict.winner
    )
    assert winner_branch.final_state.get("intent") == "injected"
    await store.close()


async def test_multipath_cancel_keeps_subchains_and_recovers(memory_storage):
    """中止语义：执行中取消（abort 同向）→ 子链 checkpoint 保留 →
    重跑从链尾/链头收口（不丢已跑轨迹）。"""
    registry = make_behavior_registry(slow_types={"domain_router"})
    store = EdgeEvidenceStore(":memory:")
    candidates = await make_candidates(registry, store, top_k=2)
    engine = make_parent_engine(registry, memory_storage, [])
    runner = make_runner(engine, store=store)
    task = asyncio.create_task(
        runner.run(
            make_request(top_k=2),
            candidates,
            entry_state={"user_query": "q"},
            thread_id="t-mp-c",
            round_id="r1",
        )
    )
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    last = await memory_storage.get_latest_checkpoint("t-mp-c:multipath:0")
    assert last is not None  # 子链已有 checkpoint（已跑轨迹保留）
    result = await runner.run(
        make_request(top_k=2),
        candidates,
        entry_state={"user_query": "q"},
        thread_id="t-mp-c",
        round_id="r1",
    )
    assert result.triggered is True
    assert result.verdict is not None
    await store.close()


# ── 硬规则：flag=False 零生效 / Junction 节点类型 / 装配接线 ─────

async def test_flag_disabled_zero_effect(memory_storage):
    """开关关闭零生效：不触发/不执行支流/不留审计；Junction 类型不存在。"""
    registry = make_behavior_registry()
    store = EdgeEvidenceStore(":memory:")
    candidates = await make_candidates(registry, store, top_k=2)
    engine = make_parent_engine(registry, memory_storage, [])
    records: list[dict] = []
    runner = MultipathRunner(
        engine,
        evidence_store=store,
        config=MultiPathConfig(),  # enabled=False（默认关）
        sink=records.append,
    )
    result = await runner.run(
        make_request(top_k=2),
        candidates,
        entry_state={"user_query": "q"},
        thread_id="t-mp-off",
    )
    assert result.triggered is False
    assert result.k == 0
    assert result.branches == ()
    assert result.audit == ()
    assert records == []
    assert not registry.has(JUNCTION_TYPE)  # 未装配 = 类型不存在（不参与执行）
    await store.close()


async def test_junction_node_type_registered_and_executes():
    """Junction 节点类型：注册表内建注册；数据形态支流清单可执行裁决。"""
    registry = make_behavior_registry()
    executor = JunctionExecutor(now=DUMMY_NOW)
    register_junction_node(registry, executor=executor)
    assert registry.has(JUNCTION_TYPE)
    with pytest.raises(GraphDefinitionError):
        register_junction_node(registry)  # 重复注册显式拒绝
    graph = Graph(name="junction-driver", entry="junction")
    graph.add_node_type("junction", JUNCTION_TYPE, config={})
    graph.add_exit("junction")
    entry_state = {
        JUNCTION_BRANCHES_STATE_KEY: [
            _branch(0, overlay={"answer": "A"}).to_dict(),
            _branch(1, overlay={"answer": "B"}).to_dict(),
        ],
        "domain": DOMAIN,
        "goal": ["answer"],
    }
    engine = make_engine(
        graph, registries=GraphRegistries(nodes=registry), transports=[]
    )
    _final, run_result = await engine._execute(
        state=dict(entry_state),
        thread_id="t-jn",
        round_id=None,
        resume_from=None,
        trace_id="trace-jn",
        queue=None,
    )
    assert run_result.reason == "reply"
    verdict_state = _final.get("multipath.verdict")
    assert verdict_state is not None
    assert verdict_state["winner"] == 0  # 同档缺成本 → 序号最小者
    assert verdict_state["mode"] == MODE_TIER


def test_flags_parse_boot_keys():
    """装配接线：PathAssemblyFlags.from_boot 按名读取（缺省全关/未知键忽略）。"""
    flags = PathAssemblyFlags.from_boot(None)
    assert flags.multipath_enabled is False
    assert not any(flags.to_dict().values())
    flags = PathAssemblyFlags.from_boot(
        {BOOT_KEY_MULTIPATH_ENABLED: True, "unknown_key": True}
    )
    assert flags.multipath_enabled is True
    assert flags.assembler_enabled is False
    cfg = multipath_config_from_flags(flags)
    assert cfg.enabled is True
    assert cfg.shared_rho == 0.3


async def test_flags_wired_config_propagates(memory_storage):
    """装配接线：按名开关 → MultiPathConfig → 运行器行为（开启 = 触发）。"""
    registry = make_behavior_registry()
    store = EdgeEvidenceStore(":memory:")
    candidates = await make_candidates(registry, store, top_k=2)
    engine = make_parent_engine(registry, memory_storage, [])
    runner = MultipathRunner(
        engine,
        evidence_store=store,
        config=multipath_config_from_flags(
            PathAssemblyFlags(multipath_enabled=True)
        ),
    )
    result = await runner.run(
        make_request(top_k=2),
        candidates,
        entry_state={"user_query": "q"},
        thread_id="t-mp-wired",
    )
    assert result.triggered is True
    await store.close()


async def test_runner_requires_min_two_candidates(memory_storage):
    """候选不足（<2）：单径执行不触发多径（注明原因）。"""
    registry = make_behavior_registry()
    store = EdgeEvidenceStore(":memory:")
    candidates = await make_candidates(registry, store, top_k=3)
    first = candidates[:1]
    engine = make_parent_engine(registry, memory_storage, [])
    runner = make_runner(engine, store=store)
    result = await runner.run(
        make_request(top_k=3),
        first,
        entry_state={"user_query": "q"},
        thread_id="t-mp-1x",
    )
    assert result.triggered is False
    assert result.k == 1
    assert "候选不足" in (result.degraded_reason or "")
    await store.close()


def test_budget_query_view_has_stable_fields():
    """预算只读查询 ctx：多径预检的轻量视图字段稳定可断言。"""
    view = BudgetView()
    assert view.node is None
    assert view.graph_path == ("multipath",)
    assert view.step_count == 0


async def _evidence_map(store: EdgeEvidenceStore):
    rows = await store.list_edges(DOMAIN)
    from ink_engine.core.multipath import evidence_index_of

    return evidence_index_of(rows)


async def test_branch_steps_limit_overrun_marks_branch_failed(memory_storage):
    """支流步数截止：执行步数超限的支流 terminal=error（裁决按失败处理）。

    子链护栏覆盖多径分支（同构子链执行机制）：支流引擎执行步数超过
    simulate_max_branch_steps 上限 = 该支流失败（不静默提交结果）。
    """
    registry = make_behavior_registry()
    store = EdgeEvidenceStore(":memory:")
    candidates = await make_candidates(registry, store, top_k=2)
    from ink_engine.core.events import CollectorTransport

    collector = CollectorTransport()
    engine = make_engine(
        demo_linear_graph(),
        storage=memory_storage,
        transports=[collector],
        registries=GraphRegistries(nodes=registry),
        simulate_max_branch_steps=1,
    )
    runner = make_runner(engine, store=store)
    result = await runner.run(
        make_request(top_k=2),
        candidates,
        entry_state={"user_query": "q"},
        thread_id="t-mp-guard",
        round_id="r1",
        trace_id="trace-mp-guard",
    )
    assert result.triggered is True
    assert result.branches
    assert all(b.terminal == "error" for b in result.branches)
    assert any("步数超限" in (b.error or "") for b in result.branches)
    assert result.verdict is not None and result.verdict.mode == MODE_NONE
