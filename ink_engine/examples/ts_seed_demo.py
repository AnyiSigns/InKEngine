"""跨语言种子包最小实现演示：Python 引擎 + TypeScript 种子包。

种子包（examples/ts_seed_pack/）= 数据 + 执行件：
- 数据：``seed_data.json``（纯 JSON 知识条目/模板，语言无关）；
- 执行件：``server.mjs``（TypeScript MCP stdio server，零 npm 依赖，
  手写 JSON-RPC over stdio——领域校验工具）。

装配闭环（运行需 node）::

    python -X utf8 examples/ts_seed_demo.py

验证：
1. 数据跨语言：JSON 种子条目注入知识集（可检索可枚举）；
2. 执行件跨语言：引擎经 MCP 协议连接 TS server，工具进工具表
   （权限 ``mcp:call:ts_seed`` 与端点判定匹配，默认门禁放行）；
3. 回合闭环：图节点经统一工具流水线调用 TS 执行件（禁忌词检测 +
   因果倒置检测），结果回流引擎事件流。

Python 是引擎的实现语言，契约（JSON 数据形态 + MCP 协议）语言无关。
"""
from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path

from ink_engine.core.approval import DefaultInterruptPolicy, InterruptPolicy
from ink_engine.core.events import EngineEvent, EngineTransport
from ink_engine.core.graph import Graph
from ink_engine.core.knowledge_set import KnowledgeEntry
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

SEED_PACK_DIR = Path(__file__).resolve().parent / "ts_seed_pack"

DEMO_TEXT = "他说出「不可饶恕」四个字，转身离去。"
DEMO_TABOOS = ["不可饶恕"]
DEMO_EVENTS = {
    "e1": {"event_id": "e1", "chapter_id": 3},
    "e2": {"event_id": "e2", "chapter_id": 23},
}
DEMO_LINKS = [
    {"cause_event_id": "e2", "effect_event_id": "e1", "note": "后果早于原因"},
]


class CollectTransport:
    """事件收集传输（内存形态：演示回合事件流摘要）。"""

    def __init__(self) -> None:
        self.events: list[EngineEvent] = []

    async def send(self, event: EngineEvent) -> None:
        self.events.append(event)


class TsSeedHost:
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


def load_ts_seed_entries() -> list[KnowledgeEntry]:
    """读 TS 种子包数据（seed_data.json，语言无关的 JSON 数据资产）。"""
    raw = json.loads((SEED_PACK_DIR / "seed_data.json").read_text(encoding="utf-8"))
    return [KnowledgeEntry.from_dict(entry) for entry in raw["entries"]]


def build_ts_demo_graph(ctx: GraphRecipeContext) -> Graph:
    """回合图：节点经统一工具流水线调用 TS 执行件（MCP 工具）。

    流水线与工具规格在图配方构建期捕获（GraphRecipeContext 提供），
    节点执行期直接引用——与既有宿主图（stdio_host）同一闭包模式。
    """

    pipeline = ctx.tool_pipeline
    specs_by_name = {spec.name: spec for spec in ctx.tool_specs}

    async def invoke_ts(ctx):
        taboo_spec = specs_by_name["taboo_check"]
        taboo_outcome = await pipeline.execute(
            ctx, taboo_spec, {"text": DEMO_TEXT, "taboos": DEMO_TABOOS}
        )
        await ctx.emit(
            "tool_end",
            {
                "tool": "taboo_check",
                "success": taboo_outcome.ok,
                "output": taboo_outcome.output[:500],
            },
            step_id="ts:1",
        )
        causal_spec = specs_by_name["causal_reverse_check"]
        causal_outcome = await pipeline.execute(
            ctx,
            causal_spec,
            {"causal_links": DEMO_LINKS, "events": DEMO_EVENTS},
        )
        await ctx.emit(
            "tool_end",
            {
                "tool": "causal_reverse_check",
                "success": causal_outcome.ok,
                "output": causal_outcome.output[:500],
            },
            step_id="ts:2",
        )
        return {
            "taboo_result": taboo_outcome.output,
            "causal_result": causal_outcome.output,
        }

    async def end(ctx):
        await ctx.emit(
            "end",
            {
                "taboo_result": ctx.state.get("taboo_result"),
                "causal_result": ctx.state.get("causal_result"),
            },
            step_id="end:1",
        )
        return {}

    g = Graph(name="ts_seed_demo", entry="invoke_ts")
    g.add_node("invoke_ts", invoke_ts)
    g.add_node("end", end)
    g.add_edge("invoke_ts", "end")
    g.add_exit("end")
    return g


def build_ts_demo_recipe() -> AssemblyRecipe:
    """装配配方：种子数据来自 TS 包 JSON（seeds 注入 = 读 JSON）。"""
    return AssemblyRecipe(
        set_id="ts_seed_demo",
        seeds=[("ts_seed", load_ts_seed_entries)],
        tool_wiring=ToolWiring(
            self_specs=self_tool_specs,
            self_executor_factory=make_self_executor,
            self_operation_of=operation_of,
        ),
        approval_levels={
            PatchKind.THEME: ApprovalLevel.L0,
            PatchKind.UI: ApprovalLevel.L0,
        },
        graph_recipe=build_ts_demo_graph,
    )


async def mount_ts_seed_server(runtime: Runtime) -> list[str]:
    """挂载 TS 种子包执行件：连接 MCP server → 导入工具 → 注册进工具表。

    与宿主挂载流程同构（连接失败/导入失败抛错不静默）；vetting 闸门
    此处跳过（演示脚本，生产挂载走审批）。
    """
    server_config = McpServerConfig(
        id="ts_seed",
        transport=McpTransport.STDIO,
        command="node",
        args=(str(SEED_PACK_DIR / "server.mjs"),),
        source=ToolSource.UNKNOWN,
    )
    await runtime.mcp_manager.connect(server_config)
    specs = await runtime.mcp_manager.import_tools("ts_seed", vetting=None)
    for spec in specs:
        runtime.harness_registry.declarative.register_definition(spec)
        runtime.tool_registry[spec.name] = spec.to_spec()
    runtime.introspection_service._sources.tools = runtime.collect_specs()
    await runtime.rebuild_engine()
    return [spec.name for spec in specs]


async def main() -> int:
    print("== 跨语言种子包演示：Python 引擎 + TypeScript 种子包 ==")
    host = TsSeedHost()
    runtime = await Runtime().boot(host, build_ts_demo_recipe())
    try:
        entries = runtime.knowledge_set.entries()
        ts_entries = [e for e in entries if e.id.startswith("seed.ts_seed.")]
        print(
            f"数据跨语言：知识集 {len(entries)} 条（通用基线 + TS 种子 {len(ts_entries)} 条，"
            f"来自 seed_data.json）"
        )
        print(f"  - {[e.id for e in ts_entries]}")

        tool_names = await mount_ts_seed_server(runtime)
        print(f"执行件跨语言：MCP 工具导入 {tool_names}（node server.mjs，stdio）")
        print("  - 权限形态: mcp:call:ts_seed（与端点判定匹配，默认门禁放行）")

        print("\n== 回合闭环：图节点经统一流水线调用 TS 执行件 ==")
        ticket = runtime.begin_run()
        transport = CollectTransport()
        try:
            result = await runtime.engine.ainvoke(
                {"input": "跨语言工具调用"},
                thread_id="ts-seed-1",
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
        await runtime.mcp_manager.disconnect("ts_seed")
        await runtime.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
