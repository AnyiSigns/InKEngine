"""回合中止 API 单测：abort_current_run（取消 → CANCELLED 快照 → 续跑）。

覆盖：无在途 run 幂等 no-op；在途 run 中止后任务收到 CancelledError
且在途节点收尾；中止后以 CANCELLED 终态快照落链（不覆盖/不破坏
既有 checkpoint 链）；中止后从快照续跑（被中止节点重新执行）；
与 pause 正交（中止不影响生命周期状态）；stop 与中止互不冲突。
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

import pytest

from ink_engine.core.approval import DefaultInterruptPolicy
from ink_engine.core.event_types import EventTypeSpec
from ink_engine.core.graph import Graph, TerminateReason
from ink_engine.core.harness import HarnessDefinition
from ink_engine.core.llm import AsyncLLM
from ink_engine.core.runtime import (
    AssemblyRecipe,
    GraphRecipeContext,
    Runtime,
    RuntimeState,
    ToolWiring,
)
from ink_engine.core.self_application import ApprovalLevel
from ink_engine.core.self_proposal import PatchKind
from ink_engine.core.self_tools import (
    make_self_executor,
    operation_of,
    self_tool_specs,
)
from ink_engine.core.storage import create_storage
from ink_engine.seeds.boot import BOOT_UI_SPEC, build_boot_seed_entries


@dataclass
class FakeHost:
    """Host 五件套 mock（真实会话需 boot 装配，五件套只是薄壳）。"""

    llm: AsyncLLM | None = None
    policy: Any = field(default_factory=DefaultInterruptPolicy)

    async def create_storage(self) -> Any:
        return create_storage("memory://")

    async def resolve_llm(self) -> AsyncLLM | None:
        return self.llm

    def interrupt_policy(self) -> Any:
        return self.policy

    def build_transport(self) -> Any:
        class _NoopTransport:
            async def send(self, event: Any) -> None:
                return None

        return _NoopTransport()

    async def close(self) -> None:
        return None


def _gate_recipe(spec: dict[str, Any]) -> AssemblyRecipe:
    """带中止测试图（start → slow gate → end）的装配配方。"""

    def graph_recipe(ctx: GraphRecipeContext) -> Graph:
        gate = spec["gate"]
        nodes_done = spec.get("nodes_done")
        if nodes_done is None:
            nodes_done = []

        async def start(ctx) -> dict:
            return {"stage": "start", "attempt": 0}

        async def slow(ctx) -> dict:
            nodes_done.append("slow")
            await gate.wait()  # 门控：测试等待节点进入后可放行/中止
            return {"stage": "done", "attempt": ctx.state.get("attempt", 0) + 1}

        async def end(ctx) -> dict:
            nodes_done.append("end")
            return {"stage": "end"}

        g = Graph(name="abort_probe", entry="start")
        g.add_node("start", start)
        g.add_node("slow", slow)
        g.add_node("end", end)
        g.add_edge("start", "slow")
        g.add_edge("slow", "end")
        g.add_exit("end")
        return g

    return AssemblyRecipe(
        set_id="default",
        seeds=[("boot", build_boot_seed_entries)],
        harness_definitions=[
            HarnessDefinition(name="forge", description="自举领域", keywords=("自举",))
        ],
        event_type_specs=[EventTypeSpec(name="reply_token", renderer="StreamingRow")],
        ui_spec=BOOT_UI_SPEC,
        ui_allowed_components=("column", "message_list", "agent_input"),
        ui_allowed_theme_tokens=("bg", "fg", "accent"),
        tool_wiring=ToolWiring(
            self_specs=self_tool_specs,
            self_executor_factory=make_self_executor,
            self_operation_of=operation_of,
        ),
        approval_levels={PatchKind.THEME: ApprovalLevel.L0},
        graph_recipe=graph_recipe,
    )


async def test_abort_noop_without_active_run():
    runtime = await Runtime().boot(FakeHost(), _gate_recipe({"gate": asyncio.Event()}))
    assert await runtime.abort_current_run() is False
    assert runtime.state is RuntimeState.RUNNING


async def test_abort_cancels_inflight_and_writes_cancelled_snapshot():
    gate = asyncio.Event()
    nodes_done: list[str] = []
    runtime = await Runtime().boot(
        FakeHost(), _gate_recipe({"gate": gate, "nodes_done": nodes_done})
    )
    engine = runtime.engine

    async def run_coro():
        ticket = runtime.begin_run(thread_id="t-abort")
        try:
            return await engine.ainvoke({}, thread_id="t-abort", round_id="r1")
        finally:
            runtime.end_run(ticket)

    task = asyncio.create_task(run_coro())
    # 等 run 真正进入 slow 节点（在途节点执行中）
    for _ in range(100):
        if "slow" in nodes_done:
            break
        await asyncio.sleep(0.01)
    assert "slow" in nodes_done

    aborted = await runtime.abort_current_run()
    assert aborted is True
    # run 任务收到 CancelledError（在途节点收尾，不是正常返回）
    with pytest.raises(asyncio.CancelledError):
        await task
    assert nodes_done == ["slow"]  # 节点未完成（gate 未放行）

    # CANCELLED 终态快照落链：链延续既有 checkpoint（start 已完成）
    latest = await runtime.storage.get_latest_checkpoint("t-abort")
    assert latest is not None
    assert latest.reason == TerminateReason.CANCELLED
    assert latest.state.get("stage") == "start"  # start 节点增量提交
    assert latest.parent_id is not None  # 续接链尾，不破坏版本链

    # 中止后可从快照续跑：被中止的 slow 节点重新执行（放行门控
    # 模拟中断点条件已满足后的重跑）
    gate.set()
    resumed = await runtime.engine.ainvoke(
        {}, thread_id="t-abort", resume_from=latest.checkpoint_id
    )
    assert resumed.reason == TerminateReason.REPLY
    assert resumed.state.get("stage") == "end"
    assert nodes_done == ["slow", "slow", "end"]  # slow 重跑 + end 完成


async def test_abort_second_call_noop_after_run_finished():
    """中止后再次调用 = no-op（在途已清空），不重复写快照。"""
    gate = asyncio.Event()
    gate.set()  # 放行节点（本测试需要 run 自然完成）
    runtime = await Runtime().boot(FakeHost(), _gate_recipe({"gate": gate}))
    result = await runtime.engine.ainvoke({}, thread_id="t-done", round_id="r")
    assert result.reason == TerminateReason.REPLY
    # 无在途 run（未 begin_run）：no-op
    assert await runtime.abort_current_run() is False


async def test_abort_does_not_change_lifecycle_state():
    """中止与 pause 正交：不改变生命周期状态机。"""
    gate = asyncio.Event()
    runtime = await Runtime().boot(FakeHost(), _gate_recipe({"gate": gate}))
    assert runtime.state is RuntimeState.RUNNING

    async def run_coro():
        ticket = runtime.begin_run(thread_id="t-lc")
        try:
            return await runtime.engine.ainvoke({}, thread_id="t-lc")
        finally:
            runtime.end_run(ticket)

    task = asyncio.create_task(run_coro())
    await asyncio.sleep(0.05)
    assert await runtime.abort_current_run() is True
    with pytest.raises(asyncio.CancelledError):
        await task
    assert runtime.state is RuntimeState.RUNNING  # 中止不改生命周期状态


async def test_abort_then_stop_still_drains():
    """中止后 stop 排空流程不受影响（在途登记正常注销）。"""
    gate = asyncio.Event()
    runtime = await Runtime().boot(FakeHost(), _gate_recipe({"gate": gate}))

    async def run_coro():
        ticket = runtime.begin_run(thread_id="t-s")
        try:
            return await runtime.engine.ainvoke({}, thread_id="t-s")
        finally:
            runtime.end_run(ticket)

    task = asyncio.create_task(run_coro())
    await asyncio.sleep(0.05)
    await runtime.abort_current_run()
    with pytest.raises(asyncio.CancelledError):
        await task
    await runtime.stop()  # 无悬挂登记 → 立即关停（幂等）
    assert runtime.state is RuntimeState.STOPPED


async def test_abort_without_thread_id_skips_snapshot(caplog):
    """未登记线程 id（begin_run() 不带参数）时中止仍取消任务，跳过快照。"""
    import logging

    gate = asyncio.Event()
    runtime = await Runtime().boot(FakeHost(), _gate_recipe({"gate": gate}))

    async def run_coro():
        ticket = runtime.begin_run()
        try:
            return await runtime.engine.ainvoke({}, thread_id="t-nt")
        finally:
            runtime.end_run(ticket)

    task = asyncio.create_task(run_coro())
    await asyncio.sleep(0.05)
    with caplog.at_level(logging.WARNING, logger="ink_engine.core.runtime"):
        assert await runtime.abort_current_run() is True
    with pytest.raises(asyncio.CancelledError):
        await task
    assert any("跳过 CANCELLED 终止快照" in r.message for r in caplog.records)
