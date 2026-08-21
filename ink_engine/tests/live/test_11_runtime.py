"""族 11：运行时机壳（test_11_runtime.py）｜Host 五件套 + boot 装配 /
生命周期 / 在途 run / 决议重入 / 引擎重建缓存 / stop 排空。

- Host 五件套契约 + boot 装配幂等
- begin_run/end_run 登记；pause 拒新 run 不打断在途 run
- resume_run 决议重入（真实回合挂卡 → 注入决议 → 收口）
- rebuild_engine 缓存语义（配置/工具表不变复用，变更才重建）
- stop 排在途完成并按序关停（MCP → 存储 → 宿主钩子）

`real` 标记 = 真实 LLM 调用（族门禁②：Host 装配 + 真实回合挂卡 +
resume_run 重入收口 + end_run/stop，LLM 调用 1 次）；其余为确定性机制
用例（零费用）。
"""
from __future__ import annotations

import asyncio
import dataclasses
from dataclasses import dataclass, field
from typing import Any

import pytest

pytestmark = pytest.mark.live

from ink_engine.core.approval import DefaultInterruptPolicy  # noqa: E402
from ink_engine.core.event_types import EventTypeSpec  # noqa: E402
from ink_engine.core.graph import Graph  # noqa: E402
from ink_engine.core.harness import HarnessDefinition  # noqa: E402
from ink_engine.core.llm import AsyncLLM  # noqa: E402
from ink_engine.core.llm.messages import user  # noqa: E402
from ink_engine.core.runtime import (  # noqa: E402
    AssemblyRecipe,
    GraphRecipeContext,
    Runtime,
    RuntimeState,
    ToolWiring,
)
from ink_engine.core.self_application import ApprovalLevel  # noqa: E402
from ink_engine.core.self_proposal import PatchKind  # noqa: E402
from ink_engine.core.self_tools import (  # noqa: E402
    make_self_executor,
    operation_of,
    self_tool_specs,
)
from ink_engine.core.storage import create_storage  # noqa: E402
from ink_engine.seeds.boot import BOOT_UI_SPEC, build_boot_seed_entries  # noqa: E402


class FakeTransport:
    """Host 传输工厂产物（事件收集；EngineTransport 协议）。"""

    def __init__(self) -> None:
        self.events: list = []

    async def send(self, event: Any) -> None:
        self.events.append(event)


@dataclass
class FakeHost:
    """Host 五件套 mock（调用留痕；可注入真实模型/策略）。"""

    calls: list[str] = field(default_factory=list)
    llm: AsyncLLM | None = None
    policy: Any = field(default_factory=DefaultInterruptPolicy)

    async def create_storage(self) -> Any:
        self.calls.append("create_storage")
        return create_storage("memory://")

    async def resolve_llm(self) -> AsyncLLM | None:
        self.calls.append("resolve_llm")
        return self.llm

    def interrupt_policy(self) -> Any:
        self.calls.append("interrupt_policy")
        return self.policy

    def build_transport(self) -> Any:
        self.calls.append("build_transport")
        return FakeTransport()

    async def close(self) -> None:
        self.calls.append("host_close")


async def _echo_agent(ctx) -> dict:
    return {"reply": "ok"}


def _echo_graph_recipe(ctx: GraphRecipeContext) -> Graph:
    g = Graph(name="echo", entry="agent")
    g.add_node("agent", _echo_agent)
    g.add_exit("agent")
    return g


async def _gate_agent(ctx) -> dict:
    decision = await ctx.interrupt("approval", {"review_type": "gate"})
    return {"decision": decision, "done": True}


def _gate_graph_recipe(ctx: GraphRecipeContext) -> Graph:
    g = Graph(name="gate", entry="gate")
    g.add_node("gate", _gate_agent)
    g.add_exit("gate")
    return g


def _real_gate_graph_recipe(ctx: GraphRecipeContext) -> Graph:
    """真实 LLM 回合图：节点持真实模型 → 挂卡 → 收口。"""

    async def llm_node(c):
        result = await ctx.llm.ainvoke(
            [user("请用一句话回答：什么是引擎运行态？")]
        )
        return {"answer": result.content}

    async def gate(c):
        decision = await c.interrupt("approval", {"review_type": "gate"})
        return {"decision": decision, "done": True}

    async def final(c):
        return {"phase": "done"}

    g = Graph(name="rt_real", entry="llm_node")
    g.add_node("llm_node", llm_node)
    g.add_node("gate", gate)
    g.add_node("final", final)
    g.add_edge("llm_node", "gate")
    g.add_edge("gate", "final")
    g.add_exit("final")
    return g


def _minimal_recipe(**overrides) -> AssemblyRecipe:
    base = AssemblyRecipe(
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
        graph_recipe=_echo_graph_recipe,
    )
    return dataclasses.replace(base, **overrides)


class _RecordingStorage:
    """存储包装：记录 close 调用（关停顺序断言用）。"""

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.closed = False

    async def close(self) -> None:
        self.closed = True
        await self._inner.close()


# ----------------------------------------------------------------------
# Host 五件套 + boot 装配幂等
# ----------------------------------------------------------------------

async def test_host_contract_all_five_methods():
    """Host 五件套契约齐备（存储/模型/策略/传输/关停均可调用）。"""
    host = FakeHost()
    storage = await host.create_storage()
    assert storage is not None
    assert await host.resolve_llm() is None
    assert host.interrupt_policy() is host.policy
    transport = host.build_transport()
    assert isinstance(transport, FakeTransport)
    await host.close()
    assert host.calls[-1] == "host_close"


async def test_boot_assembly_idempotent():
    """boot 装配产物齐全且幂等（已装配再次调用直接返回自身）。"""
    host = FakeHost()
    runtime = Runtime()
    first = await runtime.boot(host, _minimal_recipe())
    assert runtime.state is RuntimeState.RUNNING
    assert runtime.storage is not None
    assert runtime.engine is not None
    assert runtime.knowledge_set.get("seed.boot.system_prompt") is not None
    assert "forge" in runtime.harness_registry.names()
    assert "reply_token" in runtime.event_type_registry.names()
    second = await runtime.boot(FakeHost(), _minimal_recipe())
    assert first is runtime and second is runtime
    assert host.calls.count("create_storage") == 1


# ----------------------------------------------------------------------
# begin_run / end_run / pause
# ----------------------------------------------------------------------

async def test_begin_end_run_lifecycle():
    """begin_run 发放凭证、end_run 注销（在途登记表增减）。"""
    runtime = await Runtime().boot(FakeHost(), _minimal_recipe())
    ticket = runtime.begin_run()
    assert ticket.id in runtime._active_runs
    runtime.end_run(ticket)
    assert ticket.id not in runtime._active_runs


async def test_pause_rejects_new_run_keeps_inflight():
    """pause 拒新 run、不打断在途 run（在途自然完成后 end_run 放行）。"""
    runtime = await Runtime().boot(FakeHost(), _minimal_recipe())
    ticket = runtime.begin_run()
    runtime.pause()
    with pytest.raises(RuntimeError, match="不允许开始新 run"):
        runtime.begin_run()
    runtime.end_run(ticket)
    runtime.resume()
    ticket2 = runtime.begin_run()
    runtime.end_run(ticket2)


# ----------------------------------------------------------------------
# resume_run 决议重入（确定性样板）
# ----------------------------------------------------------------------

async def test_resume_run_decision_reentry():
    """resume_run：挂起 → 决议注入 → 续跑（无卡显式报错）。"""
    runtime = await Runtime().boot(
        FakeHost(), _minimal_recipe(graph_recipe=_gate_graph_recipe)
    )
    result = await runtime.engine.ainvoke(
        {"input": "x"}, thread_id="t-gate", round_id="r-gate"
    )
    assert result.interrupt is not None
    assert result.interrupt.key == "approval"
    with pytest.raises(RuntimeError, match="无挂起审批卡"):
        await runtime.resume_run("t-empty", {"decision": "accept"})
    resumed = await runtime.resume_run("t-gate", {"decision": "accept"})
    assert resumed.interrupt is None
    assert resumed.state.get("done") is True
    assert resumed.state.get("decision") == {"decision": "accept"}


# ----------------------------------------------------------------------
# rebuild_engine 缓存语义
# ----------------------------------------------------------------------

async def test_rebuild_engine_caches_by_config():
    """引擎重建缓存：模型/工具表不变复用实例，变更才重建。"""
    host = FakeHost()
    runtime = await Runtime().boot(host, _minimal_recipe())
    first = runtime.engine
    assert await runtime.rebuild_engine() is first

    class _FakeLLM:
        async def astream(self, messages, *, tools=None, params=None):
            return
            yield

        async def aclose(self) -> None:
            pass

    new_llm = _FakeLLM()
    rebuilt = await runtime.rebuild_engine(new_llm)
    assert rebuilt is not first
    assert runtime.engine_llm is new_llm
    runtime.tool_registry["injected_tool"] = self_tool_specs()[0]
    rebuilt2 = await runtime.rebuild_engine(new_llm)
    assert rebuilt2 is not rebuilt
    runtime.tool_registry.clear()
    rebuilt3 = await runtime.rebuild_engine(new_llm)
    assert rebuilt3 is not rebuilt2
    assert await runtime.rebuild_engine(new_llm) is rebuilt3


# ----------------------------------------------------------------------
# stop 排空顺序
# ----------------------------------------------------------------------

async def test_stop_drains_inflight_runs():
    """stop 排在途完成：在途未注销时等待，注销后完成关停。"""
    runtime = await Runtime().boot(FakeHost(), _minimal_recipe())
    ticket = runtime.begin_run()
    stopping = asyncio.create_task(runtime.stop())
    await asyncio.sleep(0)
    assert not stopping.done()
    runtime.end_run(ticket)
    await asyncio.wait_for(stopping, timeout=5)
    assert runtime.state is RuntimeState.STOPPED


async def test_stop_shutdown_order():
    """关停顺序：MCP 会话 → 存储 → 宿主 close 钩子。"""
    host = FakeHost()
    runtime = await Runtime().boot(host, _minimal_recipe())
    mcp_closed: list[str] = []
    original_close_all = runtime.mcp_manager.close_all

    async def _record_close_all():
        mcp_closed.append("mcp")
        return await original_close_all()

    runtime.mcp_manager.close_all = _record_close_all
    recorder = _RecordingStorage(runtime.storage)
    runtime.storage = recorder
    await runtime.stop()
    assert mcp_closed == ["mcp"]
    assert recorder.closed
    assert host.calls[-1] == "host_close"
    assert runtime.state is RuntimeState.STOPPED


# ----------------------------------------------------------------------
# 真实 LLM 回合 + 决议重入（族门禁②）
# ----------------------------------------------------------------------

@pytest.mark.real
async def test_real_host_assembly_resume_run(live_llm):
    """Host 装配 + begin_run → 真实 LLM 回合（节点挂卡）→ resume_run
    重入收口 → end_run/stop（LLM 调用 1 次，行为契约断言）。"""
    host = FakeHost(llm=live_llm)
    runtime = await Runtime().boot(
        host, _minimal_recipe(graph_recipe=_real_gate_graph_recipe)
    )
    ticket = runtime.begin_run()
    result = await runtime.engine.ainvoke(
        {"input": "x"}, thread_id="t-real", round_id="r-real"
    )
    assert result.interrupt is not None and result.interrupt.key == "approval"
    assert result.state["answer"], "真实 LLM 产出缺失"
    resumed = await runtime.resume_run("t-real", {"decision": "accept"})
    assert resumed.interrupt is None
    assert resumed.state.get("done") is True
    assert resumed.state.get("decision") == {"decision": "accept"}
    runtime.end_run(ticket)
    await runtime.stop()
    assert runtime.state is RuntimeState.STOPPED
