"""决策点推演原语的数据面（``__simulate__`` 保留键 / 分支规格 / 评估协议 / 择优调配）。

推演-回溯-换选机制的引擎形态：关键决策点节点返回推演清单，引擎把每个
分支作为独立子链执行（与 spawn 同构：分支入口状态自包含 + 独立
checkpoint 链，落选分支不销毁——保留为轨迹树引用，可回溯对比/换选，
经 :meth:`~ink_engine.core.executor.Engine.swap_branch` 重放改选），
执行结果经评估协议（Evaluator）打分，再由调配策略（BranchMixer）择优
提交主线——单选或跨分支组装（分支 A 的一部分 + 分支 B 的另一部分），
组装留痕记录「哪部分来自哪个分支」。

数据形态（节点返回值携带 ``__simulate__`` 保留键）：
    {
        "step_id": "step-123",      # 可选：决策点步骤 id（分支事件 parent_step_id）
        "budget": 4000,             # 可选：主线上下文组装预算（传给调配策略）
        "branches": [
            {"subgraph": <Graph|图定义数据>, "state": {...}, "index": 0,
             "description": "分支说明"},
            ...
        ]
    }

评估协议在引擎（core），评审策略在用户集（规则集/加权打分器）——引擎
只规定「评估产出什么」，不规定「怎么评」。
"""
from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from .exceptions import GraphDefinitionError
from .graph import Graph
from .patch_chain import Patch, PatchChain, PatchOp
from .scoring import DimensionScore

# 数据驱动形态的保留键：节点返回值携带此键 = 推演分支清单（引擎内部
# 消费，不落状态通道）；与 __spawn__/__plan__ 同属引擎保留命名空间。
SIMULATE_KEY = "__simulate__"

# 清单信封的键名
_BRANCHES_KEY = "branches"
_STEP_ID_KEY = "step_id"
_BUDGET_KEY = "budget"

# 缺省推演分支数上限（成本护栏：分支推演是完整子链执行，清单超限
# 即节点失败，防推演爆炸）
DEFAULT_MAX_SIMULATIONS = 8


@dataclass(frozen=True, slots=True)
class SimulateSpec:
    """推演分支规格：子图 + 自包含入口状态 + 分支序号 + 说明。

    Attributes:
        subgraph: 分支子图（Graph 实例；数据形态经解析器重建）。
        state: 分支入口状态（自包含：不依赖父快照，可独立重放）。
        index: 分支序号（子链归属与留痕引用；清单内唯一）。
        description: 分支说明（评估/留痕可读性；LLM 分支意图的载体）。
    """

    subgraph: Graph
    state: dict
    index: int
    description: str = ""

    def to_dict(self) -> dict:
        """序列化为纯数据（checkpoint/事件留痕用；Graph 序列化为图定义数据）。"""
        return {
            "index": self.index,
            "description": self.description,
            "subgraph": self.subgraph.to_dict(),
            "state": dict(self.state),
        }

    @classmethod
    def from_dict(
        cls,
        data: dict[str, Any],
        *,
        registry: Any = None,
        edge_registry: Any = None,
    ) -> SimulateSpec:
        """从留痕数据还原（回溯/换选定位用）。

        subgraph 支持 Graph 实例（直通）与图定义数据（经注册表重建——
        与 :meth:`Graph.from_dict` 同口径）；未注入注册表时 dict 形态
        显式拒绝（防静默当作缺子图）。
        """
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"推演分支声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        index = int(data.get("index", 0))
        description = data.get("description") or ""
        subgraph = data.get("subgraph")
        if isinstance(subgraph, Graph):
            pass
        elif isinstance(subgraph, dict) and registry is not None:
            from .graph import Graph as GraphCls

            subgraph = GraphCls.from_dict(
                subgraph, registry=registry, edge_registry=edge_registry
            )
        else:
            raise GraphDefinitionError(
                f"推演分支快照缺子图实例（Graph 或图定义数据"
                f"{'，需注入注册表' if isinstance(subgraph, dict) else ''}）"
            )
        state = data.get("state") or {}
        if not isinstance(state, dict):
            raise GraphDefinitionError("推演分支快照的状态须为 dict")
        return cls(
            subgraph=subgraph, state=dict(state), index=index, description=description
        )


@dataclass(frozen=True, slots=True)
class Evaluation:
    """分支评估结果（Evaluator 协议产出：分数 + 是否通过 + 说明 + 维度明细）。

    Attributes:
        score: 综合分（0-1，择优依据）。
        passed: 是否通过（闸门语义：未通过的分支不参与择优提交）。
        note: 评估说明（留痕可读性）。
        dimensions: 维度明细（可选；加权打分器等策略的审计细节）。
        rule_version: 评估所用规则集版本（随评估记录落库——回放/审计
            按当时版本重算，「标尺在动」不改变推演可回放性）。
        params_snapshot: 权重/阈值快照（ParameterSnapshot 序列化产物；
            None = 未记录版本上下文）。
    """

    score: float = 0.0
    passed: bool = True
    note: str = ""
    dimensions: tuple[DimensionScore, ...] = ()
    rule_version: str | None = None
    params_snapshot: dict[str, Any] | None = None

    def to_dict(self) -> dict:
        data: dict[str, Any] = {"score": self.score, "passed": self.passed}
        if self.note:
            data["note"] = self.note
        if self.dimensions:
            data["dimensions"] = [
                {"name": d.name, "score": d.score, "note": d.note}
                for d in self.dimensions
            ]
        if self.rule_version is not None:
            data["rule_version"] = self.rule_version
        if self.params_snapshot is not None:
            data["params_snapshot"] = dict(self.params_snapshot)
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Evaluation:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"评估结果声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        dimensions = tuple(
            DimensionScore(
                name=raw["name"], score=float(raw["score"]), note=raw.get("note", "")
            )
            for raw in data.get("dimensions") or ()
        )
        snapshot = data.get("params_snapshot")
        return cls(
            score=float(data.get("score", 0.0)),
            passed=bool(data.get("passed", True)),
            note=data.get("note", ""),
            dimensions=dimensions,
            rule_version=data.get("rule_version"),
            params_snapshot=dict(snapshot) if isinstance(snapshot, dict) else None,
        )


@dataclass(frozen=True, slots=True)
class EvaluatedBranch:
    """已完成评估的分支（分支规格 + 执行回流增量 + 评估结果）。

    分支结果调配（调配器思想）的「源」：多个分支结果 = 源、评估分 =
    weight、主线上下文预算 = 预算——择优策略据此单选或跨分支组装。
    """

    spec: SimulateSpec
    overlay: dict
    evaluation: Evaluation

    def to_dict(self) -> dict:
        return {
            "spec": self.spec.to_dict(),
            "overlay": dict(self.overlay),
            "evaluation": self.evaluation.to_dict(),
        }


@runtime_checkable
class Evaluator(Protocol):
    """分支评估器协议（引擎通用机制；评审策略由用户集注入）。

    引擎在分支执行完成后调用一次：给定分支规格与执行回流增量，产出
    评估结果（分数/通过/说明）。实现可为加权打分器（确定性）或 LLM
    评审（领域策略）——协议不规定怎么评。
    """

    async def evaluate(
        self, branch: SimulateSpec, overlay: dict
    ) -> Evaluation:
        ...


# 维度评分钩子：分支规格 + 回流增量 → 维度得分表（0-1，领域语义）
DimensionScorer = Callable[[SimulateSpec, dict], dict[str, float]]


class WeightedScorerEvaluator:
    """加权打分器 → 评估协议的桥接参考实现（机制接入，策略在使用方）。

    把评审打分配置（:class:`~ink_engine.core.scoring.ScoringConfig`：
    维度/权重/达标线）接入推演的评估协议：分支回流增量 → 维度得分
    （注入的评分钩子按 overlay 产出，领域语义在使用方/用户集）→
    加权打分器加权 → :class:`Evaluation`。未注入评分钩子时全部维度取
    中性基线分（1.0）——择优退化为评分一致时按分支序号最小者选择，
    保持确定性可断言。

    附带版本上下文记录：评估时所用规则版本与参数快照随评估结果落库
    （快照由使用方在评估前注入，回放/审计按当时标尺重算）。
    """

    def __init__(
        self,
        config: Any,
        *,
        dimension_scorer: DimensionScorer | None = None,
        rule_version: str | None = None,
        params_snapshot: dict[str, Any] | None = None,
    ) -> None:
        from .scoring import WeightedScorer

        self._scorer = WeightedScorer(config)
        self.dimension_scorer = dimension_scorer
        self.rule_version = rule_version
        self.params_snapshot = (
            dict(params_snapshot) if params_snapshot is not None else None
        )

    async def evaluate(
        self, branch: SimulateSpec, overlay: dict
    ) -> Evaluation:
        if self.dimension_scorer is not None:
            dimensions = self.dimension_scorer(branch, overlay) or {}
        else:
            dimensions = {
                dim.name: 1.0 for dim in self._scorer.config.dimensions
            }
        result = self._scorer.score(dimensions)
        return Evaluation(
            score=result.total,
            passed=result.passed and not result.failing_dimensions,
            note=(
                "加权打分器桥接评估"
                + (
                    f"; 未达标维度: {[d.name for d in result.failing_dimensions]}"
                    if result.failing_dimensions
                    else ""
                )
            ),
            dimensions=result.scores,
            rule_version=self.rule_version,
            params_snapshot=self.params_snapshot,
        )


@dataclass(frozen=True, slots=True)
class ProvenanceNote:
    """组装来源留痕：主线增量中「哪段来自哪个分支」（逐源留痕，可审计）。"""

    branch_index: int
    key: str
    note: str = ""


@dataclass(frozen=True, slots=True)
class BranchSelection:
    """择优结果：选中分支 + 提交主线的组装增量 + 来源留痕。

    Attributes:
        selected: 选中分支序号（单选 = 单元素；跨分支组装 = 多元素）。
        overlay: 提交主线的增量（选定分支整体或跨分支组装产物）。
        provenance: 来源留痕（哪段来自哪个分支；单选 = 全量来自该分支）。
    """

    selected: tuple[int, ...]
    overlay: dict
    provenance: tuple[ProvenanceNote, ...] = ()


class BranchMixer(Protocol):
    """分支结果调配策略（调配器思想：多源汇入单流）。

    择优不止单选：多个分支结果 = 源、评估分 = weight、主线上下文预算 =
    预算——策略可整体选优，也可跨分支组装（分支 A 的一部分 + 分支 B 的
    另一部分）。引擎默认提供单选策略（:class:`BestBranchMixer`）。
    """

    async def mix(
        self, branches: Sequence[EvaluatedBranch], *, budget: int | None = None
    ) -> BranchSelection:
        ...


def _fit_overlay(overlay: dict, budget: int | None) -> dict:
    """提交增量按预算裁剪（序列化字符上界；None/非正 = 不裁剪）。

    确定性：按键序依次纳入，字符串值超预算截断到剩余预算（文本是
    状态通道的常见形态），非字符串形态整键纳入；首个键至少保留
    （提交非空）。预算 = 主线上下文可容纳的增量上限，留痕记裁剪后
    实际提交内容。
    """
    if budget is None or budget <= 0:
        return dict(overlay)
    import json as _json

    kept: dict[str, Any] = {}
    used = 0
    for key, value in overlay.items():
        if isinstance(value, str):
            size = len(value)
            if kept and used + size > budget:
                break
            if used + size > budget:
                value = value[: budget - used]
            if value or not kept:
                kept[key] = value
                used += len(value)
            continue
        size = len(_json.dumps(value, ensure_ascii=False, default=str))
        if kept and used + size > budget:
            break
        kept[key] = value
        used += size
    return kept


class BestBranchMixer:
    """默认调配策略：通过评估的分支中取最高分整体提交（确定性单选）。

    未通过分支（passed=False）不参与择优（闸门语义：评估不过关的分支
    不得提交主线）。平分时取序号最小者（确定性，可断言）。提交增量受
    预算约束（:func:`_fit_overlay`——主线上下文预算 = 提交上界）。
    """

    async def mix(
        self, branches: Sequence[EvaluatedBranch], *, budget: int | None = None
    ) -> BranchSelection:
        candidates = [b for b in branches if b.evaluation.passed]
        if not candidates:
            raise GraphDefinitionError("无可提交的推演分支（全部未通过评估）")
        best = max(candidates, key=lambda b: (b.evaluation.score, -b.spec.index))
        overlay = _fit_overlay(best.overlay, budget)
        return BranchSelection(
            selected=(best.spec.index,),
            overlay=overlay,
            provenance=(
                (ProvenanceNote(branch_index=best.spec.index, key="*", note="整体提交"),)
                if overlay
                else ()
            ),
        )


class PatchChainBranchMixer:
    """跨分支组装参考实现（补丁链 assemble 复用，来源留痕可审计）。

    各分支 overlay 逐键落为 replace 补丁，组装 = 补丁链 assemble（纯
    函数、可版本化）——组装形态与补丁链同构：换选/回退可对组装补丁链
    做区间重放，留痕 = 来源标注（哪段来自哪个分支）。

    冲突语义：同键多分支竞争时按评估分降序先到先得（高分分支的设定
    优先，低分分支只补空缺键——跨分支拼接而非无序覆盖）；提交增量受
    预算约束（:func:`_fit_overlay`）。

    与 :class:`BestBranchMixer` 的分工：单选 = 整体提交；本策略 = 跨
    分支拼接（分支 A 的设定 + 分支 B 的走向），供需要混编的主线使用。
    """

    async def mix(
        self, branches: Sequence[EvaluatedBranch], *, budget: int | None = None
    ) -> BranchSelection:
        selected: list[int] = []
        provenance: list[ProvenanceNote] = []
        chain = PatchChain(base={})
        # 按评估分降序（平分按序号升序）填充：高分分支的键先落位，后续
        # 分支只补空缺——同键冲突由高分分支胜出（策略明确，可断言）
        ordered = sorted(
            branches,
            key=lambda b: (-b.evaluation.score, b.spec.index),
        )
        filled: set[str] = set()
        for evaluated in ordered:
            overlay = evaluated.overlay
            if not overlay:
                continue
            selected.append(evaluated.spec.index)
            for key, value in overlay.items():
                if key in filled:
                    continue  # 同键已被更高分分支占据，不覆盖
                filled.add(key)
                chain.apply(
                    Patch(op=PatchOp.REPLACE, path=(key,), value=value)
                )
                provenance.append(
                    ProvenanceNote(
                        branch_index=evaluated.spec.index,
                        key=key,
                        note="跨分支组装（补丁链）",
                    )
                )
        if not selected:
            raise GraphDefinitionError("无可提交的推演分支（全部 overlay 为空）")
        assembled = chain.assemble()
        return BranchSelection(
            selected=tuple(selected),
            overlay=_fit_overlay(assembled, budget),
            provenance=tuple(provenance),
        )


@dataclass(frozen=True, slots=True)
class SimulationResult:
    """一次决策点推演的收口结果（择优提交 + 全分支留痕）。

    Attributes:
        selection: 择优结果（选中分支/组装增量/来源留痕）。
        branches: 全部已完成评估的分支（含落选——轨迹树引用与换选依据）。
        thread_ids: 分支序号 → 独立子链线程 id（落选分支可回溯/换选锚点）。
    """

    selection: BranchSelection
    branches: tuple[EvaluatedBranch, ...] = ()
    thread_ids: dict[int, str] = field(default_factory=dict)


def parse_simulate(
    data: Any,
    *,
    resolve_graph: Callable[[Any], Graph] | None = None,
    max_branches: int = DEFAULT_MAX_SIMULATIONS,
) -> tuple[str | None, int | None, list[SimulateSpec]]:
    """解析并校验节点返回的推演清单（建期即拒绝，不延后到执行期）。

    Args:
        data: ``__simulate__`` 键的值（{"branches": [...], ...} 信封形态）。
        resolve_graph: 图定义数据 → Graph 解析器（分支子图数据形态重建；
            Graph 实例直通）。
        max_branches: 分支数上限（成本护栏；0 = 禁用推演）。

    Returns:
        (step_id, budget, branches)：决策点步骤 id（可选）、主线组装预算
        （可选）、解析校验后的分支清单。

    Raises:
        GraphDefinitionError: 形态非法/分支空/序号重复/超限/子图不可解析。
    """
    if max_branches <= 0:
        raise GraphDefinitionError("推演已禁用（max_simulations=0）")
    if not isinstance(data, dict) or not isinstance(data.get(_BRANCHES_KEY), list):
        raise GraphDefinitionError(
            f"推演清单须为 {{branches: [...]}} 信封形态: {type(data).__name__}"
        )
    step_id = data.get(_STEP_ID_KEY)
    if step_id is not None and not isinstance(step_id, str):
        raise GraphDefinitionError(f"推演决策点 step_id 须为字符串: {step_id!r}")
    budget = data.get(_BUDGET_KEY)
    if budget is not None:
        try:
            budget = int(budget)
        except (TypeError, ValueError) as exc:
            raise GraphDefinitionError(f"推演组装预算非法: {budget!r}") from exc
        if budget <= 0:
            raise GraphDefinitionError(f"推演组装预算必须为正: {budget}")
    raw_branches = data[_BRANCHES_KEY]
    if not raw_branches:
        raise GraphDefinitionError("推演分支清单为空（至少一个分支）")
    if len(raw_branches) > max_branches:
        raise GraphDefinitionError(
            f"推演分支超限: {len(raw_branches)} > {max_branches}"
        )
    branches: list[SimulateSpec] = []
    for i, raw in enumerate(raw_branches):
        if not isinstance(raw, dict):
            raise GraphDefinitionError(f"推演第 {i} 项分支声明非法: 期望 dict")
        subgraph = raw.get("subgraph")
        if isinstance(subgraph, Graph):
            pass
        elif isinstance(subgraph, dict) and resolve_graph is not None:
            subgraph = resolve_graph(subgraph)
        else:
            raise GraphDefinitionError(
                f"推演第 {i} 项缺子图实例（Graph 或图定义数据"
                f"{'，需注入解析器' if not isinstance(subgraph, dict) else ''}）"
            )
        state = raw.get("state") or {}
        if not isinstance(state, dict):
            raise GraphDefinitionError(f"推演第 {i} 项状态须为 dict")
        try:
            index = int(
                raw.get("index") if raw.get("index") is not None else len(branches)
            )
        except (TypeError, ValueError) as exc:
            raise GraphDefinitionError(f"推演第 {i} 项序号非法: {raw.get('index')!r}") from exc
        description = raw.get("description")
        if description is not None and not isinstance(description, str):
            raise GraphDefinitionError(f"推演第 {i} 项说明须为字符串: {description!r}")
        branches.append(
            SimulateSpec(
                subgraph=subgraph,
                state=dict(state),
                index=index,
                description=description or "",
            )
        )
    indexes = [b.index for b in branches]
    if len(set(indexes)) != len(indexes):
        raise GraphDefinitionError(f"推演分支序号重复: {sorted(indexes)}")
    return step_id, budget, branches


def simulate_thread_id(parent_thread: str, index: int) -> str:
    """分支独立子链归属：``{父thread}:simulate:{index}``（可回溯/换选定位）。"""
    return f"{parent_thread}:simulate:{index}"


__all__ = [
    "DEFAULT_MAX_SIMULATIONS",
    "SIMULATE_KEY",
    "BestBranchMixer",
    "BranchMixer",
    "BranchSelection",
    "DimensionScorer",
    "EvaluatedBranch",
    "Evaluation",
    "Evaluator",
    "PatchChainBranchMixer",
    "ProvenanceNote",
    "SimulateSpec",
    "SimulationResult",
    "WeightedScorerEvaluator",
    "parse_simulate",
    "simulate_thread_id",
]
