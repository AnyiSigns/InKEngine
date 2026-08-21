"""真实 MCP 插件挂载实验：官方 @modelcontextprotocol/server-everything。

验证「产品层挂载真实第三方 MCP server」（非自建 mock）::

    python -X utf8 examples/mcp_real_demo.py

server：``@modelcontextprotocol/server-everything``（官方参考实现，
stdio 传输，含无副作用工具 echo / echo_async / add 等，共 20+ 工具）。
引擎经 mcp SDK（stdio_client）连接真实进程，工具进工具表走统一
流水线（权限 mcp:call:<id> + tool_audit 审计）。

安装：``npm install @modelcontextprotocol/server-everything --prefix examples/mcp_everything_pack``
"""
from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

from ink_engine.core.approval import DefaultInterruptPolicy, InterruptPolicy
from ink_engine.core.events import EngineEvent, EngineTransport
from ink_engine.core.graph import Graph
from ink_engine.core.llm import AsyncLLM
from ink_engine.core.mcp_client import McpServerConfig, McpTransport
from ink_engine.core.runtime import (
    AssemblyRecipe,
    GraphRecipeContext,
    Runtime,
    ToolWiring,
)
from ink_engine.core.self_application import ApprovalLevel
from ink_engine.core.self_proposal import PatchKind
from ink_engine.core.self_tools import make_self_executor, operation_of, self_tool_specs
from ink_engine.core.storage import Storage, create_storage
from ink_engine.core.tool_vetting import ToolSource

EVERYTHING_ENTRY = (
    Path(__file__).resolve().parent
    / "mcp_everything_pack"
    / "node_modules"
    / "@modelcontextprotocol"
    / "server-everything"
    / "dist"
    / "index.js"
)


class CollectTransport:
    """事件收集传输（内存形态：演示回合事件流摘要）。"""

    def __init__(self) -> None:
        self.events: list[EngineEvent] = []

    async def send(self, event: EngineEvent) -> None:
        self.events.append(event)


class RealMcpHost:
    """演示宿主五件套：内存存储 / 无模型 / 直过审批 / 收集传输。"""

    def __init__(self) -> None:
        self._storage: Storage | None = None

    async def create_storage(self) -> Storage:
        self._storage = create_storage("memory://")
        return self._storage

    async def resolve_llm(self) -> AsyncLLM | None:
        return None

    def interrupt_policy(self) -> InterruptPolicy:
        return DefaultInterruptPolicy()

    def build_transport(self) -> EngineTransport:
        return CollectTransport()

    async def close(self) -> None:
        return None


def build_mcp_demo_graph(ctx: GraphRecipeContext) -> Graph:
    """回合图：调用真实 MCP server 的工具（echo / add，无副作用）。"""

    pipeline = ctx.tool_pipeline
    specs_by_name = {spec.name: spec for spec in ctx.tool_specs}

    async def invoke(ctx):
        echo_outcome = await pipeline.execute(
            ctx, specs_by_name["echo"], {"message": "来自 InkEngine 引擎的问候"}
        )
        await ctx.emit(
            "tool_end",
            {"tool": "echo", "success": echo_outcome.ok, "output": echo_outcome.output[:300]},
            step_id="real:1",
        )
        add_outcome = await pipeline.execute(
            ctx, specs_by_name["get-sum"], {"a": 19, "b": 23}
        )
        await ctx.emit(
            "tool_end",
            {"tool": "get-sum", "success": add_outcome.ok, "output": add_outcome.output[:300]},
            step_id="real:2",
        )
        return {"echo": echo_outcome.output, "add": add_outcome.output}

    async def end(ctx):
        await ctx.emit(
            "end",
            {"echo": ctx.state.get("echo"), "add": ctx.state.get("add")},
            step_id="end:1",
        )
        return {}

    g = Graph(name="mcp_real_demo", entry="invoke")
    g.add_node("invoke", invoke)
    g.add_node("end", end)
    g.add_edge("invoke", "end")
    g.add_exit("end")
    return g


def build_mcp_demo_recipe() -> AssemblyRecipe:
    """装配配方（演示最小集：仅工具分发 + 自指三路）。"""
    return AssemblyRecipe(
        set_id="mcp_real_demo",
        tool_wiring=ToolWiring(
            self_specs=self_tool_specs,
            self_executor_factory=make_self_executor,
            self_operation_of=operation_of,
        ),
        approval_levels={
            PatchKind.THEME: ApprovalLevel.L0,
            PatchKind.UI: ApprovalLevel.L0,
        },
        graph_recipe=build_mcp_demo_graph,
    )


async def main() -> int:
    print("== 真实 MCP 插件挂载实验：官方 server-everything ==")
    host = RealMcpHost()
    runtime = await Runtime().boot(host, build_mcp_demo_recipe())
    try:
        server_config = McpServerConfig(
            id="everything",
            transport=McpTransport.STDIO,
            command="node",
            args=(str(EVERYTHING_ENTRY),),
            source=ToolSource.UNKNOWN,
        )
        await runtime.mcp_manager.connect(server_config)
        specs = await runtime.mcp_manager.import_tools("everything", vetting=None)
        for spec in specs:
            runtime.harness_registry.declarative.register_definition(spec)
            runtime.tool_registry[spec.name] = spec.to_spec()
        runtime.introspection_service._sources.tools = runtime.collect_specs()
        await runtime.rebuild_engine()
        print(f"1. 挂载成功: 导入工具 {len(specs)} 个（node dist/index.js，stdio）")
        sample = [s.name for s in specs][:12]
        print(f"   工具样例: {sample} ...")

        print("\n== 回合：调用真实 MCP 工具 ==")
        ticket = runtime.begin_run()
        transport = CollectTransport()
        try:
            result = await runtime.engine.ainvoke(
                {"input": "调用真实 MCP 工具"},
                thread_id="mcp-real-1",
                round_id=uuid.uuid4().hex,
                transports=[transport],
            )
        finally:
            runtime.end_run(ticket)
        print(f"  事件 {len(transport.events)} 条: {[e.type for e in transport.events]}")
        print(f"  回合结果: {result}")
        for event in transport.events:
            if event.type in ("tool_end", "end", "error"):
                print(f"  [{event.type}] {event.payload}")
    finally:
        await runtime.mcp_manager.disconnect("everything")
        await runtime.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
