"""动态子图展开原语的数据面（子任务清单模型/校验/实例归属）。

Codex 式「主 agent 拆解 → 动态分配子 agent」的引擎形态：路由节点
（宿主注册）产出子任务清单，本模块定义清单的数据形态与收集校验；
清单的并发展开与结果回收由执行器承担（``Engine.run_spawned``）——
数据驱动形态（节点返回值携带 ``__spawn__`` 保留键）与命令式
``ctx.spawn`` 收集的清单在这里统一合并校验。

实例隔离（半共享 + 独立子链）：
- 入口状态自包含：清单 state 即实例完整入口（可序列化可重放，
  隔离清晰，恢复不依赖父快照）；
- checkpoint 独立子链：实例写入 ``{父thread}:spawn:{index}`` 版本链，
  可单独回放/回溯，失败重跑不污染父链；
- 事件统一父链：实例事件经共享 publish 通道落父 thread 执行日志、
  graph_path 追加 ``(子图名, index)`` 归属标记（回合步骤统一流、
  前端协议不变；实例级审计按路径过滤）。

失败语义：部分失败剔除（fan_out 语义），成功结果回流、失败留痕，
父链继续。恢复语义：父链挂卡中断后由路由节点重入重跑重新产出
清单，各实例从各自链尾 checkpoint 续跑（节点重入 + 实例链尾；
仅中断/未终态链尾可续跑，终态链尾 = 陈旧结果，从头执行）。
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .graph import Graph
from .state import is_merge_reducer

# 数据驱动形态的保留键：节点返回值携带此键 = 子任务清单（引擎内部
# 消费，不落状态通道）；命令式 ctx.spawn 收集的清单与此等价合并
SPAWN_KEY = "__spawn__"


@dataclass(frozen=True, slots=True)
class SpawnSpec:
    """子任务清单条目：子图 + 自包含入口状态 + 实例序号。"""

    subgraph: Graph
    state: dict
    index: int


@dataclass(frozen=True, slots=True)
class SpawnFailure:
    """单实例失败信息（剔除原因留痕，父链继续）。"""

    index: int
    error: str


@dataclass(slots=True)
class SpawnResult:
    """展开结果：成功实例回流增量（按 index 序合并）+ 失败剔除清单。"""

    overlay: dict = field(default_factory=dict)
    failures: list[SpawnFailure] = field(default_factory=list)


def instance_thread_id(parent_thread: str, index: int) -> str:
    """实例版本链归属：``{父thread}:spawn:{index}``（可回放/回溯定位）。"""
    return f"{parent_thread}:spawn:{index}"


def instance_entry_state(spec: SpawnSpec, sub_schema) -> dict:
    """实例入口状态：清单 state 自包含；合并累加族通道归零（回流增量口径）。

    与静态子图同语义：子图内从 0 起算，回流增量 = 子图内新增（父图
    reducer 加和恰好一次，防二次加和翻倍）。清单未携带的通道不继承
    父状态（隔离由清单完整决定）。
    """
    entry = dict(spec.state)
    if sub_schema is not None:
        for key, channel in sub_schema.channels.items():
            if is_merge_reducer(channel.reducer) and key in entry:
                entry[key] = {}
    return entry


def collect_spawn_specs(
    overlay: dict | None,
    pending: list[SpawnSpec],
    *,
    resolve_graph: Callable[[Any], Graph] | None = None,
) -> list[SpawnSpec]:
    """清单汇总：命令式 ctx.spawn 收集项 + 数据驱动返回键（SPAWN_KEY）。

    子图放宽：数据驱动项的子图可为 Graph 实例或图定义数据 dict（经
    ``resolve_graph`` 回调重建——图 = 数据，spawn 清单可跨进程传递、
    可随计划版本化）。未注入解析器时 dict 形态显式拒绝（防静默当作
    缺子图）。

    与命令式项统一排序（先命令式后数据驱动，序号保持稳定）；实例序号
    全局唯一（重复序号会造成实例链/回流顺序冲突，拒绝）。
    """
    specs = list(pending)
    if overlay is not None and SPAWN_KEY in overlay:
        items = overlay.pop(SPAWN_KEY)
        if not isinstance(items, list) or not all(
            isinstance(i, dict) for i in items
        ):
            raise ValueError("spawn 清单须为 [{subgraph, state, index}, ...] 形态")
        for i, item in enumerate(items):
            subgraph = item.get("subgraph")
            if isinstance(subgraph, Graph):
                pass
            elif isinstance(subgraph, dict) and resolve_graph is not None:
                subgraph = resolve_graph(subgraph)
            else:
                raise ValueError(
                    f"spawn 清单第 {i} 项缺子图实例（Graph 或图定义数据"
                    f"{'，需注入解析器' if not isinstance(subgraph, dict) else ''}）"
                )
            state = item.get("state") or {}
            if not isinstance(state, dict):
                raise ValueError(f"spawn 清单第 {i} 项状态须为 dict")
            try:
                index = int(
                    item.get("index") if item.get("index") is not None else len(specs)
                )
            except (TypeError, ValueError) as exc:
                raise ValueError(f"spawn 清单第 {i} 项序号非法: {exc!r}") from exc
            specs.append(SpawnSpec(subgraph=subgraph, state=dict(state), index=index))
    indexes = [spec.index for spec in specs]
    if len(set(indexes)) != len(indexes):
        raise ValueError(f"spawn 实例序号重复: {sorted(indexes)}")
    return specs


__all__ = [
    "SPAWN_KEY",
    "SpawnFailure",
    "SpawnResult",
    "SpawnSpec",
    "collect_spawn_specs",
    "instance_entry_state",
    "instance_thread_id",
]
