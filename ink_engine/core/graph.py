"""图定义 DSL（数据驱动，替代 langgraph StateGraph）。

Graph{nodes: {name: Node}, edges: {from: [Edge]}, entry, exits}：
- Node = async (ctx: NodeContext) -> PartialState | None（无状态副作用，返回增量）；
- Edge = 静态边 | 条件边 (ctx) -> bool 判定向 target；
- 嵌套图：子图 = 图实例挂为节点，执行时入路径栈（graph_path 显式记录，
  替代 langgraph ns 三元组）；
- 循环回路：条件边可回指图内节点（路由→监督者→域专才→回路由语义）；
- 回合终止信号：节点经 ctx.terminate(reason) 声明，引擎结束本轮并记录
  终止原因（reply/止损/超限/异常，入轨迹与审计）。
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from .exceptions import EngineError, GraphDefinitionError, NodeNotFoundError

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
    """边：静态边（condition=None）或条件边（condition 为真才走）。"""

    target: str
    condition: EdgeCondition | None = None


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

    def spawn(self, subgraph: Graph, state: dict, *, index: int | None = None) -> None:
        """登记一个动态子任务（子图实例清单项，节点返回后统一展开）。

        便捷封装：与数据驱动形态（节点返回值携带 ``__spawn__`` 保留键
        的清单）等价；清单项在节点返回后由执行器并发展开为独立子图
        实例，实例最终状态按 index 顺序回流父图。
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

    def add_node(self, name: str, fn: NodeFn) -> None:
        self.nodes[name] = fn

    def add_edge(self, source: str, target: str) -> None:
        self.edges.setdefault(source, []).append(Edge(target=target))

    def add_conditional_edge(
        self, source: str, target: str, condition: EdgeCondition
    ) -> None:
        self.edges.setdefault(source, []).append(Edge(target=target, condition=condition))

    def add_exit(self, name: str) -> None:
        self.exits.add(name)

    def add_subgraph(self, name: str, graph: Graph) -> None:
        """嵌套图：子图 = 图实例节点（graph_path 记录路径，输出回流父图）。"""
        if name in self.nodes:
            raise GraphDefinitionError(f"节点名冲突: {name}")
        self.subgraphs[name] = graph
        self.nodes[name] = _subgraph_runner(graph)  # type: ignore[assignment]

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


__all__ = [
    "CompiledGraph",
    "Edge",
    "EdgeCondition",
    "Graph",
    "NodeContext",
    "NodeFn",
    "TerminateReason",
]
