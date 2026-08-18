"""InkEngine demo：上下文调配器（Context Mixer）——多源加权融合。

演示引擎核心能力：ContextSource 源元数据模型 + 确定性预算分配 +
加权组装 + 融合钩子（LLM 调酒师，失败自动回退确定性组装）。

可独立运行，仅依赖引擎包（零宿主依赖、零 LLM 调用——融合钩子示例为
纯函数桩，演示 fail-open 语义）。
"""
from __future__ import annotations

import asyncio

from ink_engine.core.context import (
    ContextAssembler,
    ContextMixer,
    ContextSource,
    FusionHook,
    WeightedBudgetAllocator,
)


class _StubFusionHook(FusionHook):
    """融合钩子桩：演示「LLM 调酒师」接口形状；返回 None = 拒绝融合。

    真实实现（宿主注册）：给定权重指令融合 N 源为连贯上下文段
    （深度融合/候选语义融合），按需触发、失败返回 None 由引擎回退。
    """

    async def fuse(
        self,
        sources,
        *,
        instruction: str,
        budget_chars: int,
        context: dict | None = None,
    ) -> str | None:
        if not instruction:
            return None  # 无指令 = 不融合，走确定性组装
        parts = "\n".join(f"· {s.content[:40]}" for s in sources if s.content)
        return f"【调酒师融合产物（{instruction}）】\n{parts}"[:budget_chars]


async def _main() -> None:
    # ── 1. 多源上下文：章节/角色卡/记忆/支线（元数据 = 权重/相关度/时效/去重键）──
    sources = [
        ContextSource(
            type="book", content="书名：墨海", priority=10,
            dedup_key="book_title",
        ),
        ContextSource(
            type="chapter", title="最近章节（含摘要与场景）",
            content="第二卷·第3章《夜探》：主角潜入藏书阁｜场景：相遇；发现密信",
            weight=1.0, relevance=0.9, dedup_key="chapters",
        ),
        ContextSource(
            type="character", title="角色卡",
            content="林晚（女主）：冷静果敢\n沈舟（男主）：温润隐忍",
            weight=0.9, relevance=0.7, dedup_key="characters",
        ),
        ContextSource(
            type="memory", title="本作品相关长期记忆",
            content="- [plot] 先抑后扬的节奏\n- [note] 主角忌讳提起旧事",
            weight=0.7, relevance=0.6, ttl=86400, dedup_key="memory",
        ),
        ContextSource(
            type="branch", title="角色模拟支线素材",
            content="- 支线一：林晚深夜独自翻查藏书阁旧档",
            weight=0.6, relevance=0.5, dedup_key="branches",
        ),
        ContextSource(
            type="world", title="世界状态",
            content="- 林晚：位置=藏书阁；健康=轻伤；目标=找密信",
            weight=0.8, relevance=0.6, dedup_key="world_state",
        ),
        # 低相关源：预算紧张时会被丢弃（权重 0.1 × 相关度 0.5 = 0.05 < 门槛 0.15）
        ContextSource(type="trivia", content="陈年旧闻：城门修缮公告……", weight=0.1, relevance=0.5),
    ]

    # ── 2. 确定性组装（默认每回合，零额外 LLM 调用）──
    assembler = ContextAssembler(
        default_budget_chars=600,
        allocator=WeightedBudgetAllocator(),
    )
    result = assembler.assemble(sources)
    print("[1] 确定性组装（预算 600 字符）")
    print(result.text)
    print(f"    纳入 {len(result.included)} 源 / 丢弃 {len(result.dropped)} 源，"
          f"实际 {result.used_chars} 字符")
    for d in result.dropped:
        print(f"    丢弃: [{d.type}] {d.reason}")

    # ── 3. 融合钩子（LLM 调酒师，按需）：有指令 → 融合；失败/拒绝 → 回退 ──
    mixer = ContextMixer(assembler=assembler)
    print("\n[2] 无融合钩子（保持确定性组装）")
    assert (await mixer.mix(sources)).fused is False

    mixer.attach_fusion(_StubFusionHook(), instruction="深度融合为连贯上下文")
    fused = await mixer.mix(sources)
    print(f"[3] 融合钩子启用: fused={fused.fused}")
    print(fused.text[:300])

    print("\n[demo OK] 调配器 确定性组装 / 预算分配 / 融合钩子 / 回退语义 跑通")


if __name__ == "__main__":
    asyncio.run(_main())
