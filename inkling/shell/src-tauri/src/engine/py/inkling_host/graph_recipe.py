"""通用图配方：节点类型注册 + 回合图构建（GraphRegistries 数据形态）。

引擎图 DSL（core.graph）以函数式节点为最小单元；本模块把「节点类型」
注册进 GraphRegistries（声明式规格 → 工厂实例化，见 core/registry.py），
让图定义数据（graph.json / spawn 子图 / 推演分支）只携带类型名 + 配置
就能建图——图 = 数据，AI 可改图拓扑（HARNESS 补丁）。

出厂注册两个通用节点类型（PLAN §2 公理 5 的图结构演化边界）：
- ``research_orchestrator``：研究编排节点——返回 __plan__/__spawn__/
  __simulate__ 保留键的通用编排节点（数据驱动脚本形态：默认按
  workflow.json 节点序产出研究流程规划，测试/运行时可用
  state.orchestrate 覆盖）；
- ``tool_pipeline``：工具流水线编排节点——统一工具分发（内省/自指/
  声明式三路由 Runtime 装配的 tool_pipeline 承载），按配置执行指定
  工具或消费 state.pending 待执行清单，工具结果回填状态通道。

回合图 = graph.json（入口/出口/边）+ workflow.json 节点实例化
（研究流程步骤 = 工具执行步骤，workflow 节点以 tool_pipeline 类型
物化，节点 id 与工具名同源）——计划步引用这些节点名即可执行。
"""
from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any
from weakref import WeakKeyDictionary

from ink_engine.core.graph import Graph
from ink_engine.core.plan import PLAN_KEY
from ink_engine.core.runtime import GraphRecipeContext
from ink_engine.core.simulation import SIMULATE_KEY
from ink_engine.core.spawn import SPAWN_KEY
from ink_engine.core.workflow import WorkflowEdgeSpec, WorkflowNodeSpec, WorkflowSpec

# 图节点类型名（graph.json 引用；与引擎注册表约定同源）
TYPE_ORCHESTRATOR = "research_orchestrator"
TYPE_TOOL_PIPELINE = "tool_pipeline"

# 编排脚本的状态通道键（回合入口状态注入，测试/宿主驱动确定性编排）
STATE_ORCHESTRATE = "orchestrate"
STATE_STEP_ARGS = "step_args"
STATE_RESULTS = "results"
STATE_MESSAGES = "messages"
STATE_PENDING = "pending"

# 工具结果回填消息流的截断上限（上下文体积有界）
_TOOL_RESULT_MAX_CHARS = 4000


def workflow_spec_from_data(data: dict[str, Any]) -> WorkflowSpec:
    """workflow.json → WorkflowSpec（节点类型名透传，配置原样保留）。"""
    return WorkflowSpec(
        name=str(data.get("name") or "workflow"),
        nodes=tuple(
            WorkflowNodeSpec(
                id=str(node["id"]),
                type=str(node.get("type") or "tool_pipeline"),
                config=dict(node.get("config") or {}),
            )
            for node in data.get("nodes") or ()
        ),
        edges=tuple(
            WorkflowEdgeSpec(source=str(e["source"]), target=str(e["target"]))
            for e in data.get("edges") or ()
        ),
        entry=data.get("entry"),
    )


def _tool_result_message(text: str, tool_call_id: str) -> dict:
    """工具结果消息（tool 角色，回填消息流供模型/展示消费）。"""
    from ink_engine.core.llm.messages import tool_result

    return tool_result(text, tool_call_id).to_dict()


# ── 节点类型工厂 ──


def make_orchestrator_factory(
    workflow: WorkflowSpec,
) -> Callable[[dict[str, Any]], Callable[[Any], dict | None]]:
    """研究编排节点工厂：配置 → 节点执行函数（数据驱动脚本形态）。

    节点行为：读取 state.orchestrate 脚本（plan/spawns/simulate 三
    保留键的逐一透传）；脚本缺省时按工作流节点序产出默认研究流程
    规划（__plan__ 数据形态 = 每步一个节点的顺序步骤清单）。规划
    产出即发出 plan_start 事件（消息流内联行/推演轨迹树消费）。
    """
    plan_steps = tuple(node.id for node in workflow.nodes)

    def factory(config: dict[str, Any]) -> Callable[[Any], dict | None]:
        use_default_plan = config.get("default_plan", True)

        async def node(ctx: Any) -> dict | None:
            script = ctx.state.get(STATE_ORCHESTRATE) or {}
            plan_data = script.get("plan")
            spawns = script.get("spawns")
            simulate = script.get("simulate")
            delta: dict[str, Any] = {}
            if plan_data is None and use_default_plan:
                plan_data = [{"nodes": [name]} for name in plan_steps]
            if plan_data is not None:
                await ctx.emit("plan_start", {"plan": plan_data})
                delta[PLAN_KEY] = plan_data
            if spawns is not None:
                await ctx.emit("spawn_start", {"spawns": spawns})
                delta[SPAWN_KEY] = spawns
            if simulate is not None:
                delta[SIMULATE_KEY] = simulate
            return delta or None

        return node

    return factory


def make_tool_pipeline_factory(
    holder: dict[str, Any],
) -> Callable[[dict[str, Any]], Callable[[Any], dict | None]]:
    """工具流水线编排节点工厂：配置 → 节点执行函数。

    两种执行形态（配置区分）：
    - ``config.tool`` 指定工具：以该工具名执行（参数 = state.step_args
      同名项或配置缺省值）——工作流步骤节点（节点 id = 工具名）；
    - 未指定：消费 state.pending 待执行清单首项（工具调用留痕内联行）。
    ``role=terminal`` 的实例 = 图出口终态（不执行工具，直接收口）。
    执行结果经统一流水线（权限/审计/守卫机制全部生效），失败按
    降级路径落明（不崩溃、不静默吞错）。流水线与工具规格经持有者
    实时读取（挂载/补丁演化/安全层替换后重建引擎，节点拿到的是
    最新工具表与最新流水线——不携带过期闭包）。
    """
    pipeline = None

    def resolve() -> Any:
        """取当前流水线（持有者刷新后首次调用时缓存新实例）。"""
        nonlocal pipeline
        current = holder.get("pipeline")
        if current is not None and current is not pipeline:
            pipeline = current
        return pipeline

    async def run_tool(
        ctx: Any, name: str, args: dict[str, Any], step_id: str
    ) -> tuple[str, bool]:
        """执行单个工具（统一流水线分发），返回 (结果文本, 是否成功)。"""
        await ctx.emit("tool_start", {"tool": name, "args": args}, step_id=step_id)
        specs = holder.get("specs") or ()
        spec = next((s for s in specs if s.name == name), None)
        pipeline_now = resolve()
        if spec is None:
            text, success = f"未知或未启用工具: {name}", False
        elif pipeline_now is None:
            text, success = "工具未启用（无分发管线）", False
        else:
            try:
                outcome = await pipeline_now.execute(ctx, spec, args)
                text, success = (
                    outcome.output if outcome.ok else f"执行被拒: {outcome.error}",
                    outcome.ok,
                )
            except Exception as exc:
                text, success = f"工具执行异常: {exc}", False
        await ctx.emit(
            "tool_end",
            {"tool": name, "success": success, "message": text[:_TOOL_RESULT_MAX_CHARS]},
            step_id=step_id,
        )
        return text, success

    def factory(config: dict[str, Any]) -> Callable[[Any], dict | None]:
        role = config.get("role")
        tool = config.get("tool")

        async def node(ctx: Any) -> dict | None:
            if role == "terminal":
                return {}
            state = ctx.state
            if tool is not None:
                step_args = state.get(STATE_STEP_ARGS) or {}
                args = step_args.get(tool) or config.get("args") or {}
                text, _success = await run_tool(ctx, tool, args, f"tool:{tool}")
                results = dict(state.get(STATE_RESULTS) or {})
                results[tool] = text
                return {STATE_RESULTS: results}
            pending = state.get(STATE_PENDING) or []
            if not pending:
                return {}
            call = pending[0]
            name = str(call.get("name") or "")
            args = call.get("arguments") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except ValueError:
                    args = {}
            call_id = str(call.get("id") or name)
            text, _success = await run_tool(ctx, name, args, f"tool:{call_id}")
            messages = list(state.get(STATE_MESSAGES) or [])
            messages.append(_tool_result_message(text, call_id))
            return {
                STATE_MESSAGES: messages,
                STATE_PENDING: pending[1:],
            }

        return node

    return factory


# ── 回合图构建 ──

# 工具表/流水线实时持有者（WeakKeyDictionary 按节点注册表实例挂载）：节点
# 工厂只在首次建图时注册一次（注册表防重复登记），但工具表与流水线随挂载/
# 补丁演化/安全层替换而变化——持有者每次建图刷新，工厂执行时取实时值，
# 跨引擎重建不携带过期闭包。
_registry_specs: WeakKeyDictionary[Any, dict[str, Any]] | None = None

# 持有者键（值 = 各刷新一次的快照；节点执行时现取）
_HOLDER_SPECS = "specs"
_HOLDER_PIPELINE = "pipeline"


def _specs_holder(registries: Any) -> dict[str, Any]:
    """取（或建）注册表实例的实时持有者（键 = 节点类型注册表）。"""
    global _registry_specs
    if _registry_specs is None:
        _registry_specs = WeakKeyDictionary()
    holder = _registry_specs.get(registries.nodes)
    if not isinstance(holder, dict):
        holder = {}
        _registry_specs[registries.nodes] = holder
    return holder


def register_node_types(ctx: GraphRecipeContext, workflow: WorkflowSpec) -> None:
    """把两个通用节点类型登记进装配注册表（幂等：重复登记无害）。

    注册只发生一次（注册表对重复登记 fail-fast，防静默覆盖）；工具
    表与流水线持有者在每次建图时刷新——Runtime 在配置/工具表/安全层
    变更时重建引擎并重跑图配方，节点执行时取到的是实时工具表与实时
    流水线。
    """
    registries = ctx.registries
    if registries is None:
        raise ValueError("图配方需要注册表（RunOptions.registries 未注入）")
    holder = _specs_holder(registries)
    holder[_HOLDER_SPECS] = list(ctx.tool_specs)
    holder[_HOLDER_PIPELINE] = ctx.tool_pipeline
    if not registries.nodes.has(TYPE_ORCHESTRATOR):
        registries.nodes.register(TYPE_ORCHESTRATOR, make_orchestrator_factory(workflow))
    if not registries.nodes.has(TYPE_TOOL_PIPELINE):
        registries.nodes.register(
            TYPE_TOOL_PIPELINE,
            make_tool_pipeline_factory(holder),
        )


def build_round_graph(
    ctx: GraphRecipeContext,
    *,
    graph_data: dict[str, Any],
    workflow_data: dict[str, Any],
) -> Graph:
    """按 seed_data/graph.json 建回合图 + workflow.json 节点实例化。

    建图步骤：
    1. 注册节点类型（research_orchestrator / tool_pipeline）；
    2. graph.json 数据形态建图（入口/边/出口，类型按注册表解析）；
    3. workflow.json 每个步骤节点以 tool_pipeline 类型物化
       （config.tool = 节点 id，即领域工具名），步骤链边按工作流
       边序衔接，末步骤连到图出口——计划步引用这些节点名即可执行。

    Returns:
        未编译的 Graph（引擎构造时触发完整编译校验）。
    """
    workflow = workflow_spec_from_data(workflow_data)
    register_node_types(ctx, workflow)

    graph = Graph.from_dict(
        graph_data,
        registry=ctx.registries.nodes,
        edge_registry=ctx.registries.edges,
        validate=True,
    )
    for node in workflow.nodes:
        graph.add_node_type(node.id, TYPE_TOOL_PIPELINE, {"tool": node.id})
    for edge in workflow.edges:
        graph.add_edge(edge.source, edge.target)
    if workflow.nodes:
        exits = graph_data.get("exits") or ()
        if exits:
            graph.add_edge(workflow.nodes[-1].id, str(exits[0]))
    return graph


__all__ = [
    "STATE_MESSAGES",
    "STATE_ORCHESTRATE",
    "STATE_PENDING",
    "STATE_RESULTS",
    "STATE_STEP_ARGS",
    "TYPE_ORCHESTRATOR",
    "TYPE_TOOL_PIPELINE",
    "build_round_graph",
    "make_orchestrator_factory",
    "make_tool_pipeline_factory",
    "register_node_types",
    "workflow_spec_from_data",
]
