"""输入调配管线（Input Assembly：调配器升格为执行循环一等原语）。

输入调配把上下文调配器（core/context）从「组件」接线为「执行语义」：
每次 LLM 调用/节点执行前统一走输入调配——上下文片段 + 知识集注入 +
工具集裁剪 + 记忆召回 + 证据组装多源在调用点统一调配。本模块只做
组装与留痕（薄管线），不碰业务：

- :class:`AssemblyConfig`：统一预算与分级占比（一次调用的总预算在多源
  间分级分配——上下文/知识/工具/记忆不再各自为政）+ 行为开关（一键
  回退旧装配路径）；
- :class:`InputAssembler`：多源 → 预算分配 → 组装 → 激活留痕。预算
  分配复用 :class:`~ink_engine.core.context.WeightedBudgetAllocator`
  （机制零重复实现）；
- :class:`ActivationRecord`：激活模式留痕（哪些源被激活 + 强度 + 版本
  快照）——调试/审计/调参共用同一份「本次激活了什么」的记录，随调配
  决定落库；全量原文由知识集版本快照重建（留痕最小化原则）。

激活预算经验框架：agent 无算力约束，不模仿 MoE 低激活——**能全量则
全量，放不下才裁剪**（集小 = 整集注入即最优；集大 = 常驻基线 + 任务
相关裁剪）。占调用预算 T 的结构：对话/回合上下文 50-70% + 知识注入
20-40% + 工具定义 5-10%；工具激活数每轮 3-14 个。
"""
from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from typing import Any

from .context import (
    MODE_DROP,
    ContextAssembler,
    ContextSource,
    WeightedBudgetAllocator,
)
from .exceptions import GraphDefinitionError
from .tool_orchestrator import DEFAULT_MAX_TOOLS

# 源类别（分级预算分配的分组标签；与使用方声明保持一致）
SOURCE_CONTEXT = "context"  # 对话历史/回合上下文
SOURCE_KNOWLEDGE = "knowledge"  # 知识集注入（基线 + 任务激活）
SOURCE_TOOL = "tool"  # 工具定义（集内裁剪）
SOURCE_MEMORY = "memory"  # 记忆召回
SOURCE_EVIDENCE = "evidence"  # 证据组装（web 验证产物）

_SOURCE_TYPES = (
    SOURCE_CONTEXT,
    SOURCE_KNOWLEDGE,
    SOURCE_TOOL,
    SOURCE_MEMORY,
    SOURCE_EVIDENCE,
)

# 回退优先级（数值大 = 更晚被丢弃 = 更高优）。回退兜底按
# 此优先级从尾部丢整块：evidence/memory 最先丢，context 最后丢——
# 不依赖 _SOURCE_TYPES 元组序，显式可断言。
_ROLLBACK_PRIORITY: dict[str, int] = {
    SOURCE_EVIDENCE: 0,
    SOURCE_MEMORY: 1,
    SOURCE_TOOL: 2,
    SOURCE_KNOWLEDGE: 3,
    SOURCE_CONTEXT: 4,
}

# 缺省总预算（字符）：对齐宿主旧静态取段 4000 上限的调用点总口径
DEFAULT_TOTAL_BUDGET = 8000

# 分级占比默认值（占调用预算 T 的结构；校验：合计 ≤ 1 防超分——
# 上下文 50-70% + 知识 20-40% + 工具 5-10% 为经验区间，记忆/证据
# 从知识预算内细分，默认合计 = 1.0）
DEFAULT_CONTEXT_RATIO = 0.5
DEFAULT_KNOWLEDGE_RATIO = 0.3
DEFAULT_TOOL_RATIO = 0.1
DEFAULT_MEMORY_RATIO = 0.05
DEFAULT_EVIDENCE_RATIO = 0.05
# 工具激活数上限（每轮 3-14 个的经验框架；与工具调配器同源单点定义）
# ——从 tool_orchestrator 导入即模块级常量（装配层与调配层同口径）

# 缺省装配预算（单次 assemble 未指定时的总预算）
DEFAULT_ASSEMBLY_BUDGET = DEFAULT_TOTAL_BUDGET

# 组装期条目内压缩（非破坏性摘要视图）的激活留痕模式
MODE_COMPRESSED = "compressed"

# 条目内压缩钩子：源 + 预算 → 摘要视图（非破坏性：原文不动，仅本次
# 调用使用压缩视图；返回空串 = 不压缩，走默认截断）
EntryCompressor = Callable[[ContextSource, int], str]

# 利用率聚合默认阈值（MoE 辅助损失借鉴：过热 = 激活失衡提示，过冷 =
# 长期零激活进归档候选；数值为经验基线，宿主可按场景注入）
DEFAULT_OVERHEATED_RATE = 0.8
DEFAULT_COLD_WINDOW = 10


@dataclass(frozen=True, slots=True)
class AssemblyConfig:
    """输入调配配置（统一预算 + 分级占比 + 行为开关）。

    Attributes:
        enabled: 行为开关（False = 装配禁用，调用点回退旧路径）。
        total_budget: 一次调用的总预算（字符；多源分级分配的硬上界）。
        context_ratio: 上下文源预算占比（对话/回合历史 50-70%）。
        knowledge_ratio: 知识注入预算占比（20-40%）。
        tool_ratio: 工具定义预算占比（5-10%）。
        memory_ratio: 记忆召回预算占比（从知识预算内另立池）。
        evidence_ratio: 证据组装预算占比（web 验证产物）。
        max_tools: 工具激活数上限（每轮 3-14 个）。
    """

    enabled: bool = True
    total_budget: int = DEFAULT_TOTAL_BUDGET
    context_ratio: float = DEFAULT_CONTEXT_RATIO
    knowledge_ratio: float = DEFAULT_KNOWLEDGE_RATIO
    tool_ratio: float = DEFAULT_TOOL_RATIO
    memory_ratio: float = DEFAULT_MEMORY_RATIO
    evidence_ratio: float = DEFAULT_EVIDENCE_RATIO
    max_tools: int = DEFAULT_MAX_TOOLS

    def __post_init__(self) -> None:
        if self.total_budget <= 0:
            raise GraphDefinitionError(f"装配总预算必须为正: {self.total_budget}")
        ratios = [
            self.context_ratio,
            self.knowledge_ratio,
            self.tool_ratio,
            self.memory_ratio,
            self.evidence_ratio,
        ]
        if any(r < 0 or r > 1 for r in ratios):
            raise GraphDefinitionError(f"分级占比必须在 [0, 1] 内: {ratios}")
        if sum(ratios) > 1.0:
            raise GraphDefinitionError(
                f"分级占比合计超限（必须 ≤ 1，防超分）: {sum(ratios):.2f}"
            )
        if self.max_tools < 1:
            raise GraphDefinitionError(f"工具激活数上限必须为正: {self.max_tools}")

    def pool_for(self, source_type: str) -> int:
        """源类别 → 分级预算池（总预算 × 占比，向下取整）。"""
        return int(self.total_budget * _ratio_for(self, source_type))

    def to_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "total_budget": self.total_budget,
            "context_ratio": self.context_ratio,
            "knowledge_ratio": self.knowledge_ratio,
            "tool_ratio": self.tool_ratio,
            "memory_ratio": self.memory_ratio,
            "evidence_ratio": self.evidence_ratio,
            "max_tools": self.max_tools,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> AssemblyConfig:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"装配配置声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        return cls(
            enabled=bool(data.get("enabled", True)),
            total_budget=int(data.get("total_budget", DEFAULT_TOTAL_BUDGET)),
            context_ratio=float(data.get("context_ratio", DEFAULT_CONTEXT_RATIO)),
            knowledge_ratio=float(data.get("knowledge_ratio", DEFAULT_KNOWLEDGE_RATIO)),
            tool_ratio=float(data.get("tool_ratio", DEFAULT_TOOL_RATIO)),
            memory_ratio=float(data.get("memory_ratio", DEFAULT_MEMORY_RATIO)),
            evidence_ratio=float(data.get("evidence_ratio", DEFAULT_EVIDENCE_RATIO)),
            max_tools=int(data.get("max_tools", DEFAULT_MAX_TOOLS)),
        )


@dataclass(frozen=True, slots=True)
class SourceActivation:
    """单个源的激活留痕（激活模式：源 + 强度 + 分配档位）。

    Attributes:
        source_type: 源类别（context/knowledge/tool/memory/evidence）。
        title: 源标题（可读定位）。
        weight: 源权重（可信度/调用频率）。
        relevance: 任务相关度。
        char_limit: 分配字符数（0 = 本调用未纳入，见 mode/note）。
        mode: 分配档位（keep_full/truncate/drop/compressed/fallback_keep）。
        entry_ref: 知识条目/记忆条目的引用（版本快照外可重建）。
        note: 档位说明（丢弃原因/保底说明等，审计可读）。
    """

    source_type: str
    title: str
    weight: float
    relevance: float
    char_limit: int
    mode: str
    entry_ref: str = ""  # 知识条目/记忆条目的引用（版本快照外可重建）
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "source_type": self.source_type,
            "title": self.title,
            "weight": self.weight,
            "relevance": self.relevance,
            "char_limit": self.char_limit,
            "mode": self.mode,
            "entry_ref": self.entry_ref,
        }
        if self.note:
            data["note"] = self.note
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SourceActivation:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"激活留痕声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        return cls(
            source_type=data.get("source_type", ""),
            title=data.get("title", ""),
            weight=float(data.get("weight", 0.0)),
            relevance=float(data.get("relevance", 0.0)),
            char_limit=int(data.get("char_limit", 0)),
            mode=data.get("mode", ""),
            entry_ref=data.get("entry_ref", ""),
            note=data.get("note", ""),
        )


@dataclass(frozen=True, slots=True)
class ActivationRecord:
    """激活模式记录（统一留痕：本次调配激活了什么 + 版本快照）。

    与留痕最小化原则衔接：记录组装决定（源/权重/预算/版本快照），全量
    原文由知识集版本快照重建——两者合起来满足「模型可见皆可从日志重建」。
    """

    total_budget: int
    assembled_chars: int
    sources: tuple[SourceActivation, ...] = ()
    version_snapshot: dict[str, Any] | None = None
    truncated_chars: int = 0  # 全局硬截断量（拼接超界时的兜底削减，归因留痕）
    created_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "total_budget": self.total_budget,
            "assembled_chars": self.assembled_chars,
            "sources": [s.to_dict() for s in self.sources],
            "version_snapshot": dict(self.version_snapshot) if self.version_snapshot else None,
            "created_at": self.created_at,
        }
        if self.truncated_chars:
            data["truncated_chars"] = self.truncated_chars
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ActivationRecord:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"激活记录声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        raw_sources = data.get("sources") or ()
        return cls(
            total_budget=int(data.get("total_budget", 0)),
            assembled_chars=int(data.get("assembled_chars", 0)),
            sources=tuple(SourceActivation.from_dict(s) for s in raw_sources),
            version_snapshot=data.get("version_snapshot"),
            truncated_chars=int(data.get("truncated_chars", 0)),
            created_at=float(data.get("created_at", time.time())),
        )


@dataclass(frozen=True, slots=True)
class InputAssemblyResult:
    """一次输入调配的产物（组装文本 + 激活留痕）。

    Attributes:
        text: 组装后的输入文本（按源块拼接，分隔符计入预算）。
        record: 激活模式记录（本次激活了什么 + 版本快照，可落库回放）。

    .. note:: 命名区分（ENG9a-24）：本类 = 输入调配产物（InputAssembler
        assemble 的返回），与 :class:`~ink_engine.core.path_assembler
        .PathAssemblyResult`（路径组装候选结果）同包同名异义已消除——
        ``AssemblyResult`` 旧名保留为兼容别名（executor 等既有消费方
        沿用），新代码一律用区分名。
    """

    text: str
    record: ActivationRecord


# 兼容别名（ENG9a-24）：旧名 AssemblyResult 保留供既有消费方
# （executor 等）沿用；新代码用 :class:`InputAssemblyResult`
AssemblyResult = InputAssemblyResult


def _group_sources(
    sources: list[ContextSource],
) -> dict[str, list[ContextSource]]:
    """按源类别分组（未知类别显式拒绝——类别是预算分级的键，不得漂移）。"""
    grouped: dict[str, list[ContextSource]] = {kind: [] for kind in _SOURCE_TYPES}
    for source in sources:
        if source.type not in _SOURCE_TYPES:
            raise GraphDefinitionError(f"未知装配源类别: {source.type}")
        grouped[source.type].append(source)
    return grouped


def _limit_tools(
    sources: list[ContextSource], max_tools: int
) -> list[ContextSource]:
    """工具激活数裁剪：按分配分（weight × relevance）取前 N（经验框架）。"""
    if len(sources) <= max_tools:
        return sources
    return sorted(
        sources, key=lambda s: (s.score(), s.priority), reverse=True
    )[:max_tools]


class InputAssembler:
    """输入调配管线执行体：多源统一预算分配 → 组装 → 激活留痕。

    「能全量则全量，放不下才裁剪」：全部源内容总长不超过总预算时整包
    激活（集小无稀疏必要——预算足够即零丢弃，不被低分门槛误伤）；
    超预算才按分级池分配（常驻基线 + 任务相关裁剪）。预算分配复用
    WeightedBudgetAllocator（高权重全保留/中权重截断/低权重丢弃），
    组装复用 ContextAssembler（标题块 + 逐源留痕）——注入的分配器
    同时驱动组装与留痕（换策略即换产物，留痕与实际一致）。
    """

    def __init__(
        self,
        config: AssemblyConfig | None = None,
        *,
        allocator: WeightedBudgetAllocator | None = None,
        compressor: EntryCompressor | None = None,
        aggregator: ActivationAggregator | None = None,
    ) -> None:
        self.config = config or AssemblyConfig()
        self._allocator = allocator or WeightedBudgetAllocator()
        # 组装器与留痕共用同一分配器：注入策略真实作用于产物（一次分配
        # 语义——分配决定 = 组装决定，留痕即事实）
        self._assembler = ContextAssembler(allocator=self._allocator)
        self._compressor = compressor
        # 激活聚合器：随本次挂上 InputAssembler——每次
        # 调配留痕同步喂聚合器，衔接知识集归档/进化优先级；None = 不聚合
        self._aggregator = aggregator
        # 全量路径分配器：门槛归零 = 预算足够时全部保留（零低分丢弃）
        self._keep_all = WeightedBudgetAllocator(
            keep_full_threshold=0.0, truncate_min_score=0.0, min_truncate_chars=0
        )

    def _feed_aggregator(self, record: ActivationRecord) -> ActivationRecord:
        """留痕同步喂聚合器（ENG9a-12 接线；聚合器为空 = 零影响）。"""
        if self._aggregator is not None:
            self._aggregator.record(record)
        return record

    def assemble(
        self,
        sources: list[ContextSource],
        *,
        total_budget: int | None = None,
        version_snapshot: dict[str, Any] | None = None,
    ) -> AssemblyResult:
        """统一调配入口：多源 → 预算分配 → 组装 → 激活留痕。

        Args:
            sources: 本次调用的全部源（上下文/知识/工具/记忆/证据混列，
                按源 type 分级分配）。
            total_budget: 调用点总预算（None = 用配置默认——一次调用的
                总预算在多源间分级分配，不再各自为政）。
            version_snapshot: 知识/规则版本快照（随激活记录落库，供全量
                原文重建与回放审计；按副本留存，外部改写不污染留痕）。

        Returns:
            AssemblyResult：组装文本 + 激活记录。

        Raises:
            GraphDefinitionError: 未知源类别/配置非法。
        """
        if not self.config.enabled:
            raise GraphDefinitionError("输入调配已禁用（enabled=False，调用点应走旧路径）")
        budget = total_budget or self.config.total_budget
        if budget <= 0:
            raise GraphDefinitionError(f"装配总预算必须为正: {budget}")
        snapshot = dict(version_snapshot) if version_snapshot else None
        grouped = _group_sources(sources)
        all_sources = [s for group in grouped.values() for s in group]

        # 能全量则全量：总内容不超过预算 → 整包激活（集小无稀疏必要）。
        # 工具激活数上限是独立护栏（每轮 3-14 个，降模型选错工具概率）——
        # 全量路径同样受其约束（预算宽裕不代表工具可以无限暴露）。
        total_chars = sum(len(s.content) for s in all_sources)
        if total_chars <= budget:
            activated: list[ContextSource] = []
            dropped_tools: list[ContextSource] = []
            for kind in _SOURCE_TYPES:
                group = grouped[kind]
                if kind == SOURCE_TOOL and len(group) > self.config.max_tools:
                    kept_tools = _limit_tools(group, self.config.max_tools)
                    kept_ids = {id(s) for s in kept_tools}
                    dropped_tools.extend(s for s in group if id(s) not in kept_ids)
                    group = kept_tools
                activated.extend(group)
            full_assembler = ContextAssembler(allocator=self._keep_all)
            assembled = full_assembler.assemble(activated, total_chars=budget)
            allocations = self._keep_all.allocate(activated, budget)
            activations = [
                SourceActivation(
                    source_type=a.source.type,
                    title=a.source.title or "",
                    weight=a.source.weight,
                    relevance=a.source.relevance,
                    char_limit=a.char_limit,
                    mode=a.mode,
                    entry_ref=a.source.meta.get("entry_id", ""),
                )
                for a in allocations
            ]
            activations.extend(
                SourceActivation(
                    source_type=s.type,
                    title=s.title or "",
                    weight=s.weight,
                    relevance=s.relevance,
                    char_limit=0,
                    mode=MODE_DROP,
                    entry_ref=s.meta.get("entry_id", ""),
                    note=f"工具激活数超上限（{self.config.max_tools}）",
                )
                for s in dropped_tools
            )
            return AssemblyResult(
                text=assembled.text,
                record=self._feed_aggregator(
                    ActivationRecord(
                        total_budget=budget,
                        assembled_chars=len(assembled.text),
                        sources=tuple(activations),
                        version_snapshot=snapshot,
                    )
                ),
            )
        # 放不下才裁剪：分级池预算两遍分配（ENG9a-13）——先按占比分池，
        # 再把无源池与取整余量二次回拨给有源池（缺源的池预算不闲置：
        # 仅 context 源可用预算 ≈ 总预算，与「能全量则全量」取向一致）
        present_kinds = [kind for kind in _SOURCE_TYPES if grouped[kind]]
        pool_budgets = {
            kind: int(budget * _ratio_for(self.config, kind))
            for kind in present_kinds
        }
        remainder = max(0, budget - sum(pool_budgets.values()))
        ratio_sum = sum(_ratio_for(self.config, kind) for kind in present_kinds)
        if remainder > 0 and ratio_sum > 0:
            for kind in present_kinds:
                pool_budgets[kind] += int(
                    remainder * _ratio_for(self.config, kind) / ratio_sum
                )
        activations: list[SourceActivation] = []
        # 源块清单（ENG9a-14）：逐池组装文本 + 该池激活留痕成对保存——
        # 全局预算回退按块整体丢弃（不切半句），被丢块的留痕同步改写
        blocks: list[tuple[str, list[SourceActivation]]] = []
        for kind in present_kinds:
            pool_sources = grouped[kind]
            pool_budget = pool_budgets[kind]
            group_activations: list[SourceActivation] = []
            if kind == SOURCE_TOOL and len(pool_sources) > self.config.max_tools:
                kept_tools = _limit_tools(pool_sources, self.config.max_tools)
                kept_ids = {id(s) for s in kept_tools}
                group_activations.extend(
                    SourceActivation(
                        source_type=s.type,
                        title=s.title or "",
                        weight=s.weight,
                        relevance=s.relevance,
                        char_limit=0,
                        mode=MODE_DROP,
                        entry_ref=s.meta.get("entry_id", ""),
                        note=f"工具激活数超上限（{self.config.max_tools}）",
                    )
                    for s in pool_sources
                    if id(s) not in kept_ids
                )
                pool_sources = kept_tools
            if not pool_sources:
                continue
            allocations = self._allocator.allocate(pool_sources, pool_budget)
            # 组装期条目内压缩（「放不下」三层处置的组装期条目内层）：
            # 被截断的源若挂了压缩钩子，用非破坏性摘要视图替代截断内容——
            # 原文不动（v4 CompressionPolicy 语义：摘要视图/非破坏性压缩），
            # 压缩失败（空串）走默认截断，不影响装配结果。
            kept: list[ContextSource] = []
            compressed_ids: set[int] = set()
            for a in allocations:
                if a.char_limit <= 0:
                    continue
                if (
                    self._compressor is not None
                    and len(a.source.content) > a.char_limit
                ):
                    compressed = self._compressor(a.source, a.char_limit) or ""
                    if compressed:
                        kept.append(
                            replace(
                                a.source,
                                content=compressed,
                                meta={
                                    **a.source.meta,
                                    "compressed": True,
                                    "original_chars": len(a.source.content),
                                },
                            )
                        )
                        compressed_ids.add(id(a.source))
                        continue
                kept.append(a.source)
            if not kept:
                group_activations.extend(
                    SourceActivation(
                        source_type=a.source.type,
                        title=a.source.title or "",
                        weight=a.source.weight,
                        relevance=a.source.relevance,
                        char_limit=0,
                        mode=a.mode,
                        entry_ref=a.source.meta.get("entry_id", ""),
                        note=a.reason,
                    )
                    for a in allocations
                )
                activations.extend(group_activations)
                continue
            assembled = self._assembler.assemble(
                kept, total_chars=pool_budget
            )
            for a in allocations:
                group_activations.append(
                    SourceActivation(
                        source_type=a.source.type,
                        title=a.source.title or "",
                        weight=a.source.weight,
                        relevance=a.source.relevance,
                        char_limit=a.char_limit,
                        mode=MODE_COMPRESSED if id(a.source) in compressed_ids else a.mode,
                        entry_ref=a.source.meta.get("entry_id", ""),
                        note=a.reason if a.char_limit <= 0 else "",
                    )
                )
            if assembled.text:
                blocks.append((assembled.text, group_activations))
            activations.extend(group_activations)
        text = "\n\n".join(block[0] for block in blocks)
        # 粘合开销兜底（ENG9a-14）：各分级池分别填满后拼接会超出总预算
        # （每处边界两个分隔符）——**按源块边界回退丢整块**（不再全局
        # 硬截断切半句/恒定牺牲最后一个池）：按回退优先级从低到高排序
        # （低优池在尾部），从尾部逐块回退直至不超预算，保证 context 等
        # 高优池最后才被牺牲。被丢块的源留痕改写为 drop（char_limit=0 +
        # 归因 note），截断量随留痕记录（归因可见，回放不丢信息）
        blocks.sort(
            key=lambda block: _ROLLBACK_PRIORITY.get(
                block[1][0].source_type if block[1] else "", 0
            ),
            reverse=True,
        )
        truncated_chars = 0
        # 运行长度跟踪（W-1 修复）：迭代回退用累计字符数递减代替每轮
        # 重新 join 全文（块数上百时 O(n²) 不可忽视）；被丢块 = 块文本 +
        # 尾部分隔符（2 字符），末块无分隔符
        total_chars = len(text)
        while blocks and total_chars > budget:
            removed_text, removed_activations = blocks.pop()
            removed_chars = len(removed_text) + (2 if blocks else 0)
            total_chars -= removed_chars
            truncated_chars += removed_chars
            for act in removed_activations:
                if act.char_limit <= 0:
                    continue
                for index, existing in enumerate(activations):
                    if existing is act:
                        activations[index] = replace(
                            act,
                            char_limit=0,
                            mode=MODE_DROP,
                            note="全局预算回退：按源块边界丢整块（粘合开销超预算）",
                        )
                        break
        text = "\n\n".join(block[0] for block in blocks)
        # 兜底防线：单块仍超预算（组装器异常，理论不可达）时最后硬截断
        if len(text) > budget:
            truncated_chars += len(text) - budget
            text = text[:budget]
        # 空装配保底：预算过小导致全部分配被丢弃时，保留最高优先源的
        # 可读片段（宁可截断也不空手喂模型——装配空 = 调用点拿不到
        # 任何输入上下文）。保底源追加到留痕，保留原有各源 drop 记录
        # 不整体替换——审计可见「哪些源被丢弃 + 哪个源保底」。
        if not text and all_sources:
            top = max(all_sources, key=lambda s: (s.score(), s.priority))
            text = top.content[:budget]
            activations = list(activations) + [
                SourceActivation(
                    source_type=top.type,
                    title=top.title or "",
                    weight=top.weight,
                    relevance=top.relevance,
                    char_limit=len(text),
                    mode="fallback_keep",
                    entry_ref=top.meta.get("entry_id", ""),
                    note="空装配保底：仅保留最高优先源的可读片段",
                )
            ]
        return AssemblyResult(
            text=text,
            record=self._feed_aggregator(
                ActivationRecord(
                    total_budget=budget,
                    assembled_chars=len(text),
                    sources=tuple(activations),
                    version_snapshot=snapshot,
                    truncated_chars=truncated_chars,
                )
            ),
        )


def _ratio_for(config: AssemblyConfig, kind: str) -> float:
    """源类别 → 分级占比（统一预算的分配比例，防各自为政）。"""
    return {
        SOURCE_CONTEXT: config.context_ratio,
        SOURCE_KNOWLEDGE: config.knowledge_ratio,
        SOURCE_TOOL: config.tool_ratio,
        SOURCE_MEMORY: config.memory_ratio,
        SOURCE_EVIDENCE: config.evidence_ratio,
    }.get(kind, 0.0)


@dataclass(frozen=True, slots=True)
class EntryActivationStats:
    """单个知识条目的激活聚合（利用率观测的最小单元）。"""

    entry_ref: str
    activations: int  # 窗口内激活次数
    total_weight: float  # 激活强度累计（weight 求和）
    total_chars: int  # 分配字符累计
    last_activated_call: int  # 最近一次激活所在的调用序号
    activation_rate: float  # 激活次数 / 窗口调用数（0-1）

    def to_dict(self) -> dict[str, Any]:
        return {
            "entry_ref": self.entry_ref,
            "activations": self.activations,
            "total_weight": self.total_weight,
            "total_chars": self.total_chars,
            "last_activated_call": self.last_activated_call,
            "activation_rate": self.activation_rate,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> EntryActivationStats:
        return cls(
            entry_ref=data.get("entry_ref", ""),
            activations=int(data.get("activations", 0)),
            total_weight=float(data.get("total_weight", 0.0)),
            total_chars=int(data.get("total_chars", 0)),
            last_activated_call=int(data.get("last_activated_call", 0)),
            activation_rate=float(data.get("activation_rate", 0.0)),
        )


@dataclass(frozen=True, slots=True)
class ActivationSummary:
    """激活利用率聚合快照（MoE 辅助损失借鉴：过热/过冷提示）。

    Attributes:
        calls: 聚合窗口内的调配调用数。
        total_refs: 窗口内出现过的条目引用总数。
        active_refs: 近期窗口内有激活的条目数。
        utilization: 活跃条目 / 总条目（0-1；负载均衡观察）。
        overheated: 过热条目（激活率 ≥ 阈值——激活失衡/粒度不当，
            提示检视激活规则与预算分级）。
        cold: 过冷条目（曾激活但窗口内长期零激活——进归档候选，
            衔接进化工厂「长期未调用」优先级）。
        per_entry: 逐条目聚合明细（排序稳定，可断言）。
    """

    calls: int
    total_refs: int
    active_refs: int
    utilization: float
    overheated: tuple[str, ...]
    cold: tuple[str, ...]
    per_entry: tuple[EntryActivationStats, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "calls": self.calls,
            "total_refs": self.total_refs,
            "active_refs": self.active_refs,
            "utilization": self.utilization,
            "overheated": list(self.overheated),
            "cold": list(self.cold),
            "per_entry": [s.to_dict() for s in self.per_entry],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ActivationSummary:
        return cls(
            calls=int(data.get("calls", 0)),
            total_refs=int(data.get("total_refs", 0)),
            active_refs=int(data.get("active_refs", 0)),
            utilization=float(data.get("utilization", 0.0)),
            overheated=tuple(data.get("overheated") or ()),
            cold=tuple(data.get("cold") or ()),
            per_entry=tuple(
                EntryActivationStats.from_dict(s) for s in data.get("per_entry") or ()
            ),
        )


class ActivationAggregator:
    """激活留痕利用率聚合（MoE 负载均衡借鉴的观测件）。

    输入 = 逐轮激活记录（:meth:`record`，与 InputAssembler 的留痕同源），
    输出 = 利用率快照（:meth:`snapshot`）：过热条目提示激活规则失衡/粒度
    不当（检视预算分级），过冷条目 = 长期零激活的归档候选（衔接知识集
    归档机制与进化工厂「长期未调用」优先级）——调试/审计/调参共用同一
    份「本次激活了什么」的聚合视图，不新增裁剪机制。
    """

    def __init__(
        self,
        *,
        overheated_rate: float = DEFAULT_OVERHEATED_RATE,
        cold_window: int = DEFAULT_COLD_WINDOW,
    ) -> None:
        if not 0 < overheated_rate <= 1:
            raise GraphDefinitionError(
                f"过热激活率阈值必须在 (0, 1] 内: {overheated_rate}"
            )
        if cold_window < 1:
            raise GraphDefinitionError(f"过冷窗口必须为正: {cold_window}")
        self.overheated_rate = overheated_rate
        self.cold_window = cold_window
        self._calls = 0
        self._stats: dict[str, list[Any]] = {}

    def record(self, record: ActivationRecord) -> None:
        """聚合一次调配留痕（逐源累积激活计数/强度/最近激活序号）。

        被丢弃的源不计激活（ENG9a-12）：``char_limit<=0``（分配为 0 =
        本调用未纳入）或 ``mode=MODE_DROP``（预算/上限丢弃）的条目若计
        入激活，预算丢弃会反向推高「过热」判定、过冷归档候选失真——
        只有真正进入装配文本的源才算激活。
        """
        self._calls += 1
        for source in record.sources:
            ref = source.entry_ref
            if not ref:
                continue  # 无条目引用的源（上下文/工具）不参与知识利用率
            if source.char_limit <= 0 or source.mode == MODE_DROP:
                continue  # 丢弃/零分配源不计激活
            stats = self._stats.setdefault(ref, [0, 0.0, 0, 0])
            stats[0] += 1  # 激活次数
            stats[1] += source.weight  # 激活强度累计
            stats[2] += source.char_limit  # 分配字符累计
            stats[3] = self._calls  # 最近激活调用序号

    def snapshot(self) -> ActivationSummary:
        """汇出利用率快照（过热/过冷提示 + 逐条目明细，可落库审计）。

        过热判定：激活率 ≥ 阈值（且窗口调用数 ≥ 2，单次调用不判定——
        无失衡语义）；过冷判定：曾激活但最近 ``cold_window`` 次调用内
        零激活（窗口调用数须超过冷窗，否则样本不足不判定）。
        """
        if self._calls == 0:
            return ActivationSummary(
                calls=0, total_refs=0, active_refs=0, utilization=0.0,
                overheated=(), cold=(), per_entry=(),
            )
        stats: list[EntryActivationStats] = []
        for ref, raw in self._stats.items():
            activations, weight, chars, last = raw
            stats.append(
                EntryActivationStats(
                    entry_ref=ref,
                    activations=activations,
                    total_weight=weight,
                    total_chars=chars,
                    last_activated_call=last,
                    activation_rate=activations / self._calls,
                )
            )
        stats.sort(key=lambda s: s.entry_ref)
        active = [
            s for s in stats if s.last_activated_call > self._calls - self.cold_window
        ]
        overheated = tuple(
            s.entry_ref
            for s in stats
            if self._calls >= 2 and s.activation_rate >= self.overheated_rate
        )
        cold = tuple(
            s.entry_ref
            for s in stats
            if self._calls > self.cold_window
            and s.last_activated_call <= self._calls - self.cold_window
        )
        return ActivationSummary(
            calls=self._calls,
            total_refs=len(stats),
            active_refs=len(active),
            utilization=len(active) / len(stats) if stats else 0.0,
            overheated=overheated,
            cold=cold,
            per_entry=tuple(stats),
        )


__all__ = [
    "DEFAULT_ASSEMBLY_BUDGET",
    "DEFAULT_COLD_WINDOW",
    "DEFAULT_CONTEXT_RATIO",
    "DEFAULT_EVIDENCE_RATIO",
    "DEFAULT_KNOWLEDGE_RATIO",
    "DEFAULT_MAX_TOOLS",
    "DEFAULT_MEMORY_RATIO",
    "DEFAULT_OVERHEATED_RATE",
    "DEFAULT_TOOL_RATIO",
    "DEFAULT_TOTAL_BUDGET",
    "MODE_COMPRESSED",
    "SOURCE_CONTEXT",
    "SOURCE_EVIDENCE",
    "SOURCE_KNOWLEDGE",
    "SOURCE_MEMORY",
    "SOURCE_TOOL",
    "ActivationAggregator",
    "ActivationRecord",
    "ActivationSummary",
    "AssemblyConfig",
    "AssemblyResult",
    "EntryActivationStats",
    "EntryCompressor",
    "InputAssembler",
    "InputAssemblyResult",
    "SourceActivation",
]
