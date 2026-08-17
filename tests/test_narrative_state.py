"""叙事状态定义单测（D6 小说语义层）。

覆盖：
- 伏笔/情节线状态枚举与终态声明
- 合法/非法转换判定（与宿主写时预检共用同一规则）
- 实体类型判定、触发方常量
- 转换日志推导当前状态（回溯/回滚场景）
"""

from __future__ import annotations

import pytest

from ink_engine.domain_novel.narrative_state import (
    ACTOR_AGENT,
    ACTOR_PRECHECK,
    ACTOR_SYSTEM,
    ACTOR_USER,
    ENTITY_FORESHADOWING,
    ENTITY_PLOT_THREAD,
    ENTITY_TYPES,
    NARRATIVE_STATE_MACHINE,
    NARRATIVE_STATUSES,
    STATUS_ADVANCING,
    STATUS_RESOLVED,
    STATUS_SET,
    STATUS_STALLED,
    TERMINAL_STATUSES,
    is_entity_type,
    is_illegal_transition,
    is_valid_status,
    new_transition_log,
)


def test_status_enum_and_terminal():
    assert NARRATIVE_STATUSES == (STATUS_SET, STATUS_ADVANCING, STATUS_RESOLVED, STATUS_STALLED)
    assert frozenset({STATUS_RESOLVED}) == TERMINAL_STATUSES
    assert NARRATIVE_STATE_MACHINE.name == "narrative"


def test_is_valid_status():
    for status in NARRATIVE_STATUSES:
        assert is_valid_status(status)
    assert not is_valid_status("bogus")
    assert not is_valid_status(None)
    # 历史英文旧值不是合法枚举（归一化由宿主别名表负责）
    assert not is_valid_status("planted")


@pytest.mark.parametrize(
    "from_status,to_status,illegal",
    [
        (None, "set", False),
        ("set", "advancing", False),
        ("advancing", "resolved", False),
        ("set", "resolved", False),  # 可在推进前直接回收
        ("advancing", "stalled", False),
        ("stalled", "advancing", False),  # 停滞待办修正后可恢复推进
        ("stalled", "resolved", False),
        ("resolved", "set", True),  # 已回收不得回退（伏笔链非法）
        ("resolved", "advancing", True),
        ("resolved", "stalled", True),
        ("set", "invalid", True),  # 非法枚举
        (None, "invalid", True),
    ],
)
def test_is_illegal_transition(from_status, to_status, illegal):
    """与宿主 domains/narrative/state_machine 的判定同源，规则表锁死语义。"""
    assert is_illegal_transition(from_status, to_status) is illegal


def test_entity_types():
    assert ENTITY_TYPES == (ENTITY_FORESHADOWING, ENTITY_PLOT_THREAD)
    assert is_entity_type(ENTITY_FORESHADOWING)
    assert is_entity_type(ENTITY_PLOT_THREAD)
    assert not is_entity_type("character")
    assert not is_entity_type(None)


def test_actor_constants_distinct():
    actors = {ACTOR_AGENT, ACTOR_USER, ACTOR_SYSTEM, ACTOR_PRECHECK}
    assert len(actors) == 4


def test_transition_log_tracks_foreshadowing_lifecycle():
    """埋设 → 推进 → 回收：当前状态由 append-only 日志推导。"""
    log = new_transition_log()
    log.append(STATUS_SET, actor=ACTOR_AGENT, note="写工具创建")
    log.append(STATUS_ADVANCING, actor=ACTOR_AGENT)
    log.append(STATUS_RESOLVED, actor=ACTOR_USER, note="第 23 章揭示")
    assert log.current_state == STATUS_RESOLVED
    assert [e.to_state for e in log.history()] == [
        STATUS_SET,
        STATUS_ADVANCING,
        STATUS_RESOLVED,
    ]
    # 回滚一次即回到推进态（状态回滚 = 日志截断重推）
    assert log.rollback() == STATUS_ADVANCING


def test_transition_log_seeded_with_current_status():
    log = new_transition_log(STATUS_SET)
    assert log.current_state == STATUS_SET
    entry = log.append(STATUS_ADVANCING, actor=ACTOR_AGENT)
    assert entry is not None
    assert entry.from_state == STATUS_SET


def test_transition_log_skips_noop():
    log = new_transition_log(STATUS_ADVANCING)
    assert log.append(STATUS_ADVANCING) is None
    assert len(log) == 0
