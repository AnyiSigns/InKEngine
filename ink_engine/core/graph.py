"""图定义 DSL（数据驱动，替代 langgraph StateGraph）。

Graph{nodes: {name: Node}, edges: {from: [Edge]}, entry, exits}：
- Node = async (ctx: NodeContext) -> PartialState | None（无状态副作用，返回增量）；
- Edge = 静态边 | 条件边 (ctx) -> bool 判定向 target；
- 嵌套图：子图 = 图实例挂为节点，执行时入路径栈（graph_path 显式记录，
  替代 langgraph ns 三元组）；
- 循环回路：条件边可回指图内节点（路由→监督者→域专才→回路由语义）；
- 回合终止信号：节点经 ctx.terminate(reason) 声明，引擎结束本轮并记录
  终止原因（reply/止损/超限/异常，入轨迹与审计）。

图定义数据化（Graph as Data）：图 = 可序列化数据（节点按注册类型名
引用、条件边按条件名引用），可随 checkpoint 版本化、随 harness 仓库
导出/导入——演化 = 新版本，回退 = 旧版本，分支 = 平行图。
"""
from __future__ import annotations

import hashlib
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol

from .exceptions import EngineError, GraphDefinitionError, NodeNotFoundError

if TYPE_CHECKING:
    from .registry import EdgeConditionRegistry, NodeTypeRegistry

# 节点签名：async (ctx) -> 增量 dict（None = 无状态变更）；
# 兼容同步函数（执行器 inspect.isawaitable 检测）
NodeFn = Callable[["NodeContext"], dict | Awaitable[dict | None] | None]

# 条件边判定：(ctx) -> bool；同样兼容同步/异步
EdgeCondition = Callable[["NodeContext"], bool | Awaitable[bool]]

# 图终止原因（入轨迹与审计，枚举化防魔法值）
class TerminateReason:
    REPLY = "reply"  # 正常回复收尾
    STOP = "stop"  # 业务止损（拒绝转讨论/domain_all 兜底等）
    BUDGET_EXCEEDED = "budget_exceeded"  # 执行预算超限
    ERROR = "error"  # 节点异常终止
    CANCELLED = "cancelled"  # 外部取消（打断重定向）

    _ALL = (REPLY, STOP, BUDGET_EXCEEDED, ERROR, CANCELLED)

    @classmethod
    def is_valid(cls, reason: str) -> bool:
        return reason in cls._ALL


@dataclass(frozen=True, slots=True)
class Edge:
    """边：静态边（condition=None）或条件边（condition 为真才走）。

    条件边有两种声明形态：直接挂判定函数（``add_conditional_edge``，
    进程内执行语义）或按条件名引用（``add_conditional_edge_by_name``，
    可序列化形态——图定义数据随 checkpoint/harness 仓库持久化）。
    """

    target: str
    condition: EdgeCondition | None = None
    condition_name: str | None = None

    def to_dict(self) -> dict:
        """序列化：条件边必须携带条件名（函数本身不是数据，拒绝静默丢失）。"""
        if self.condition is not None and self.condition_name is None:
            raise GraphDefinitionError(
                f"条件边 -> {self.target} 未注册条件名，无法序列化"
                f"（请用 add_conditional_edge_by_name 声明）"
            )
        data: dict[str, Any] = {"target": self.target}
        if self.condition_name is not None:
            data["condition"] = self.condition_name
        return data


@dataclass(frozen=True, slots=True)
class NodeBinding:
    """声明式节点的类型绑定（节点名 → 注册类型名 + 配置）。

    经 :meth:`Graph.add_node_type` 登记；序列化/重建时按类型名引用，
    函数实例化发生在类型解析（:meth:`Graph.resolve_types`）阶段。
    """

    type_name: str
    config: dict[str, Any]


class NodeContext(Protocol):
    """节点运行时上下文（执行器注入，节点经 ctx 发射事件/声明中断/终止）。"""

    @property
    def state(self) -> dict: ...

    @property
    def graph_path(self) -> tuple[str, ...]: ...

    @property
    def round_id(self) -> str | None: ...

    @property
    def trace_id(self) -> str: ...

    async def emit(self, etype: str, payload: dict, *, step_id: str | None = None) -> None: ...

    async def interrupt(self, review_key: str, payload: dict) -> Any: ...

    async def get_interrupt_payload(self, review_key: str) -> dict | None:
        """读取链尾挂起卡负载（key 匹配时）：重入场景读回挂起时的卡状态
        （如审批超时窗口 expires_at），供挂起语义的时间敏感判定使用。
        """
        ...

    def spawn(self, subgraph: Graph, state: dict, *, index: int | None = None) -> None:
        """登记一个动态子任务（子图实例清单项，节点返回后统一展开）。

        便捷封装：与数据驱动形态（节点返回值携带 ``__spawn__`` 保留键
        的清单）等价；清单项在节点返回后由执行器并发展开为独立子图
        实例，实例最终状态按 index 顺序回流父图。
        """
        ...

    async def assemble(
        self,
        sources: list[Any],
        *,
        total_budget: int | None = None,
        version_snapshot: dict | None = None,
    ) -> Any:
        """输入调配统一入口（执行语义：每次 LLM 调用前多源统一调配）。

        上下文片段 + 知识集注入 + 工具集裁剪 + 记忆召回 + 证据组装在
        调用点统一预算分配与留痕（激活记录随事件落库，模型可见皆记录）。
        预装配（preassemble）后调用复用缓存结果；未启用调配
        （RunOptions.assembly=None 或 enabled=False）时抛
        GraphDefinitionError——调用点据此回退旧装配路径（一键开关）。
        """
        ...

    async def preassemble(self) -> None:
        """节点执行前的统一预装配（执行器在节点循环内自动调用）。

        源由 RunOptions.assembly_sources 提供（未注入时静默跳过，节点
        自行经 assemble 装配）；预装配结果随 assemble 复用，模型可见
        的激活记录只留痕一次。
        """
        ...

    def terminate(self, reason: str, **meta: Any) -> None: ...

    @property
    def terminated(self) -> bool: ...


@dataclass(slots=True)
class Graph:
    """数据驱动图定义。

    entry/exits 必须声明（多入口图不支持，入口 = entry 节点）；
    exits 中的节点执行完毕后图终止（含 END 语义，业务自行命名）。

    schema: 本图状态通道 schema（None = 继承父图/引擎默认）。嵌套子图
    允许自定义 schema（路由子图/工具子图各自声明通道），未声明时继承
    父引擎 options.schema——单引擎内子图按需声明，互不干扰。
    """

    name: str
    entry: str
    nodes: dict[str, NodeFn] = field(default_factory=dict)
    edges: dict[str, list[Edge]] = field(default_factory=dict)
    exits: set[str] = field(default_factory=set)
    subgraphs: dict[str, Graph] = field(default_factory=dict)
    schema: Any = None
    # 声明式节点绑定（节点名 → 类型名+配置）：序列化/重建的唯一引用来源。
    # 函数直挂节点（add_node）无绑定，序列化时显式拒绝（防静默丢失）。
    node_bindings: dict[str, NodeBinding] = field(default_factory=dict)

    def add_node(self, name: str, fn: NodeFn) -> None:
        if name in self.nodes or name in self.node_bindings or name in self.subgraphs:
            raise GraphDefinitionError(f"节点名冲突: {name}")
        self.nodes[name] = fn

    def add_node_type(
        self, name: str, type_name: str, config: dict[str, Any] | None = None
    ) -> None:
        """声明式节点：按注册表类型名引用（可序列化/重建，图定义数据形态）。

        函数实例化延迟到 :meth:`resolve_types`（传入节点注册表）或
        :meth:`from_dict`（重建路径）；绑定记录随图序列化持久化。
        """
        if name in self.nodes or name in self.subgraphs:
            raise GraphDefinitionError(f"节点名冲突: {name}")
        if not type_name:
            raise GraphDefinitionError(f"节点 {name} 的类型名不能为空")
        self.node_bindings[name] = NodeBinding(
            type_name=type_name, config=dict(config or {})
        )

    def resolve_types(self, registry: NodeTypeRegistry | None = None) -> None:
        """把声明式节点绑定实例化为函数节点（递归子图，幂等）。

        已实例化的绑定跳过（重复调用安全）；未提供注册表且仍有未解析
        绑定 = 图不可运行（建图期拒绝，不等到执行期节点未注册才暴露）。
        """
        if not self.node_bindings:
            return
        if registry is None:
            raise GraphDefinitionError(
                f"图 {self.name} 含未解析的声明式节点，需注入节点注册表"
            )
        for name, binding in self.node_bindings.items():
            if name not in self.nodes:
                self.nodes[name] = registry.create(binding.type_name, binding.config)
        for subgraph in self.subgraphs.values():
            subgraph.resolve_types(registry)

    def add_edge(self, source: str, target: str) -> None:
        self.edges.setdefault(source, []).append(Edge(target=target))

    def add_conditional_edge(
        self, source: str, target: str, condition: EdgeCondition
    ) -> None:
        self.edges.setdefault(source, []).append(Edge(target=target, condition=condition))

    def add_conditional_edge_by_name(
        self, source: str, target: str, condition_name: str
    ) -> None:
        """按条件名声明条件边（可序列化形态：条件名经注册表在解析时绑定）。

        判定函数在 :meth:`resolve_conditions`（传入条件注册表）时实例化
        ——解析前编译校验会拒绝该图（按名声明却未解析 = 图不可运行）。
        """
        if not condition_name:
            raise GraphDefinitionError(f"条件边 {source}->{target} 的条件名不能为空")
        self.edges.setdefault(source, []).append(
            Edge(target=target, condition_name=condition_name)
        )

    def resolve_conditions(
        self, edge_registry: EdgeConditionRegistry | None = None
    ) -> None:
        """把按名声明的条件边解析为判定函数（递归子图，幂等）。

        已解析的边跳过（重复调用安全）；未提供注册表且仍有未解析条件
        边 = 图不可运行（编译期拒绝，不等到运行期按静态边误走）。
        """
        pending = [
            (source, edge)
            for source, edge_list in self.edges.items()
            for edge in edge_list
            if edge.condition_name is not None and edge.condition is None
        ]
        if not pending:
            return
        if edge_registry is None:
            raise GraphDefinitionError(
                f"图 {self.name} 含未解析的条件边，需注入条件注册表: "
                + ", ".join(f"{source}->{edge.target}" for source, edge in pending)
            )
        for source, edge in pending:
            edge_list = self.edges[source]
            edge_list[edge_list.index(edge)] = Edge(
                target=edge.target,
                condition=edge_registry.create(edge.condition_name),
                condition_name=edge.condition_name,
            )
        for subgraph in self.subgraphs.values():
            subgraph.resolve_conditions(edge_registry)

    def add_exit(self, name: str) -> None:
        self.exits.add(name)

    def add_subgraph(self, name: str, graph: Graph) -> None:
        """嵌套图：子图 = 图实例节点（graph_path 记录路径，输出回流父图）。"""
        if name in self.nodes or name in self.node_bindings:
            raise GraphDefinitionError(f"节点名冲突: {name}")
        self.subgraphs[name] = graph
        self.nodes[name] = _subgraph_runner(graph)  # type: ignore[assignment]

    def to_dict(self) -> dict:
        """序列化为图定义数据（节点按类型名引用、条件边按条件名引用）。

        Returns:
            dict：name/entry/nodes/edges/exits/subgraphs/schema 全量结构。

        Raises:
            GraphDefinitionError: 存在函数直挂节点（未注册类型名）或函数
                直挂条件边（未注册条件名）——函数不是数据，序列化拒绝
                而非静默丢失。
        """
        nodes: dict[str, dict[str, Any]] = {}
        for name in set(self.nodes) | set(self.node_bindings):
            if name in self.subgraphs:
                continue  # 子图节点经 subgraphs 递归序列化，不重复
            binding = self.node_bindings.get(name)
            if binding is None:
                raise GraphDefinitionError(
                    f"节点 {name} 未注册类型名，无法序列化（请用 add_node_type 声明）"
                )
            nodes[name] = {
                "type": binding.type_name,
                "config": dict(binding.config),
            }
        edges = {
            source: [edge.to_dict() for edge in edge_list]
            for source, edge_list in self.edges.items()
        }
        schema = None
        if self.schema is not None:
            if not hasattr(self.schema, "to_dict"):
                raise GraphDefinitionError(
                    f"图 {self.name} 的 schema 不可序列化: {type(self.schema).__name__}"
                )
            schema = self.schema.to_dict()
        return {
            "name": self.name,
            "entry": self.entry,
            "nodes": nodes,
            "edges": edges,
            "exits": sorted(self.exits),
            "subgraphs": {
                name: subgraph.to_dict() for name, subgraph in self.subgraphs.items()
            },
            "schema": schema,
        }

    @classmethod
    def from_dict(
        cls,
        data: dict[str, Any],
        *,
        registry: NodeTypeRegistry | None = None,
        edge_registry: EdgeConditionRegistry | None = None,
        validate: bool = False,
    ) -> Graph:
        """从图定义数据重建（节点/条件按注册表解析，含子图递归与 schema 还原）。

        Args:
            data: :meth:`to_dict` 产出的图定义数据。
            registry: 节点注册表（解析节点类型；缺省 None = 仅允许无绑定图）。
            edge_registry: 条件注册表（解析条件边；存在条件边时必须提供）。
            validate: 重建后执行 :meth:`compile` 结构校验（悬挂入口/边源/出口
                与未解析条件在建图期暴露）——harness 注册等「LLM 生成图定义」
                入口应开启，避免非法定义延后到执行期才静默降级。

        Raises:
            GraphDefinitionError: 结构非法（缺字段/类型错乱/未知节点引用/
                条件名未注册/子图校验失败）。
        """
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"图定义数据非法: 期望 dict，收到 {type(data).__name__}"
            )
        name = data.get("name")
        entry = data.get("entry")
        if not name or not entry:
            raise GraphDefinitionError("图定义数据缺 name/entry 字段")
        graph = cls(name=name, entry=entry)
        nodes_data = data.get("nodes")
        if nodes_data is not None and not isinstance(nodes_data, dict):
            raise GraphDefinitionError(
                f"图定义数据 nodes 字段非法: 期望 dict，收到 {type(nodes_data).__name__}"
            )
        for node_name, spec in (nodes_data or {}).items():
            if not isinstance(spec, dict) or not spec.get("type"):
                raise GraphDefinitionError(f"节点 {node_name} 的类型声明非法")
            config = spec.get("config") or {}
            if not isinstance(config, dict):
                raise GraphDefinitionError(
                    f"节点 {node_name} 的 config 声明非法: 期望 dict，"
                    f"收到 {type(config).__name__}"
                )
            graph.add_node_type(node_name, spec["type"], config)
        subgraphs_data = data.get("subgraphs")
        if subgraphs_data is not None and not isinstance(subgraphs_data, dict):
            raise GraphDefinitionError(
                f"图定义数据 subgraphs 字段非法: 期望 dict，"
                f"收到 {type(subgraphs_data).__name__}"
            )
        for sub_name, sub_data in (subgraphs_data or {}).items():
            if not isinstance(sub_data, dict):
                raise GraphDefinitionError(
                    f"子图 {sub_name} 定义非法: 期望 dict，收到 {type(sub_data).__name__}"
                )
            graph.add_subgraph(
                sub_name,
                cls.from_dict(
                    sub_data,
                    registry=registry,
                    edge_registry=edge_registry,
                    validate=validate,
                ),
            )
        edges_data = data.get("edges")
        if edges_data is not None and not isinstance(edges_data, dict):
            raise GraphDefinitionError(
                f"图定义数据 edges 字段非法: 期望 dict，收到 {type(edges_data).__name__}"
            )
        for source, edge_list in (edges_data or {}).items():
            if not isinstance(edge_list, list):
                raise GraphDefinitionError(
                    f"节点 {source} 的边声明非法: 期望 list，收到 {type(edge_list).__name__}"
                )
            for edge_data in edge_list:
                if not isinstance(edge_data, dict):
                    raise GraphDefinitionError(
                        f"节点 {source} 的边声明非法: 期望 dict，收到 {type(edge_data).__name__}"
                    )
                target = edge_data.get("target")
                if not isinstance(target, str):
                    raise GraphDefinitionError(
                        f"节点 {source} 的边声明非法（缺 target）"
                    )
                condition_name = edge_data.get("condition")
                if condition_name is None:
                    graph.add_edge(source, target)
                else:
                    if edge_registry is None or not edge_registry.has(condition_name):
                        raise GraphDefinitionError(
                            f"条件边 {source}->{target} 的条件未注册: {condition_name}"
                        )
                    graph.add_conditional_edge_by_name(source, target, condition_name)
        exits_data = data.get("exits")
        if exits_data is not None and not isinstance(exits_data, list):
            raise GraphDefinitionError(
                f"图定义数据 exits 字段非法: 期望 list，收到 {type(exits_data).__name__}"
            )
        graph.exits.update(exits_data or [])
        graph.schema = _schema_from_data(data.get("schema"))
        graph.resolve_conditions(edge_registry)
        graph.resolve_types(registry)
        if validate:
            graph.compile()
        return graph

    def digest(self) -> str:
        """图内容指纹（sha256）：图定义身份 = 拓扑 + 节点/条件引用 + 子图 + schema。

        用于 checkpoint 图版本一致性校验：执行中的图与恢复锚点同指纹才可
        续跑（图定义变了 = 恢复语义不保证，显式拒绝而非静默错位）。
        函数直挂节点按模块.限定名参与指纹（进程内稳定；lambda 无限定名
        按占位处理——拓扑变更仍会改变指纹，仅同拓扑实现替换不敏感）。
        """
        def node_ref(name: str) -> str:
            binding = self.node_bindings.get(name)
            if binding is not None:
                return json.dumps(
                    {"type": binding.type_name, "config": binding.config},
                    ensure_ascii=False,
                    sort_keys=True,
                )
            fn = self.nodes.get(name)
            qualname = getattr(fn, "__module__", "") + "." + getattr(
                fn, "__qualname__", "<lambda>"
            )
            return qualname

        def edge_ref(edge: Edge) -> str:
            if edge.condition_name is not None:
                return json.dumps(
                    {"target": edge.target, "condition": edge.condition_name},
                    ensure_ascii=False,
                    sort_keys=True,
                )
            if edge.condition is not None:
                fn = edge.condition
                return json.dumps(
                    {
                        "target": edge.target,
                        "condition_fn": getattr(fn, "__module__", "")
                        + "."
                        + getattr(fn, "__qualname__", "<lambda>"),
                    },
                    ensure_ascii=False,
                    sort_keys=True,
                )
            return json.dumps(
                {"target": edge.target}, ensure_ascii=False, sort_keys=True
            )

        payload = {
            "name": self.name,
            "entry": self.entry,
            "nodes": {
                name: node_ref(name)
                for name in set(self.nodes) | set(self.node_bindings)
                if name not in self.subgraphs
            },
            "edges": {
                source: [edge_ref(e) for e in edge_list]
                for source, edge_list in self.edges.items()
            },
            "exits": sorted(self.exits),
            "subgraphs": {
                name: sub.digest() for name, sub in self.subgraphs.items()
            },
            "schema": (
                self.schema.to_dict()
                if self.schema is not None and hasattr(self.schema, "to_dict")
                else (repr(type(self.schema)) if self.schema is not None else None)
            ),
        }
        blob = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    def compile(self) -> CompiledGraph:
        """校验并冻结图定义（节点存在/边目标存在/入口存在/出口合法/子图递归校验）。

        校验在建图期暴露：嵌套子图同样递归校验（子图非法不等到运行时才抛）；
        同一源节点静态边与条件边混用是语义陷阱（执行器静态边优先，条件边会
        被静默闷杀），编译期显式拒绝，业务按需拆分节点。
        """
        if self.entry not in self.nodes and self.entry not in self.subgraphs:
            raise GraphDefinitionError(f"入口节点不存在: {self.entry}")
        for source, edges in self.edges.items():
            if source not in self.nodes:
                raise NodeNotFoundError(source)
            for edge in edges:
                if edge.condition_name is not None and edge.condition is None:
                    # 按名声明的条件边未解析 = 图不可运行（未注入条件注册表）。
                    # 未解析的条件边会被执行器当静态边误走（静默错路），显式拒绝。
                    raise GraphDefinitionError(
                        f"条件边 {source}->{edge.target} 未解析（按名声明需注入"
                        f"条件注册表并调用 resolve_conditions）"
                    )
            has_static = any(e.condition is None for e in edges)
            has_conditional = any(e.condition is not None for e in edges)
            if has_static and has_conditional:
                raise GraphDefinitionError(
                    f"节点 {source} 静态边与条件边混用：静态边优先会闷杀条件边，"
                    f"请拆分节点或统一为条件边"
                )
            for edge in edges:
                if edge.target not in self.nodes:
                    raise NodeNotFoundError(edge.target)
        for name in self.exits:
            if name not in self.nodes:
                raise NodeNotFoundError(name)
        # 嵌套子图递归校验（非法子图在建图期暴露，而非运行时才失败）
        for name, subgraph in self.subgraphs.items():
            try:
                subgraph.compile()
            except EngineError as exc:
                raise GraphDefinitionError(f"子图 {name} 校验失败: {exc}") from exc
        return CompiledGraph(graph=self)


@dataclass(frozen=True, slots=True)
class CompiledGraph:
    """编译产物：运行时只读视图（编译校验错误在建图期暴露）。"""

    graph: Graph


def _subgraph_runner(subgraph: Graph) -> NodeFn:
    """嵌套图节点包装：执行子图并把子图最终状态作为增量返回（输出回流）。

    子图输出回流语义内建（子图通道回流的教训：目标通道在父层不存在时静默丢弃）：
    子图最终状态整体作为增量合并回父图——父图 reducer 负责按通道语义合并，
    未知通道宽容覆盖，绝不静默丢值。子图内部事件经父 ctx 透传（graph_path
    记录子图路径，前端协议不变）。
    """

    async def runner(ctx: NodeContext) -> dict | None:
        # 延迟 import 防循环依赖（executor 依赖 graph，graph 不能反向依赖 executor）
        from .executor import run_subgraph

        return await run_subgraph(subgraph, ctx)

    return runner


def _schema_from_data(data: Any) -> Any:
    """图定义数据中的 schema 字段 → StateSchema（None/缺省 = 无 schema）。

    反序列化保持宽容：未知 schema 形态原样透传（引擎只认识 StateSchema，
    其余交由宿主解释），校验仍由执行期承担。
    """
    if not data:
        return None
    from .state import StateSchema

    return StateSchema.from_dict(data) if isinstance(data, dict) else data


__all__ = [
    "CompiledGraph",
    "Edge",
    "EdgeCondition",
    "Graph",
    "NodeBinding",
    "NodeContext",
    "NodeFn",
    "TerminateReason",
]
