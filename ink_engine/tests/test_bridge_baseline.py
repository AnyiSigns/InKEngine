"""桥 op 单测：工具全量清单 + 常驻必带集（设置页「工具」管理面数据源）。

覆盖：
- engine.tools_manifest：全量工具清单（merged_specs）附带常驻标记/来源/
  声明式细节（endpoint/meta/mcp_server）；
- engine.baseline_get：读当前常驻必带集；
- engine.baseline_set：整集替换写（强制保留检索工具），并随 records 持久化；
- engine.baseline_set 非法名结构化拒绝。
"""
from __future__ import annotations

import asyncio
import dataclasses
import importlib
import json
import sys
from pathlib import Path
from typing import Any

import pytest

from ink_engine.core.event_types import EventTypeSpec
from ink_engine.core.harness import HarnessDefinition
from ink_engine.core.llm.tools import ToolSpec
from ink_engine.core.self_application import ApprovalLevel
from ink_engine.core.self_proposal import PatchKind
from ink_engine.core.self_tools import make_self_executor, self_tool_specs
from ink_engine.core.storage import create_storage
from ink_engine.seeds.boot import BOOT_UI_SPEC, build_boot_seed_entries


def _spec(name: str, description: str = "") -> ToolSpec:
    return ToolSpec(name=name, description=description, parameters={})


class _EchoAgent:
    async def __call__(self, ctx) -> dict:
        return {"reply": "ok"}


def _echo_graph_recipe(ctx):
    from ink_engine.core.graph import Graph

    g = Graph(name="echo", entry="agent")
    g.add_node("agent", _EchoAgent())
    g.add_exit("agent")
    return g


def _minimal_recipe(**overrides):
    from ink_engine.core.runtime import AssemblyRecipe, ToolWiring

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
            self_operation_of=lambda spec: ("propose", "patch"),
        ),
        approval_levels={PatchKind.THEME: ApprovalLevel.L0},
        graph_recipe=_echo_graph_recipe,
    )
    return dataclasses.replace(base, **overrides)


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
        from ink_engine.core.approval import DefaultInterruptPolicy

        return DefaultInterruptPolicy()

    def build_transport(self) -> Any:
        self.calls.append("build_transport")
        from ink_engine.core.events import CollectorTransport

        return CollectorTransport()

    async def close(self) -> None:
        self.calls.append("host_close")


def _load_bridge():
    repo_root = Path(__file__).resolve().parents[2]
    bridge_path = (
        repo_root / "inkling" / "shell" / "src-tauri" / "src" / "engine" / "py" / "bridge.py"
    )
    if "inkling_bridge" not in sys.modules:
        spec = importlib.util.spec_from_file_location("inkling_bridge", bridge_path)
        bridge = importlib.util.module_from_spec(spec)
        sys.modules["inkling_bridge"] = bridge
        spec.loader.exec_module(bridge)
    return sys.modules["inkling_bridge"]


@pytest.fixture
def booted_bridge():
    from ink_engine.core.runtime import Runtime

    bridge = _load_bridge()
    host = FakeHost()
    runtime = asyncio.run(Runtime().boot(host, _minimal_recipe()))
    for name in ("file_read", "file_write", "file_edit", "grep", "glob"):
        runtime.tool_registry[name] = ToolSpec(name=name, description=f"{name} 工具")
    bridge.bind_runtime(runtime, None)
    yield runtime, bridge
    bridge.bind_runtime(None, None)
    asyncio.run(host.close())


def _invoke_sync(bridge, name: str, args: dict | None = None) -> dict:
    return json.loads(bridge.invoke(name, json.dumps(args or {})))


def _invoke_async(bridge, name: str, args: dict | None = None) -> dict:
    raw = asyncio.run(bridge.invoke_async(name, json.dumps(args or {})))
    return json.loads(raw)


def test_tools_manifest_lists_all_tools_with_flags(booted_bridge):
    _, bridge = booted_bridge
    result = _invoke_sync(bridge, "engine.tools_manifest")
    names = {t["name"] for t in result["tools"]}
    # 全量（自指 5 + 声明式文件 5），非仅常驻集
    assert "file_read" in names
    assert "search_tools" in names
    assert "request_tool" in names
    for entry in result["tools"]:
        assert "baseline" in entry
        assert "source" in entry
    # 常驻标记：出厂必带集内的工具标记为 true
    baseline_names = {t["name"] for t in result["tools"] if t["baseline"]}
    assert "file_read" in baseline_names
    assert "search_tools" in baseline_names
    assert "request_tool" in baseline_names


def test_tools_manifest_merges_declarative_detail(booted_bridge):
    from ink_engine.core.declarative_tools import DeclarativeToolSpec, EndpointType

    runtime, bridge = booted_bridge
    decl = DeclarativeToolSpec(
        name="mcp_new_tool",
        description="MCP 挂载工具",
        parameters={"type": "object", "properties": {}},
        permissions=("mcp:call:server_a",),
        endpoint=EndpointType.MCP,
        endpoint_config={"server_id": "server_a"},
        meta={"domain": "research", "mcp_server": "server_a"},
    )
    runtime.harness_registry.declarative.register_definition(decl)
    runtime.tool_registry["mcp_new_tool"] = decl.to_spec()
    result = _invoke_sync(bridge, "engine.tools_manifest")
    entry = next(t for t in result["tools"] if t["name"] == "mcp_new_tool")
    assert entry["source"] == "declarative"
    assert entry["endpoint"] == "mcp"
    assert entry["endpoint_config"] == {"server_id": "server_a"}
    assert entry["meta"]["mcp_server"] == "server_a"
    assert entry["baseline"] is False


def test_baseline_get_returns_default(booted_bridge):
    _, bridge = booted_bridge
    result = _invoke_sync(bridge, "engine.baseline_get")
    assert "search_tools" in result["tools"]
    assert "request_tool" in result["tools"]
    assert len(result["tools"]) >= 10


def test_baseline_set_applies_full_set(booted_bridge):
    from ink_engine.core.declarative_tools import DeclarativeToolSpec, EndpointType

    runtime, bridge = booted_bridge
    decl = DeclarativeToolSpec(
        name="mcp_new_tool",
        description="MCP 挂载工具",
        parameters={"type": "object", "properties": {}},
        permissions=("mcp:call:server_a",),
        endpoint=EndpointType.MCP,
        endpoint_config={"server_id": "server_a"},
        meta={"domain": "research", "mcp_server": "server_a"},
    )
    runtime.harness_registry.declarative.register_definition(decl)
    runtime.tool_registry["mcp_new_tool"] = decl.to_spec()
    full = [
        "file_read", "file_write", "file_edit", "grep", "glob",
        "propose_patch", "propose_domain_manifest", "inspect_tools",
        "search_tools", "request_tool", "mcp_new_tool",
    ]
    result = _invoke_async(bridge, "engine.baseline_set", {"tools": full})
    assert "mcp_new_tool" in result["tools"]
    manifest = _invoke_sync(bridge, "engine.tools_manifest")
    baseline_names = {t["name"] for t in manifest["tools"] if t["baseline"]}
    assert baseline_names == set(full)


def test_baseline_set_rejects_unknown_tool(booted_bridge):
    _, bridge = booted_bridge
    with pytest.raises(ValueError, match="未注册工具"):
        _invoke_async(bridge, "engine.baseline_set", {"tools": ["no_such_tool_xyz"]})


def test_baseline_set_persists_and_restores(booted_bridge):
    import asyncio

    from ink_engine.core.declarative_tools import DeclarativeToolSpec, EndpointType
    from ink_engine.core.runtime import Runtime

    bridge = _load_bridge()
    raw_storage = create_storage("memory://")

    class SharedStorageHost(FakeHost):
        async def create_storage(self) -> Any:
            return raw_storage

    decl = DeclarativeToolSpec(
        name="mcp_new_tool",
        description="MCP 挂载工具",
        parameters={"type": "object", "properties": {}},
        permissions=("mcp:call:server_a",),
        endpoint=EndpointType.MCP,
        endpoint_config={"server_id": "server_a"},
        meta={"domain": "research", "mcp_server": "server_a"},
    )

    def register_tools(runtime) -> None:
        for name in ("file_read", "file_write", "file_edit", "grep", "glob"):
            runtime.tool_registry[name] = ToolSpec(name=name, description=f"{name} 工具")
        runtime.harness_registry.declarative.register_definition(decl)
        runtime.tool_registry["mcp_new_tool"] = decl.to_spec()

    host_a = SharedStorageHost()
    runtime_a = asyncio.run(Runtime().boot(host_a, _minimal_recipe()))
    register_tools(runtime_a)
    bridge.bind_runtime(runtime_a, None)
    full = [
        "file_read", "file_write", "file_edit", "grep", "glob",
        "propose_patch", "propose_domain_manifest", "inspect_tools",
        "search_tools", "request_tool", "mcp_new_tool",
    ]
    _invoke_async(bridge, "engine.baseline_set", {"tools": full})
    bridge.bind_runtime(None, None)
    asyncio.run(host_a.close())

    host_b = SharedStorageHost()
    runtime_b = asyncio.run(Runtime().boot(host_b, _minimal_recipe()))
    register_tools(runtime_b)
    restored = runtime_b.baseline_names
    assert "mcp_new_tool" in restored, "重启后常驻必带集应从 records 恢复"
    assert "search_tools" in restored and "request_tool" in restored
    assert "file_read" in restored
    asyncio.run(host_b.close())
