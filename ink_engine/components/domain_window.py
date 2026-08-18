"""域上下文窗口投影原语（域上下文管理）。

多域/多角色 agent 的痛点：所有域共享一条消息流，域切换后 LLM 会看到大量
异域噪音（其它域的工具调用与结果）。域窗口 = 对共享消息流做**投影**，
只给当前域看它该看的部分：

- 用户消息全留（跨回合意图连续性，不设上限）；
- 本域（及公共集）最近若干工具轮保留，异域工具轮整轮剔除；
- 最近一条完成性正文保留（承接上文）；
- 离开该域时窗口归档为确定性摘要，下次进入该域时作为连续性锚点注入。

共享消息流本身不变（对话流/checkpoint/审计/历史渲染零影响），投影只作用
于装配给模型的上下文——「投影」而非「裁剪」是本原语的核心语义。

领域中立：工具→域的归属关系由宿主经 ``group_of`` 注入（引擎不内置任何
业务工具名或域定义），投影与摘要算法本身对多域 agent 通用。
"""
from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

from ink_engine.core.llm.messages import message_role

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
    """消息文本统一取值（Message / dict 双形态）。"""
    if isinstance(msg, dict):
        return str(msg.get("content") or "")
    return str(getattr(msg, "content", None) or "")


def _tool_calls_of(msg: Any) -> Sequence[Any]:
    """assistant 消息的工具调用列表（无则空序列）。"""
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
    边界）停止——工具轮只取最近回合的；完成性正文 assistant 消息（无
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
            # 完成性正文：其后的未配对缓冲不属任何轮（正文在消息流中位于轮后）
            pending_tool_msgs = []
        elif role == "user":
            break
    return list(reversed(rounds))


def last_body_message(messages: Sequence[Any]) -> Any | None:
    """最近一条完成性正文（assistant 且无 tool_calls 且文本非空），不跨回合。"""
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
    """上下文视图投影：用户消息全留 + 本域最近工具轮 + 最近完成性正文。

    工具轮归属：轮内**任一**工具属于本域（或公共集）则整轮保留——宁多勿少，
    防上下文撕裂（只留半轮会让模型看到无结果的调用或无调用的结果）。

    Args:
        messages: 共享消息流（只读，不修改）。
        group: 当前域名。
        group_of: 工具→域归属解析器（宿主注入）；返回 None = 公共集工具。
        max_tool_rounds: 保留的工具轮数上限，防上下文膨胀。

    Returns:
        投影后的窗口消息列表（用户消息在前，工具轮与正文按原序在后）。
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

    内容 = 最近用户目标 + 最近正文截断 + 工具轮统计，作为下次进入该域时的
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
        parts.append("最近正文：" + bodies[-1])
    parts.append(f"工具轮数：{tool_rounds}")
    return "\n".join(parts)[:max_chars]


__all__ = [
    "DEFAULT_DIGEST_MAX_CHARS",
    "DEFAULT_MAX_TOOL_ROUNDS",
    "GroupResolver",
    "archive_digest",
    "build_domain_window",
    "iter_tool_rounds",
    "last_body_message",
    "message_text",
]
