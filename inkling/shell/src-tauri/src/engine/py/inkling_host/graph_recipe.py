"""通用图配方：节点类型注册 + 回合图构建（GraphRegistries 数据形态）。

引擎图 DSL（core.graph）以函数式节点为最小单元；本模块把「节点类型」
注册进 GraphRegistries（声明式规格 → 工厂实例化，见 core/registry.py），
让图定义数据（graph.json / spawn 子图 / 推演分支）只携带类型名 + 配置
就能建图——图 = 数据，AI 可改图拓扑（HARNESS 补丁）。

出厂注册两个通用节点类型（设计文档第二节公理 5 的图结构演化边界）：
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
from collections.abc import Callable, Sequence
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
# LLM 决策循环节点（产品 agent 回合入口：LLM 读消息流 → 工具调用清单 →
# pending 回环执行 → 无工具调用时收口回复；产品装配版 agent 循环）
TYPE_LLM_DECIDER = "llm_decider"
# 组装编排节点（组装优先：PathAssembler 产候选路径 → spawn 展开执行；
# 零候选/组装未装配 = 回落研究链默认规划，保持既有行为）
TYPE_ASSEMBLY_ORCHESTRATOR = "assembly_orchestrator"

# 编排脚本的状态通道键（回合入口状态注入，测试/宿主驱动确定性编排）
STATE_ORCHESTRATE = "orchestrate"
STATE_STEP_ARGS = "step_args"
STATE_RESULTS = "results"
STATE_MESSAGES = "messages"
STATE_PENDING = "pending"

# LLM 决策循环护栏（回合工具循环上限；成本护栏与参考宿主同阶）
MAX_TOOL_ROUNDS = 8
# 工具结果回填消息流的截断上限（上下文体积有界）
TOOL_RESULT_MAX_CHARS = 4000
# 组装回环上限（候选执行失败 → 修复算子重组装的重试轮数）
ASSEMBLY_MAX_ROUNDS = 2

# llm_decider 回环条件边名（graph.json 引用；判定见 register_node_types）
COND_PENDING = "llm.pending_nonempty"
COND_FINISHED = "llm.pending_empty"

# 子图命名前缀（spawn 分组展开实例的子图名；实例事件按 graph_path 归属）
_SPAWN_SUBGRAPH_PREFIX = "inkling.spawn."


def spawn_group_specs(
    workflow: WorkflowSpec, spawns: list[dict], step_args: dict | None = None
) -> list[dict]:
    """spawn 分组清单 → 引擎子任务清单契约（subgraph/state/index）。

    策略层产出的分组形态 = {id, nodes[], parallel, label}（展示语义）；
    引擎消费形态 = {subgraph: 图定义数据, state: 入口状态, index: 实例序号}。
    契约锚定在引擎侧（collect_spawn_specs），本转换与 build_round_graph
    同源同模块：parallel 组按每节点一实例拆分子图（单节点 tool_pipeline，
    引擎并发上限天然约束并行度），串行组为单实例链式子图（按分组列表序
    串联边）。state 携带回合步骤参数（step_args 透传，各实例只消费自己
    工具名对应的参数段；无参数时为空字典）。index 全局唯一（组序×组内
    序），引擎拒绝重复序号。未知节点 id 不在此处校验——子图重建时由引擎
    图校验失败收口（fail-closed，不静默跳过）。
    """
    shared_args = dict(step_args or {})
    specs: list[dict] = []
    for group_index, group in enumerate(spawns):
        group_id = str(group.get("id") or f"g{group_index}")
        nodes = list(group.get("nodes") or [])
        parallel = bool(group.get("parallel"))
        if not nodes:
            raise ValueError(f"spawn 分组 {group_id} 为空（无节点清单）")
        if parallel:
            for node_index, node in enumerate(nodes):
                subgraph = {
                    "name": f"{_SPAWN_SUBGRAPH_PREFIX}{group_id}.{node}",
                    "entry": node,
                    "nodes": {
                        node: {
                            "type": TYPE_TOOL_PIPELINE,
                            "config": {"tool": node},
                        }
                    },
                    "edges": {},
                    "exits": [node],
                }
                specs.append({
                    "subgraph": subgraph,
                    "state": {"step_args": shared_args},
                    "index": group_index * 100 + node_index,
                })
        else:
            subgraph = {
                "name": f"{_SPAWN_SUBGRAPH_PREFIX}{group_id}",
                "entry": nodes[0],
                "nodes": {
                    node: {
                        "type": TYPE_TOOL_PIPELINE,
                        "config": {"tool": node},
                    }
                    for node in nodes
                },
                "edges": {
                    nodes[i]: [{"target": nodes[i + 1]}]
                    for i in range(len(nodes) - 1)
                },
                "exits": [nodes[-1]],
            }
            specs.append({
                "subgraph": subgraph,
                "state": {"step_args": shared_args},
                "index": group_index * 100,
            })
    return specs


def assembly_candidate_specs(
    candidates: list[dict], step_args: dict | None = None
) -> list[dict]:
    """组装候选（图定义数据）→ spawn 子任务清单契约（直接消费候选图）。

    ENG9a-2 接线：候选图定义数据（``candidate["graph"]``）直接作 spawn
    subgraph 消费——graph/score/rank/契约快照不再被降级丢弃为工具名列表；
    节点类型即注册表类型（组装候选链的全部结点都在注册表内带契约登记，
    见 :func:`register_node_types` 的工具契约登记）。

    「类型名→工具名」显式映射契约 + 两端断言：
    - 登记端（register_node_types）：结点类型名 == 工具名（同源单一事实，
      经 declarative_tools.tool_node_mapping 保证）；
    - 消费端（本函数）：候选图内每个结点类型名都须已登记（
      ``registries.nodes.has`` 断言）——类型名与工具名漂移（候选引用未
      登记类型）在此显式报错，不做静默降级。

    index 全局唯一（组序 × 100 + 组内序），引擎拒绝重复序号；state 携带
    回合步骤参数（step_args 透传）。
    """
    registries = _current_registries()
    shared_args = dict(step_args or {})
    specs: list[dict] = []
    for rank, candidate in enumerate(candidates, start=1):
        graph_data = candidate.get("graph")
        if not isinstance(graph_data, dict):
            raise TypeError(f"组装候选 {rank} 缺图定义数据（candidate.graph）")
        chain = candidate.get("chain") or ()
        if registries is not None:
            for type_name in chain:
                if not registries.nodes.has(str(type_name)):
                    raise ValueError(
                        f"组装候选 {rank} 引用未登记结点类型: {type_name}"
                        f"（类型名→工具名映射契约：结点类型须已登记）"
                    )
        specs.append(
            {
                "subgraph": graph_data,
                "state": {"step_args": shared_args},
                "index": rank * 100,
            }
        )
    return specs


def _current_registries() -> Any:
    """取当前装配注册表（图配方注册处挂载的 GraphRegistries；未挂载 = None）。

    注册表实例随引擎重建变化（register_node_types 按 ctx.registries 挂载），
    本函数经模块级最近一次注册记录取用——组装候选消费端断言用。
    """
    return _REGISTRIES_STATE.get("registries") if _REGISTRIES_STATE else None


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
                # 展示形态保留（{id,nodes,parallel,label}，前端零改动）；
                # 引擎消费形态 = 转换后的契约清单（subgraph/state/index），
                # 回合步骤参数随实例入口状态透传（各实例只消费自己工具段）
                delta[SPAWN_KEY] = spawn_group_specs(
                    workflow, spawns, step_args=ctx.state.get(STATE_STEP_ARGS)
                )
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
        # canary 态桩化（ENG9a-6 护栏的结点层一侧）：canary 单回合验证
        # 只确认「图合法 + 走通」，真实工具调用（文件写/shell/MCP）不得
        # 在 canary 态发生——工具层桩执行并标记成功，路径完整走完
        from ink_engine.core.path_assembler import canary_active

        if canary_active():
            return "（canary 桩执行：工具未真实调用）", True
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
            {"tool": name, "success": success, "message": text[:TOOL_RESULT_MAX_CHARS]},
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


def make_llm_decider_factory(
    holder: dict[str, Any],
) -> Callable[[dict[str, Any]], Callable[[Any], dict | None]]:
    """LLM 决策循环节点工厂：配置 → 节点执行函数（产品 agent 回合入口）。

    节点行为（build_agent_graph 的产品装配形态，机制零新增）：
    1. 恢复消息流（缺省 = 系统提示 + 回合输入组装首条）；
    2. 调 LLM（带全量工具表，经 holder 实时取模型/规格/流水线——引擎
       重建后取最新装配源，不携带过期闭包）；
    3. 流式增量发 reply_token 事件，工具调用增量累积；
    4. 有工具调用 → 写 state.pending（工具调用留痕清单）+ 消息流回填，
       图边回环 tool_pipeline 消费；无工具调用 → 收口（回合终态）。
    工具循环护栏（MAX_TOOL_ROUNDS）超限强制收口，防成本失控。
    """
    from ink_engine.core.llm.messages import (
        Message,
        accumulate_tool_calls,
        assistant,
        system,
        user,
    )

    def factory(config: dict[str, Any]) -> Callable[[Any], dict | None]:
        system_prompt = str(config.get("system_prompt") or "")
        max_rounds = int(config.get("max_tool_rounds") or MAX_TOOL_ROUNDS)

        async def restore_messages(ctx: Any) -> list[Message]:
            restored = ctx.state.get(STATE_MESSAGES) or []
            if restored:
                return [
                    Message.from_dict(m) for m in restored if isinstance(m, dict)
                ]
            messages: list[Message] = []
            if system_prompt:
                messages.append(system(system_prompt))
            # 输入调配产物接入（组装观察 2 接线）：预装配文本（多源统一
            # 调配的产物——上下文/知识/工具/记忆/证据）并入首条用户消息，
            # llm_decider 的 messages 不再只由 system_prompt + 原始输入构成
            assembled_text = ""
            assembled = getattr(ctx, "_assembled", None)
            if assembled is not None and getattr(assembled, "text", ""):
                assembled_text = assembled.text
            base_input = str(ctx.state.get("input") or "")
            if assembled_text:
                messages.append(
                    user(
                        f"{base_input}\n\n【回合输入调配】\n{assembled_text}"
                        if base_input
                        else f"【回合输入调配】\n{assembled_text}"
                    )
                )
            else:
                messages.append(user(base_input))
            return messages

        async def node(ctx: Any) -> dict | None:
            llm = holder.get("llm")
            if llm is None:
                await ctx.emit("error", {"message": "模型未装配（llm_decider 无模型可调）"})
                return {}
            messages = await restore_messages(ctx)
            reply = str(ctx.state.get("reply") or "")
            rounds = int(ctx.state.get("tool_rounds") or 0)
            if rounds >= max_rounds:
                return {"reply": reply}
            # canary 态桩化（ENG9a-6）：不调模型，直接以输入收口回复——
            # canary 单回合验证不产生真实 LLM 调用（成本与副作用护栏）
            from ink_engine.core.path_assembler import canary_active

            if canary_active():
                return {
                    "reply": str(ctx.state.get("input") or "") or reply,
                    STATE_MESSAGES: [m.to_dict() for m in messages],
                }
            content = ""
            deltas: list = []
            try:
                specs = holder.get("specs") or ()
                stream = llm.astream(
                    messages,
                    tools=list(specs) or None,
                    params=None,
                )
                async for chunk in stream:
                    if getattr(chunk, "token", None):
                        content += chunk.token
                        reply += chunk.token
                        await ctx.emit("reply_token", {"token": chunk.token})
                    if getattr(chunk, "tool_calls_delta", None):
                        deltas.extend(chunk.tool_calls_delta)
            except Exception as exc:
                await ctx.emit("error", {"message": f"模型调用失败: {exc}"})
                return {"reply": reply}
            calls = accumulate_tool_calls(deltas)
            messages.append(assistant(content, tool_calls=calls or None))
            if not calls:
                return {
                    "reply": reply,
                    STATE_MESSAGES: [m.to_dict() for m in messages],
                }
            pending = [
                {"name": call.name, "id": call.id, "arguments": call.arguments}
                for call in calls
            ]
            return {
                STATE_MESSAGES: [m.to_dict() for m in messages],
                STATE_PENDING: pending,
                "reply": reply,
                "tool_rounds": rounds + 1,
            }

        return node

    return factory


def make_assembler_factory(
    workflow: WorkflowSpec,
) -> Callable[[dict[str, Any]], Callable[[Any], dict | None]]:
    """组装编排节点工厂：配置 → 节点执行函数（组装优先，研究链回落）。

    节点行为（组装器接入回合图的产品形态）：
    1. 读 state.orchestrate 脚本（plan/spawns/simulate 保留键透传，
       确定性编排优先——既有 research_orchestrator 语义保留）；
    2. 脚本缺省时调组装运行期（get_default_assembly_runtime；
       boot 装配已挂载 PathAssemblyRuntime）：
       - 组装请求：目标字段（config.goal_fields 或回合输入推导）、
         域（config.domain 或 default）、放行档（approval 映射）、
         质量闸门（DomainQualityGate）、草稿源（LLM 草稿桥或 None）；
       - 候选路径（1..k 条）→ 转 spawn（候选链作为 tool_pipeline
         子图展开执行，回合步骤参数随实例透传）；
       - 零候选/组装未装配 → 回落默认研究链规划（__plan__ 既有
         数据形态，前端零改动）；
    3. 失败回环：候选执行失败信号（state.assembly_failed）→ 条件边
       回本节点重试（修复算子重组装，ASSEMBLY_MAX_ROUNDS 上限），
       回环轮次经 state.assembly_rounds 计数。
    """
    plan_steps = tuple(node.id for node in workflow.nodes)

    def factory(config: dict[str, Any]) -> Callable[[Any], dict | None]:
        use_default_plan = config.get("default_plan", True)
        goal_fields = tuple(str(f) for f in (config.get("goal_fields") or ()))
        domain = str(config.get("domain") or "default")
        max_rounds = int(config.get("max_rounds") or ASSEMBLY_MAX_ROUNDS)
        # 回合审批档（graph.json 配置声明；缺省 None = 0 最严 fail-closed）
        approval_tier = config.get("approval_tier")
        # 本次组装的请求（多径调度清单携带：执行入口经请求取安全档/域/闸门）
        result_request: Any = None

        async def assemble_candidates(
            ctx: Any,
        ) -> tuple[list[dict], str, Any | None]:
            """组装请求 → (候选清单图定义形态, 说明, 组装结果)；未装配 = 空。"""
            from ink_engine.core.path_assembler import (
                AssemblyRequest,
                get_default_assembly_runtime,
            )
            from ink_engine.core.schema_validator import (
                FIELD_STRING,
                SchemaField,
                SchemaSpec,
            )

            from inkling_host.quality import (
                DomainQualityGate,
                approval_tier_to_max_safety_tier,
            )

            runtime = get_default_assembly_runtime()
            if runtime is None:
                return [], "组装运行期未装配（默认关闭）", None
            # 目标字段：config 声明优先，缺省按研究链产出形态（result 通道）
            fields = goal_fields or ("result",)
            goal_schema = SchemaSpec(
                name="assembly.goal",
                fields=tuple(
                    SchemaField(name=f, required=True, kind=FIELD_STRING)
                    for f in fields
                ),
            )
            nonlocal result_request
            result_request = AssemblyRequest(
                goal_schema=goal_schema,
                entry_fields=(),
                domain=domain,
                max_safety_tier=approval_tier_to_max_safety_tier(approval_tier),
                quality_gate=DomainQualityGate(),
                top_k=int(config.get("top_k") or 2),
            )
            result = await runtime.assemble_plan(result_request)
            if not result.candidates:
                return [], f"组装零候选（{result.fallback_reason or '无解'}）", result
            candidates = [candidate.to_dict() for candidate in result.candidates]
            return candidates, "组装候选产出", result

        async def node(ctx: Any) -> dict | None:
            script = ctx.state.get(STATE_ORCHESTRATE) or {}
            plan_data = script.get("plan")
            spawns = script.get("spawns")
            simulate = script.get("simulate")
            if plan_data is not None or spawns is not None or simulate is not None:
                # 确定性编排优先（既有 research_orchestrator 语义透传）
                delta: dict[str, Any] = {}
                if plan_data is not None:
                    await ctx.emit("plan_start", {"plan": plan_data})
                    delta[PLAN_KEY] = plan_data
                if spawns is not None:
                    await ctx.emit("spawn_start", {"spawns": spawns})
                    delta[SPAWN_KEY] = spawn_group_specs(
                        workflow, spawns, step_args=ctx.state.get(STATE_STEP_ARGS)
                    )
                if simulate is not None:
                    delta[SIMULATE_KEY] = simulate
                return delta or None
            # 组装优先：候选路径 → 执行展开（多径开启 = 多径调度；否则
            # spawn 子图展开执行）
            rounds = int(ctx.state.get("assembly_rounds") or 0)
            if rounds >= max_rounds:
                if use_default_plan:
                    fallback = [{"nodes": [name]} for name in plan_steps]
                    await ctx.emit("plan_start", {"plan": fallback})
                    return {PLAN_KEY: fallback}
                return {}
            candidates, note, result = await assemble_candidates(ctx)
            if not candidates:
                if use_default_plan:
                    fallback = [{"nodes": [name]} for name in plan_steps]
                    await ctx.emit("plan_start", {"plan": fallback})
                    return {PLAN_KEY: fallback}
                return {}
            # 多径调度（E-P2 接线）：机制开关（装配运行期 multipath_enabled）
            # + 触发信号（组装结果 multipath_signal）双双放行 → 候选集交
            # 执行入口经 MultipathRunner 并行执行 + 汇流裁决；信号不成立 =
            # 走单链 spawn 展开（组装候选仍被执行，不静默丢弃）
            from ink_engine.core.multipath import MULTIPATH_KEY
            from ink_engine.core.path_assembler import get_default_assembly_runtime

            mp_runtime = get_default_assembly_runtime()
            if (
                mp_runtime is not None
                and getattr(mp_runtime, "multipath_enabled", False)
                and result is not None
                and result.multipath_signal
            ):
                return {
                    MULTIPATH_KEY: {
                        "request": result_request,
                        "candidates": list(result.candidates),
                        "entry_state": {
                            "input": ctx.state.get("input") or "",
                            "step_args": ctx.state.get(STATE_STEP_ARGS) or {},
                        },
                        "k": int(config.get("multipath_k") or 2),
                    },
                    "assembly_rounds": rounds + 1,
                }
            # 候选图定义数据直接作 spawn subgraph 消费（ENG9a-2：不再降级
            # 为工具名列表）；展示形态（spawn_start 事件）仍按候选链给前端
            spawn_groups: list[dict] = []
            for rank, candidate in enumerate(candidates, start=1):
                chain = candidate.get("chain") or []
                if not chain:
                    continue
                spawn_groups.append(
                    {
                        "id": f"assembly-{rounds + 1}-{rank}",
                        "nodes": list(chain),
                        "parallel": False,
                        "label": f"组装候选 {rank}（{note}）",
                    }
                )
            if not spawn_groups:
                if use_default_plan:
                    fallback = [{"nodes": [name]} for name in plan_steps]
                    await ctx.emit("plan_start", {"plan": fallback})
                    return {PLAN_KEY: fallback}
                return {}
            await ctx.emit("spawn_start", {"spawns": spawn_groups})
            return {
                SPAWN_KEY: assembly_candidate_specs(
                    candidates, step_args=ctx.state.get(STATE_STEP_ARGS)
                ),
                "assembly_rounds": rounds + 1,
            }

        return node

    return factory

# 工具表/流水线实时持有者（WeakKeyDictionary 按节点注册表实例挂载）：节点
# 工厂只在首次建图时注册一次（注册表防重复登记），但工具表与流水线随挂载/
# 补丁演化/安全层替换而变化——持有者每次建图刷新，工厂执行时取实时值，
# 跨引擎重建不携带过期闭包。
_registry_specs: WeakKeyDictionary[Any, dict[str, Any]] | None = None

# 最近一次图配方注册的注册表实例（组装候选消费端断言取用；引擎重建后
# 由 register_node_types 刷新——只读引用，不持有可变状态快照）
_REGISTRIES_STATE: dict[str, Any] = {}

# 持有者键（值 = 各刷新一次的快照；节点执行时现取）
_HOLDER_SPECS = "specs"
_HOLDER_PIPELINE = "pipeline"
_HOLDER_LLM = "llm"


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
    """把节点类型登记进装配注册表（幂等：重复登记无害）。

    注册只发生一次（注册表对重复登记 fail-fast，防静默覆盖）；工具
    表、流水线与模型持有者在每次建图时刷新——Runtime 在配置/工具表/
    安全层变更时重建引擎并重跑图配方，节点执行时取到的是实时工具表、
    实时流水线与实时模型（llm_decider 决策循环依赖模型实时引用）。
    """
    registries = ctx.registries
    if registries is None:
        raise ValueError("图配方需要注册表（RunOptions.registries 未注入）")
    _REGISTRIES_STATE["registries"] = registries
    holder = _specs_holder(registries)
    holder[_HOLDER_SPECS] = list(ctx.tool_specs)
    holder[_HOLDER_PIPELINE] = ctx.tool_pipeline
    holder[_HOLDER_LLM] = ctx.llm
    if not registries.nodes.has(TYPE_ORCHESTRATOR):
        registries.nodes.register(TYPE_ORCHESTRATOR, make_orchestrator_factory(workflow))
    if not registries.nodes.has(TYPE_TOOL_PIPELINE):
        registries.nodes.register(
            TYPE_TOOL_PIPELINE,
            make_tool_pipeline_factory(holder),
        )
    if not registries.nodes.has(TYPE_LLM_DECIDER):
        registries.nodes.register(TYPE_LLM_DECIDER, make_llm_decider_factory(holder))
    if not registries.nodes.has(TYPE_ASSEMBLY_ORCHESTRATOR):
        registries.nodes.register(
            TYPE_ASSEMBLY_ORCHESTRATOR, make_assembler_factory(workflow)
        )
    # llm_decider 回环条件边（判定 = 状态通道 pending 是否有待执行工具调用）
    edges = registries.edges
    if not edges.has(COND_PENDING):
        edges.register(
            COND_PENDING,
            lambda ctx: bool(ctx.state.get(STATE_PENDING)),
        )
    if not edges.has(COND_FINISHED):
        edges.register(
            COND_FINISHED,
            lambda ctx: not bool(ctx.state.get(STATE_PENDING)),
        )


def register_tool_node_types(registry: Any, specs: Sequence[Any]) -> int:
    """声明式工具 → 结点类型登记（结点类型 = 工具名；契约随登记）。

    ENG9a-1 接线：组装池不再只有 vision_perceive 一个带契约类型——每个
    声明式工具以「结点类型 = 工具名」登记（契约 = 工具声明自动生成：
    输入 = parameters、输出 = 端点操作结果形态、安全档 = 审批档同阶，
    见 ``declarative_tools.tool_contract_from_declaration``），assemble
    的目标字段与真实工具产出可匹配、放行档剪枝按真实审批档生效。

    「类型名→工具名」显式映射契约 + 登记端断言：tool_node_mapping 保证
    工具名唯一且 node_type == tool_name（同源单一事实，漂移显式报错）；
    契约自动生成缺失 = 显式报错不静默跳过。工厂 = 工具流水线工厂按
    工具名绑定（执行走实时持有者的最新流水线/工具表快照）。

    Returns:
        本次新登记类型数（幂等：已登记类型跳过）。
    """
    from ink_engine.core.declarative_tools import (
        node_contracts_from_tools,
        tool_node_mapping,
    )

    definitions = list(specs)
    mapping = tool_node_mapping(definitions)
    contracts = node_contracts_from_tools(definitions)
    holder = _specs_holder_from_registry(registry)
    inner = make_tool_pipeline_factory(holder)
    registered = 0
    for tool_name in mapping:
        type_name = mapping[tool_name]
        contract = contracts.get(type_name)
        if contract is None:
            raise ValueError(f"工具 {tool_name} 契约自动生成缺失（登记失败）")
        if registry.has(type_name):
            continue  # 幂等：跨引擎重建重复登记无害
        registry.register(
            type_name,
            lambda config, _name=tool_name: inner({**config, "tool": _name}),
            contract=contract,
        )
        registered += 1
    return registered


def _specs_holder_from_registry(registry: Any) -> dict[str, Any]:
    """取（或建）注册表实例的实时持有者（与 register_node_types 同源）。"""
    global _registry_specs
    if _registry_specs is None:
        _registry_specs = WeakKeyDictionary()
    holder = _registry_specs.get(registry)
    if not isinstance(holder, dict):
        holder = {}
        _registry_specs[registry] = holder
    return holder


def build_round_graph(
    ctx: GraphRecipeContext,
    *,
    graph_data: dict[str, Any],
    workflow_data: dict[str, Any],
) -> Graph:
    """按 seed_data/graph.json 建回合图 + workflow.json 节点实例化。

    建图步骤：
    1. 注册节点类型（research_orchestrator / tool_pipeline /
       llm_decider / assembly_orchestrator）；
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
        # 研究链末节点收口到 LLM 决策循环（存在时）：研究链工具执行后
        # 由模型自主决策收尾/修复/续做；无 llm_decider 节点则按图出口收口
        exits = graph_data.get("exits") or ()
        sink = "llm_decider" if "llm_decider" in graph.node_bindings else (
            str(exits[0]) if exits else None
        )
        if sink is not None:
            graph.add_edge(workflow.nodes[-1].id, sink)
    return graph


__all__ = [
    "ASSEMBLY_MAX_ROUNDS",
    "MAX_TOOL_ROUNDS",
    "STATE_MESSAGES",
    "STATE_ORCHESTRATE",
    "STATE_PENDING",
    "STATE_RESULTS",
    "STATE_STEP_ARGS",
    "TOOL_RESULT_MAX_CHARS",
    "TYPE_ASSEMBLY_ORCHESTRATOR",
    "TYPE_LLM_DECIDER",
    "TYPE_ORCHESTRATOR",
    "TYPE_TOOL_PIPELINE",
    "assembly_candidate_specs",
    "build_round_graph",
    "make_assembler_factory",
    "make_llm_decider_factory",
    "make_orchestrator_factory",
    "make_tool_pipeline_factory",
    "register_node_types",
    "register_tool_node_types",
    "spawn_group_specs",
    "workflow_spec_from_data",
]
