"""域上下文窗口投影原语单测（D4 域上下文管理）。

覆盖：
- 用户消息全留（跨回合），异域工具轮整轮剔除，公共集工具轮保留
- 轮内任一工具属本域即整轮保留（防上下文撕裂）
- 工具轮数上限截断；最近完成性正文保留
- 工具轮切分边界：用户消息停止、完成性正文清空未配对缓冲
- 工具名提取双形态（dict / ToolCall 对象）
- 归档摘要确定性、成分组装与总长截断
"""

from __future__ import annotations

from ink_engine.core.domain_window import (
    DEFAULT_MAX_TOOL_ROUNDS,
    archive_digest,
    build_domain_window,
    iter_tool_rounds,
    last_body_message,
    message_text,
)
from ink_engine.core.llm.messages import ToolCall, assistant, tool_result, user

# 测试用工具→域归属表：write/query 各自成域，shared_lookup 为公共集（None）
_TOOL_GROUPS: dict[str, str | None] = {
    "write_body": "write",
    "polish_text": "text",
    "shared_lookup": None,
}


def _group_of(tool_name: str) -> str | None:
    """宿主侧组归属解析器替身（未登记工具视为公共集）。"""
    return _TOOL_GROUPS.get(tool_name)


def _ai_call(text: str, *names: str) -> object:
    """带 tool_calls 的 assistant 消息（dict 形态调用，对齐宿主注入形态）。"""
    msg = assistant(text)
    msg.tool_calls = [{"name": n, "args": {}, "id": f"c-{n}"} for n in names]
    return msg


def _tool_msg(name: str) -> object:
    return tool_result('{"ok": true}', f"c-{name}")


# ---------------------------------------------------------------------------
# 窗口投影
# ---------------------------------------------------------------------------


def test_keeps_all_user_messages_across_rounds():
    """用户消息全留（跨回合意图连续性），工具轮只取最近回合。"""
    messages = [
        user("第一句"),
        _ai_call("完成正文", "write_body"),
        _tool_msg("write_body"),
        user("第二句"),
        _ai_call("查设定", "shared_lookup"),
        _tool_msg("shared_lookup"),
        assistant("写正文完成"),
    ]
    window = build_domain_window(messages, "write", group_of=_group_of)
    users = [m for m in window if getattr(m, "role", None) == "user"]
    assert [m.content for m in users] == ["第一句", "第二句"]
    # 跨回合的 write 轮不再保留（工具轮扫描遇用户消息即止）
    names = [tc["name"] for m in window if getattr(m, "tool_calls", None) for tc in m.tool_calls]
    assert names == ["shared_lookup"]
    assert window[-1].content == "写正文完成"


def test_drops_other_domain_tool_rounds():
    """异域工具轮整轮剔除（含其 assistant 消息），本域/公共集保留。"""
    messages = [
        user("润色并写正文"),
        _ai_call("先润色", "polish_text"),  # 异域
        _tool_msg("polish_text"),
        _ai_call("写正文", "write_body"),  # 本域
        _tool_msg("write_body"),
        _ai_call("查设定", "shared_lookup"),  # 公共集
        _tool_msg("shared_lookup"),
    ]
    window = build_domain_window(messages, "write", group_of=_group_of)
    names = [tc["name"] for m in window if getattr(m, "tool_calls", None) for tc in m.tool_calls]
    assert names == ["write_body", "shared_lookup"]
    kept_ai = [
        m.content
        for m in window
        if getattr(m, "role", None) == "assistant" and getattr(m, "tool_calls", None)
    ]
    assert kept_ai == ["写正文", "查设定"]


def test_mixed_round_kept_whole():
    """轮内任一工具属本域 → 整轮保留（宁多勿少，防半轮上下文撕裂）。"""
    messages = [
        user("混合轮"),
        _ai_call("同轮两工具", "polish_text", "write_body"),
        _tool_msg("polish_text"),
        _tool_msg("write_body"),
    ]
    window = build_domain_window(messages, "write", group_of=_group_of)
    # assistant + 两条 tool 消息全保留
    assert len(window) == 1 + 3


def test_pure_other_domain_round_dropped_entirely():
    messages = [
        user("只润色"),
        _ai_call("润色", "polish_text"),
        _tool_msg("polish_text"),
    ]
    window = build_domain_window(messages, "write", group_of=_group_of)
    assert [m.content for m in window] == ["只润色"]


def test_caps_tool_rounds():
    """工具轮数上限（防上下文膨胀），用户消息不设限。"""
    messages = [user("开始")]
    for i in range(20):
        messages.append(_ai_call(f"轮{i}", "shared_lookup"))
        messages.append(_tool_msg("shared_lookup"))
    window = build_domain_window(messages, "query", group_of=_group_of)
    rounds = sum(1 for m in window if getattr(m, "tool_calls", None))
    assert rounds == DEFAULT_MAX_TOOL_ROUNDS


def test_max_tool_rounds_override():
    messages = [user("开始")]
    for i in range(5):
        messages.append(_ai_call(f"轮{i}", "shared_lookup"))
        messages.append(_tool_msg("shared_lookup"))
    window = build_domain_window(messages, "query", group_of=_group_of, max_tool_rounds=2)
    assert sum(1 for m in window if getattr(m, "tool_calls", None)) == 2


def test_tool_call_object_form_name_extraction():
    """ToolCall 对象形态（流式累积产出）同样能解析工具名。"""
    msg = assistant("对象形态")
    msg.tool_calls = [ToolCall(id="c1", name="write_body", arguments="{}")]
    window = build_domain_window([user("x"), msg, tool_result("{}", "c1")], "write", group_of=_group_of)
    assert msg in window


def test_unknown_tool_treated_as_shared():
    """未登记工具（group_of 返回 None）按公共集处理，所有域可见。"""
    messages = [user("x"), _ai_call("未知工具", "brand_new_tool"), _tool_msg("brand_new_tool")]
    window = build_domain_window(messages, "write", group_of=_group_of)
    assert sum(1 for m in window if getattr(m, "tool_calls", None)) == 1


def test_empty_messages_and_no_tool_rounds():
    assert build_domain_window([], "write", group_of=_group_of) == []
    window = build_domain_window([user("只有用户消息")], "write", group_of=_group_of)
    assert len(window) == 1
    assert window[0].content == "只有用户消息"


# ---------------------------------------------------------------------------
# 工具轮切分
# ---------------------------------------------------------------------------


def test_iter_tool_rounds_pairs_in_order():
    messages = [
        user("开始"),
        _ai_call("轮一", "shared_lookup"),
        _tool_msg("shared_lookup"),
        _ai_call("轮二", "write_body"),
        _tool_msg("write_body"),
    ]
    rounds = iter_tool_rounds(messages)
    assert [ai.content for ai, _ in rounds] == ["轮一", "轮二"]
    assert all(len(tmsgs) == 1 for _, tmsgs in rounds)


def test_iter_tool_rounds_stops_at_user_boundary():
    messages = [
        _ai_call("上一回合轮", "write_body"),
        _tool_msg("write_body"),
        user("新回合"),
        _ai_call("本回合轮", "write_body"),
        _tool_msg("write_body"),
    ]
    rounds = iter_tool_rounds(messages)
    assert [ai.content for ai, _ in rounds] == ["本回合轮"]


def test_body_message_clears_unpaired_tool_buffer():
    """完成性正文位于工具轮之后：其后的 tool 消息不得错配给更早的轮。"""
    messages = [
        user("开始"),
        _ai_call("有调用的轮", "write_body"),
        _tool_msg("write_body"),
        assistant("完成性正文"),
    ]
    rounds = iter_tool_rounds(messages)
    assert len(rounds) == 1
    assert len(rounds[0][1]) == 1


def test_last_body_message_not_crossing_user_boundary():
    messages = [assistant("上一回合正文"), user("新回合"), _ai_call("调用", "write_body")]
    assert last_body_message(messages) is None


def test_last_body_message_skips_blank_content():
    messages = [user("x"), assistant("   "), assistant("有内容")]
    body = last_body_message(messages)
    assert body is not None and body.content == "有内容"


def test_message_text_dual_form():
    assert message_text(user("文本")) == "文本"
    assert message_text({"content": "字典文本"}) == "字典文本"
    assert message_text({}) == ""
    assert message_text(assistant()) == ""


# ---------------------------------------------------------------------------
# 归档摘要
# ---------------------------------------------------------------------------


def test_archive_digest_deterministic_and_composed():
    """摘要 = 用户目标 + 最近正文 + 工具轮数（确定性，无 LLM）。"""
    window = [
        user("帮我设计几个角色"),
        _ai_call("创建角色", "write_body"),
        _tool_msg("write_body"),
        assistant("已完成角色创建，共 3 名角色。"),
    ]
    digest = archive_digest(window)
    assert "帮我设计几个角色" in digest
    assert "已完成角色创建" in digest
    assert "工具轮数：1" in digest
    assert archive_digest(window) == digest


def test_archive_digest_keeps_last_goals_only():
    """用户目标只取最近 3 条（预算内保留最相关意图）。"""
    window = [user(f"目标{i}") for i in range(5)]
    digest = archive_digest(window)
    assert "目标0" not in digest
    assert "目标2" in digest and "目标4" in digest


def test_archive_digest_without_users_or_bodies():
    """无用户消息/正文时仍产出工具轮数（摘要永不为空，保证锚点存在）。"""
    digest = archive_digest([_ai_call("调用", "write_body"), _tool_msg("write_body")])
    assert digest == "工具轮数：1"


def test_archive_digest_truncated_to_max_chars():
    window = [user("很长的目标" * 200), assistant("很长的正文" * 200)]
    assert len(archive_digest(window, max_chars=100)) == 100


def test_archive_digest_empty_window():
    assert archive_digest([]) == "工具轮数：0"
