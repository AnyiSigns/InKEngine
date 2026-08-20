"""运行时单测：Host 契约五件套 + 装配数据 + 生命周期状态机。

覆盖：boot 幂等装配与产物齐全；Host mock 全五件套调用；状态机转换
矩阵（非法转换显式拒绝）；pause 拒新不打断在途；stop 排空在途且按
序关停（MCP → 存储 → 宿主钩子）且幂等；resume_run 决议重入样板
（挂起 → 注入 → 续跑）；引擎重建缓存（配置/工具表变更才重建）；
装配配方缺件显式报错。
"""
from __future__ import annotations

import asyncio
import dataclasses
from dataclasses import dataclass, field
from typing import Any

import pytest

from ink_engine.core.approval import DefaultInterruptPolicy
from ink_engine.core.event_types import EventTypeSpec
from ink_engine.core.graph import Graph
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


class FakeTransport:
    """Host 传输工厂的产物（事件收集；EngineTransport 协议）。"""

    def __init__(self) -> None:
        self.events: list = []

    async def send(self, event: Any) -> None:
        self.events.append(event)


@dataclass
class FakeHost:
    """Host 五件套 mock（调用留痕供顺序断言；可注入假模型/策略）。"""

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


class _RecordingStorage:
    """存储包装：记录 close 调用（关停顺序断言用；仅转发关闭）。"""

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.closed = False

    async def close(self) -> None:
        self.closed = True
        await self._inner.close()


async def _echo_agent(ctx) -> dict:
    await ctx.emit("reply_token", {"token": "ok"}, step_id="reply:1")
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


def _minimal_recipe(**overrides) -> AssemblyRecipe:
    """最小配方（默认 echo 图；测试按需覆盖图/种子/白名单等字段）。"""
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


async def test_host_contract_all_five_methods():
    """Host 五件套契约齐备（存储/模型/策略/传输/关停钩子均可调用）。"""
    host = FakeHost()
    storage = await host.create_storage()
    assert storage is not None
    assert await host.resolve_llm() is None
    assert host.interrupt_policy() is host.policy
    transport = host.build_transport()
    assert isinstance(transport, FakeTransport)
    await host.close()
    assert host.calls[-1] == "host_close"


async def test_boot_assembles_all_artifacts():
    """配方注入后装配产物齐全（存储/注册表/种子/harness/事件/元工具/管线）。"""
    host = FakeHost()
    runtime = await Runtime().boot(host, _minimal_recipe())
    assert runtime.state is RuntimeState.RUNNING
    assert host.calls[0] == "create_storage"
    assert runtime.storage is not None
    assert runtime.guard_token is not None
    assert runtime.graph_registries is not None
    # 种子注入（通用基线 + boot 领域种子）
    assert len(runtime.knowledge_set.entries()) > 0
    assert runtime.knowledge_set.get("seed.boot.system_prompt") is not None
    # harness 注册 + 落库
    assert "forge" in runtime.harness_registry.names()
    saved = await runtime.harness_repository.get("forge")
    assert saved is not None and saved.name == "forge"
    # 事件类型注册表（基线 + 装配期持久化）
    assert "reply_token" in runtime.event_type_registry.names()
    # 元工具流水线（内省 5 + 契约自指 4）
    assert len(runtime.introspection_specs) == 5
    assert len(runtime.self_specs) == 4
    assert runtime.introspection_service is not None
    assert runtime.introspection_pipeline is not None
    assert runtime.self_pipeline is not None
    assert runtime.self_pipeline_runner is not None
    assert runtime.retriever_registry is not None
    assert runtime.mcp_manager is not None
    assert runtime.tool_pipeline is not None
    # 引擎已重建（图可观察）
    assert runtime.engine is not None
    assert runtime.engine_llm is None  # 未配置模型 → None（路由端引导）
    # 界面基线经白名单校验后装配（未回落未定形）
    snapshot = runtime.introspection_service.snapshot_ui()
    assert snapshot["ui_spec"] is not None


async def test_boot_is_idempotent():
    """boot 幂等：已装配再次调用直接返回自身（装配动作不重复执行）。"""
    host = FakeHost()
    runtime = Runtime()
    first = await runtime.boot(host, _minimal_recipe())
    second = await runtime.boot(FakeHost(), _minimal_recipe())
    assert first is runtime and second is runtime
    assert host.calls.count("create_storage") == 1


async def test_boot_rejects_incomplete_recipe():
    """配方缺件显式报错（工具三路/图配方为装配非谈判项）。"""
    with pytest.raises(RuntimeError, match="tool_wiring"):
        await Runtime().boot(
            FakeHost(), _minimal_recipe(tool_wiring=None)
        )
    with pytest.raises(RuntimeError, match="graph_recipe"):
        await Runtime().boot(
            FakeHost(), _minimal_recipe(graph_recipe=None)
        )


async def test_state_transition_matrix():
    """状态机转换矩阵：合法转换通过，非法转换显式拒绝。"""
    runtime = await Runtime().boot(FakeHost(), _minimal_recipe())
    # running → paused（pause 合法；paused 再 pause 非法）
    runtime.pause()
    assert runtime.state is RuntimeState.PAUSED
    with pytest.raises(RuntimeError, match="非法状态转换"):
        runtime.pause()
    # paused → running（resume 合法；running 再 resume 非法）
    runtime.resume()
    assert runtime.state is RuntimeState.RUNNING
    with pytest.raises(RuntimeError, match="非法状态转换"):
        runtime.resume()
    # running → paused → stopped（paused 可直接关停）
    runtime.pause()
    await runtime.stop()
    assert runtime.state is RuntimeState.STOPPED
    # stop 幂等
    await runtime.stop()
    assert runtime.state is RuntimeState.STOPPED
    # 停后不可恢复/不可暂停（非法转换显式拒绝）
    with pytest.raises(RuntimeError, match="非法状态转换"):
        runtime.resume()
    with pytest.raises(RuntimeError, match="非法状态转换"):
        runtime.pause()


async def test_pause_rejects_new_run_keeps_inflight():
    """pause 拒新 run、不打断在途 run（在途自然完成后 end_run 放行）。"""
    runtime = await Runtime().boot(FakeHost(), _minimal_recipe())
    ticket = runtime.begin_run()
    runtime.pause()
    with pytest.raises(RuntimeError, match="不允许开始新 run"):
        runtime.begin_run()
    runtime.end_run(ticket)  # 在途登记注销不受 pause 影响
    runtime.resume()
    ticket2 = runtime.begin_run()
    runtime.end_run(ticket2)


async def test_stop_drains_inflight_runs():
    """stop 排在途完成：在途未注销时等待，注销后完成关停。"""
    runtime = await Runtime().boot(FakeHost(), _minimal_recipe())
    ticket = runtime.begin_run()
    stopping = asyncio.create_task(runtime.stop())
    await asyncio.sleep(0)
    assert not stopping.done()  # 在途未完成 → 等待排空
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


async def test_resume_run_decision_reentry():
    """resume_run：挂起 → 决议注入 → 续跑（样板：挂起卡 → 锚点 → 重入）。"""
    runtime = await Runtime().boot(
        FakeHost(), _minimal_recipe(graph_recipe=_gate_graph_recipe)
    )
    result = await runtime.engine.ainvoke(
        {"input": "x"}, thread_id="t-gate", round_id="r-gate"
    )
    assert result.interrupt is not None
    assert result.interrupt.key == "approval"
    # 无挂起卡时显式报错（宿主转用户可读拒绝）
    with pytest.raises(RuntimeError, match="无挂起审批卡"):
        await runtime.resume_run("t-empty", {"decision": "accept"})
    # 决议注入重入
    resumed = await runtime.resume_run("t-gate", {"decision": "accept"})
    assert resumed.interrupt is None
    assert resumed.state.get("done") is True
    assert resumed.state.get("decision") == {"decision": "accept"}


async def test_resume_run_rejects_stale_card():
    """挂起卡已失效（链尾非挂起卡）显式报错，不静默重放。"""
    runtime = await Runtime().boot(FakeHost(), _minimal_recipe())
    await runtime.engine.ainvoke({"input": "x"}, thread_id="t-ok", round_id="r-ok")
    with pytest.raises(RuntimeError, match="无挂起审批卡"):
        await runtime.resume_run("t-ok", {"decision": "accept"})


async def test_rebuild_engine_caches_by_config():
    """引擎重建缓存：模型/工具表不变复用实例，变更才重建。"""
    host = FakeHost()
    runtime = await Runtime().boot(host, _minimal_recipe())
    first = runtime.engine
    assert await runtime.rebuild_engine() is first  # 同配置（同 llm 对象）复用

    class _FakeLLM:
        async def astream(self, messages, *, tools=None, params=None):
            return
            yield  # 空流（async generator 形态；永不产出增量）

        async def aclose(self) -> None:
            pass

    new_llm = _FakeLLM()
    rebuilt = await runtime.rebuild_engine(new_llm)
    assert rebuilt is not first  # 模型变更 → 重建
    assert runtime.engine_llm is new_llm
    # 工具表变化（MCP 挂载/补丁链工具）→ 重建
    runtime.tool_registry["injected_tool"] = self_tool_specs()[0]
    rebuilt2 = await runtime.rebuild_engine(new_llm)
    assert rebuilt2 is not rebuilt
    # 工具表恢复后重建一次（缓存只记住最近一次重建的配置；变更即重建）
    runtime.tool_registry.clear()
    rebuilt3 = await runtime.rebuild_engine(new_llm)
    assert rebuilt3 is not rebuilt2
    # 再次同配置调用 → 复用
    assert await runtime.rebuild_engine(new_llm) is rebuilt3


async def test_collect_specs_merges_three_routes():
    """工具清单汇总 = 内省 + 自指 + 动态三路（内省快照/回合装配同源）。"""
    runtime = await Runtime().boot(FakeHost(), _minimal_recipe())
    specs = runtime.collect_specs()
    assert len(specs) == 9
    assert {s.name for s in specs} >= {"inspect_graph", "propose_patch", "apply_patch"}
    runtime.tool_registry["dynamic"] = self_tool_specs()[0]
    assert len(runtime.collect_specs()) == 10


async def test_unified_pipeline_routes_self_tools():
    """统一工具流水线按名路由：契约自指工具经装配后的流水线可执行。"""
    runtime = await Runtime().boot(FakeHost(), _minimal_recipe())
    spec = next(s for s in runtime.self_specs if s.name == "apply_patch")
    result = await runtime.tool_pipeline.execute(
        None, spec, {"kind": "theme", "payload": {"tokens": {"bg": "#123456"}}}
    )
    assert result.ok is True
    assert '"ok": true' in result.output
    state = await runtime.self_pipeline.chain.assemble()
    assert state["theme"] == {"bg": "#123456"}
