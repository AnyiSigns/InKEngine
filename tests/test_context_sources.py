"""novel_harness/context_sources.py 测试：叙事源构建器（纯数据 → 源）。"""
from __future__ import annotations

from ink_engine.core.context import ContextSource
from ink_engine.core.memory import MemoryEntry
from ink_engine.novel_harness.context_sources import (
    SOURCE_BOOK,
    SOURCE_BRANCH,
    SOURCE_CHAPTER,
    SOURCE_CHARACTER,
    SOURCE_FEEDBACK,
    SOURCE_MEMORY,
    SOURCE_STYLE,
    SOURCE_WORLD,
    STYLE_KIND,
    ChapterSummary,
    CharacterCard,
    FeedbackItem,
    SimBranchInfo,
    body_source,
    book_title_source,
    branch_source,
    chapter_summary_source,
    character_source,
    feedback_source,
    memory_source,
    style_source,
    world_state_source,
)
from ink_engine.novel_harness.world_state import CharacterState, WorldState


def _mem(content: str, kind: str = "note") -> MemoryEntry:
    return MemoryEntry(namespace="book:1", kind=kind, content=content)


def test_book_title_source():
    src = book_title_source("墨海")
    assert isinstance(src, ContextSource)
    assert src.type == SOURCE_BOOK
    assert src.content == "书名：墨海"
    assert src.priority == 10
    assert src.dedup_key == "book_title"


def test_chapter_summary_source_formatting():
    src = chapter_summary_source(
        [
            ChapterSummary(
                chapter_no=3,
                title="夜探",
                summary="主角潜入藏书阁",
                vol_label="二",
                events=("相遇", "发现密信"),
            ),
            ChapterSummary(chapter_no=2, title="前情", summary=""),
        ]
    )
    assert src.type == SOURCE_CHAPTER
    assert src.dedup_key == "chapters"
    assert src.title == "最近章节（含摘要与场景）"
    assert "第二卷·第3章《夜探》：主角潜入藏书阁｜场景：相遇；发现密信" in src.content
    assert "第2章《前情》（无摘要）" in src.content


def test_chapter_summary_truncates_long_fields():
    src = chapter_summary_source(
        [ChapterSummary(chapter_no=1, title="T", summary="长" * 500, events=("短",))]
    )
    # 单行摘要截断 200 + 场景截断 200
    assert "长" * 200 in src.content
    assert "长" * 201 not in src.content


def test_character_source():
    src = character_source(
        [
            CharacterCard(name="林晚", role_type="女主", description="冷静果敢"),
            CharacterCard(name="无描述", role_type="", description=""),
        ]
    )
    assert src.type == SOURCE_CHARACTER
    assert "林晚（女主）：冷静果敢" in src.content
    assert "无描述" in src.content


def test_character_description_truncated():
    src = character_source([CharacterCard(name="X", role_type="", description="长" * 300)])
    assert "长" * 120 in src.content


def test_body_source():
    src = body_source("夜探", "正文" * 5000)
    assert src.type == "body"
    assert src.dedup_key == "latest_body"
    assert src.title == "最近章节《夜探》正文开头"
    assert len(src.content) == 800


def test_branch_source_skips_empty():
    src = branch_source(
        [
            SimBranchInfo(title="支线一", content="内容" * 10),
            SimBranchInfo(title="空支线", content=""),
        ]
    )
    assert src.type == SOURCE_BRANCH
    assert "- 支线一：" in src.content
    assert "空支线" not in src.content


def test_memory_source():
    src = memory_source([_mem("先抑后扬", kind="plot"), _mem("")])
    assert src.type == SOURCE_MEMORY
    assert "- [plot] 先抑后扬" in src.content
    assert src.dedup_key == "memory"
    assert "严禁原样转述" in src.title


def test_style_source():
    src = style_source([_mem("禁用烂尾桥段", kind=STYLE_KIND)])
    assert src.type == SOURCE_STYLE
    assert "- [style] 禁用烂尾桥段" in src.content
    assert src.dedup_key == "style"


def test_memory_style_kind_partition():
    """kind 分流：style 条目只进 style 源，普通条目只进 memory 源（防双源重复注入）。"""
    style_entry = _mem("禁用烂尾桥段", kind=STYLE_KIND)
    plot_entry = _mem("先抑后扬", kind="plot")
    mem = memory_source([style_entry, plot_entry])
    assert "先抑后扬" in mem.content
    assert "禁用烂尾桥段" not in mem.content
    st = style_source([style_entry, plot_entry])
    assert "禁用烂尾桥段" in st.content
    assert "先抑后扬" not in st.content


def test_feedback_source():
    src = feedback_source(
        [FeedbackItem(content="节奏稍慢", chapter_id=5), FeedbackItem(content="无章") ]
    )
    assert src.type == SOURCE_FEEDBACK
    assert "- 节奏稍慢（第5章）" in src.content
    assert "- 无章" in src.content


def test_world_state_source_empty():
    src = world_state_source(WorldState())
    assert src.type == SOURCE_WORLD
    assert "暂无关键变更" in src.content


def test_world_state_source_renders_components():
    from ink_engine.novel_harness.world_state import ForeshadowingNode

    world = WorldState()
    world.set_character(
        CharacterState(
            character_id="1", name="林晚", location="藏书阁",
            health="轻伤", goals=("找密信",),
        ),
        at_chapter=3,
    )
    world.set_character(CharacterState(character_id="2", name="路人"), at_chapter=1)
    world.foreshadowings["f1"] = ForeshadowingNode(
        foreshadowing_id="f1", description="密信", status="set", planted_at_chapter=1
    )
    src = world_state_source(world)
    assert "林晚" in src.content
    assert "位置=藏书阁" in src.content
    assert "健康=轻伤" in src.content
    assert "伏笔" in src.content and "密信" in src.content


def test_all_sources_valid_metadata():
    sources = [
        book_title_source("B"),
        chapter_summary_source([ChapterSummary(1, "T", "S")]),
        character_source([CharacterCard("N", "D")]),
        body_source("T", "C"),
        branch_source([SimBranchInfo("T", "C")]),
        memory_source([_mem("C")]),
        style_source([_mem("C", kind=STYLE_KIND)]),
        feedback_source([FeedbackItem("C")]),
        world_state_source(WorldState()),
    ]
    for src in sources:
        assert src.weight >= 0
        assert 0 <= src.relevance <= 1
        assert src.content
