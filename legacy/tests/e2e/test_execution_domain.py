"""执行域装配 e2e：RunOptions 全项注入（直接构造 Engine，逐机制钉住）。

Runtime 的 RunOptions 是引擎默认装配形态；执行域用例直接构造
Engine（与宿主图配方同源的回合金图），把 RunOptions 每一项都注入
并断言其行为——计划策略两档/步数上限/工作流约束域/子任务展开与
并发/推演评估与换选/预算护栏/异常三态/链压缩窗口/状态 schema。
"""
from __future__ import annotations

from typing import Any

from helpers import (
    build_ctx,
    build_round_graph,
    build_test_pipeline,
    domain_tool_specs,
    make_collector,
    orc_subgraph,
    review_scorer,
    run_engine,
    workflow_spec,
)
from ink_engine.core.budget import BudgetExceededError, BudgetManager
from ink_engine.core.executor import Engine, RunOptions
from ink_engine.core.graph import Graph
from ink_engine.core.registry import GraphRegistries
from ink_engine.core.state import StateSchema, register_reducer
from ink_engine.core.storage import create_storage


def _engine(
    *,
    pipeline: Any = None,
    tool_specs: list[Any] | None = None,
    storage: Any = None,
    **options: Any,
) -> Engine:
    """直接构造 Engine（图配方同源 + RunOptions 注入；registries 必注入）。"""
    registries = GraphRegistries()
    graph = build_round_graph(
        build_ctx(pipeline=pipeline, tool_specs=tool_specs or [], registries=registries),
    )
    defaults = {"registries": registries, "storage": storage}
    return Engine(
        graph, options=RunOptions(**{**defaults, **options})
    )


def _pipeline() -> Any:
    """脚本化工具流水线（六工作流工具 + echo 确定性结果）。"""
    script = {name: f"ok:{name}" for name in ("collect_material", "parse_material", "validate_material", "score_material", "review_material", "distill_knowledge", "echo")}
    return build_test_pipeline(script)


def _plan(*names: str) -> dict[str, Any]:
    """编排脚本（__plan__ 数据形态：顺序步骤清单）。"""
    return {"orchestrate": {"plan": [{"nodes": [name]} for name in names]}}


def _spawns(items: list[dict[str, Any]]) -> dict[str, Any]:
    return {"orchestrate": {"spawns": items}}


# ── 计划策略 ──


async def test_plan_policy_loose_within_domain():
    """loose 策略：计划落在约束域内任意节点即可执行（节点存在性校验）。

    引擎语义：计划 = 下一跳编排清单，计划耗尽后沿图拓扑续跑——
    本图工作流链边使剩余研究步骤按拓扑序自然执行，计划段 = 前两步。
    """
    engine = _engine(
        pipeline=_pipeline(),
        tool_specs=domain_tool_specs(),
        plan_workflow=workflow_spec(),
        plan_policy="loose",
    )
    transport = make_collector()
    result = await run_engine(
        engine, _plan("collect_material", "parse_material"), transports=[transport]
    )
    assert result.reason == "reply"
    assert result.state["results"]["collect_material"] == "ok:collect_material"
    assert result.state["results"]["parse_material"] == "ok:parse_material"
    events = [e.type for e in transport.events]
    assert "plan_start" in events
    tool_names = [
        e.payload["tool"]
        for e in transport.events
        if e.type == "tool_end"
    ]
    assert tool_names[:2] == ["collect_material", "parse_material"]  # 计划段先行
    assert len(tool_names) == 6  # 计划耗尽后沿工作流链边续跑至出口


async def test_plan_policy_strict_requires_workflow_edge_order():
    """strict 策略：相邻步骤须满足约束域边序（逆序步骤拒绝）。"""
    engine = _engine(
        pipeline=_pipeline(),
        tool_specs=domain_tool_specs(),
        plan_workflow=workflow_spec(),
        plan_policy="strict",
    )
    result = await run_engine(
        engine, _plan("parse_material", "collect_material")
    )
    assert result.reason == "error"
    assert "计划清单非法" in (result.error or "")


async def test_plan_workflow_constraint_out_of_domain_fails():
    """plan_workflow 约束域：引用约束域外节点（越域）→ 失败断言。"""
    engine = _engine(
        pipeline=_pipeline(),
        tool_specs=domain_tool_specs(),
        plan_workflow=workflow_spec(),
    )
    # tool_pipeline 在图中、不在工作流约束域内 → 越域拒绝
    result = await run_engine(engine, _plan("tool_pipeline"))
    assert result.reason == "error"
    assert "tool_pipeline" in (result.error or "")


async def test_max_plan_steps_guardrail():
    """max_plan_steps 步数上限：四步计划超限 → 失败（成本护栏）。"""
    engine = _engine(
        pipeline=_pipeline(),
        tool_specs=domain_tool_specs(),
        max_plan_steps=3,
    )
    result = await run_engine(
        engine,
        _plan("collect_material", "parse_material", "validate_material", "score_material"),
    )
    assert result.reason == "error"
    assert "步数" in (result.error or "") or "计划清单非法" in (result.error or "")


async def test_plan_disabled_when_max_plan_steps_zero():
    """max_plan_steps=0 = 计划禁用：编排节点返回计划 → 显式失败。"""
    engine = _engine(
        pipeline=_pipeline(),
        tool_specs=domain_tool_specs(),
        max_plan_steps=0,
    )
    result = await run_engine(engine, {"input": "x"})
    assert result.reason == "error"
    assert "计划已禁用" in (result.error or "")


# ── 子任务展开（__spawn__） ──


async def test_spawn_subtasks_expand_and_merge():
    """__spawn__ 数据形态：子图实例并发展开，结果回流合并（spawn_start 留痕）。"""
    engine = _engine(
        pipeline=_pipeline(),
        tool_specs=domain_tool_specs(),
        max_spawns=4,
        spawn_concurrency=2,
    )
    transport = make_collector()
    state = _spawns(
        [
            {"subgraph": orc_subgraph("collect_material"), "state": {"input": "a"}, "index": 0},
            {"subgraph": orc_subgraph("parse_material"), "state": {"input": "b"}, "index": 1},
        ]
    )
    result = await run_engine(engine, state, transports=[transport])
    assert result.reason == "reply"
    assert result.state["results"]["collect_material"] == "ok:collect_material"
    assert result.state["results"]["parse_material"] == "ok:parse_material"
    event_types = [e.type for e in transport.events]
    assert "spawn_start" in event_types
    assert "tool_end" in event_types


async def test_max_spawns_guardrail():
    """max_spawns 上限：清单超限 → 失败（成本护栏，不静默截断）。"""
    engine = _engine(
        pipeline=_pipeline(),
        tool_specs=domain_tool_specs(),
        max_spawns=1,
    )
    state = _spawns(
        [
            {"subgraph": orc_subgraph("collect_material"), "state": {}, "index": 0},
            {"subgraph": orc_subgraph("parse_material"), "state": {}, "index": 1},
        ]
    )
    result = await run_engine(engine, state)
    assert result.reason == "error"
    assert "超限" in (result.error or "")


# ── 推演（__simulate__） ──


def _simulate(branches: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "orchestrate": {
            "simulate": {
                "step_id": "dec-1",
                "budget": 4000,
                "branches": branches,
            }
        }
    }


def _branch(index: int, description: str, **scores: float) -> dict[str, Any]:
    state = {}
    state.update({f"score:{k}": v for k, v in scores.items()})
    return {
        "subgraph": orc_subgraph("collect_material"),
        "state": state,
        "index": index,
        "description": description,
    }


async def test_simulate_evaluates_and_selects_best():
    """决策点推演：WeightedScorerEvaluator（review.json 打分配置）+ 择优提交。"""
    engine = _engine(
        pipeline=_pipeline(),
        tool_specs=domain_tool_specs(),
        evaluator=review_scorer(),
        max_simulations=8,
        simulate_concurrency=2,
    )
    transport = make_collector()
    state = _simulate(
        [
            _branch(0, "低分分支", citation_quality=0.4, consistency=0.4, readability=0.4),
            _branch(1, "高分分支", citation_quality=0.9, consistency=0.9, readability=0.9),
        ]
    )
    result = await run_engine(engine, state, transports=[transport])
    assert result.reason == "reply"
    decisions = [e for e in transport.events if e.type == "simulate_decision"]
    assert len(decisions) == 1
    payload = decisions[0].payload
    assert payload["selected"] == [1]  # 高分分支选中（低分分支未过阈值被剔除）
    branch_scores = {b["index"]: b["score"] for b in payload["branches"]}
    assert branch_scores[1] > branch_scores[0]
    assert branch_scores[1] >= 0.75  # review.json pass_threshold 语义
    # 选中分支结果回流主线
    assert result.state["results"]["collect_material"] == "ok:collect_material"


async def test_simulate_facts_anchor_cross_validation():
    """samples.json facts 锚点：facts_hit 参与 cross_validation 维度打分。"""
    engine = _engine(
        pipeline=_pipeline(),
        tool_specs=domain_tool_specs(),
        evaluator=review_scorer(),
        max_simulations=8,
    )
    transport = make_collector()
    state = _simulate(
        [
            _branch(0, "四事实命中分支", citation_quality=0.9, consistency=0.9, readability=0.9),
            _branch(1, "无事实分支", citation_quality=0.9, consistency=0.9, readability=0.9),
        ]
    )
    # 分支 0 携带四事实命中（cross_validation 满分）；分支 1 中性分
    state["orchestrate"]["simulate"]["branches"][0]["state"]["facts_hit"] = 4
    result = await run_engine(engine, state, transports=[transport])
    assert result.reason == "reply"
    decision = next(e for e in transport.events if e.type == "simulate_decision")
    scores = {b["index"]: b["score"] for b in decision.payload["branches"]}
    assert scores[0] > scores[1]  # 事实锚点抬升交叉验证维度 → 总分行差
    assert decision.payload["selected"] == [0]


async def test_max_simulations_guardrail():
    """max_simulations 上限：分支超限 → 失败（成本护栏）。"""
    engine = _engine(
        pipeline=_pipeline(),
        tool_specs=domain_tool_specs(),
        evaluator=review_scorer(),
        max_simulations=2,
    )
    state = _simulate(
        [_branch(0, "a", consistency=0.5), _branch(1, "b", consistency=0.5), _branch(2, "c", consistency=0.5)]
    )
    result = await run_engine(engine, state)
    assert result.reason == "error"


async def test_branch_mixer_injection():
    """branch_mixer 注入：自定义调配策略决定换选（默认 BestBranchMixer 单选最高分）。"""
    from ink_engine.core.simulation import BranchSelection

    class _PickLastMixer:
        async def mix(self, branches, *, budget=None):
            picked = branches[-1]
            return BranchSelection(
                selected=(picked.spec.index,), overlay=picked.overlay
            )

    engine = _engine(
        pipeline=_pipeline(),
        tool_specs=domain_tool_specs(),
        evaluator=review_scorer(),
        branch_mixer=_PickLastMixer(),
        max_simulations=8,
    )
    transport = make_collector()
    state = _simulate(
        [
            _branch(0, "高分首位", citation_quality=0.9, consistency=0.9, readability=0.9),
            _branch(1, "及格末位", citation_quality=0.85, consistency=0.85, readability=0.85),
        ]
    )
    result = await run_engine(engine, state, transports=[transport])
    assert result.reason == "reply"
    decision = next(e for e in transport.events if e.type == "simulate_decision")
    assert decision.payload["selected"] == [1]  # 注入调配策略取末位


# ── 预算护栏 / 链压缩 / 异常策略 / 状态 schema ──


async def test_budget_guardrail_auto_terminates():
    """回合预算钩子：超限自动终止（budget_exceeded 入轨迹与审计）。"""
    budget = BudgetManager()
    budget.register(_StepBudgetPolicy(limit=3))
    engine = _engine(
        pipeline=_pipeline(),
        tool_specs=domain_tool_specs(),
        budget=budget,
    )
    result = await run_engine(engine, {"input": "x"})
    assert result.reason == "budget_exceeded"


class _StepBudgetPolicy:
    """步骤计数预算策略（节点边界检查；超限抛 BudgetExceededError）。"""

    def __init__(self, limit: int) -> None:
        self._limit = limit

    async def check(self, ctx: Any) -> None:
        if ctx.step_count >= self._limit:
            raise BudgetExceededError("steps", self._limit, ctx.step_count)


async def test_checkpoint_keep_chain_compaction():
    """checkpoint_keep 链压缩窗口：下一回合入口压缩历史前缀（窗口外折叠）。

    压缩语义：窗口管历史前缀（每叶路径 ≤ keep），本回合新增行不受
    压缩影响（下次回合入口再折叠）——断言历史前缀确实被折叠而非链
    无限增长。
    """
    storage = create_storage("memory://")
    engine = _engine(
        pipeline=_pipeline(),
        tool_specs=domain_tool_specs(),
        storage=storage,
        checkpoint_keep=2,
    )
    result = await run_engine(engine, {"input": "x"}, thread_id="ckpt-1")
    assert result.reason == "reply"
    result = await run_engine(engine, {"input": "x"}, thread_id="ckpt-1")
    assert result.reason == "reply"
    links = await storage.chain_index("ckpt-1")
    # 9 行/回合：两回合 18 行 → 压缩后 ≤ 2（首回合前缀）+ 9（本回合）
    assert len(links) <= 11
    assert len(links) < 18  # 压缩确实发生
    # 窗口外前缀已折叠：最旧保留行的 checkpoint_id 属于最近回合
    assert links[0].checkpoint_id >= 10


def _boom_graph() -> Graph:
    """异常注入图（boom 节点必炸；after 节点标记到达）。"""

    async def boom(ctx: Any) -> None:
        raise RuntimeError("boom 节点故障")

    async def after(ctx: Any) -> dict[str, Any]:
        return {"reached_after": True}

    g = Graph(name="boom", entry="boom")
    g.add_node("boom", boom)
    g.add_node("after", after)
    g.add_edge("boom", "after")
    g.add_exit("after")
    return g


async def test_error_on_exception_terminate():
    """异常策略·终止：error_on_exception=True 且不重试 → 本轮 error 终止。"""
    engine = Engine(
        _boom_graph(),
        options=RunOptions(error_on_exception=True, max_node_retries=0),
    )
    result = await run_engine(engine, {})
    assert result.reason == "error"
    assert "boom" in (result.error or "")


async def test_error_on_exception_skip():
    """异常策略·跳过：error_on_exception=False → 跳过异常节点继续。"""
    engine = Engine(
        _boom_graph(),
        options=RunOptions(error_on_exception=False, max_node_retries=0),
    )
    result = await run_engine(engine, {})
    assert result.reason == "reply"
    assert result.state.get("reached_after") is True


async def test_max_node_retries_transient_recovery():
    """异常策略·重试：max_node_retries 内瞬时故障恢复（三次后成功）。"""

    class _Flaky:
        attempts = 0

    async def flaky(ctx: Any) -> dict[str, Any]:
        _Flaky.attempts += 1
        if _Flaky.attempts < 3:
            raise RuntimeError("瞬时故障")
        return {"recovered": True}

    g = Graph(name="flaky", entry="flaky")
    g.add_node("flaky", flaky)
    g.add_exit("flaky")
    engine = Engine(
        g, options=RunOptions(error_on_exception=True, max_node_retries=2)
    )
    result = await run_engine(engine, {})
    assert result.reason == "reply"
    assert result.state.get("recovered") is True
    assert _Flaky.attempts == 3


async def test_state_schema_reducer_registry():
    """StateSchema reducer 注册表：add_messages 追加语义（裸通道覆盖语义对照）。"""

    async def emit_a(ctx: Any) -> dict[str, Any]:
        return {"messages": [{"id": "a", "role": "user"}]}

    async def emit_b(ctx: Any) -> dict[str, Any]:
        return {"messages": [{"id": "b", "role": "user"}]}

    def build(reducer: str | None) -> Engine:
        g = Graph(name="reducer", entry="a")
        g.add_node("a", emit_a)
        g.add_node("b", emit_b)
        g.add_edge("a", "b")
        g.add_exit("b")
        schema = StateSchema({"messages": reducer}) if reducer else None
        return Engine(g, options=RunOptions(schema=schema))

    # add_messages 追加：两条消息都在
    result = await run_engine(build("add_messages"), {}, thread_id="reducer-add")
    assert [m["id"] for m in result.state["messages"]] == ["a", "b"]
    # 裸通道覆盖：后写者胜
    result = await run_engine(build(None), {}, thread_id="reducer-bare")
    assert [m["id"] for m in result.state["messages"]] == ["b"]


def test_state_schema_custom_reducer_registration():
    """StateSchema 支持自定义 reducer 注册（register_reducer 扩展点）。"""

    def concat(base: Any, overlay: Any) -> str:
        return str(base) + str(overlay)

    register_reducer("concat_str", concat)
    schema = StateSchema({"label": "concat_str"})
    assert schema.apply({"label": "ab"}, {"label": "cd"}) == {"label": "abcd"}


async def test_trace_id_propagation():
    """trace_id 透传（回回合 id）：回合事件携带同一链路标识。"""
    engine = _engine(pipeline=_pipeline(), tool_specs=domain_tool_specs())
    transport = make_collector()
    result = await run_engine(
        engine,
        {"input": "x"},
        thread_id="trace-1",
        transports=[transport],
    )
    assert result.reason == "reply"
    assert len(transport.events) > 0
    trace_ids = {e.trace_id for e in transport.events}
    assert len(trace_ids) == 1
    assert trace_ids != {"-"}
    assert {e.round_id for e in transport.events} == {"round-trace-1"}


async def test_transports_collect_engine_events():
    """事件传输：回合事件流完整（plan/tool/error 事件信封与负载）。"""
    engine = _engine(
        pipeline=_pipeline(),
        tool_specs=domain_tool_specs(),
        plan_workflow=workflow_spec(),
    )
    transport = make_collector()
    result = await run_engine(
        engine, _plan("collect_material"), transports=[transport]
    )
    assert result.reason == "reply"
    types = [e.type for e in transport.events]
    assert "plan_start" in types
    assert "tool_start" in types
    assert "tool_end" in types
    tool_end = next(e for e in transport.events if e.type == "tool_end")
    assert tool_end.payload["tool"] == "collect_material"
    assert tool_end.payload["success"] is True
