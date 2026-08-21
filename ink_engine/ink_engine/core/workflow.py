"""声明式工作流编译：节点类型清单 + 静态边 → 图定义（建图期校验）。

图 DSL（core.graph）以函数式节点为最小单元、执行模型为路径行走
（单条确定性路径，出口即终止）；工作流把节点降维成「类型名 + 配置」
的数据描述，语义为「全节点按依赖序各执行一次」。两种语义的差异
（扇出分支）由编译器在表达层收敛：按拓扑序串行化，分支间以桥接边
衔接——节点执行顺序与「先决节点先执行」的依赖语义不变，画布上
平行的分支在顺序上前后衔接（稳定序：边插入序），状态按通道累积，
与运行期可观测行为等价。需要回路的动态编排直接用图 DSL 表达，
不经本编译器（静态边回路在建图期拒绝）。

建图期校验：节点 id 重复、节点类型未注册、边引用未知节点、静态边
回路、入口歧义/缺失、入口不可达节点——全部在建图时报错，不等到
运行时。返回未编译的 Graph（宿主可继续追加节点/边——如挂接收尾
节点——再经 Engine 构造触发完整编译校验）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from itertools import pairwise
from typing import Any

from .exceptions import GraphDefinitionError
from .graph import Graph
from .registry import NodeTypeRegistry


@dataclass(frozen=True, slots=True)
class WorkflowNodeSpec:
    """工作流节点声明（类型 + 配置，建图时实例化执行函数）。"""

    id: str
    type: str
    config: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class WorkflowEdgeSpec:
    """工作流边声明（来源节点 → 目标节点）。"""

    source: str
    target: str


@dataclass(frozen=True, slots=True)
class WorkflowSpec:
    """工作流规格：节点清单 + 边清单 + 可选显式入口。

    entry 缺省时按「唯一无入边节点」推断；多个无入边节点须显式指定
    入口，且入口须能到达全部节点（不可达节点建图期拒绝）。
    """

    name: str
    nodes: tuple[WorkflowNodeSpec, ...] = ()
    edges: tuple[WorkflowEdgeSpec, ...] = ()
    entry: str | None = None


def _infer_entry(node_ids: list[str], incoming: set[str], declared: str | None) -> str:
    """入口解析：显式声明优先（校验存在），否则唯一无入边节点。

    无入边节点多于一个 = 入口歧义（工作流 DSL 单入口，建图期拒绝）；
    一个都没有 = 边集构成回路（已在回路校验拦截，此处兜底说明）。
    """
    if declared is not None:
        if declared not in node_ids:
            raise GraphDefinitionError(f"入口节点不存在: {declared}")
        return declared
    if not node_ids:
        raise GraphDefinitionError("工作流为空（无节点）")
    sources = [nid for nid in node_ids if nid not in incoming]
    if len(sources) == 1:
        return sources[0]
    if not sources:
        raise GraphDefinitionError("工作流存在循环依赖，无法确定入口")
    raise GraphDefinitionError(
        "工作流存在多个无入边节点，入口歧义，请显式声明入口: " + ", ".join(sources)
    )


def _topological_order(
    node_ids: list[str],
    edges: list[WorkflowEdgeSpec],
    entry: str,
) -> list[str]:
    """稳定拓扑序（Kahn）：依赖序串行化的衔接顺序。

    初始队列 = 入口；零入度节点按节点清单插入序入队（同输入恒同序）。
    显式入口时校验全节点可达（入口不可达的孤岛建图期拒绝，防止
    串行化后孤岛被静默跳过）。
    """
    out_map: dict[str, list[str]] = {}
    in_degree: dict[str, int] = {}
    for edge in edges:
        out_map.setdefault(edge.source, []).append(edge.target)
        in_degree[edge.target] = in_degree.get(edge.target, 0) + 1
        in_degree.setdefault(edge.source, 0)

    reachable: set[str] = set()
    stack = [entry]
    while stack:
        current = stack.pop()
        if current in reachable:
            continue
        reachable.add(current)
        stack.extend(out_map.get(current, []))
    isolated = [nid for nid in node_ids if nid not in reachable]
    if isolated:
        raise GraphDefinitionError(
            "存在从入口不可达的节点，工作流不完整: " + ", ".join(isolated)
        )

    order: list[str] = []
    queue = [nid for nid in node_ids if in_degree.get(nid, 0) == 0]
    # 入口必须是首个入队节点（唯一无入边节点时天然满足；显式入口时
    # 其它无入边节点已被可达性校验排除）
    queue = [entry] + [nid for nid in queue if nid != entry]
    while queue:
        current = queue.pop(0)
        order.append(current)
        for target in out_map.get(current, []):
            in_degree[target] -= 1
            if in_degree[target] == 0:
                queue.append(target)
    if len(order) != len(node_ids):
        raise GraphDefinitionError("工作流存在循环依赖")
    return order


def build_workflow_graph(spec: WorkflowSpec, registry: NodeTypeRegistry) -> Graph:
    """把工作流规格编译为图定义（类型解析 + 边校验 + 串行化 + 入口/出口）。

    扇出串行化：全节点按稳定拓扑序衔接，画布平行分支在顺序上前后
    衔接（桥接边只在缺少直接边时补插）——执行模型从路径行走收敛到
    工作流语义（全节点各执行一次，先决节点先执行）。

    Args:
        spec: 工作流规格（节点/边/可选入口）。
        registry: 节点类型注册表（按类型解析工厂，配置透传实例化）。

    Returns:
        未编译的 Graph（宿主可继续追加节点/边后交给 Engine 构造）。

    注意：非链（分支）规格边（不在拓扑序相邻节点对上的 edge）仅作为
    图定义数据保留，运行期不触发——执行模型为单条确定性路径（沿首个
    静态边行走），分支边不参与路径行走，需回路/分支编排请直接用图 DSL。

    Raises:
        GraphDefinitionError: 规格非法（重复 id/未知类型/悬空边/回路/
            入口问题/入口不可达节点）。
    """
    node_ids: list[str] = []
    seen: set[str] = set()
    for node in spec.nodes:
        if node.id in seen:
            raise GraphDefinitionError(f"节点 id 重复: {node.id}")
        seen.add(node.id)
        node_ids.append(node.id)

    edge_list = list(spec.edges)
    for edge in edge_list:
        if edge.source not in seen:
            raise GraphDefinitionError(f"边引用未知节点: {edge.source} -> {edge.target}")
        if edge.target not in seen:
            raise GraphDefinitionError(f"边引用未知节点: {edge.source} -> {edge.target}")

    incoming = {edge.target for edge in edge_list}
    entry = _infer_entry(node_ids, incoming, spec.entry)
    order = _topological_order(node_ids, edge_list, entry)

    graph = Graph(name=spec.name, entry=order[0])
    for node in spec.nodes:
        # 声明式绑定：类型名 + 配置记录在图上（图定义数据化——序列化/重建
        # 按类型名引用），函数实例化经 resolve_types 统一解析
        graph.add_node_type(node.id, node.type, node.config)
    graph.resolve_types(registry)
    # 串行化衔接：相邻拓扑序节点的连接边（规格边或桥接边）一律先于
    # 该节点的其余规格边加入——执行器沿首个静态边行走，链边必须占据
    # 边列表首位，否则扇出分支会抢先拐走、后续节点被跳过。
    chain_edges = set(pairwise(order))
    for prev, nxt in chain_edges:
        graph.add_edge(prev, nxt)
    for edge in edge_list:
        if (edge.source, edge.target) not in chain_edges:
            graph.add_edge(edge.source, edge.target)
    graph.add_exit(order[-1])
    return graph


__all__ = [
    "WorkflowEdgeSpec",
    "WorkflowNodeSpec",
    "WorkflowSpec",
    "build_workflow_graph",
]
