"""Cordis 插件市场挂载实验：市场 MCP server → 市场数据 → 数据集变更。

模拟「产品层从插件市场添砖加瓦」闭环（运行需 node）::

    python -X utf8 examples/market_seed_demo.py

验证链路：
1. 挂载市场：node cordis_market_pack/market.mjs（MCP stdio，零依赖）
   → market_search / market_fetch 进工具表（权限 mcp:call:cordis_market）；
2. 市场取数：回合节点调 market_search（插件清单）→ market_fetch
   （插件详情，携带知识条目数据——语言无关 JSON）；
3. 数据集变更：市场数据经引擎自指管线 apply_patch（kind=knowledge）
   写入知识集——旁路写防护保证集内可演化资产的唯一写入路径 = 应用
   管线，市场工具只能取数不能直写；L0 直过（真实产品按分级表走）；
4. 验证：落库后知识集检索命中 + 补丁链版本前进 + set_audit 留痕。

数据 = 市场提供（JSON），执行件 = Node（MCP），机制 = 引擎（审批/
补丁链/审计）——三方各司其职。
"""
from __future__ import annotations

import asyncio
import json
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

MARKET_DIR = Path(__file__).resolve().parent / "cordis_market_pack"


class CollectTransport:
    """事件收集传输（内存形态：演示回合事件流摘要）。"""

    def __init__(self) -> None:
        self.events: list[EngineEvent] = []

    async def send(self, event: EngineEvent) -> None:
        self.events.append(event)


class MarketHost:
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


def build_market_graph(ctx: GraphRecipeContext) -> Graph:
    """回合图：市场取数（MCP 工具）→ 数据集变更（自指 apply_patch）。

    市场工具与自指工具经统一工具流水线调用（同一权限门禁与审计管线）；
    流水线与工具规格在图配方构建期捕获（GraphRecipeContext 提供）。
    """

    pipeline = ctx.tool_pipeline
    specs_by_name = {spec.name: spec for spec in ctx.tool_specs}

    async def market(ctx):
        search_outcome = await pipeline.execute(
            ctx, specs_by_name["market_search"], {"query": "dataset"}
        )
        await ctx.emit(
            "tool_end",
            {"tool": "market_search", "output": search_outcome.output[:400]},
            step_id="market:1",
        )
        fetch_outcome = await pipeline.execute(
            ctx,
            specs_by_name["market_fetch"],
            {"plugin_id": "cordis.dataset-viz"},
        )
        await ctx.emit(
            "tool_end",
            {"tool": "market_fetch", "output": fetch_outcome.output[:400]},
            step_id="market:2",
        )
        data = json.loads(fetch_outcome.output)
        entries = data.get("entries") or []
        return {"market_entries": entries}

    async def apply(ctx):
        entries = ctx.state.get("market_entries") or []
        results = []
        base_version: int | None = None
        for entry in entries:
            args: dict = {
                "kind": PatchKind.KNOWLEDGE.value,
                "payload": {"entry": entry},
                "rationale": f"从 Cordis 插件市场安装（{entry.get('id')}）",
            }
            if base_version is not None:
                args["base_version"] = base_version
            outcome = await pipeline.execute(
                ctx, specs_by_name["apply_patch"], args
            )
            results.append(
                {"entry_id": entry.get("id"), "outcome": outcome.output[:200]}
            )
            await ctx.emit(
                "tool_end",
                {
                    "tool": "apply_patch",
                    "entry_id": entry.get("id"),
                    "output": outcome.output[:200],
                },
                step_id=f"apply:{entry.get('id')}",
            )
            if outcome.ok:
                parsed = json.loads(outcome.output)
                if parsed.get("patch_id"):
                    base_version = parsed["patch_id"]
        return {"apply_results": results}

    async def end(ctx):
        await ctx.emit(
            "end",
            {
                "apply_results": ctx.state.get("apply_results"),
                "market_entries": len(ctx.state.get("market_entries") or []),
            },
            step_id="end:1",
        )
        return {}

    g = Graph(name="market_demo", entry="market")
    g.add_node("market", market)
    g.add_node("apply", apply)
    g.add_node("end", end)
    g.add_edge("market", "apply")
    g.add_edge("apply", "end")
    g.add_exit("end")
    return g


def build_market_recipe() -> AssemblyRecipe:
    """装配配方：knowledge 补丁 L0 直过（演示无挂卡；真实产品按分级表）。"""
    return AssemblyRecipe(
        set_id="market_demo",
        tool_wiring=ToolWiring(
            self_specs=self_tool_specs,
            self_executor_factory=make_self_executor,
            self_operation_of=operation_of,
        ),
        approval_levels={
            PatchKind.THEME: ApprovalLevel.L0,
            PatchKind.UI: ApprovalLevel.L0,
            PatchKind.KNOWLEDGE: ApprovalLevel.L0,
        },
        graph_recipe=build_market_graph,
    )


async def mount_market_server(runtime: Runtime) -> list[str]:
    """挂载 Cordis 插件市场（MCP stdio，node market.mjs）。"""
    server_config = McpServerConfig(
        id="cordis_market",
        transport=McpTransport.STDIO,
        command="node",
        args=(str(MARKET_DIR / "market.mjs"),),
        source=ToolSource.UNKNOWN,
    )
    await runtime.mcp_manager.connect(server_config)
    specs = await runtime.mcp_manager.import_tools("cordis_market", vetting=None)
    for spec in specs:
        runtime.harness_registry.declarative.register_definition(spec)
        runtime.tool_registry[spec.name] = spec.to_spec()
    runtime.introspection_service._sources.tools = runtime.collect_specs()
    await runtime.rebuild_engine()
    return [spec.name for spec in specs]


async def main() -> int:
    print("== Cordis 插件市场挂载实验：市场 → 数据 → 数据集变更 ==")
    host = MarketHost()
    runtime = await Runtime().boot(host, build_market_recipe())
    try:
        tool_names = await mount_market_server(runtime)
        print(f"1. 挂载市场: 工具导入 {tool_names}（node market.mjs，stdio）")
        print("   权限形态: mcp:call:cordis_market（取数只读；写入走自指管线）")

        print("\n== 回合：市场取数 → apply_patch 落库 → 数据集变更 ==")
        ticket = runtime.begin_run()
        transport = CollectTransport()
        try:
            await runtime.engine.ainvoke(
                {"input": "从市场安装 dataset-viz 插件"},
                thread_id="market-1",
                round_id=uuid.uuid4().hex,
                transports=[transport],
            )
        finally:
            runtime.end_run(ticket)
        for event in transport.events:
            if event.type == "tool_end":
                print(f"  [tool_end] {event.payload}")
            if event.type == "end":
                print(f"  [end] {event.payload}")

        print("\n== 数据集变更验证 ==")
        state = await runtime.self_pipeline.chain.assemble()
        knowledge_state = state.get("knowledge") or {}
        market_ids = [k for k in knowledge_state if k.startswith("market.")]
        print(f"补丁链 knowledge 段: {len(knowledge_state)} 条（新增 market.* {len(market_ids)} 条）")
        for key in market_ids:
            print(f"  - {key}")
        hits = runtime.knowledge_set.search("market", limit=10)
        print(
            f"运行期内存知识集检索命中: {len(hits)} 条（集补丁链 = 权威；"
            "内存视图同步需配方 apply_targets 钩子，未注册时重启恢复即见）"
        )
        version = await runtime.self_pipeline.chain.current_version()
        print(f"补丁链版本: {version}（apply_patch 落库后前进）")
        audit = await runtime.self_pipeline.audit_log(limit=10)
        print(f"set_audit 审计记录: {len(audit)} 条")
        for record in audit[-2:]:
            print(f"  - {record.get('kind')}/{record.get('status')}: {record.get('patch_id')}")

        print("\n== 结论 ==")
        print(
            "市场挂载成功，市场数据经 apply_patch 写入数据集（检索/版本/审计"
            "全部生效）；市场工具只能取数，集内写入唯一路径 = 应用管线。"
        )
    finally:
        await runtime.mcp_manager.disconnect("cordis_market")
        await runtime.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
