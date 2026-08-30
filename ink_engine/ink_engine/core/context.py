"""上下文调配器原语（Context Mixer：多源融合的确定性层 + LLM 融合钩子）。

多源上下文注入（检索片段/长期记忆/设定卡/分支线/外部反馈），
简单全拼会导致上下文膨胀与噪音——调配器的职责是当「调酒师」，按源元数据
（来源/权重/相关度/优先级/时效）在预算内加权融合。

本模块只定义**机制**（源元数据模型 + 预算分配策略 + 加权组装 + 融合钩子 +
域上下文窗口投影），不绑定任何领域语义：

- :class:`ContextSource`：源元数据模型（type/weight/relevance/priority/ttl）；
- :class:`BudgetAllocator`：预算分配策略接口 + :class:`WeightedBudgetAllocator`
  确定性默认实现（高权重全保留、中权重截断、低权重丢弃，零 LLM 调用）；
- :class:`ContextAssembler`：加权组装（跨源去重 + 按预算拼接 + 留痕）；
- :class:`FusionHook`：LLM「调酒师」融合钩子接口（按需/候选融合，注册制）；
- :class:`ContextMixer`：门面——有融合钩子时优先融合（失败自动回退确定性
  组装，fail-open），无钩子时纯确定性组装，零额外 LLM 调用；
- 域上下文窗口投影（原 components/domain_window）：对共享消息流做**投影**，
  只给当前域看它该看的部分（用户消息全留 + 本域最近工具轮 + 最近完成性
  回复 + 归档摘要锚点）——「投影」而非「裁剪」，共享消息流本身不变。

预算单位 = 字符（引擎无分词器，字符数是对 token 的确定性近似；宿主按
模型上下文窗换算）。

行为开关（默认新装配、一键回退旧静态取段）属宿主配置（配置驱动原则）：
引擎只提供装配 API，宿主在 settings 持开关选择走调配器还是旧路径。
"""
from __future__ import annotations

import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from .llm.messages import message_role, user
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
        """源的可用内容字符数（max_chars 兜底截断，保证单源也有上限）。"""
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
        # （块成本含标题/分隔符开销，分配按内容长口径——超界部分由
        # 组装层按剩余预算截断内容保留，见 ContextAssembler.assemble）
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
        if allocator is not None and not isinstance(allocator, BudgetAllocator):
            # 协议运行期校验（ENG2-14）：BudgetAllocator 不再只是类型注解——
            # 注入的分配策略不满足协议（缺 allocate/签名漂移）在装配期暴露，
            # 而非执行期 AttributeError 炸链路
            raise TypeError(
                f"allocator 须实现 BudgetAllocator 协议: {type(allocator).__name__}"
            )
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
        # 装配顺序 = 分配优先级顺序（而非输入顺序）：分配结果已按优先级/
        # 分数定好谁 keep_full/truncate/drop，但 concatenate 若按输入序，预算
        # 紧张时前置低优截断源会先占预算、把后置高优 keep_full 源的内容二次
        # 截断挤出。重排只影响拼接顺序，不动分配结果（预算硬上界不变）。
        order = sorted(
            range(len(allocations)),
            key=lambda i: (
                0 if allocations[i].mode != MODE_DROP else 1,
                -allocations[i].source.priority,
                -allocations[i].source.score(),
                i,  # 同优先级的稳定序（输入序）
            ),
        )
        blocks: list[str] = []
        included: list[SourceInclusion] = []
        dropped: list[DroppedSource] = []
        used = 0
        for i in order:
            alloc = allocations[i]
            if alloc.mode == MODE_DROP:
                dropped.append(
                    DroppedSource(alloc.source.type, alloc.source.title, alloc.reason)
                )
                continue
            content = alloc.source.content[: alloc.char_limit]
            if not content.strip():
                dropped.append(DroppedSource(alloc.source.type, alloc.source.title, "截断后为空"))
                continue
            title = alloc.source.title
            # 块成本 = 标题块【t】\n + 内容 + 块间分隔符 \n\n（首块无分隔符）
            # 【title】\n 实际为 len(title)+3（【/】/\n 各占 1），原 +2 少算 1
            overhead = (len(title) + 3 if title else 0) + (2 if blocks else 0)
            if used + overhead >= total:
                # 标题/分隔符开销都放不下：整块无法呈现，丢弃（留痕可辨）
                dropped.append(
                    DroppedSource(alloc.source.type, alloc.source.title, "预算耗尽")
                )
                continue
            if used + overhead + len(content) > total:
                # 内容超界：截断内容至剩余预算（标题保留）——分配层按内容
                # 长口径判全保留，块开销（标题/分隔符）会顶掉少量内容；
                # 截断保留而非整源丢弃，高优源必在场（防静默丢重要内容）
                content = content[: total - used - overhead]
                if not content.strip():
                    dropped.append(
                        DroppedSource(alloc.source.type, alloc.source.title, "预算耗尽")
                    )
                    continue
                dropped.append(  # 留痕：截断部分的来源可追溯
                    DroppedSource(
                        alloc.source.type,
                        alloc.source.title,
                        f"块开销截断 {len(alloc.source.content[: alloc.char_limit]) - len(content)} 字符",
                    )
                )
            block = f"【{title}】\n{content}" if title else content
            cost = len(block) + (2 if blocks else 0)
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

    消费方 = :class:`ContextMixer`（ENG2-11 接入）：mix 未直接注入
    ``fusion_hook`` 时，按 ``fusion_hook_name`` 从注册表取钩子——
    注册表不再是无消费方的孤儿代码，多策略注册经名称选择参与融合。
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
    - 未直接注入钩子时，可按 ``fusion_registry`` 注册表按名取钩子
      （ENG2-11：注册表有真实消费方）；
    - 未注册任何钩子 → 纯确定性组装，零额外 LLM 调用。
    """

    def __init__(
        self,
        *,
        assembler: ContextAssembler | None = None,
        fusion_hook: FusionHook | None = None,
        fusion_instruction: str = "",
        fusion_registry: FusionRegistry | None = None,
        fusion_hook_name: str = "default",
    ) -> None:
        self.assembler = assembler or ContextAssembler()
        self.fusion_hook = fusion_hook
        self.fusion_instruction = fusion_instruction
        self.fusion_registry = fusion_registry
        self.fusion_hook_name = fusion_hook_name

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
        hook = self.fusion_hook
        if hook is None and self.fusion_registry is not None:
            hook = self.fusion_registry.get(self.fusion_hook_name)
        if hook is not None and sources:
            try:
                fused = await hook.fuse(
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


# ── 上下文窗口参数动态化（按模型档案 context_window 推算）────────────
# 窗口参数一律按「该调用所用模型」的模型档案（model_archive context_window），
# 不做档位推断（档位只决定哪个通道用哪个模型，不决定窗口参数）；档案缺失
# 回落 200k 兜底（现代长窗，避免短视压缩）。比例由宿主可调（全局占比）。
COMPRESSION_CONTEXT_WINDOW_RATIO = 0.8
COMPRESSION_DEFAULT_CONTEXT_WINDOW = 200_000
COMPRESSION_DEFAULT_MIN_CHARS = int(
    COMPRESSION_DEFAULT_CONTEXT_WINDOW * COMPRESSION_CONTEXT_WINDOW_RATIO
)
# 工具结果截断（回填消息流/事件）：窗口占比 + 下限兜底（小窗口模型不虚高）
TOOL_RESULT_WINDOW_RATIO = 0.05
TOOL_RESULT_MAX_CHARS_FLOOR = 4000


def resolve_compression_min_chars(
    context_window: int | None = None,
    *,
    ratio: float = COMPRESSION_CONTEXT_WINDOW_RATIO,
) -> int:
    """压缩字符阈值（按模型档案 context_window 动态推算）。

    - 已知 context_window：取 ``int(ratio * cw)``（250k→200k、32k→26k）；
    - 档案缺失：回落 ``ratio × 200k`` 兜底（不按档位推断）。
    """
    if context_window and context_window > 0:
        return int(context_window * ratio)
    return int(COMPRESSION_DEFAULT_CONTEXT_WINDOW * ratio)


def resolve_tool_result_max_chars(
    context_window: int | None = None,
    *,
    ratio: float = TOOL_RESULT_WINDOW_RATIO,
    floor: int = TOOL_RESULT_MAX_CHARS_FLOOR,
) -> int:
    """工具结果回填截断上限（按模型档案 context_window 动态推算）。

    - 已知 context_window：``max(floor, int(ratio * cw))``（250k→12.5k）；
    - 档案缺失：``max(floor, int(0.05 * 200k))``（10k）；
    - 下限 = floor（小窗口模型不因比例跌破，零回归）。
    """
    if context_window and context_window > 0:
        return max(floor, int(context_window * ratio))
    return max(floor, int(COMPRESSION_DEFAULT_CONTEXT_WINDOW * ratio))


class ThresholdCompressionPolicy:
    """默认压缩策略：消息量与字符量双阈值触发（确定性，可断言）。

    策略语义：两者都达到阈值才触发（短消息多轮不压、长消息少量不压），
    预算固定返回配置值；阈值与预算均为构造参数（宿主按场景注入）。

    ``from_context_window`` 类方法按模型档案 ``context_window`` 动态推算
    字符阈值，使压缩阈值随模型窗口自适应。
    """

    def __init__(
        self,
        *,
        min_messages: int = 30,
        min_chars: int = COMPRESSION_DEFAULT_MIN_CHARS,
        budget_chars: int = 8000,
    ) -> None:
        if min_messages < 1 or min_chars < 1 or budget_chars < 1:
            raise ValueError("压缩阈值与预算必须为正数")
        self.min_messages = min_messages
        self.min_chars = min_chars
        self._budget_chars = budget_chars

    @classmethod
    def from_context_window(
        cls,
        context_window: int | None = None,
        *,
        ratio: float = COMPRESSION_CONTEXT_WINDOW_RATIO,
        min_messages: int = 30,
        budget_chars: int = 8000,
    ) -> ThresholdCompressionPolicy:
        """按模型档案 context_window 动态构建（阈值 = 占比 × cw，档案缺失 200k 兜底）。

        ratio = 压缩占比（全局唯一旋钮，默认 0.8；用户可在设置页调整，
        引擎按模型档案窗口 × 占比动态推算阈值——不暴露 token 数）。
        """
        min_chars = resolve_compression_min_chars(context_window, ratio=ratio)
        return cls(
            min_messages=min_messages,
            min_chars=min_chars,
            budget_chars=budget_chars,
        )

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


def compress_message_history(
    messages: Sequence[Any],
    *,
    policy: CompressionPolicy,
    keep_recent: int = 10,
) -> list[Any]:
    """回合内消息流压缩（LLM 消息组装处的确定性压缩视图）。

    语义（非破坏性：原始消息流不修改，返回压缩后的视图列表）：
    - ``policy.should_compress`` 未触发 → 原列表副本直接返回（零改动）；
    - 触发 → 头部 system 消息恒保留（提示词不压缩）+ 最近
      ``keep_recent`` 条消息原样保留 + 中间旧消息段折叠为一条确定性
      摘要 user 消息（:func:`archive_digest`，预算 = ``policy.budget_chars``）。

    触发阈值默认 30 条 / 160000 字符（:class:`ThresholdCompressionPolicy`
    构造参数可配；引擎按模型窗口占比动态推算，档案缺失回落 0.8×200k
    兜底），仅极端膨胀回合触发；摘要以「历史上下文压缩摘要」
    标注前缀，模型可辨识该段为压缩锚点而非原始消息。

    Args:
        messages: 消息流（Message 对象或 dict 形态混排均可，只读）。
        policy: 压缩策略（触发判定 + 摘要预算）。
        keep_recent: 保留的最近消息条数（触发时；system 消息恒保留）。

    Returns:
        压缩后的消息视图（未触发 = 原列表副本）。
    """
    if not messages:
        return list(messages)
    state = {
        "messages": [
            m if isinstance(m, dict) else m.to_dict() for m in messages
        ]
    }
    if not policy.should_compress(state):
        return list(messages)
    count = len(messages)
    head = 0
    while head < count and message_role(messages[head]) == "system":
        head += 1
    tail_start = max(head, count - max(1, int(keep_recent)))
    # 折叠边界对齐工具轮：不让 tail 以 tool 消息开头（无前置 tool_call 的
    # 悬空 tool 消息），也不把工具轮从中劈断。候选 tail_start 若落在某
    # 工具轮区间内，回退到该轮起点（assistant + tool_calls，连同其 tool
    # 消息一并保留）；若该轮起点已在 head 之前（整轮横跨折叠边界），则
    # 改为跳到该轮尾之后，使悬空 tool 消息归入 middle 折叠段。
    for start, end in _tool_round_spans(messages):
        if start <= tail_start <= end:
            tail_start = start if start >= head else end + 1
            break
    # 兜底：剔除仍可能残留在 tail 开头的孤立 tool 消息（无配对 assistant）
    while tail_start < count and message_role(messages[tail_start]) == "tool":
        tail_start += 1
    if tail_start <= head:
        # 中间无旧消息段可折叠（全部为 system + 保留尾段）——不压缩
        return list(messages)
    middle = messages[head:tail_start]
    digest = archive_digest(middle, max_chars=policy.budget_chars(state))
    summary = user(f"【历史上下文压缩摘要（{len(middle)} 条旧消息）】\n{digest}")
    return [*messages[:head], summary, *messages[tail_start:]]


# ── 域上下文窗口投影（原 components/domain_window，并入机制层）──────────────

# 域窗口保留的工具轮数上限（防上下文膨胀；用户消息不设限全留）
DEFAULT_MAX_TOOL_ROUNDS = 8

# 归档摘要总长上限（连续性锚点，供下次进入该域时注入装配）
DEFAULT_DIGEST_MAX_CHARS = 800

# 摘要各成分的截断长度与条数（确定性摘要，无 LLM 调用）
_DIGEST_GOAL_CHARS = 120
_DIGEST_GOAL_COUNT = 3
_DIGEST_BODY_CHARS = 400

# 工具→域归属解析器：工具名 → 域名；返回 None = 公共集工具（所有域共用）
GroupResolver = Callable[[str], str | None]

# 公共集哨兵：group_of 返回 None 表示该工具不属任何单一域，所有域都可见
_SHARED_GROUP = None


def message_text(msg: Any) -> str:
    """消息文本统一取值（Message / dict 双形态；list 型 content 拼接 text 段）。"""
    content = msg.get("content") if isinstance(msg, dict) else getattr(msg, "content", None)
    if isinstance(content, list):
        # list 型 content（多模态/结构化段）按 text 段拼接为可读文本，
        # 避免 str() 产出 Python repr 污染预算/摘要
        parts = [
            str(seg.get("text"))
            for seg in content
            if isinstance(seg, dict) and seg.get("text") is not None
        ]
        return "\n".join(parts)
    return str(content or "")


def _tool_calls_of(msg: Any) -> Sequence[Any]:
    """assistant 消息的工具调用列表（Message / dict 双形态，无则空序列）。"""
    if isinstance(msg, dict):
        return msg.get("tool_calls") or ()
    return getattr(msg, "tool_calls", None) or ()


def _tool_names_of_round(ai_msg: Any, tool_msgs: Sequence[Any]) -> set[str]:
    """一轮工具调用涉及的工具名集合（ToolCall 对象与 dict 双形态兼容）。"""
    names: set[str] = set()
    for call in _tool_calls_of(ai_msg):
        name = call.get("name") if isinstance(call, dict) else getattr(call, "name", None)
        if name:
            names.add(str(name))
    for msg in tool_msgs:
        name = getattr(msg, "name", None)
        if name:
            names.add(str(name))
    return names


def iter_tool_rounds(messages: Sequence[Any]) -> list[tuple[Any, list]]:
    """从末尾向前切分工具轮：``[(带 tool_calls 的 assistant 消息, 该轮 tool 消息), ...]``。

    消息流顺序 = assistant(tool_calls) → tool 消息…，故从后往前扫时 tool
    消息先入缓冲，遇到其所属 assistant 消息时配对成轮；遇用户消息（回合
    边界）停止——工具轮只取最近回合的；完成性回复 assistant 消息（无
    tool_calls）不属任何轮，清空未配对缓冲后继续向前扫（其前可能仍有更早
    的工具轮）。

    Returns:
        按消息流正序排列的工具轮列表。
    """
    rounds: list[tuple[Any, list]] = []
    pending_tool_msgs: list[Any] = []
    for msg in reversed(messages):
        role = message_role(msg)
        if role == "tool":
            pending_tool_msgs.append(msg)
        elif role == "assistant":
            if _tool_calls_of(msg):
                rounds.append((msg, pending_tool_msgs))
            # 完成性回复：其后的未配对缓冲不属任何轮（回复在消息流中位于轮后）
            pending_tool_msgs = []
        elif role == "user":
            break
    return list(reversed(rounds))


def _tool_round_spans(messages: Sequence[Any]) -> list[tuple[int, int]]:
    """每个工具轮的 [起点索引, 终点索引]（assistant(tool_calls) → 末尾 tool）。

    与 :func:`iter_tool_rounds` 同口径（按消息流正序返回区间），供压缩折叠
    边界对齐使用——折叠点若落在某轮区间内会劈断工具轮，产生悬空 tool 消息。
    """
    spans: list[tuple[int, int]] = []
    cur_start: int | None = None
    cur_tools: list[int] = []

    def _close() -> None:
        nonlocal cur_start, cur_tools
        if cur_start is not None and cur_tools:
            spans.append((cur_start, cur_tools[-1]))
        cur_start = None
        cur_tools = []

    for idx, msg in enumerate(messages):
        role = message_role(msg)
        if role == "tool":
            if cur_start is not None:
                cur_tools.append(idx)
        elif role == "assistant":
            # 进入新 assistant：先闭合上一未闭合轮（完成性回复/新轮开始）
            _close()
            if _tool_calls_of(msg):
                cur_start = idx
        elif role == "user":
            _close()  # 回合边界闭合当前轮
    _close()
    return spans


def last_body_message(messages: Sequence[Any]) -> Any | None:
    """最近一条完成性回复（assistant 且无 tool_calls 且文本非空），不跨回合。"""
    for msg in reversed(messages):
        role = message_role(msg)
        if role == "user":
            break
        if role == "assistant" and not _tool_calls_of(msg) and message_text(msg).strip():
            return msg
    return None


def build_domain_window(
    messages: Sequence[Any],
    group: str,
    *,
    group_of: GroupResolver,
    max_tool_rounds: int = DEFAULT_MAX_TOOL_ROUNDS,
) -> list:
    """上下文视图投影：用户消息全留 + 本域最近工具轮 + 最近完成性回复。

    工具轮归属：轮内**任一**工具属于本域（或公共集）则整轮保留——宁多勿少，
    防上下文撕裂（只留半轮会让模型看到无结果的调用或无调用的结果）。

    Args:
        messages: 共享消息流（只读，不修改）。
        group: 当前域名。
        group_of: 工具→域归属解析器（宿主注入）；返回 None = 公共集工具。
        max_tool_rounds: 保留的工具轮数上限，防上下文膨胀。

    Returns:
        投影后的窗口消息列表（用户消息在前，工具轮与回复按原序在后）。
    """
    window = [m for m in messages if message_role(m) == "user"]
    kept: list = []
    for ai_msg, tool_msgs in iter_tool_rounds(messages)[-max_tool_rounds:]:
        names = _tool_names_of_round(ai_msg, tool_msgs)
        if any(group_of(name) in (_SHARED_GROUP, group) for name in names):
            kept.append(ai_msg)
            kept.extend(tool_msgs)
    body = last_body_message(messages)
    if body is not None:
        kept.append(body)
    return window + kept


def archive_digest(
    window: Sequence[Any], *, max_chars: int = DEFAULT_DIGEST_MAX_CHARS
) -> str:
    """确定性窗口归档摘要（无 LLM，避免域切换频繁触发压缩成本）。

    内容 = 最近用户目标 + 最近回复截断 + 工具轮统计，作为下次进入该域时的
    连续性锚点。确定性 = 同一窗口必得同一摘要（可缓存、可断言、零成本）；
    LLM 级语义摘要由上层记忆策略承接，不在此原语内。
    """
    goals = [
        text[:_DIGEST_GOAL_CHARS]
        for m in window
        if message_role(m) == "user" and (text := message_text(m))
    ]
    bodies = [
        text[:_DIGEST_BODY_CHARS]
        for m in window
        if message_role(m) == "assistant"
        and not _tool_calls_of(m)
        and (text := message_text(m))
    ]
    tool_rounds = sum(
        1 for m in window if message_role(m) == "assistant" and _tool_calls_of(m)
    )
    parts: list[str] = []
    if goals:
        parts.append("用户目标：" + "；".join(goals[-_DIGEST_GOAL_COUNT:]))
    if bodies:
        parts.append("最近回复：" + bodies[-1])
    parts.append(f"工具轮数：{tool_rounds}")
    return "\n".join(parts)[:max_chars]


__all__ = [
    "COMPRESSION_CONTEXT_WINDOW_RATIO",
    "COMPRESSION_DEFAULT_CONTEXT_WINDOW",
    "COMPRESSION_DEFAULT_MIN_CHARS",
    "DEFAULT_BUDGET_CHARS",
    "DEFAULT_DIGEST_MAX_CHARS",
    "DEFAULT_MAX_TOOL_ROUNDS",
    "DEFAULT_RELEVANCE",
    "KEEP_FULL_THRESHOLD",
    "MIN_TRUNCATE_CHARS",
    "MODE_DROP",
    "MODE_KEEP_FULL",
    "MODE_TRUNCATE",
    "TOOL_RESULT_MAX_CHARS_FLOOR",
    "TOOL_RESULT_WINDOW_RATIO",
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
    "GroupResolver",
    "SourceAllocation",
    "SourceInclusion",
    "ThresholdCompressionPolicy",
    "WeightedBudgetAllocator",
    "archive_digest",
    "build_domain_window",
    "compress_message_history",
    "iter_tool_rounds",
    "last_body_message",
    "message_text",
    "resolve_compression_min_chars",
    "resolve_tool_result_max_chars",
]
