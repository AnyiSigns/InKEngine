"""动态子图展开原语（spawn：子任务清单 → 并发展开为子图实例）。

Codex 式「主 agent 拆解 → 动态分配子 agent」的引擎形态：路由节点
（宿主注册）产出子任务清单，本原语把清单并发展开为子图实例执行，
实例最终状态按 index 顺序回流父图（结果回收）。拆解策略/分配策略
在路由节点（业务），引擎只提供展开、隔离与回收。

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

from dataclasses import dataclass, field

from .executor import Engine, RunOptions, _NodeContextImpl, _subgraph_overlay_delta
from .fanout import fan_out
from .graph import Graph, NodeContext, TerminateReason
from .interrupt import InterruptSignal
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


def _instance_thread_id(parent_thread: str, index: int) -> str:
    """实例版本链归属：``{父thread}:spawn:{index}``（可回放/回溯定位）。"""
    return f"{parent_thread}:spawn:{index}"


def _instance_entry_state(spec: SpawnSpec, sub_schema) -> dict:
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


def _make_instance_engine(parent: _NodeContextImpl, subgraph: Graph) -> Engine:
    """实例引擎：独立实例（并发安全，不复用图级缓存——实例间互不干扰）。

    共享父引擎存储/schema/预算/传输配置；coordinator 共享（实例内
    interrupt 重入与父图同一通道）。
    """
    engine = parent._engine
    sub_engine = Engine(
        subgraph,
        options=RunOptions(
            storage=engine.options.storage,
            schema=subgraph.schema or engine.options.schema,
            budget=engine.options.budget,
            transports=engine.options.transports,
            max_node_retries=engine.options.max_node_retries,
            error_on_exception=engine.options.error_on_exception,
        ),
    )
    sub_engine._coordinator = engine._coordinator
    return sub_engine


async def run_spawned_subgraphs(
    specs: list[SpawnSpec],
    parent_ctx: NodeContext,
    *,
    concurrency: int,
) -> SpawnResult:
    """把子任务清单并发展开为子图实例，回收结果回流父图。

    Args:
        specs: 子任务清单（路由节点产出，按 index 顺序回流合并）。
        concurrency: 并发上限（fan_out 限流，成本护栏）。
        parent_ctx: 父图节点上下文（事件透传/中断共享/版本链归属）。

    Returns:
        SpawnResult：成功实例回流增量（按 index 升序合并，确定性）+ 失败清单。

    Raises:
        InterruptSignal: 任一实例内中断（提升为父图挂起卡，重入语义一致）。
    """
    parent: _NodeContextImpl = parent_ctx  # type: ignore[assignment]
    engine = parent._engine
    results: dict[int, dict] = {}
    failures: list[SpawnFailure] = []

    async def run_one(index: int) -> None:
        spec = specs[index]
        sub_engine = _make_instance_engine(parent, spec.subgraph)
        sub_path = (*parent_ctx.graph_path, spec.subgraph.name, str(spec.index))
        instance_thread = _instance_thread_id(parent._thread_id, spec.index)
        # 恢复：实例从自身链尾续跑（中断/未终态 checkpoint 续跑，同回合
        # 挂卡重入不重跑已完成节点）；终态链尾（reply/stop/error 等 = 上
        # 一回合或已完成的陈旧结果）不作续跑锚点——从头执行，防多轮会话
        # 静默沿用旧结果。从头执行也续接实例链尾（版本链严格线性）。
        resume_from: int | None = None
        if engine.options.storage is not None:
            tail = await engine.options.storage.get_latest_checkpoint(instance_thread)
            if tail is not None and tail.reason in (None, "interrupted"):
                resume_from = tail.checkpoint_id
            sub_engine._chain_advanced = True
        final_state, sub_result = await sub_engine._execute(
            state=_instance_entry_state(spec, sub_engine.options.schema),
            thread_id=parent._thread_id,
            round_id=parent_ctx.round_id,
            resume_from=resume_from,
            trace_id=parent_ctx.trace_id,
            queue=None,
            graph_path=sub_path,
            # checkpoint 独立子链：实例写入实例 thread，事件日志统一父链
            checkpoint_thread_id=instance_thread,
        )
        # 实例事件并入父引擎计数与 seq 锚点（事件统一落父链日志，父引擎
        # 后续 checkpoint 须以含实例事件的最新 seq 为锚，防恢复重放重复）
        engine._event_counter += sub_engine._event_counter
        if sub_engine._latest_event_seq is not None:
            engine._latest_event_seq = (
                sub_engine._latest_event_seq
                if engine._latest_event_seq is None
                else max(engine._latest_event_seq, sub_engine._latest_event_seq)
            )
        # 实例内中断 → 提升为父图 interrupt（挂起卡跨层保留，重入语义一致）
        if sub_result.interrupt is not None:
            raise InterruptSignal(sub_result.interrupt.key, sub_result.interrupt.payload)
        # 实例终态为 ERROR：不入回流（剔除留痕，父链继续）——部分失败
        # 语义不允许失败实例的部分状态污染父图
        if sub_result.reason == TerminateReason.ERROR:
            raise RuntimeError(
                sub_result.error or f"spawn 实例执行失败（index={index}）"
            )
        results[spec.index] = _subgraph_overlay_delta(
            _instance_entry_state(spec, sub_engine.options.schema),
            final_state,
            sub_engine.options.schema,
        )

    # 并发展开：部分失败剔除（成功结果回流，父链继续）；实例内中断为
    # 控制流异常（propagate 传播），中断时 fan_out 取消未完成兄弟实例
    outcome = await fan_out(
        [lambda i: run_one(i) for i in range(len(specs))],
        concurrency,
        propagate=InterruptSignal,
    )
    for failure in outcome.failures:
        failures.append(SpawnFailure(failure.index, failure.error))

    overlay: dict = {}
    for spec in sorted(specs, key=lambda s: s.index):
        if spec.index in results:
            overlay.update(results[spec.index])
    return SpawnResult(overlay=overlay, failures=failures)


def collect_spawn_specs(
    overlay: dict | None,
    pending: list[SpawnSpec],
) -> list[SpawnSpec]:
    """清单汇总：命令式 ctx.spawn 收集项 + 数据驱动返回键（SPAWN_KEY）。

    数据驱动项校验（子图必须为 Graph 实例），与命令式项统一排序
    （先命令式后数据驱动，序号保持稳定）；实例序号全局唯一（重复
    序号会造成实例链/回流顺序冲突，拒绝）。
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
            if not isinstance(subgraph, Graph):
                raise ValueError(f"spawn 清单第 {i} 项缺子图实例（Graph）")
            state = item.get("state") or {}
            if not isinstance(state, dict):
                raise ValueError(f"spawn 清单第 {i} 项状态须为 dict")
            index = int(item.get("index") if item.get("index") is not None else len(specs))
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
    "run_spawned_subgraphs",
]
