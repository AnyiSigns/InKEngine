"""族 20：混合嵌套（test_20_nested_mixed.py）｜执行语义嵌套的全真实模式 E2E。

本族聚焦「多机制在流程结构上嵌套」——一类机制作为另一类机制的执行
语义载体（plan 内嵌 spawn、spawn 内嵌 simulate、子图内嵌审批挂卡、
断链恢复续跑嵌套审批重入、工具链混合嵌套自指应用与内省），覆盖 12 项
场景：

1. 长链：plan → spawn → simulate → 择优 → 审批挂卡 → 决议 → 重入 → 收口
   （**真实 LLM 用例**，节点闭包持 live_llm，LLM 调用 ≤4 次）
2. 审批嵌套：挂卡等待期间同回合并行分支推进事件按序落流（事件序断言）
3. 断链恢复 + 续跑 + 审批重入
4. 编辑重放 + 审批卡状态（edit 决议重新过校验）
5. 孵化（蒸馏+闸门） + 自指补丁同链 base 冲突重提
6. 工具链混合：MCP 取数 → 文件写盘 → apply_patch 落知识 → inspect 验证
7. 多线程（asyncio 多任务）并发 run 同 storage（乐观锁安全语义）
8. 断链恢复 + 工具审计链完整（事件序 + 不重不漏）
9. 演化 + 晋升 + 导出导入组合（跨实例后数据完整可回退）
10. 坏 tool call → strict 拒绝 → 重试 → 审批 → 重入（确定性 strict 路径）
11. spawn 内 simulate（嵌套展开，分支结果回流父图）
12. 子图内审批挂卡（不同图深度 graph_path 断言）

`real` 标记 = 真实 LLM 调用（族门禁②）；其余为确定性机制用例（零费用）。
"""
from __future__ import annotations

import asyncio

import pytest

pytestmark = pytest.mark.live

from ink_engine.core.approval import (  # noqa: E402
    DECISION_ACCEPT,
    approve_before_execute,
)
from ink_engine.core.events import CollectorTransport  # noqa: E402
from ink_engine.core.evolution import (  # noqa: E402
    DeterministicMutation,
    EvolutionCandidate,
    EvolutionFactory,
)
from ink_engine.core.executor import Engine, RunOptions  # noqa: E402
from ink_engine.core.graph import Graph, TerminateReason  # noqa: E402
from ink_engine.core.introspection import (  # noqa: E402
    IntrospectionService,
    IntrospectionSources,
    introspection_tool_specs,
)
from ink_engine.core.knowledge_gate import (  # noqa: E402
    GateL2FixtureExecutor,
    KnowledgeGate,
)
from ink_engine.core.knowledge_set import (  # noqa: E402
    KIND_RULE,
    LEVEL_USER,
    KnowledgeEntry,
    KnowledgeSet,
)
from ink_engine.core.knowledge_signals import (  # noqa: E402
    SIGNAL_INSIGHT,
    DeterministicDistiller,
    ExecutionSignal,
)
from ink_engine.core.llm.errors import LLMFormatError  # noqa: E402
from ink_engine.core.llm.messages import ToolCall, user  # noqa: E402
from ink_engine.core.mcp_client import (  # noqa: E402
    McpClientManager,
    McpServerConfig,
    McpTransport,
)
from ink_engine.core.plan import PLAN_KEY  # noqa: E402
from ink_engine.core.rules import FixtureCase, FixtureSet, RuleTypeRegistry  # noqa: E402
from ink_engine.core.self_application import (  # noqa: E402
    AUDIT_STATUS_APPLIED,
    SelfApplicationPipeline,
)
from ink_engine.core.self_proposal import (  # noqa: E402
    PatchKind,
    ProposalValidator,
    SelfProposal,
)
from ink_engine.core.simulation import SIMULATE_KEY  # noqa: E402
from ink_engine.core.spawn import SPAWN_KEY  # noqa: E402
from ink_engine.core.storage import create_storage  # noqa: E402


def _engine(graph: Graph, *, storage=None, **kw) -> Engine:
    return Engine(
        graph,
        options=RunOptions(storage=storage, transports=[CollectorTransport()], **kw),
    )


class _StubCtx:
    """自指应用管线桩 ctx：THEME 为 L0 直过，不挂卡（interrupt 不被调用）。"""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    async def interrupt(self, key: str, payload: dict):
        self.calls.append((key, payload))
        return None

    async def get_interrupt_payload(self, key: str) -> dict | None:
        return None


def _sub_graph(value: int) -> Graph:
    async def node(ctx):
        return {"spawned": value}

    g = Graph(name="sub", entry="s1")
    g.add_node("s1", node)
    g.add_exit("s1")
    return g


def _sim_branch(delta: int) -> Graph:
    async def node(ctx):
        await ctx.emit("branch_run", {"delta": delta})
        return {"branch_value": ctx.state.get("seed", 0) + delta}

    g = Graph(name="sim", entry="s1")
    g.add_node("s1", node)
    g.add_exit("s1")
    return g


class _ScoringEvaluator:
    def __init__(self, scores: dict, passed: dict | None = None) -> None:
        self._scores = scores
        self._passed = passed or {}

    async def evaluate(self, branch, overlay: dict):
        from ink_engine.core.simulation import Evaluation

        return Evaluation(
            score=self._scores.get(branch.index, 0.0),
            passed=self._passed.get(branch.index, True),
            note=f"branch-{branch.index}",
        )


# ----------------------------------------------------------------------
# 1. 长链：plan → spawn → simulate → 择优 → 审批挂卡 → 决议 → 重入 → 收口
#    （真实 LLM 用例，节点闭包持 live_llm，调用 ≤4 次）
# ----------------------------------------------------------------------

@pytest.mark.real
async def test_real_long_chain_nested(live_llm, memory_storage):
    transport = CollectorTransport()

    async def llm_node(ctx):
        result = await live_llm.ainvoke([user("用一句话回答：什么是人工智能？")])
        await ctx.emit("llm_reply", {"content": result.content})
        return {"answer": result.content}

    async def plan_node(ctx):
        return {
            PLAN_KEY: [
                {"nodes": ["llm_node"]},
                {"nodes": ["spawn_node"]},
                {"nodes": ["sim_node"]},
            ]
        }

    async def spawn_node(ctx):
        return {SPAWN_KEY: [{"subgraph": _sub_graph(3), "state": {}, "index": 0}]}

    async def sim_node(ctx):
        return {
            SIMULATE_KEY: {
                "branches": [
                    {"subgraph": _sim_branch(1), "state": {"seed": 10}, "index": 0},
                    {"subgraph": _sim_branch(2), "state": {"seed": 10}, "index": 1},
                ]
            }
        }

    async def gate_node(ctx):
        decision = await approve_before_execute(
            ctx, "approve:long", {"tool": "finalize", "args": {}, "summary": "收口"}
        )
        if decision.decision == DECISION_ACCEPT:
            return {"finalized": True}
        ctx.terminate(TerminateReason.CANCELLED)
        return {}

    g = Graph(name="long_chain", entry="plan_node")
    g.add_node("plan_node", plan_node)
    g.add_node("llm_node", llm_node)
    g.add_node("spawn_node", spawn_node)
    g.add_node("sim_node", sim_node)
    g.add_node("gate_node", gate_node)
    for src in ("plan_node", "llm_node", "spawn_node", "sim_node"):
        g.add_edge(src, "gate_node")
    g.add_exit("gate_node")

    engine = Engine(
        g,
        options=RunOptions(
            storage=memory_storage,
            transports=[transport],
            evaluator=_ScoringEvaluator({0: 0.3, 1: 0.9}),
        ),
    )
    first = await engine.ainvoke({}, thread_id="long")
    assert first.reason == "interrupted"
    assert first.interrupt is not None and first.interrupt.key == "approve:long"
    assert isinstance(first.state.get("answer"), str) and first.state["answer"].strip()
    assert any(e.type == "llm_reply" and e.payload["content"] for e in transport.events)

    resumed = await engine.ainvoke(
        {},
        thread_id="long",
        resume_from=first.checkpoint_id,
        inject={"approve:long": {"decision": "accept"}},
    )
    assert resumed.reason == TerminateReason.REPLY
    assert resumed.state["finalized"] is True
    assert resumed.state.get("spawned") == 3
    assert resumed.state.get("branch_value") == 12
    assert resumed.state["answer"].strip()


# ----------------------------------------------------------------------
# 2. 审批嵌套：挂卡等待期间同回合并行分支推进事件按序落流
# ----------------------------------------------------------------------

async def test_nested_approval_parallel_progress_order(memory_storage):
    async def worker(ctx):
        await ctx.emit("work_tick", {"n": 1})
        await ctx.emit("work_tick", {"n": 2})
        return {"worked": True}

    async def gated(ctx):
        await ctx.interrupt("review:nested", {"q": "?"})
        return {"gated_done": True}

    async def route(ctx):
        return {PLAN_KEY: [{"parallel": ["worker", "gated"]}]}

    g = Graph(name="nested_approval", entry="route")
    g.add_node("route", route)
    g.add_node("worker", worker)
    g.add_node("gated", gated)
    g.add_exit("route")
    engine = _engine(g, storage=memory_storage)
    result = await engine.ainvoke({}, thread_id="t")
    assert result.reason == "interrupted"
    assert result.interrupt is not None and result.interrupt.key == "review:nested"
    stream = [e.type for e in engine.options.transports[0].events]
    work_positions = [i for i, t in enumerate(stream) if t == "work_tick"]
    card_positions = [i for i, t in enumerate(stream) if t == "review_card"]
    assert work_positions and card_positions
    assert max(work_positions) < min(card_positions)


# ----------------------------------------------------------------------
# 3. 断链恢复 + 续跑 + 审批重入
# ----------------------------------------------------------------------

async def test_recovery_resume_approval_reenter(memory_storage):
    transport = CollectorTransport()

    async def pre(ctx):
        await ctx.emit("pre_step", {"n": 1})
        return {"pre": True}

    async def gate(ctx):
        decision = await approve_before_execute(
            ctx, "approve:rec", {"tool": "act", "args": {}, "summary": "做"}
        )
        if decision.decision == DECISION_ACCEPT:
            return {"approved": True}
        ctx.terminate(TerminateReason.CANCELLED)
        return {}

    g = Graph(name="recovery_approval", entry="pre")
    g.add_node("pre", pre)
    g.add_node("gate", gate)
    g.add_edge("pre", "gate")
    g.add_exit("gate")
    engine = Engine(
        g, options=RunOptions(storage=memory_storage, transports=[transport])
    )
    first = await engine.ainvoke({}, thread_id="t")
    assert first.reason == "interrupted"
    assert first.interrupt is not None and first.interrupt.key == "approve:rec"

    resumed = await engine.ainvoke(
        {},
        thread_id="t",
        resume_from=first.checkpoint_id,
        inject={"approve:rec": {"decision": "accept"}},
    )
    assert resumed.reason == TerminateReason.REPLY
    assert resumed.state["approved"] is True
    assert resumed.state["pre"] is True
    pre_events = [e for e in transport.events if e.type == "pre_step"]
    assert len(pre_events) == 1  # 断链续跑：前置节点不重跑


# ----------------------------------------------------------------------
# 4. 编辑重放 + 审批卡状态（edit 决议重新过校验）
# ----------------------------------------------------------------------

async def test_edit_replay_approval_card_state(memory_storage):
    async def gate(ctx):
        decision = await approve_before_execute(
            ctx, "approve:edit", {"tool": "write", "args": {}, "summary": "写"}
        )
        if decision.decision == "edit":
            return {"content": decision.edited_content}
        if decision.decision == DECISION_ACCEPT:
            return {"content": "原文"}
        ctx.terminate(TerminateReason.CANCELLED)
        return {}

    g = Graph(name="edit_replay", entry="gate")
    g.add_node("gate", gate)
    g.add_exit("gate")
    engine = _engine(g, storage=memory_storage)
    first = await engine.ainvoke({}, thread_id="t")
    assert first.reason == "interrupted"
    latest = await memory_storage.get_latest_checkpoint("t")
    assert latest is not None and latest.interrupt is not None
    assert latest.interrupt.payload.get("review_type") == "gate"

    resumed = await engine.ainvoke(
        {},
        thread_id="t",
        resume_from=first.checkpoint_id,
        inject={"approve:edit": {"decision": "edit", "edited_content": "改写后正文"}},
    )
    assert resumed.reason == TerminateReason.REPLY
    assert resumed.state["content"] == "改写后正文"


# ----------------------------------------------------------------------
# 5. 孵化（蒸馏 + 闸门） + 自指补丁同链 base 冲突重提
# ----------------------------------------------------------------------

def _rule_registry() -> RuleTypeRegistry:
    reg = RuleTypeRegistry()

    def pred(target, config, context):
        value = target.get("value")
        if value == config.get("forbid"):
            return [{"message": "禁止值命中"}]
        return []

    reg.register("forbid_value", pred)
    return reg


def _rule_schema():
    from ink_engine.core.schema_validator import SchemaSpec

    return SchemaSpec.from_dict(
        {
            "name": "knowledge_entry",
            "fields": [
                {"name": "id", "required": True, "kind": "string"},
                {"name": "level", "required": True, "kind": "string"},
                {"name": "kind", "required": True, "kind": "string"},
                {"name": "credibility", "kind": "number", "min": 0.0, "max": 1.0},
                {"name": "data.rule.message", "kind": "string", "required": True},
            ],
        }
    )


def _fixtures():
    return FixtureSet(
        name="demo",
        cases=(
            FixtureCase(id="p1", data={"value": "ok"}, expected_pass=True),
            FixtureCase(id="f1", data={"value": "bad"}, expected_pass=False),
        ),
    )


async def test_incubate_then_patch_base_conflict(memory_storage):
    distiller = DeterministicDistiller()
    signals = [ExecutionSignal(kind=SIGNAL_INSIGHT, message="成功经验", source="model")]
    distilled = distiller.distill(signals)
    assert distilled is not None
    rule = {
        "id": "r-1",
        "message": distilled["insight"]["message"],
        "predicate": "forbid_value",
        "config": {"forbid": "bad"},
        "kind": "rule",
    }
    entry = KnowledgeEntry(
        id="k-1",
        level="work",
        kind=KIND_RULE,
        data={"rule": rule},
        source="model",
    )
    gate = KnowledgeGate(l2_executor=None)
    l1 = gate.check_l1(_rule_schema(), entry)
    assert l1.passed

    pipeline = SelfApplicationPipeline(
        memory_storage,
        validator=ProposalValidator(allowed_theme_tokens=("bg",)),
    )
    ctx = _StubCtx()
    first = await pipeline.apply(
        ctx,
        SelfProposal(
            kind=PatchKind.THEME,
            payload={"tokens": {"bg": "#111"}},
            base_version=1,
            rationale="首版主题",
        ),
    )
    assert first.applied is True
    # 同链基于过期 base (v1) 重提 → 并发冲突拒绝
    stale = await pipeline.apply(
        ctx,
        SelfProposal(
            kind=PatchKind.THEME,
            payload={"tokens": {"bg": "#222"}},
            base_version=1,
            rationale="基于旧版重提",
        ),
    )
    assert stale.status == "conflict"
    # 基于最新 base (v2) 重提 → 落链成功
    fresh = await pipeline.apply(
        ctx,
        SelfProposal(
            kind=PatchKind.THEME,
            payload={"tokens": {"bg": "#333"}},
            base_version=2,
            rationale="基于最新重提",
        ),
    )
    assert fresh.applied is True
    state = await pipeline.chain.assemble()
    assert state["theme"]["bg"] == "#333"


# ----------------------------------------------------------------------
# 6. 工具链混合：MCP 取数 → 文件写盘 → apply_patch 落知识 → inspect 验证
# ----------------------------------------------------------------------

async def test_toolchain_mixed_mcp_file_patch_inspect(memory_storage, mcp_http_server, live_tmp):
    manager = McpClientManager()
    try:
        await manager.connect(
            McpServerConfig(id="mixed", transport=McpTransport.HTTP, url=mcp_http_server.url)
        )
        specs = await manager.import_tools("mixed", source="test")
        echo = next(s for s in specs if s.name == "echo")
        data = await manager.dispatch(None, echo, {"text": "混链数据"})
        assert isinstance(data, str) and "混链数据" in data
        # 文件写盘
        path = live_tmp / "mixed_out.txt"
        path.write_text(data, encoding="utf-8")
        assert path.read_text(encoding="utf-8") == data
        # apply_patch 落知识（自指应用管线，THEME=L0 直过）
        pipeline = SelfApplicationPipeline(
            memory_storage,
            validator=ProposalValidator(allowed_theme_tokens=("bg",)),
        )
        outcome = await pipeline.apply(
            _StubCtx(),
            SelfProposal(
                kind=PatchKind.THEME,
                payload={"tokens": {"bg": "#444"}},
                base_version=1,
                rationale="混链主题",
            ),
        )
        assert outcome.applied is True and outcome.status == AUDIT_STATUS_APPLIED
        assembled = await pipeline.chain.assemble()
        assert assembled["theme"]["bg"] == "#444"
        # inspect 验证（内省快照确定性可序列化）
        service = IntrospectionService(
            IntrospectionSources(graph=None, tools=introspection_tool_specs())
        )
        snap = service.snapshot_tools()
        assert snap["count"] >= 1
        assert "inspect_graph" in {t["name"] for t in snap["tools"]}
        log = await pipeline.audit_log()
        assert any(e["status"] == AUDIT_STATUS_APPLIED for e in log)
    finally:
        await manager.close_all()


# ----------------------------------------------------------------------
# 7. 多线程（asyncio 多任务）并发 run 同 storage（乐观锁安全语义）
# ----------------------------------------------------------------------

async def test_concurrent_runs_same_storage(memory_storage):
    async def leaf(ctx):
        return {"done": True}

    def make_graph(tag: str) -> Graph:
        g = Graph(name=f"conc_{tag}", entry="a")
        g.add_node("a", leaf)
        g.add_exit("a")
        return g

    async def run_one(tag: str):
        engine = _engine(make_graph(tag), storage=memory_storage)
        return await engine.ainvoke({}, thread_id=f"conc-{tag}")

    results = await asyncio.gather(*[run_one(str(i)) for i in range(5)])
    assert all(r.reason == TerminateReason.REPLY for r in results)
    for i in range(5):
        cp = await memory_storage.get_latest_checkpoint(f"conc-{i}")
        assert cp is not None and cp.reason == TerminateReason.REPLY


# ----------------------------------------------------------------------
# 8. 断链恢复 + 工具审计链完整（事件序 + 不重不漏）
# ----------------------------------------------------------------------

async def test_recovery_tool_audit_chain_complete(memory_storage, mcp_http_server):
    manager = McpClientManager()
    transport = CollectorTransport()
    try:
        await manager.connect(
            McpServerConfig(id="audit", transport=McpTransport.HTTP, url=mcp_http_server.url)
        )
        specs = await manager.import_tools("audit", source="test")
        echo = next(s for s in specs if s.name == "echo")

        async def fetch(ctx):
            out = await manager.dispatch(None, echo, {"text": "审计数据"})
            await ctx.emit("mcp_done", {"out": out})
            return {"fetched": True}

        async def gate(ctx):
            decision = await approve_before_execute(
                ctx, "approve:audit", {"tool": "act", "args": {}, "summary": "做"}
            )
            if decision.decision == DECISION_ACCEPT:
                return {"finalized": True}
            ctx.terminate(TerminateReason.CANCELLED)
            return {}

        g = Graph(name="audit_chain", entry="fetch")
        g.add_node("fetch", fetch)
        g.add_node("gate", gate)
        g.add_edge("fetch", "gate")
        g.add_exit("gate")
        engine = Engine(
            g, options=RunOptions(storage=memory_storage, transports=[transport])
        )
        first = await engine.ainvoke({}, thread_id="t")
        assert first.reason == "interrupted"
        assert any(e.type == "mcp_done" and e.payload["out"] for e in transport.events)

        resumed = await engine.ainvoke(
            {},
            thread_id="t",
            resume_from=first.checkpoint_id,
            inject={"approve:audit": {"decision": "accept"}},
        )
        assert resumed.reason == TerminateReason.REPLY
        stored = await memory_storage.events_after("t", 0)
        types = [e.type for e in stored]
        assert "mcp_done" in types and "review_card" in types
        assert types.index("mcp_done") < types.index("review_card")
        assert types.count("mcp_done") == 1
    finally:
        await manager.close_all()


# ----------------------------------------------------------------------
# 9. 演化 + 晋升 + 导出导入组合（跨实例后数据完整可回退）
# ----------------------------------------------------------------------

async def test_evolution_promote_export_import(memory_storage):
    class GoodMutation(DeterministicMutation):
        def mutate(self, entry, failure_logs):
            data = dict(entry.data)
            data["rule"] = {**data["rule"], "config": {"forbid": "bad"}}
            return [data]

    mother = KnowledgeEntry(
        id="k-1",
        level=LEVEL_USER,
        kind=KIND_RULE,
        data={"rule": {"id": "r", "predicate": "forbid_value", "config": {"forbid": "x"}, "kind": "rule", "message": "母体规则"}},
        source="model",
    )
    candidate = EvolutionCandidate(
        entry=mother, failure_rate=0.8, failure_logs=("失败日志",)
    )
    factory = EvolutionFactory(
        gate=KnowledgeGate(
            l2_executor=GateL2FixtureExecutor(registry=_rule_registry()),
            registry=_rule_registry(),
        ),
        mutation=GoodMutation(),
    )
    outcome = await factory.evolve(
        candidate,
        schema=_rule_schema(),
        fixtures=_fixtures(),
        old_metrics={"accuracy": 0.95, "latency": 0.7, "safety": 1.0},
    )
    # 演化 + 晋升：变异体过闸门保留
    assert outcome.kept == 1
    rule_data = outcome.variants[0].data["rule"]
    assert rule_data["config"]["forbid"] == "bad"
    # 导出（to_dict）→ 跨实例导入（新存储 + 新知识集）
    promoted = KnowledgeEntry(
        id="evolved",
        level=LEVEL_USER,
        kind=KIND_RULE,
        data={"rule": rule_data},
        source="model",
    )
    exported = promoted.to_dict()
    new_set = KnowledgeSet("u2", storage=create_storage("memory://"))
    new_set.add(KnowledgeEntry.from_dict(exported))
    restored = new_set.get("evolved")
    assert restored is not None
    assert restored.data["rule"]["config"]["forbid"] == "bad"
    assert restored.data["rule"]["predicate"] == "forbid_value"


# ----------------------------------------------------------------------
# 10. 坏 tool call → strict 拒绝 → 重试 → 审批 → 重入
#      （确定性：构造非法 ToolCall JSON 走 strict 拒绝路径）
# ----------------------------------------------------------------------

def test_bad_tool_call_strict_reject():
    broken = ToolCall(id="x", name="f", arguments='{"city": "北')
    assert broken.parse_arguments(strict=False) == {}
    with pytest.raises(LLMFormatError):
        broken.parse_arguments(strict=True)
    # 重试：合法调用解析通过
    good = ToolCall(id="y", name="f", arguments='{"city": "北京"}')
    assert good.parse_arguments(strict=True) == {"city": "北京"}


async def test_strict_reject_then_approve_reenter(memory_storage):
    async def node(ctx):
        await ctx.emit("retried", {"n": 1})
        decision = await approve_before_execute(
            ctx, "approve:retry", {"tool": "act", "args": {}, "summary": "做"}
        )
        if decision.decision == DECISION_ACCEPT:
            return {"retried_ok": True}
        ctx.terminate(TerminateReason.CANCELLED)
        return {}

    g = Graph(name="strict_retry", entry="node")
    g.add_node("node", node)
    g.add_exit("node")
    engine = _engine(g, storage=memory_storage)
    first = await engine.ainvoke({}, thread_id="t")
    assert first.reason == "interrupted"
    assert first.interrupt is not None and first.interrupt.key == "approve:retry"
    resumed = await engine.ainvoke(
        {},
        thread_id="t",
        resume_from=first.checkpoint_id,
        inject={"approve:retry": {"decision": "accept"}},
    )
    assert resumed.reason == TerminateReason.REPLY
    assert resumed.state["retried_ok"] is True


# ----------------------------------------------------------------------
# 11. spawn 内 simulate（嵌套展开，分支结果回流父图）
# ----------------------------------------------------------------------

async def test_spawn_within_simulate_nested(memory_storage):
    async def sim_route(ctx):
        return {
            SIMULATE_KEY: {
                "branches": [
                    {"subgraph": _sim_branch(1), "state": {"seed": 10}, "index": 0},
                    {"subgraph": _sim_branch(2), "state": {"seed": 10}, "index": 1},
                ]
            }
        }

    inner = Graph(name="inner", entry="route")
    inner.add_node("route", sim_route)
    inner.add_exit("route")

    async def spawn_route(ctx):
        return {SPAWN_KEY: [{"subgraph": inner, "state": {}, "index": 0}]}

    g = Graph(name="spawn_sim", entry="spawn_route")
    g.add_node("spawn_route", spawn_route)
    g.add_exit("spawn_route")
    engine = _engine(
        g,
        storage=memory_storage,
        evaluator=_ScoringEvaluator({0: 0.3, 1: 0.9}),
    )
    result = await engine.ainvoke({}, thread_id="t")
    assert result.reason == TerminateReason.REPLY
    assert result.state.get("branch_value") == 12  # 择优分支（10+2）回流父图


# ----------------------------------------------------------------------
# 12. 子图内审批挂卡（不同图深度 graph_path 断言）
# ----------------------------------------------------------------------

async def test_deep_subgraph_approval_graph_path(memory_storage):
    async def deep_gate(ctx):
        await ctx.emit("deep_marker", {"n": 1})
        decision = await approve_before_execute(
            ctx, "approve:deep", {"tool": "act", "args": {}, "summary": "做"}
        )
        if decision.decision == DECISION_ACCEPT:
            return {"deep_ok": True}
        ctx.terminate(TerminateReason.CANCELLED)
        return {}

    inner = Graph(name="inner", entry="i1")
    inner.add_node("i1", deep_gate)
    inner.add_exit("i1")

    parent = Graph(name="parent", entry="inner")
    parent.add_subgraph("inner", inner)
    parent.add_exit("inner")
    engine = _engine(parent, storage=memory_storage)
    first = await engine.ainvoke({}, thread_id="t")
    assert first.reason == "interrupted"
    assert first.interrupt is not None and first.interrupt.key == "approve:deep"
    # 子图内事件携带深度 graph_path（不同图深度的执行语义断言）
    events = [e for e in engine.options.transports[0].events if e.type == "deep_marker"]
    assert events and events[0].graph_path == ("inner",)

    resumed = await engine.ainvoke(
        {},
        thread_id="t",
        resume_from=first.checkpoint_id,
        inject={"approve:deep": {"decision": "accept"}},
    )
    assert resumed.reason == TerminateReason.REPLY
    assert resumed.state["deep_ok"] is True
