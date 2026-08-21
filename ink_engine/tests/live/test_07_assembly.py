"""族 7：调配（test_07_assembly.py）｜assembly/context。

- assembly 多源（上下文+知识+工具+记忆+证据）真实调配 + 激活留痕
- context mixer：确定性组装（预算/去重/截断/留痕）+ 融合钩子（真实 LLM）
  成功与失败回退
- 域窗口投影/归档摘要；压缩策略（阈值触发）；预算裁剪（大输入放不下）

`real` 标记 = 真实 LLM 调用（族门禁②）；其余为确定性机制用例。
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.live

from ink_engine.core.assembly import (  # noqa: E402
    SOURCE_CONTEXT,
    SOURCE_EVIDENCE,
    SOURCE_KNOWLEDGE,
    SOURCE_MEMORY,
    SOURCE_TOOL,
    AssemblyConfig,
    InputAssembler,
)
from ink_engine.core.context import (  # noqa: E402
    ContextAssembler,
    ContextMixer,
    ContextSource,
    WeightedBudgetAllocator,
)
from ink_engine.core.llm.messages import user  # noqa: E402


def _sources() -> list[ContextSource]:
    return [
        ContextSource(type=SOURCE_CONTEXT, content="用户：请帮我规划一次旅行", title="对话", weight=1.0, relevance=1.0),
        ContextSource(type=SOURCE_KNOWLEDGE, content="知识：目的地最佳旅行季节是秋季", title="目的地知识", weight=0.9, relevance=0.9),
        ContextSource(type=SOURCE_TOOL, content="工具：get_weather(city)", title="天气工具", weight=0.7, relevance=0.8),
        ContextSource(type=SOURCE_MEMORY, content="记忆：用户偏好自由行", title="偏好", weight=0.6, relevance=0.6),
        ContextSource(type=SOURCE_EVIDENCE, content="证据：检索命中条目 #3", title="检索证据", weight=0.8, relevance=0.85),
    ]


def test_assembly_multi_source_and_activation_trace():
    assembler = InputAssembler(AssemblyConfig(enabled=True, total_budget=8000))
    result = assembler.assemble(_sources())
    assert "用户：请帮我规划一次旅行" in result.text
    assert "最佳旅行季节" in result.text
    assert "get_weather" in result.text
    # 激活留痕：五类源全部入录（模型可见皆记录）
    activated = {s.source_type for s in result.record.sources}
    assert {SOURCE_CONTEXT, SOURCE_KNOWLEDGE, SOURCE_TOOL, SOURCE_MEMORY, SOURCE_EVIDENCE} <= activated


def test_assembly_budget_trimming():
    big = ContextSource(type=SOURCE_CONTEXT, content="X" * 5000, title="大输入")
    assembler = InputAssembler(AssemblyConfig(enabled=True, total_budget=1000))
    result = assembler.assemble([big])
    assert len(result.text) <= 1000  # 预算硬上界
    assert result.text


async def test_context_mixer_deterministic():
    mixer = ContextMixer(assembler=ContextAssembler(default_budget_chars=4000))
    result = await mixer.mix(_sources())
    assert result.text
    assert len(result.text) <= 4000
    assert result.fused is False  # 无融合钩子 = 确定性组装
    # 去重：同 dedup_key 源只留一份
    dup = [*_sources(),
        ContextSource(type=SOURCE_CONTEXT, content="重复内容", dedup_key="dedup-1"),
        ContextSource(type=SOURCE_CONTEXT, content="重复内容", dedup_key="dedup-1"),
    ]
    mixed = await mixer.mix(dup)
    assert mixed.text.count("重复内容") <= 1
    # 超预算源：按分配分数截断/丢弃（预算裁剪语义）
    tiny = ContextMixer(assembler=ContextAssembler(default_budget_chars=200))
    squeezed = await tiny.mix([ContextSource(type=SOURCE_CONTEXT, content="Y" * 1000, title="长文")])
    assert len(squeezed.text) <= 200


@pytest.mark.real
async def test_context_mixer_fusion_hook_real(live_llm):
    """融合钩子（真实 LLM，FusionHook.fuse 协议）：融合成功 → fused=True；
    失败 → 回退确定性组装。"""
    from ink_engine.core.context import FusionHook

    class RealFusionHook(FusionHook):
        async def fuse(self, sources, *, instruction: str = "", budget_chars: int = 4000) -> str:
            joined = "；".join(s.content for s in sources)[:500]
            result = await live_llm.ainvoke(
                [user(f"请把以下内容压缩成一句话：{joined}")]
            )
            return result.content

    mixer = ContextMixer(assembler=ContextAssembler(default_budget_chars=4000))
    mixer.attach_fusion(RealFusionHook(), instruction="压缩成一句话")
    fused = await mixer.mix(_sources())
    assert fused.fused is True
    assert fused.text.strip(), "融合钩子未产出内容"

    class BrokenHook(FusionHook):
        async def fuse(self, sources, *, instruction: str = "", budget_chars: int = 4000) -> str:
            raise RuntimeError("融合失败")

    mixer2 = ContextMixer(assembler=ContextAssembler(default_budget_chars=4000))
    mixer2.attach_fusion(BrokenHook())
    fallback = await mixer2.mix(_sources())
    assert fallback.fused is False  # 失败回退确定性组装（不阻断）
    assert fallback.text  # 回退产物完整


def test_weighted_budget_allocator():
    allocator = WeightedBudgetAllocator()
    sources = _sources()
    allocations = allocator.allocate(sources, 8000)
    total = sum(a.char_limit for a in allocations)
    assert total <= 8000
    # 高相关源优先保留（≥0.8 全保留语义在预算充足时成立）
    assert allocations[0].source.type == SOURCE_CONTEXT


# 域窗口投影/归档摘要（族 7 范围：context 模块内建原语）
def test_domain_window_projection_archive():
    from ink_engine.core.context import archive_digest, build_domain_window
    from ink_engine.core.llm.messages import assistant, tool_result, user

    messages = [
        user("帮我写正文"),
        assistant("完成正文", tool_calls=None),
        tool_result('{"ok": true}', "c-1"),
    ]
    window = build_domain_window(messages, "write", group_of=lambda name: "write")
    assert window  # 域窗口投影保留
    digest = archive_digest(window)
    assert isinstance(digest, str) and digest  # 归档摘要可落库
