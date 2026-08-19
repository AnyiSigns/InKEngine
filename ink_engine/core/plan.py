"""运行时重规划原语的数据面（``__plan__`` 保留键 / 计划清单模型 / 解析校验）。

图拓扑随状态演化：节点返回下一跳计划清单（顺序节点组/并行组/条件门/
spawn 子任务项），引擎按清单续跑、执行一段后再规划——拓扑成为可改写
的数据，而非编译期固定。与 ``__spawn__`` 的关系：计划 = 流的结构
（下一跳编排），spawn = 流的展开（并行子任务），两者可嵌套（计划
步骤可携带 spawn 清单，展开共用执行器的实例展开路径）。

计划版本化（硬性要求）：计划是 checkpoint 快照字段（随版本链落盘与
回滚）——回溯决策点时计划与状态一起回到当时版本，保证后续推演/换选
的锚点语义。因此本模块全部模型为纯数据（可 JSON 序列化）：节点/条件
以注册名引用，spawn 子图以图定义数据形态携带（Graph 对象在入计划前
序列化为数据，函数不是数据）。

工作流约束域：计划引用的节点必须存在于当前图（计划落在「可执行的
计划空间」内）；宽松域 = 任意已注册节点，严格序 = 每一步节点须与
上一步存在图边关联（策略由 RunOptions.plan_policy 配置）。
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from itertools import pairwise
from typing import TYPE_CHECKING, Any

from .exceptions import GraphDefinitionError
from .graph import Graph

if TYPE_CHECKING:
    from .registry import EdgeConditionRegistry

# 数据驱动形态的保留键：节点返回值携带此键 = 下一跳计划清单（引擎内部
# 消费，不落状态通道）；与 __spawn__ 键同属引擎保留命名空间。
PLAN_KEY = "__plan__"

# 计划步骤类型（声明式数据，枚举化防魔法值）
KIND_NODES = "nodes"  # 顺序节点组：按序逐个执行
KIND_PARALLEL = "parallel"  # 并行节点组：隔离状态并发执行，结果按序合并
KIND_SPAWNS = "spawns"  # 子任务展开：携带 spawn 清单，展开执行器与 __spawn__ 共用

# 计划数据形态的键名
_STEPS_KEY = "steps"
_INDEX_KEY = "index"

# 缺省计划步数上限（成本护栏：计划超限即节点失败，防清单爆炸）
DEFAULT_MAX_PLAN_STEPS = 32


def _require_exactly_one_kind(data: dict[str, Any]) -> str:
    """计划步骤的类型键解析：nodes/parallel/spawns 恰好声明一个。

    多键并存 = 声明歧义（同一计划步同时要求两种执行形态，拒绝）——
    宁可报错也不猜意图，防静默错序执行。
    """
    present = [kind for kind in (KIND_NODES, KIND_PARALLEL, KIND_SPAWNS) if kind in data]
    if len(present) != 1:
        raise GraphDefinitionError(
            f"计划步骤须恰好声明 nodes/parallel/spawns 之一，实际: {present or '无'}"
        )
    return present[0]


@dataclass(frozen=True, slots=True)
class PlanStep:
    """计划一步：顺序节点组 / 并行节点组 / spawn 子任务 + 可选条件门。

    Attributes:
        kind: 步骤类型（nodes/parallel/spawns）。
        nodes: 节点名（nodes = 顺序执行序；parallel = 并行组成员序）。
        spawns: spawn 子任务清单（数据形态：{subgraph, state, index}，
            subgraph 为图定义数据 dict——Graph 对象已序列化）。
        condition: 条件名（经条件注册表解析；None = 恒真，步骤必执行）。
    """

    kind: str
    nodes: tuple[str, ...] = ()
    spawns: tuple[dict[str, Any], ...] = ()
    condition: str | None = None

    def to_dict(self) -> dict:
        """序列化为纯数据（checkpoint 计划快照/回放用）。"""
        data: dict[str, Any] = {self.kind: list(self.nodes) if self.nodes else []}
        if self.kind == KIND_SPAWNS:
            data[KIND_SPAWNS] = list(self.spawns)
        if self.condition is not None:
            data["condition"] = self.condition
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> PlanStep:
        kind = _require_exactly_one_kind(data)
        condition = data.get("condition")
        if condition is not None and not isinstance(condition, str):
            raise GraphDefinitionError(f"计划步骤条件名须为字符串: {condition!r}")
        if kind == KIND_SPAWNS:
            spawns = data.get(KIND_SPAWNS)
            if not isinstance(spawns, list) or not all(
                isinstance(item, dict) for item in spawns
            ):
                raise GraphDefinitionError(
                    "计划 spawn 步骤须携带 [{subgraph, state, index}, ...] 清单"
                )
            return cls(kind=kind, spawns=tuple(spawns), condition=condition)
        names = data.get(kind)
        if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
            raise GraphDefinitionError(f"计划步骤 {kind} 须为节点名列表")
        if not names:
            raise GraphDefinitionError(f"计划步骤 {kind} 为空（无节点可执行）")
        return cls(kind=kind, nodes=tuple(names), condition=condition)


@dataclass(frozen=True, slots=True)
class Plan:
    """运行时计划（下一跳编排清单，随 checkpoint 版本化的数据形态）。

    Attributes:
        steps: 计划步骤序列（按序执行）。
        index: 当前游标（checkpoint 快照记录下一待执行步骤；回滚到历史
            快照即回到当时的计划进度）。
    """

    steps: tuple[PlanStep, ...]
    index: int = 0

    @property
    def remaining(self) -> tuple[PlanStep, ...]:
        """尚未执行的步骤（当前游标之后的切片）。"""
        return self.steps[self.index :]

    def to_dict(self) -> dict:
        return {
            _STEPS_KEY: [step.to_dict() for step in self.steps],
            _INDEX_KEY: self.index,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Plan:
        """从 checkpoint 快照还原（计划版本化：回溯决策点恢复当时计划）。"""
        raw_steps = data.get(_STEPS_KEY)
        if not isinstance(raw_steps, list):
            raise GraphDefinitionError("计划快照缺 steps 清单")
        index = int(data.get(_INDEX_KEY, 0))
        steps = tuple(PlanStep.from_dict(step) for step in raw_steps)
        if index < 0 or index > len(steps):
            raise GraphDefinitionError(f"计划游标越界: {index}（共 {len(steps)} 步）")
        return cls(steps=steps, index=index)

    @classmethod
    def parse(
        cls,
        data: Any,
        *,
        graph: Graph,
        edge_registry: EdgeConditionRegistry | None = None,
        policy: str = "loose",
        max_steps: int = DEFAULT_MAX_PLAN_STEPS,
        workflow: Any = None,
    ) -> Plan:
        """解析并校验节点返回的计划清单（建期即拒绝，不等到执行期）。

        工作流约束域（workflow 提供时）：工作流 = 用户预编排的「可执行的
        计划空间」（节点/边集合）——计划节点必须落在工作流节点集内
        （宽松域 = 节点存在即可，agent 自由选序）；严格序 = 计划步骤须
        与工作流边关联（按序执行）。不提供工作流时按图校验（节点存在
        性/图边 strict 语义）。

        Args:
            data: 节点返回值携带的 ``__plan__`` 值（步骤列表；兼容
                {"steps": [...]} 信封形态）。
            graph: 当前图（节点存在性/严格序约束校验依据）。
            edge_registry: 条件注册表（条件门按名校验；含条件步骤时必须提供）。
            policy: 工作流约束策略——loose = 节点存在即可；strict =
                步骤节点须与上一执行节点存在边关联（工作流边或图边，
                计划落在约束域内）。
            max_steps: 计划步数上限（超限即拒绝，成本护栏）。
            workflow: 工作流规格（WorkflowSpec；提供时计划节点必须落在
                工作流节点集内，strict 按工作流边校验）。

        Raises:
            GraphDefinitionError: 形态非法/节点不存在/条件未注册/步数超限/
                计划节点不在工作流约束域内。
        """
        if isinstance(data, dict) and _STEPS_KEY in data:
            data = data[_STEPS_KEY]
        if not isinstance(data, list):
            raise GraphDefinitionError(
                f"计划清单须为步骤列表或 {{steps: [...]}} 信封: {type(data).__name__}"
            )
        if not data:
            raise GraphDefinitionError("计划清单为空（无下一步编排）")
        if max_steps > 0 and len(data) > max_steps:
            raise GraphDefinitionError(f"计划步数超限: {len(data)} > {max_steps}")
        workflow_node_ids = (
            {node.id for node in workflow.nodes} if workflow is not None else None
        )
        steps: list[PlanStep] = []
        for i, raw in enumerate(data):
            step = PlanStep.from_dict(raw)
            if step.kind == KIND_SPAWNS:
                # 计划快照纯数据契约：Graph 对象在入计划时序列化为图定义
                # 数据（checkpoint 计划快照/回滚必须可 JSON 落盘；无法
                # 序列化的图（函数节点未绑定类型名）在此显式拒绝）
                normalized: list[dict[str, Any]] = []
                for item in step.spawns:
                    item = dict(item)
                    if isinstance(item.get("subgraph"), Graph):
                        item["subgraph"] = item["subgraph"].to_dict()
                    normalized.append(item)
                step = replace(step, spawns=tuple(normalized))
            if step.kind == KIND_NODES and len(step.nodes) > 1:
                # 顺序组展开为单节点步：每节点 = 一个 checkpoint 单元
                # （恢复续跑精确到节点；条件门随展开逐节点独立求值——与
                # 整组跳过语义等价，且状态演化后条件可重估）
                for name in step.nodes:
                    steps.append(
                        PlanStep(
                            kind=KIND_NODES,
                            nodes=(name,),
                            condition=step.condition,
                        )
                    )
                continue
            if step.kind == KIND_NODES:
                if workflow_node_ids is not None:
                    if step.nodes[0] not in workflow_node_ids:
                        raise GraphDefinitionError(
                            f"计划第 {i} 步引用工作流约束域外节点: {step.nodes[0]}"
                        )
                elif step.nodes[0] not in graph.nodes:
                    raise GraphDefinitionError(
                        f"计划第 {i} 步引用未知节点: {step.nodes[0]}"
                    )
            elif step.kind == KIND_PARALLEL:
                for name in step.nodes:
                    if workflow_node_ids is not None:
                        if name not in workflow_node_ids:
                            raise GraphDefinitionError(
                                f"计划第 {i} 步引用工作流约束域外节点: {name}"
                            )
                    elif name not in graph.nodes:
                        raise GraphDefinitionError(
                            f"计划第 {i} 步引用未知节点: {name}"
                        )
            if step.condition is not None and (
                edge_registry is None or not edge_registry.has(step.condition)
            ):
                raise GraphDefinitionError(
                    f"计划第 {i} 步条件未注册: {step.condition}"
                )
            for item in step.spawns:
                _validate_spawn_item(item, step_index=i)
            steps.append(step)
        if policy == "strict":
            _validate_strict_order(steps, graph, workflow=workflow)
        elif policy != "loose":
            raise GraphDefinitionError(f"未知计划策略: {policy}")
        return cls(steps=tuple(steps))


def _validate_spawn_item(item: dict[str, Any], *, step_index: int) -> None:
    """spawn 子任务项的形态校验（子图 = 图定义数据或 Graph 对象）。

    Graph 对象在执行期展开前序列化为数据（计划快照必须纯数据）——此处
    只校验形态，图定义数据的注册表解析在展开时进行。
    """
    subgraph = item.get("subgraph")
    if subgraph is None:
        raise GraphDefinitionError(f"计划第 {step_index} 步 spawn 项缺 subgraph")
    state = item.get("state")
    if state is not None and not isinstance(state, dict):
        raise GraphDefinitionError(
            f"计划第 {step_index} 步 spawn 项状态须为 dict"
        )
    index = item.get("index")
    if index is not None:
        try:
            int(index)
        except (TypeError, ValueError) as exc:
            raise GraphDefinitionError(
                f"计划第 {step_index} 步 spawn 项序号非法: {index!r}"
            ) from exc


def _validate_strict_order(
    steps: tuple[PlanStep, ...], graph: Graph, *, workflow: Any = None
) -> None:
    """严格序约束：计划步节点须与上一执行节点存在边关联。

    边域 = 工作流边（提供 WorkflowSpec 时，计划落在工作流约束域内）或
    图边（未提供时）。只校验计划内部相邻节点的可达性（上一步末节点 →
    下一步首节点/并行组成员）；计划首步与当前执行节点的衔接由执行器
    校验（当前节点与计划首节点之间须有边，或当前节点即计划首节点——
    同节点续跑）。
    """
    workflow_edges: set[tuple[str, str]] | None = None
    if workflow is not None:
        workflow_edges = {(edge.source, edge.target) for edge in workflow.edges}
    for prev, nxt in pairwise(steps):
        prev_tails = _step_tails(prev)
        nxt_heads = _step_heads(nxt)
        if not prev_tails:
            continue
        if workflow_edges is not None:
            linked = any(
                (tail, head) in workflow_edges
                for tail in prev_tails
                for head in nxt_heads
            )
            domain = "工作流约束域"
        else:
            linked = any(
                any(
                    edge.target == head
                    for edge in graph.edges.get(tail, ())
                )
                for tail in prev_tails
                for head in nxt_heads
            )
            domain = "图约束"
        if not linked:
            raise GraphDefinitionError(
                f"严格序计划不满足{domain}: {prev_tails} -> {nxt_heads} 无边关联"
            )


def _step_tails(step: PlanStep) -> tuple[str, ...]:
    """步骤的收尾节点（顺序组 = 末节点；并行组 = 全部成员；spawn = 无）。"""
    if step.kind == KIND_NODES:
        return step.nodes[-1:] if step.nodes else ()
    if step.kind == KIND_PARALLEL:
        return step.nodes
    return ()


def _step_heads(step: PlanStep) -> tuple[str, ...]:
    """步骤的起始节点（顺序组 = 首节点；并行组 = 全部成员；spawn = 无）。"""
    if step.kind == KIND_NODES:
        return step.nodes[:1] if step.nodes else ()
    if step.kind == KIND_PARALLEL:
        return step.nodes
    return ()


__all__ = [
    "DEFAULT_MAX_PLAN_STEPS",
    "KIND_NODES",
    "KIND_PARALLEL",
    "KIND_SPAWNS",
    "PLAN_KEY",
    "Plan",
    "PlanStep",
]
