"""e2e 公共构件：直接构造 Engine（执行域测试底座）+ 脚本化工具流水线。

执行域用例不走 Runtime（Runtime 的 RunOptions 是引擎默认装配形态）；
本模块提供与宿主图配方同源的回合金图 + 全项 RunOptions 注入入口，
让每个用例独立钉住一个执行机制（计划策略/预算/异常/推演…）。
"""
from __future__ import annotations

import json
from typing import Any

from conftest import load_seed
from ink_engine.core.declarative_tools import DeclarativeToolSpec
from ink_engine.core.executor import Engine
from ink_engine.core.graph import Graph
from ink_engine.core.permissions import PermissionGate, parse_permission
from ink_engine.core.registry import GraphRegistries
from ink_engine.core.runtime import GraphRecipeContext
from ink_engine.core.tool_pipeline import ToolPipeline

SEED_DATA = {
    name: load_seed(name)
    for name in (
        "graph.json",
        "workflow.json",
        "review.json",
        "samples.json",
        "tools.json",
        "memory.json",
    )
}


def build_ctx(
    *,
    pipeline: ToolPipeline | None = None,
    tool_specs: list[Any] | None = None,
    registries: GraphRegistries | None = None,
) -> GraphRecipeContext:
    """装配上下文（GraphRecipeContext 数据形态，与 Runtime 同源）。"""
    return GraphRecipeContext(
        llm=None,
        tool_pipeline=pipeline,
        tool_specs=tuple(tool_specs or ()),
        storage=None,
        registries=registries or GraphRegistries(),
    )


def build_round_graph(
    ctx: GraphRecipeContext | None = None,
    *,
    pipeline: ToolPipeline | None = None,
    tool_specs: list[Any] | None = None,
) -> Graph:
    """回合金图（host.graph_recipe 同源：graph.json + workflow.json 实例化）。

    传 ctx 时复用其注册表（执行域用例注入 registries 到 RunOptions）；
    不传时自建（boot 断言等只读图结构场景）。
    """
    from host.graph_recipe import build_round_graph as _build

    if ctx is None:
        ctx = build_ctx(pipeline=pipeline, tool_specs=tool_specs or [])
    return _build(
        ctx,
        graph_data=SEED_DATA["graph.json"],
        workflow_data=SEED_DATA["workflow.json"],
    )


def build_test_pipeline(executor_script: dict[str, str]) -> ToolPipeline:
    """脚本化工具流水线：按工具名返回确定性结果（免 MCP/执行件依赖）。

    操作提取 = 权限声明首条规则（mcp:call:inkling_exec → call/
    inkling_exec），权限门禁按声明命中放行——与统一流水线同判定形态。
    """

    async def executor(ctx: Any, spec: Any, args: dict[str, Any], approval: Any) -> str:
        return executor_script.get(spec.name, f"stub:{spec.name}")

    def extractor(spec: Any, args: dict[str, Any]) -> tuple[str, str] | None:
        if not spec.permissions:
            return None
        rule = parse_permission(spec.permissions[0])
        return (rule.action, rule.pattern)

    return ToolPipeline(
        gate=PermissionGate(),
        extractor=extractor,
        executor=executor,
    )


def domain_tool_specs() -> list[Any]:
    """tools.json 领域工具规格（ToolSpec 形态，与装配动作同源）。"""
    return [spec.to_spec() for spec in domain_declarative_specs()]


def domain_declarative_specs() -> list[DeclarativeToolSpec]:
    """tools.json 声明式定义（DeclarativeToolSpec 形态）。"""
    return [
        DeclarativeToolSpec.from_dict(raw)
        for raw in SEED_DATA["tools.json"].get("tools") or ()
    ]


async def run_engine(
    engine: Engine,
    state: dict[str, Any],
    *,
    thread_id: str = "e2e-thread",
    transports: list[Any] | None = None,
) -> Any:
    """执行一次回合（ainvoke 封装：事件收集 + 结果）。"""
    result = await engine.ainvoke(
        state,
        thread_id=thread_id,
        round_id=f"round-{thread_id}",
        transports=transports,
    )
    return result


def review_scorer() -> Any:
    """review.json + samples facts → 分支评估器（执行域推演用例底座）。"""
    from host.scoring import build_review_scorer

    facts = [f.get("statement") for f in SEED_DATA["samples.json"].get("facts") or ()]
    return build_review_scorer(SEED_DATA["review.json"], facts)


def workflow_spec() -> Any:
    """workflow.json → WorkflowSpec（plan_workflow 约束域注入形态）。"""
    from host.graph_recipe import workflow_spec_from_data

    return workflow_spec_from_data(SEED_DATA["workflow.json"])


def collect_events(transport: Any) -> list[Any]:
    """事件收集（CollectorTransport 形态；测试断言事件流）。"""
    return list(transport.events)


def make_collector() -> Any:
    from ink_engine.core.events import CollectorTransport

    return CollectorTransport()


def orc_subgraph(tool: str, *, node_name: str = "tool_node") -> dict[str, Any]:
    """数据形态子图（spawn/推演分支共用）：单工具节点回合图。"""
    return {
        "name": f"sub.{tool}",
        "entry": node_name,
        "nodes": {
            node_name: {
                "type": "tool_pipeline",
                "config": {"tool": tool},
            }
        },
        "edges": {},
        "exits": [node_name],
        "subgraphs": {},
        "schema": None,
    }


def jsonify(value: Any) -> str:
    """序列化辅助（事件负载断言）。"""
    return json.dumps(value, ensure_ascii=False, default=str)


__all__ = [
    "SEED_DATA",
    "build_ctx",
    "build_round_graph",
    "build_test_pipeline",
    "collect_events",
    "domain_declarative_specs",
    "domain_tool_specs",
    "jsonify",
    "make_collector",
    "orc_subgraph",
    "review_scorer",
    "run_engine",
    "workflow_spec",
]
