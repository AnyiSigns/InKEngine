"""状态机原语与 append-only 转换日志单测（D6 通用底座）。

覆盖：
- StateMachine：合法状态判定、终态单向、可选转换白名单、声明期配置校验
- TransitionLog：append-only 累积、当前状态推导、无变化/非法目标不写日志
- 回滚（截断日志重推）、历史回溯、序列化往返
"""

from __future__ import annotations

import pytest

from ink_engine.core.state_machine import (
    INITIAL_STATE,
    StateMachine,
    StateTransition,
    TransitionLog,
)

# 测试用状态机：draft → review → published（终态）/ rejected
_STATES = ("draft", "review", "published", "rejected")


def _machine(**kw) -> StateMachine:
    return StateMachine(_STATES, terminal_states=("published",), name="doc", **kw)


# ---------------------------------------------------------------------------
# StateMachine 规则
# ---------------------------------------------------------------------------


class TestStateMachine:
    def test_valid_state(self):
        m = _machine()
        assert m.is_valid_state("draft")
        assert not m.is_valid_state("bogus")
        # None 是初始前态占位，不是合法状态
        assert not m.is_valid_state(INITIAL_STATE)

    def test_states_and_terminal_exposed(self):
        m = _machine()
        assert m.states == frozenset(_STATES)
        assert m.terminal_states == frozenset({"published"})
        assert m.name == "doc"
        assert m.is_terminal("published")
        assert not m.is_terminal("draft")

    def test_initial_write_allowed_for_any_valid_state(self):
        m = _machine()
        for state in _STATES:
            assert not m.is_illegal_transition(INITIAL_STATE, state)

    def test_invalid_target_is_illegal(self):
        assert _machine().is_illegal_transition("draft", "bogus")

    def test_terminal_state_is_one_way(self):
        m = _machine()
        assert m.is_illegal_transition("published", "draft")
        assert m.is_illegal_transition("published", "review")
        # 非终态之间自由转换（未声明白名单时）
        assert not m.is_illegal_transition("rejected", "review")
        assert not m.is_illegal_transition("draft", "published")

    def test_allowed_whitelist_restricts_transitions(self):
        m = StateMachine(
            _STATES,
            terminal_states=("published",),
            allowed={"draft": ("review",), "review": ("published", "rejected"), "rejected": ("draft",)},
            name="doc_strict",
        )
        assert not m.is_illegal_transition("draft", "review")
        # 白名单外：draft 不能直接发布
        assert m.is_illegal_transition("draft", "published")
        assert not m.is_illegal_transition("review", "published")
        # 初始写入不受白名单约束（只校验目标状态合法性）
        assert not m.is_illegal_transition(INITIAL_STATE, "published")

    def test_whitelist_missing_source_blocks_all(self):
        m = StateMachine(_STATES, allowed={"draft": ("review",)}, name="partial")
        assert m.is_illegal_transition("review", "draft")

    def test_unknown_terminal_state_rejected_at_declaration(self):
        with pytest.raises(ValueError, match="终态"):
            StateMachine(("a", "b"), terminal_states=("c",), name="bad")

    def test_unknown_whitelist_state_rejected_at_declaration(self):
        with pytest.raises(ValueError, match="白名单"):
            StateMachine(("a", "b"), allowed={"a": ("zzz",)}, name="bad")


# ---------------------------------------------------------------------------
# TransitionLog
# ---------------------------------------------------------------------------


class TestTransitionLog:
    def test_current_state_derived_from_log(self):
        log = _machine().log()
        assert log.current_state is INITIAL_STATE
        log.append("draft", actor="user")
        assert log.current_state == "draft"
        log.append("review", actor="user")
        assert log.current_state == "review"
        assert len(log) == 2

    def test_initial_state_seeds_current_state(self):
        log = _machine().log(initial_state="review")
        assert log.current_state == "review"
        entry = log.append("published")
        assert entry is not None
        assert entry.from_state == "review"

    def test_noop_transition_not_logged(self):
        log = _machine().log(initial_state="draft")
        assert log.append("draft") is None
        assert len(log) == 0

    def test_invalid_target_not_logged(self):
        log = _machine().log(initial_state="draft")
        assert log.append("bogus") is None
        assert len(log) == 0
        assert log.current_state == "draft"

    def test_illegal_transition_is_not_blocked_here(self):
        """非法转换的拦截策略由调用方决定，日志原语只保证 append-only。"""
        machine = _machine()
        log = machine.log(initial_state="published")
        assert machine.is_illegal_transition("published", "draft")
        assert log.append("draft") is not None
        assert log.current_state == "draft"

    def test_history_is_ordered_and_copied(self):
        log = _machine().log()
        log.append("draft")
        log.append("review")
        history = log.history()
        assert [e.to_state for e in history] == ["draft", "review"]
        assert [e.from_state for e in history] == [INITIAL_STATE, "draft"]
        # 返回副本：外部追加不影响日志本体
        history.append(StateTransition(to_state="published"))
        assert len(log) == 2

    def test_metadata_recorded(self):
        log = _machine().log()
        entry = log.append("draft", actor="agent", note="写工具创建", meta={"chapter_id": 7}, at=1234.5)
        assert entry is not None
        assert entry.actor == "agent"
        assert entry.note == "写工具创建"
        assert entry.meta == {"chapter_id": 7}
        assert entry.at == 1234.5

    def test_meta_defensively_copied(self):
        log = _machine().log()
        meta = {"k": 1}
        entry = log.append("draft", meta=meta)
        meta["k"] = 999
        assert entry is not None and entry.meta == {"k": 1}

    def test_rollback_truncates_and_rederives_state(self):
        log = _machine().log()
        log.append("draft")
        log.append("review")
        log.append("rejected")
        assert log.rollback() == "review"
        assert len(log) == 2
        assert log.rollback(5) is INITIAL_STATE
        assert len(log) == 0

    def test_rollback_non_positive_is_noop(self):
        log = _machine().log()
        log.append("draft")
        assert log.rollback(0) == "draft"
        assert log.rollback(-3) == "draft"
        assert len(log) == 1

    def test_log_rebuilt_from_entries(self):
        """宿主从存储读出历史转换后重建日志，当前状态可推导。"""
        entries = [
            StateTransition(to_state="draft"),
            StateTransition(to_state="review", from_state="draft"),
        ]
        log = TransitionLog(_machine(), entries=entries)
        assert log.current_state == "review"
        assert len(log) == 2

    def test_machine_exposed(self):
        machine = _machine()
        assert machine.log().machine is machine


# ---------------------------------------------------------------------------
# StateTransition 序列化
# ---------------------------------------------------------------------------


class TestStateTransition:
    def test_dict_round_trip(self):
        entry = StateTransition(
            to_state="review", from_state="draft", actor="agent", note="n", at=100.0, meta={"a": 1}
        )
        restored = StateTransition.from_dict(entry.to_dict())
        assert restored == entry

    def test_from_dict_tolerates_missing_fields(self):
        """字段缺失走默认值（存储 schema 增量演进兼容）。"""
        restored = StateTransition.from_dict({"to_state": "draft"})
        assert restored.to_state == "draft"
        assert restored.from_state is INITIAL_STATE
        assert restored.actor == "system"
        assert restored.note is None
        assert restored.meta == {}
        assert restored.at > 0

    def test_immutable(self):
        entry = StateTransition(to_state="draft")
        with pytest.raises(AttributeError):  # 冻结数据类：赋值即 AttributeError
            entry.to_state = "review"  # type: ignore[misc]
