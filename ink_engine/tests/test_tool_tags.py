"""工具单源 + 标签单测：tool_registry 全量权威 + 标签区分注册状态。

覆盖：
- immutable 标签：内省/自指恒注入（collect_specs 含它们，不可摘除）
- baseline 标签：必带恒注入（出厂基线）
- thread 标签：request_tool 绑定 → 会话窗口注入（collect_specs(thread_id)）
- 工具 tab（merged_specs）与检索（tool_index）同源一致
- thread 标签 TTL 惰性清理
- thread 标签持久化 + 重启恢复
"""
from __future__ import annotations

import time
from typing import Any

from ink_engine.core.event_types import EventTypeSpec
from ink_engine.core.harness import HarnessDefinition
from ink_engine.core.runtime import (
    Runtime,
    TAG_IMMUTABLE,
    TAG_THREAD_PREFIX,
    THREAD_TAG_TTL_SECONDS,
)
from ink_engine.core.self_application import ApprovalLevel, SelfApplicationPipeline
from ink_engine.core.self_proposal import PatchKind
from ink_engine.core.self_tools import make_self_executor, self_tool_specs
from ink_engine.core.storage import create_storage
from ink_engine.core.llm.tools import ToolSpec
from ink_engine.seeds.boot import BOOT_UI_SPEC, build_boot_seed_entries


def _spec(name: str, description: str = "") -> ToolSpec:
    return ToolSpec(name=name, description=description, parameters={})


class FakeHost:
    def __init__(self) -> None:
        self.calls = []

    async def create_storage(self) -> Any:
        self.calls.append("create_storage")
        return create_storage("memory://")

    async def resolve_llm(self) -> Any:
        self.calls.append("resolve_llm")
        return None

    def interrupt_policy(self) -> Any:
        self.calls.append("interrupt_policy")
        from ink_engine.core.approval import DefaultInterruptPolicy
        return DefaultInterruptPolicy()

    def build_transport(self) -> Any:
        self.calls.append("build_transport")
        from ink_engine.core.events import CollectorTransport
        return CollectorTransport()

    async def close(self) -> None:
        self.calls.append("host_close")


async def _echo_agent(ctx) -> dict:
    await ctx.emit("reply_token", {"token": "ok"}, step_id="reply:1")
    return {"reply": "ok"}


def _echo_graph_recipe(ctx):
    from ink_engine.core.graph import Graph
    g = Graph(name="echo", entry="agent")
    g.add_node("agent", _echo_agent)
    g.add_exit("agent")
    return g


def _recipe():
    import dataclasses

    from ink_engine.core.runtime import AssemblyRecipe, ToolWiring

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
            self_operation_of=lambda spec: ("propose", "patch"),
        ),
        approval_levels={PatchKind.THEME: ApprovalLevel.L0},
        graph_recipe=_echo_graph_recipe,
    )


async def _boot_runtime():
    host = FakeHost()
    runtime = await Runtime().boot(host, _recipe())
    return host, runtime


# ── 1. immutable 恒注入 + 不可摘除 ──


async def test_immutable_always_injected_and_pinned():
    host, runtime = await _boot_runtime()
    # 内省/自指工具已打 immutable 标签
    self_names = {s.name for s in runtime.self_specs}
    introspection_names = {s.name for s in runtime.introspection_specs}
    for name in (*self_names, *introspection_names):
        assert TAG_IMMUTABLE in runtime.tool_tags(name)
    # immutable 不可摘除
    runtime.untag_tool("search_tools", TAG_IMMUTABLE)
    assert TAG_IMMUTABLE in runtime.tool_tags("search_tools")
    # 注入集（无 thread）恒含 immutable 工具
    injected = {s.name for s in runtime.collect_specs()}
    assert "search_tools" in injected
    assert "inspect_tools" in injected
    await host.close()


# ── 2. 工具 tab（merged_specs）与检索（tool_index）同源 ──


async def test_manifest_and_search_share_same_source():
    host, runtime = await _boot_runtime()
    # 声明式工具注册后：merged_specs（工具 tab）与 tool_index（检索）一致
    runtime.tool_registry["collect_material"] = _spec(
        "collect_material", "采集研究素材"
    )
    runtime.refresh_tool_index()
    merged = {s.name for s in runtime.merged_specs()}
    assert "collect_material" in merged
    assert runtime.tool_index.has("collect_material")
    # search_tools 能检索到（工具 tab 可见 = 检索可见 = 同一数据源）
    results = runtime.tool_index.search("采集素材", limit=5)
    assert any(r.name == "collect_material" for r in results)
    await host.close()


# ── 3. thread 标签：request_tool 绑定 → 会话窗口注入 ──


async def test_thread_tag_injects_into_session():
    host, runtime = await _boot_runtime()
    # 声明式工具注册（模拟 MCP 挂载：进总源但未打标签 = 不注入）
    runtime.tool_registry["mcp_quote"] = _spec("mcp_quote", "行情查询")
    runtime.refresh_tool_index()
    # 未绑定前：无 thread 上下文不注入；指定 thread 也不注入
    assert "mcp_quote" not in {s.name for s in runtime.collect_specs()}
    assert "mcp_quote" not in {
        s.name for s in runtime.collect_specs(thread_id="t1")
    }
    # request_tool 绑定：打 thread:t1 标签（模拟 _request_tool 成功路径）
    runtime.tag_tool("mcp_quote", f"{TAG_THREAD_PREFIX}t1")
    # t1 会话窗口注入
    assert "mcp_quote" in {
        s.name for s in runtime.collect_specs(thread_id="t1")
    }
    # 其它 thread 隔离：t2 不可见
    assert "mcp_quote" not in {
        s.name for s in runtime.collect_specs(thread_id="t2")
    }
    await host.close()


# ── 4. thread 标签 TTL 惰性清理 ──


async def test_thread_tag_ttl_expiry():
    host, runtime = await _boot_runtime()
    runtime.tool_registry["mcp_t"] = _spec("mcp_t", "TTL 测试")
    runtime.refresh_tool_index()
    runtime.tag_tool("mcp_t", f"{TAG_THREAD_PREFIX}tx")
    assert "mcp_t" in {s.name for s in runtime.collect_specs(thread_id="tx")}
    # 模拟过期：手工把打标时间戳拨到 TTL 之前
    (name, thread_id), _ = next(iter(runtime._thread_tag_created.items()))
    runtime._thread_tag_created[(name, thread_id)] = (
        time.time() - THREAD_TAG_TTL_SECONDS - 1
    )
    assert "mcp_t" not in {
        s.name for s in runtime.collect_specs(thread_id="tx")
    }
    # 过期后标签已回收
    assert not runtime._thread_tag_created
    await host.close()


# ── 5. thread 标签持久化 + 重启恢复 ──


async def test_thread_tag_persist_and_restore():
    shared = create_storage("memory://")

    class _SharedHost(FakeHost):
        async def create_storage(self) -> Any:
            self.calls.append("create_storage")
            return shared

    host, runtime = await _boot_runtime()
    runtime.storage = shared
    runtime.tool_registry["persist_tool"] = _spec("persist_tool", "持久化工具")
    runtime.refresh_tool_index()
    runtime.tag_tool("persist_tool", f"{TAG_THREAD_PREFIX}keep")
    await runtime._persist_thread_tags()
    await host.close()

    # 重启（新 host + 新 runtime，共享同一存储）
    host2 = _SharedHost()
    runtime2 = await Runtime().boot(host2, _recipe())
    # 声明式工具重新注册（模拟重启后 MCP 重新挂载/补丁链恢复）
    runtime2.tool_registry["persist_tool"] = _spec("persist_tool", "持久化工具")
    runtime2.refresh_tool_index()
    await runtime2._restore_thread_tags()
    # keep 会话窗口注入保持（跨重启恒注册）
    assert "persist_tool" in {
        s.name for s in runtime2.collect_specs(thread_id="keep")
    }
    # 其它 thread 不可见
    assert "persist_tool" not in {
        s.name for s in runtime2.collect_specs(thread_id="other")
    }
    await host2.close()


# ── 6. 注入集预算默认 18（可调非硬锁）──


async def test_inject_budget_default_18():
    host, runtime = await _boot_runtime()
    assert runtime.tool_selector.max_tools == 18
    # 超过预算时按序截断（不抛错）
    for i in range(30):
        runtime.tool_registry[f"bulk_{i}"] = _spec(f"bulk_{i}", f"批量工具 {i}")
    runtime.refresh_tool_index()
    injected = runtime.collect_specs()
    assert len(injected) <= 18
    await host.close()
