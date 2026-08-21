"""全链路闭环 e2e：注入 → 挂载 → 回合 → 推演 → 孵化 → 补丁 → 回退 →
续流 → 压缩 → 调优 → 领域长出（喂资料 → 研究 → 孵化 → 沉淀闭环）。

闭环在引擎 pytest 环境全链可跑（stub LLM + 嵌入式/stdio MCP 传输）：
- 注入：boot_prompt 定稿形态 + 种子注入（知识集/界面基线）；
- 挂载：MCP 双入口之一（设置页一键挂载）→ vetting → L2 → 补丁链；
- 回合：计划执行（plan_start → 工具流水线 → review 卡 → 决议续跑）；
- 推演：simulate_decision 分支对比 + 评估择优（与宿主图配方同源的
  直接 Engine 装配——运行时级评估器注入为遗留待议，见最终报告）；
- 孵化：信号 → 蒸馏 → 三层闸门 → 落库；
- 补丁/回退：审批卡 → 集补丁链 → 链尾折叠回退（审计留痕）；
- 断线续流：挂卡 → resume_run 逐卡重入至终态；
- 链压缩：checkpoint 链窗口折叠（历史前缀归档）；
- 调优：回合指标聚合 → 参数调整 → 快照（低分反馈降权）；
- 领域长出：新规则经样例闸门放行 → 自指 KNOWLEDGE 补丁挂载（可回退）。
"""
from __future__ import annotations

import json
from typing import Any

import pytest
from conftest import SEED_ROOT, ScriptedApprovalCtx, StubLLM, load_seed
from fixtures.mcp_fixture_server import build_echo_server
from ink_engine.core.chain_rebase import maybe_compact_chain
from ink_engine.core.executor import Engine, RunOptions
from ink_engine.core.knowledge_set import KnowledgeEntry
from ink_engine.core.registry import GraphRegistries
from ink_engine.core.tuning import MetaTuner, TunableParams, TurnMetrics

from host.host import boot_inkling
from host.knowledge_domain import entry_from_distill
from host.mcp_service import in_memory_server_factory

# 自举提示词定稿（§5.1 原文，与 schema 校验脚本逐字比对同源）
BOOT_PROMPT_FINAL = (
    "你是 InKling——一个自进化认知伙伴。你对用户的领域起初只有隐约的理解，"
    "通过观察、检索、校验与孵化，把使用中积累的理解沉淀为可信的知识；"
    "每一次变化都经审批、可审计、可回退；你也可以提议接入外部工具/插件"
    "来扩展能力，经你确认后生效。用中文简明作答。"
)


def _market_with(entry: dict[str, Any]) -> dict[str, Any]:
    """市场数据副本 + 测试条目（市场是数据，测试注入本地可离线条目）。"""
    import copy

    market = copy.deepcopy(load_seed("mcp_market.json"))
    market["servers"] = [*market["servers"], entry]
    return market


_IN_MEMORY_ECHO_ENTRY: dict[str, Any] = {
    "id": "test.echo",
    "name": "测试回声 server（嵌入式）",
    "source": "e2e fixture",
    "transport": "in_memory",
    "url": None,
    "command": None,
    "args": [],
    "credentials": {"required": False},
    "risk": "low",
    "risk_note": "e2e 离线闭环条目",
    "category": "fixture",
    "premounted": False,
}


async def _mount_echo(runtime: Any, mount_service: Any, ctx: Any) -> str:
    """挂载闭环：市场条目 → vetting → L2 审批 → 补丁链 → 工具表生效。"""
    outcome = await mount_service.propose_mount(
        ctx,
        "test.echo",
        server_factory=in_memory_server_factory(build_echo_server()),
    )
    assert outcome.ok, outcome.error
    assert outcome.status == "mounted"
    assert runtime.mcp_manager.list_servers() == ["test.echo"]
    return outcome.tool_names[0]


async def _call_tool(runtime: Any, ctx: Any, name: str, args: dict[str, Any]) -> str:
    spec = runtime.tool_registry[name]
    result = await runtime.tool_pipeline.execute(ctx, spec, args)
    assert result.ok, result.error
    return result.output


async def _round_to_reply(runtime: Any, host: Any, thread_id: str) -> list[Any]:
    """回合 + 断线续流：跑一轮（review 卡挂起）→ 逐卡 resume 至终态。"""
    offset = len(host.events)
    first = await runtime.engine.ainvoke(
        {"input": "研究墨引擎机制"},
        thread_id=thread_id,
        round_id=f"round-{thread_id}",
        transports=[host.build_transport()],
    )
    assert first.reason == "interrupted"
    resumed = first
    guard = 0
    while resumed.reason == "interrupted":
        guard += 1
        assert guard <= 8  # 卡数上限护栏（防死循环）
        resumed = await runtime.resume_run(
            thread_id,
            "accept",
            round_id=f"round-{thread_id}-resume-{guard}",
            transports=[host.build_transport()],
        )
    assert resumed.reason == "reply"
    return host.events[offset:]


async def test_full_loop_incubate_chain():
    """全链路闭环（嵌入式挂载）：注入→挂载→回合→推演→孵化→补丁→回退→
    续流→压缩→调优→领域长出。"""
    runtime, host, mount_service = await boot_inkling(
        SEED_ROOT,
        llm=StubLLM(),
        market=_market_with(_IN_MEMORY_ECHO_ENTRY),
    )
    try:
        ctx = ScriptedApprovalCtx()

        # ── ① 注入（boot_prompt 定稿形态 + 种子基线）──
        assert host.boot_prompt["prompt"] == BOOT_PROMPT_FINAL
        assert host.boot_prompt["name"] == "inkling.boot_prompt"
        seeds = [e for e in runtime.knowledge_set.entries() if e.id.startswith("seed.")]
        assert seeds  # 通用 + 领域种子注入生效
        ui = runtime.introspection_service.snapshot_ui()["ui_spec"]
        assert ui["name"] == "boot.panel"

        # ── ② 挂载（设置页一键挂载：市场 → vetting → L2 → 补丁链）──
        tool_name = await _mount_echo(runtime, mount_service, ctx)
        text = await _call_tool(runtime, ctx, tool_name, {"message": "闭环"})
        assert text == "echo: 闭环"
        audit = await runtime.self_pipeline.audit_log()
        assert audit[-1]["status"] == "applied"  # 挂载补丁审计留痕

        # ── ③ 回合（计划执行：plan_start → 工具流水线 → 决议续跑）──
        events = await _round_to_reply(runtime, host, "loop-round-1")
        assert any(e.type == "plan_start" for e in events)
        assert any(e.type == "tool_start" for e in events)
        assert any(e.type == "tool_end" for e in events)  # 工具执行留痕
        assert any(e.type == "review_card" for e in events)  # 审批卡流程

        # ── ④ 推演（simulate_decision 分支对比 + 评估择优）──
        simulate_events = await _run_simulate()
        assert simulate_events

        # ── ⑤ 孵化（信号 → 蒸馏 → 三层闸门 → 落库）──
        signals = host.incubation.classify(
            [
                {"type": "review_pass", "message": "评审通过：来源可追溯",
                 "source": "model"},
                {"type": "tool_error", "message": "一次预期外失败（教训来源）",
                 "source": "model"},
            ]
        )
        assert host.incubation.should_distill(complexity=6)
        decision = host.incubation.distill(signals, "来源可追溯的评审经验")
        assert decision.distilled is not None  # 未命中复用 → 蒸馏产出
        entry = entry_from_distill(decision.distilled, "k.loop.incubated")
        l1, l2, l3 = await host.incubation.verify_gate(entry)
        assert l1.passed and l2.passed and l3.passed
        landed = await host.incubation.sediment(entry)
        assert runtime.knowledge_set.get(landed.id) is not None  # 沉淀落库

        # ── ⑥ 补丁（审批卡 → KNOWLEDGE 补丁落链）──
        outcome = await host.incubation.propose_knowledge_patch(
            ctx, entry, "e2e 全链路：孵化沉淀自指挂载", round_id="loop-patch"
        )
        assert outcome.applied
        assert "patch:knowledge" in ctx.card_keys  # 审批卡留痕
        assert runtime.knowledge_set.get(entry.id) is not None

        # ── ⑦ 回退（补丁链链尾折叠 → 活跃态撤销 + 审计）──
        reverted = await runtime.self_pipeline.revert(
            ctx, outcome.patch_id, reason="e2e 全链路回退"
        )
        assert reverted.status == "reverted"
        assert runtime.knowledge_set.get(entry.id) is None  # 活跃态撤销
        audit = await runtime.self_pipeline.audit_log()
        assert audit[-1]["status"] == "reverted"

        # ── ⑧ 断线续流（新线程挂卡 → resume_run 逐卡重入）──
        resume_events = await _round_to_reply(runtime, host, "loop-round-2")
        assert any(e.type == "review_card" for e in resume_events)

        # ── ⑨ 链压缩（checkpoint 链窗口折叠：历史前缀归档）──
        links = await runtime.storage.chain_index("loop-round-2")
        full_count = len(links)
        outcome = await maybe_compact_chain(runtime.storage, "loop-round-2", keep=2)
        assert outcome.compacted
        after = await runtime.storage.chain_index("loop-round-2")
        assert len(after) < full_count  # 窗口外历史前缀折叠
        assert outcome.removed > 0

        # ── ⑩ 调优（回合指标聚合 → 参数调整 → 快照）──
        tune_result = await _run_tuning()
        assert tune_result.changes  # 低分反馈降权生效
        assert tune_result.snapshot is not None  # 参数快照可回放

        # ── ⑪ 领域长出（新规则经样例闸门放行 → 自指挂载 → 可回退）──
        new_rule = KnowledgeEntry(
            id="k.loop.grown_rule",
            level="work",
            kind="rule",
            data={
                "rule": {
                    "id": "rule.loop.grown_rule",
                    "predicate": "present",
                    "config": {"path": "title", "message": "材料须含标题字段"},
                    "type": "constraint",
                    "target_path": "material",
                    "severity": "error",
                }
            },
            source="model",
            title="领域长出的新规则",
        )
        l1, l2, l3 = await host.incubation.verify_gate(new_rule)
        assert l1.passed and l2.passed and l3.passed  # 样例闸门放行
        await host.incubation.sediment(new_rule)
        grown = await host.incubation.propose_knowledge_patch(
            ctx, new_rule, "e2e 领域长出：样例放行后自指挂载", round_id="loop-grown"
        )
        assert grown.applied
        rules = runtime.introspection_service.snapshot_rules()["rules"]
        assert any(r["id"] == "rule.loop.grown_rule" for r in rules)
        # 长出可回退（链尾折叠撤销）
        undone = await runtime.self_pipeline.revert(
            ctx, grown.patch_id, reason="e2e 领域长出回退"
        )
        assert undone.status == "reverted"
    finally:
        await runtime.stop()


async def _run_simulate() -> list[Any]:
    """推演分支对比（与宿主图配方同源的直接 Engine 装配）。

    运行时级评估器注入（Runtime 引擎的 RunOptions 无评估器）为遗留待议
    ——本步骤用执行域装配形态钉住推演机制（simulate_decision 事件 +
    评估择优），见最终报告遗留清单。
    """
    from helpers import (
        build_ctx,
        build_round_graph,
        build_test_pipeline,
        domain_tool_specs,
        make_collector,
        orc_subgraph,
        review_scorer,
    )

    registries = GraphRegistries()
    pipeline = build_test_pipeline({"collect_material": "材料已取回"})
    graph = build_round_graph(
        build_ctx(
            pipeline=pipeline,
            tool_specs=domain_tool_specs(),
            registries=registries,
        )
    )
    engine = Engine(
        graph,
        options=RunOptions(
            registries=registries,
            evaluator=review_scorer(),
            simulate_concurrency=2,
        ),
    )
    transport = make_collector()

    def branch(index: int, description: str, **scores: float) -> dict[str, Any]:
        state = {f"score:{k}": v for k, v in scores.items()}
        return {
            "subgraph": orc_subgraph("collect_material"),
            "state": state,
            "index": index,
            "description": description,
        }

    result = await engine.ainvoke(
        {
            "input": "推演分支对比",
            "orchestrate": {
                "simulate": {
                    "step_id": "dec-loop",
                    "budget": 4000,
                    "branches": [
                        branch(
                            0, "低分分支",
                            citation_quality=0.4, consistency=0.4, readability=0.4,
                        ),
                        branch(
                            1, "高分分支",
                            citation_quality=0.9, consistency=0.9, readability=0.9,
                        ),
                    ],
                }
            },
        },
        thread_id="loop-simulate",
        round_id="round-simulate",
        transports=[transport],
    )
    assert result.reason == "reply"
    decisions = [e for e in transport.events if e.type == "simulate_decision"]
    assert decisions
    assert decisions[-1].payload["selected"] == [1]  # 评估择优选中高分分支
    scores = {b["index"]: b["score"] for b in decisions[-1].payload["branches"]}
    assert scores[1] >= 0.75  # review.json pass_threshold 语义
    return decisions


async def _run_tuning() -> Any:
    """调优一步：回合指标 → 参数调整（低分反馈降权）+ 快照。"""
    from ink_engine.core.knowledge_gate import KnowledgeGate
    from ink_engine.core.rules import FixtureCase, FixtureSet
    from ink_engine.core.tuning import ParamRegressionExecutor

    gate = KnowledgeGate(l2_executor=ParamRegressionExecutor())
    fixtures = FixtureSet(
        name="param-regression",
        cases=(
            FixtureCase(
                id="weight_floor",
                data={
                    "bounds": {
                        "weights": {"min": 0.1, "max": 1.0},
                        "thresholds": {"min": 0.0, "max": 10.0},
                    }
                },
                expected_pass=True,
            ),
        ),
    )
    params = TunableParams(
        weights={"quality": 0.5, "consistency": 0.5},
        thresholds={"pass": 0.6},
    )
    metrics = TurnMetrics()
    metrics.record_turn()
    metrics.record_review(0.9)
    result = await MetaTuner().tune_with_regression(
        params,
        metrics,
        fixtures,
        feedback={"quality": 0.2},  # 低分反馈 → quality 降权
        rule_version="rules-v-loop",
        gate=gate,
    )
    assert result.params.weights["quality"] < 0.5  # 降权生效
    return result


@pytest.mark.skipif(
    not (SEED_ROOT / "exec" / "target" / "debug" / "inkling_exec.exe").is_file(),
    reason="Rust 执行件未构建（cargo build 后重跑）",
)
async def test_full_loop_stdio_rust_exec():
    """全链路（stdio 真 Rust 执行件）：注入 → 挂载 → 真实执行件调用闭环。"""
    binary = SEED_ROOT / "exec" / "target" / "debug" / "inkling_exec.exe"
    entry = {
        "id": "inkling_exec",
        "name": "InKling Rust 执行件（本产品）",
        "source": "本仓库构建产物",
        "transport": "stdio",
        "url": None,
        "command": str(binary),
        "args": [],
        "credentials": {"required": False},
        "risk": "low",
        "risk_note": "产品自带执行件，命令白名单声明在市场内",
        "category": "executor",
        "premounted": False,
    }
    runtime, host, mount_service = await boot_inkling(
        SEED_ROOT, llm=StubLLM(), market=_market_with(entry)
    )
    try:
        # 注入定稿形态（与嵌入式闭环同一断言）
        assert host.boot_prompt["prompt"] == BOOT_PROMPT_FINAL
        ctx = ScriptedApprovalCtx()
        outcome = await mount_service.propose_mount(ctx, "inkling_exec")
        assert outcome.ok, outcome.error
        assert outcome.status == "mounted"
        assert any(name.startswith("inkling_") for name in outcome.tool_names)
        # 真实执行件经统一流水线调用（initialize → tools/list → tools/call）
        spec = runtime.tool_registry["inkling_collect"]
        result = await runtime.tool_pipeline.execute(
            ctx, spec, {"source": "text", "text": "墨引擎机制"}
        )
        assert result.ok
        payload = json.loads(result.output)
        assert payload.get("ok") is True
        assert payload.get("content")
        await mount_service.unmount(ctx, "inkling_exec")
        assert "inkling_collect" not in runtime.tool_registry  # 卸载撤销
    finally:
        await runtime.stop()
