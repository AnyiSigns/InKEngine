"""上下文调配器原语（Context Mixer：多源融合的确定性层 + LLM 融合钩子）。

多源上下文注入（检索片段/长期记忆/设定卡/分支线/外部反馈），
简单全拼会导致上下文膨胀与噪音——调配器的职责是当「调酒师」，按源元数据
（来源/权重/相关度/优先级/时效）在预算内加权融合。

本模块只定义**机制**（源元数据模型 + 预算分配策略 + 加权组装 + 融合钩子），
不绑定任何领域语义：

- :class:`ContextSource`：源元数据模型（type/weight/relevance/priority/ttl）；
- :class:`BudgetAllocator`：预算分配策略接口 + :class:`WeightedBudgetAllocator`
  确定性默认实现（高权重全保留、中权重截断、低权重丢弃，零 LLM 调用）；
- :class:`ContextAssembler`：加权组装（跨源去重 + 按预算拼接 + 留痕）；
- :class:`FusionHook`：LLM「调酒师」融合钩子接口（按需/候选融合，注册制）；
- :class:`ContextMixer`：门面——有融合钩子时优先融合（失败自动回退确定性
  组装，fail-open），无钩子时纯确定性组装，零额外 LLM 调用。

预算单位 = 字符（引擎无分词器，字符数是对 token 的确定性近似；宿主按
模型上下文窗换算）。

行为开关（默认新装配、一键回退旧静态取段）属宿主配置（配置驱动原则）：
引擎只提供装配 API，宿主在 settings 持开关选择走调配器还是旧路径。
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from .logging import get_logger

logger = get_logger(__name__)

# 默认装配预算（字符）：与宿主旧静态取段 4000 上限对齐，宿主可覆盖
DEFAULT_BUDGET_CHARS = 4000

# 相关度默认值（未显式声明时取中值，防全默认 = 全相同导致预算均分）
DEFAULT_RELEVANCE = 0.5

# 高权重源全保留阈值：score = weight × relevance ≥ 该值 → 预算内整源保留
KEEP_FULL_THRESHOLD = 0.8

# 中权重源截断门槛：score ≥ 该值 → 按预算份额截断保留；低于 → 丢弃
TRUNCATE_MIN_SCORE = 0.15

# 截断保留的字符下限：份额低于该值不值得保留（近似噪音），直接丢弃
MIN_TRUNCATE_CHARS = 100

# 分配模式（确定性层的三种处理档位）
MODE_KEEP_FULL = "keep_full"
MODE_TRUNCATE = "truncate"
MODE_DROP = "drop"


@dataclass(frozen=True, slots=True)
class ContextSource:
    """单个上下文源（带元数据的融合输入）。

    Attributes:
        type: 源类型（业务自定义：topic/memory/entity/state/...）。
        content: 源文本（空内容 = 无意义源，分配时剔除）。
        title: 可选标题（装配时作块标题行，留痕可读）。
        weight: 权重（预算分配主因子，数值大多分配）。
        relevance: 相关度（0-1，与当前任务的匹配度，预算分配次因子）。
        priority: 优先级（同分时排序，数值大在前）。
        ttl: 时效秒数（None = 不过期；过期源分配时剔除）。
        max_chars: 该源保留上限（None = 不设额外上限）。
        dedup_key: 跨源去重键（同键源只保留优先级最高者）。
        meta: 扩展元数据（来源引用/目标标识等，装配留痕透传）。
        created_at: 创建时间戳（epoch 秒，ttl 基准）。
    """

    type: str
    content: str
    title: str | None = None
    weight: float = 1.0
    relevance: float = DEFAULT_RELEVANCE
    priority: int = 5
    ttl: float | None = None
    max_chars: int | None = None
    dedup_key: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)

    def __post_init__(self) -> None:
        if self.weight < 0:
            raise ValueError(f"源权重不能为负: {self.weight}")
        if not 0 <= self.relevance <= 1:
            raise ValueError(f"源相关度必须在 [0, 1] 内: {self.relevance}")
        if self.ttl is not None and self.ttl < 0:
            raise ValueError(f"源时效不能为负: {self.ttl}")
        if self.max_chars is not None and self.max_chars < 0:
            raise ValueError(f"源保留上限不能为负: {self.max_chars}")

    def is_expired(self, now: float | None = None) -> bool:
        """按 ttl 判定源是否过期（None = 永不过期）。"""
        if self.ttl is None:
            return False
        current = time.time() if now is None else now
        return current - self.created_at >= self.ttl

    def score(self) -> float:
        """确定性层分配分 = 权重 × 相关度（单一排序键，可解释）。"""
        return self.weight * self.relevance


@dataclass(frozen=True, slots=True)
class SourceAllocation:
    """单个源的预算分配结果（确定性层三种档位）。

    Attributes:
        source: 分配对象。
        mode: 分配模式（keep_full/truncate/drop）。
        char_limit: 该源可用字符上限（drop 为 0）。
        reason: 分配理由（留痕可读：高权重全保留/预算份额/时效过期/低于门槛…）。
    """

    source: ContextSource
    mode: str
    char_limit: int
    reason: str


@runtime_checkable
class BudgetAllocator(Protocol):
    """预算分配策略接口：源列表 + 总预算 → 逐源分配。

    实现约定：
    - 返回与输入等长的一一对应分配结果；
    - 确定性：同一输入必得同一输出（业务可替换策略，换策略不改装配）；
    - 总分配量不得超过 total_chars（预算硬上界）。
    """

    def allocate(
        self, sources: list[ContextSource], total_chars: int
    ) -> list[SourceAllocation]: ...


def _dedup_sources(sources: list[ContextSource]) -> list[ContextSource]:
    """跨源去重：同 dedup_key 只保留优先级最高者（插入序稳定）。"""
    seen: dict[str, ContextSource] = {}
    order: list[str] = []
    for src in sources:
        if not src.dedup_key:
            continue
        prev = seen.get(src.dedup_key)
        if prev is None or (src.priority, src.score()) > (prev.priority, prev.score()):
            seen[src.dedup_key] = src
            order.append(src.dedup_key)
    keys = set(seen)
    return [s for s in sources if s.dedup_key not in keys or seen[s.dedup_key] is s]


class WeightedBudgetAllocator:
    """确定性默认预算分配：高权重全保留、中权重截断、低权重丢弃。

    规则（按分配分 score = weight × relevance 分档，预算顺序填充）：
    1. 剔除过期 / 空内容源；
    2. 跨源去重（同 dedup_key 保留优先级最高者）；
    3. score ≥ ``keep_full_threshold`` → 整源保留（受 max_chars 约束），
       按（优先级降序, score 降序）顺序填充预算，预算不足者降级为截断；
    4. 其余 score ≥ ``truncate_min_score`` → 按分配分占比分享剩余预算
       （水塘填充：超过可用长度的份额返还重新分配，跨轮份额**累加**、
       已整源保留者移出池锁定，防截断到比自己还短）；
    5. 份额低于 ``min_truncate_chars`` 或 score 低于门槛 → 丢弃。

    确定性 = 同一输入必得同一输出（可缓存、可断言、零 LLM 调用）。
    """

    def __init__(
        self,
        *,
        keep_full_threshold: float = KEEP_FULL_THRESHOLD,
        truncate_min_score: float = TRUNCATE_MIN_SCORE,
        min_truncate_chars: int = MIN_TRUNCATE_CHARS,
    ) -> None:
        if not 0 <= keep_full_threshold <= 1:
            raise ValueError(f"全保留阈值必须在 [0, 1] 内: {keep_full_threshold}")
        if truncate_min_score < 0 or truncate_min_score > keep_full_threshold:
            raise ValueError(
                f"截断门槛必须非负且不高于全保留阈值: {truncate_min_score}"
            )
        if min_truncate_chars < 0:
            raise ValueError(f"截断下限不能为负: {min_truncate_chars}")
        self.keep_full_threshold = keep_full_threshold
        self.truncate_min_score = truncate_min_score
        self.min_truncate_chars = min_truncate_chars

    @staticmethod
    def _available_chars(source: ContextSource) -> int:
        """源的可用字符数（max_chars 兜底截断，保证单源也有上限）。"""
        length = len(source.content)
        if source.max_chars is not None:
            return min(length, source.max_chars)
        return length

    def allocate(
        self, sources: list[ContextSource], total_chars: int
    ) -> list[SourceAllocation]:
        if total_chars < 0:
            raise ValueError(f"总预算不能为负: {total_chars}")
        now = time.time()
        alive = [
            s for s in sources if s.content.strip() and not s.is_expired(now)
        ]
        alive = _dedup_sources(alive)
        if not alive:
            return []

        # 分档：全保留 / 截断 / 丢弃（score 升序为水塘填充顺序，插序稳定）
        keep = [
            s for s in alive if s.score() >= self.keep_full_threshold
        ]
        trunc = [
            s for s in alive if self.truncate_min_score <= s.score() < self.keep_full_threshold
        ]
        dropped = [
            s for s in alive if s.score() < self.truncate_min_score
        ]
        keep.sort(key=lambda s: (s.priority, s.score()), reverse=True)

        allocations: dict[int, SourceAllocation] = {}
        # 3. 全保留档顺序填充；预算不足者降级到截断池分享剩余
        remaining = total_chars
        degraded: list[ContextSource] = []
        for src in keep:
            avail = self._available_chars(src)
            if remaining - avail >= 0:
                allocations[id(src)] = SourceAllocation(
                    src, MODE_KEEP_FULL, avail, f"高权重源全保留（score={src.score():.2f}）"
                )
                remaining -= avail
            else:
                degraded.append(src)
        if degraded:
            trunc = sorted(trunc + degraded, key=lambda s: s.score(), reverse=True)

        # 4. 截断档水塘填充：每轮所有源按同一初始余额算份额，轮末统一扣减
        #    本轮实际分配额（预算硬上界：下一轮余额 = 尚未分配的部分，封顶
        #    源多占份额自然留池回流；同轮内不互相挤占份额）。
        #    跨轮**累加**：源在后续轮的份额是新增量而非覆写——覆写会把已
        #    封顶源释放预算触发第二轮时其余源的份额变小，静默少分配/丢内容
        #    （硬上界断言不触发，属静默错误）。已整源保留的源移出池锁定。
        pool = trunc
        while pool and remaining > 0:
            total_score = sum(s.score() for s in pool)
            if total_score <= 0:
                for src in pool:
                    if id(src) not in allocations:
                        allocations[id(src)] = SourceAllocation(
                            src, MODE_DROP, 0, "分配分为零，无份额"
                        )
                break
            next_pool: list[ContextSource] = []
            spent = 0
            for src in pool:
                share = int(remaining * src.score() / total_score)
                avail = self._available_chars(src)
                cur = allocations.get(id(src))
                cur_limit = cur.char_limit if cur is not None else 0
                if cur_limit >= avail:
                    continue  # 已整源保留：移出池锁定，不覆写不重复扣减
                if share >= avail - cur_limit:
                    allocations[id(src)] = SourceAllocation(
                        src, MODE_TRUNCATE, avail,
                        f"预算份额 {share} 超过可用长度，整源保留",
                    )
                    spent += avail - cur_limit
                elif cur_limit + share >= self.min_truncate_chars:
                    allocations[id(src)] = SourceAllocation(
                        src, MODE_TRUNCATE, cur_limit + share,
                        f"预算份额 {share} 字符（累计 {cur_limit + share}）",
                    )
                    spent += share
                    next_pool.append(src)
                else:
                    # 份额低于下限：从未获得分配的源丢弃（其份额自然回流池
                    # 重新分配）；已有累计分配的源保留现有结果并退出池
                    if cur is None:
                        allocations[id(src)] = SourceAllocation(
                            src, MODE_DROP, 0,
                            f"预算份额 {share} 低于下限 {self.min_truncate_chars}，丢弃",
                        )
            remaining -= spent
            if not next_pool or len(next_pool) >= len(pool):
                # 全部封顶或份额无变化（精度收敛），退出防死循环
                pool = next_pool if len(next_pool) < len(pool) else []
            else:
                pool = next_pool

        for src in dropped:
            allocations[id(src)] = SourceAllocation(
                src, MODE_DROP, 0, f"分配分低于截断门槛（{src.score():.2f} < {self.truncate_min_score}）"
            )
        # 兜底：预算耗尽前未进入分配池的源（如剩余预算为 0 的降级源）补丢弃标记
        for src in alive:
            if id(src) not in allocations:
                allocations[id(src)] = SourceAllocation(
                    src, MODE_DROP, 0, "预算耗尽"
                )
        result = [allocations[id(s)] for s in alive]
        # 预算硬上界契约（Protocol 承诺）：总分配量不得超过 total_chars。
        # 违反即分配器实现缺陷（编程错误），显式失败而非静默超预算。
        total_allocated = sum(a.char_limit for a in result)
        if total_allocated > total_chars:
            raise AssertionError(
                f"预算分配超出硬上界: 分配 {total_allocated} > 预算 {total_chars}"
            )
        return result


@dataclass(frozen=True, slots=True)
class SourceInclusion:
    """装配留痕：一个被纳入源的使用明细（审计「喂了什么」）。"""

    type: str
    title: str | None
    mode: str
    chars: int


@dataclass(frozen=True, slots=True)
class DroppedSource:
    """装配留痕：一个被丢弃的源（原因可读，便于调预算）。"""

    type: str
    title: str | None
    reason: str


@dataclass(frozen=True, slots=True)
class AssembledContext:
    """装配结果：最终文本 + 逐源留痕（可审计/可回退）。

    Attributes:
        text: 装配产物（长度 ≤ total_chars，硬上界）。
        included: 被纳入源的使用明细（按装配顺序）。
        dropped: 被丢弃源及原因。
        total_chars: 本次预算。
        used_chars: 实际使用字符数（分隔符计入）。
        fused: 是否经 LLM 融合钩子产出（否则为确定性组装）。
    """

    text: str
    included: tuple[SourceInclusion, ...] = ()
    dropped: tuple[DroppedSource, ...] = ()
    total_chars: int = DEFAULT_BUDGET_CHARS
    used_chars: int = 0
    fused: bool = False


class ContextAssembler:
    """加权组装：去重 + 预算分配 + 按块拼接（确定性层执行器）。

    块格式：有标题的源 = ``【标题】\n文本``，无标题 = 纯文本；
    块间 ``\\n\\n`` 分隔。预算硬上界 = total_chars（分隔符计入成本，
    末尾超界块跳过，兜底整串硬截断——保证输出永不超预算）。
    """

    def __init__(
        self,
        *,
        default_budget_chars: int = DEFAULT_BUDGET_CHARS,
        allocator: BudgetAllocator | None = None,
    ) -> None:
        if default_budget_chars < 0:
            raise ValueError(f"默认预算不能为负: {default_budget_chars}")
        self.default_budget_chars = default_budget_chars
        self.allocator = allocator or WeightedBudgetAllocator()

    def assemble(
        self,
        sources: list[ContextSource],
        *,
        total_chars: int | None = None,
    ) -> AssembledContext:
        """确定性组装：源列表 → 预算内拼接文本 + 留痕。"""
        total = self.default_budget_chars if total_chars is None else total_chars
        if total < 0:
            raise ValueError(f"总预算不能为负: {total}")
        if not sources:
            return AssembledContext(text="", total_chars=total, used_chars=0)

        allocations = self.allocator.allocate(sources, total)
        blocks: list[str] = []
        included: list[SourceInclusion] = []
        dropped: list[DroppedSource] = []
        used = 0
        for alloc in allocations:
            if alloc.mode == MODE_DROP:
                dropped.append(
                    DroppedSource(alloc.source.type, alloc.source.title, alloc.reason)
                )
                continue
            content = alloc.source.content[: alloc.char_limit]
            if not content.strip():
                dropped.append(DroppedSource(alloc.source.type, alloc.source.title, "截断后为空"))
                continue
            block = (
                f"【{alloc.source.title}】\n{content}"
                if alloc.source.title
                else content
            )
            cost = len(block) + (2 if blocks else 0)  # 块间 "\n\n" 分隔符计入预算
            if used + cost > total:
                dropped.append(
                    DroppedSource(alloc.source.type, alloc.source.title, "预算耗尽")
                )
                continue
            blocks.append(block)
            used += cost
            included.append(
                SourceInclusion(alloc.source.type, alloc.source.title, alloc.mode, len(content))
            )
        text = "\n\n".join(blocks)
        if len(text) > total:  # 兜底硬截断（分隔符累计误差防御）
            text = text[:total]
            used = len(text)
        return AssembledContext(
            text=text,
            included=tuple(included),
            dropped=tuple(dropped),
            total_chars=total,
            used_chars=used,
        )


@runtime_checkable
class FusionHook(Protocol):
    """LLM「调酒师」融合钩子接口（按需/候选融合，注册制）。

    实现约定：
    - 对给定源列表按指令融合为连贯上下文段（深度融合/候选语义融合）；
    - 返回 None = 本次不融合（宿主显式拒绝，走确定性组装）；
    - 融合失败不得抛错——抛错由调用方捕获并回退确定性组装（fail-open，
      融合是增强能力，不阻断主流程）。
    """

    async def fuse(
        self,
        sources: list[ContextSource],
        *,
        instruction: str,
        budget_chars: int,
        context: dict[str, Any] | None = None,
    ) -> str | None: ...


class FusionRegistry:
    """融合钩子注册表（新增融合策略 = 注册新钩子类，装配核心零改动）。

    插拔语义：同名重复注册 = 覆盖（宿主启动按配置装配，配置驱动）。
    """

    def __init__(self) -> None:
        self._hooks: dict[str, FusionHook] = {}

    def register(self, name: str, hook: FusionHook) -> None:
        if not name:
            raise ValueError("融合钩子名称不能为空")
        self._hooks[name] = hook

    def get(self, name: str) -> FusionHook | None:
        """按名取钩子（未注册返回 None，宿主自行决定是否回退确定性组装）。"""
        return self._hooks.get(name)

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(self._hooks)


class ContextMixer:
    """调配器门面：确定性组装 + 可选 LLM 融合（按需，失败自动回退）。

    - 注册融合钩子（或 mix 调用时注入）→ 优先融合：融合产出即最终文本，
      且留痕 fused=True；融合返回 None / 抛异常 → 自动回退确定性组装
      （fail-open，融合成本 = 按需额外 LLM 调用，不默认）；
    - 未注册钩子 → 纯确定性组装，零额外 LLM 调用。
    """

    def __init__(
        self,
        *,
        assembler: ContextAssembler | None = None,
        fusion_hook: FusionHook | None = None,
        fusion_instruction: str = "",
    ) -> None:
        self.assembler = assembler or ContextAssembler()
        self.fusion_hook = fusion_hook
        self.fusion_instruction = fusion_instruction

    def attach_fusion(self, hook: FusionHook, instruction: str = "") -> None:
        """挂载/替换融合钩子（运行期可换，插拔语义）。"""
        self.fusion_hook = hook
        if instruction:
            self.fusion_instruction = instruction

    async def mix(
        self,
        sources: list[ContextSource],
        *,
        total_chars: int | None = None,
        instruction: str | None = None,
    ) -> AssembledContext:
        """混合装配入口：有融合钩子先融合，失败/拒绝回退确定性组装。"""
        total = (
            self.assembler.default_budget_chars
            if total_chars is None
            else total_chars
        )
        if self.fusion_hook is not None and sources:
            try:
                fused = await self.fusion_hook.fuse(
                    sources,
                    instruction=instruction or self.fusion_instruction,
                    budget_chars=total,
                )
                if fused:
                    text = fused[:total]
                    return AssembledContext(
                        text=text,
                        total_chars=total,
                        used_chars=len(text),
                        fused=True,
                    )
                logger.info("[mixer] 融合钩子返回 None，回退确定性组装")
            except Exception as exc:
                # fail-open：融合失败不阻断主流程，回退确定性组装
                logger.warning(f"[mixer] 融合失败回退确定性组装: {exc}")
        return self.assembler.assemble(sources, total_chars=total)


@runtime_checkable
class CompressionPolicy(Protocol):
    """压缩策略钩子：触发判定 + 预算（宿主注入，换策略不改装配）。

    触发判定与预算分配分层：判定（该不该压）与分配（压到多紧）都是
    可注入策略——分配复用 BudgetAllocator 协议，判定/预算经本钩子
    注入；默认实现见 ThresholdCompressionPolicy。
    """

    def should_compress(self, state: dict) -> bool:
        """触发判定：基于状态（消息量/字符量等）决定本轮是否压缩。"""
        ...

    def budget_chars(self, state: dict) -> int:
        """压缩预算（摘要目标字符数，喂给预算分配）。"""
        ...


class ThresholdCompressionPolicy:
    """默认压缩策略：消息量与字符量双阈值触发（确定性，可断言）。

    策略语义：两者都达到阈值才触发（短消息多轮不压、长消息少量不压），
    预算固定返回配置值；阈值与预算均为构造参数（宿主按场景注入）。
    """

    def __init__(
        self,
        *,
        min_messages: int = 30,
        min_chars: int = 40000,
        budget_chars: int = 8000,
    ) -> None:
        if min_messages < 1 or min_chars < 1 or budget_chars < 1:
            raise ValueError("压缩阈值与预算必须为正数")
        self.min_messages = min_messages
        self.min_chars = min_chars
        self._budget_chars = budget_chars

    def should_compress(self, state: dict) -> bool:
        messages = state.get("messages") or []
        if len(messages) < self.min_messages:
            return False
        total = 0
        for msg in messages:
            content = msg.get("content") if isinstance(msg, dict) else getattr(msg, "content", None)
            total += len(str(content or ""))
            if total >= self.min_chars:
                return True
        return False

    def budget_chars(self, state: dict) -> int:
        return self._budget_chars


__all__ = [
    "DEFAULT_BUDGET_CHARS",
    "DEFAULT_RELEVANCE",
    "KEEP_FULL_THRESHOLD",
    "MIN_TRUNCATE_CHARS",
    "MODE_DROP",
    "MODE_KEEP_FULL",
    "MODE_TRUNCATE",
    "TRUNCATE_MIN_SCORE",
    "AssembledContext",
    "BudgetAllocator",
    "CompressionPolicy",
    "ContextAssembler",
    "ContextMixer",
    "ContextSource",
    "DroppedSource",
    "FusionHook",
    "FusionRegistry",
    "SourceAllocation",
    "SourceInclusion",
    "ThresholdCompressionPolicy",
    "WeightedBudgetAllocator",
]
