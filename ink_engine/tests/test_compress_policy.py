"""压缩策略钩子 + 消息压缩补丁链单测（压缩下沉引擎侧原语）。

语义检查点：触发判定与预算为可注入策略（默认双阈值实现）；消息压缩
= delete 旧段 + insert 摘要的补丁链（删除差集契约由 delete op 吸收，
可回放可压扁，序列化往返保留）。
"""
from __future__ import annotations

import pytest

from ink_engine.core.context import (
    CompressionPolicy,
    ThresholdCompressionPolicy,
    compress_message_history,
)
from ink_engine.core.llm.messages import Message, assistant, system, user
from ink_engine.core.patch_chain import (
    PatchChain,
    PatchOp,
    build_message_compress_patches,
)


def _messages(count: int, chars: int = 10) -> list[dict]:
    return [{"id": f"m{i}", "role": "user" if i % 2 == 0 else "assistant", "content": "x" * chars} for i in range(count)]


# ── 压缩策略钩子 ──


def test_threshold_policy_triggers_on_both_thresholds():
    policy = ThresholdCompressionPolicy(min_messages=5, min_chars=100)
    assert policy.should_compress({"messages": _messages(6, chars=20)})  # 6 条 × 20 字 ≥ 双阈值
    assert not policy.should_compress({"messages": _messages(4, chars=20)})  # 条数不足
    assert not policy.should_compress({"messages": _messages(6, chars=10)})  # 字符量不足
    assert not policy.should_compress({})  # 无消息


def test_threshold_policy_budget():
    policy = ThresholdCompressionPolicy(budget_chars=5000)
    assert policy.budget_chars({}) == 5000


def test_policy_is_protocol_injectable():
    """宿主自定义策略可实现 CompressionPolicy 协议（换策略不改装配）。"""

    class AlwaysCompress:
        def should_compress(self, state: dict) -> bool:
            return True

        def budget_chars(self, state: dict) -> int:
            return 100

    assert isinstance(AlwaysCompress(), CompressionPolicy)
    # 结构兼容：默认实现同样满足协议（宿主可注入任意实现）
    assert isinstance(ThresholdCompressionPolicy(), CompressionPolicy)


def test_threshold_policy_rejects_bad_params():
    with pytest.raises(ValueError):
        ThresholdCompressionPolicy(min_messages=0)
    with pytest.raises(ValueError):
        ThresholdCompressionPolicy(budget_chars=0)


# ── 回合内消息流压缩原语（D5 接线：LLM 消息组装处的压缩视图）──


def _long_messages(n: int, chars: int) -> list[Message]:
    """n 条历史消息（交替 user/assistant，各 chars 字符）+ system 链首。"""
    messages = [system("系统提示")]
    for i in range(n):
        messages.append(user(f"u{i}" + "x" * chars))
        messages.append(assistant("a" + "y" * chars))
    return messages


def test_compress_history_not_triggered_returns_copy():
    policy = ThresholdCompressionPolicy(min_messages=30, min_chars=40000)
    messages = _long_messages(5, chars=10)  # 双阈值均不达
    result = compress_message_history(messages, policy=policy, keep_recent=6)
    assert result == list(messages)
    assert result is not messages  # 副本（非破坏性视图）


def test_compress_history_triggered_summary_replaces_middle():
    policy = ThresholdCompressionPolicy(min_messages=30, min_chars=40000)
    messages = _long_messages(60, chars=700)  # 121 条 × ~700 字 → 触发
    result = compress_message_history(messages, policy=policy, keep_recent=6)
    assert len(result) < len(messages)
    assert result[0] == messages[0]  # system 恒保留
    assert result[0].role == "system"
    summary = result[1]
    assert summary.role == "user"
    assert "历史上下文压缩摘要" in summary.content
    assert "工具轮数" in summary.content  # 摘要含连续性锚点
    assert result[-6:] == messages[-6:]  # 最近 6 条原样保留


def test_compress_history_system_messages_all_kept():
    policy = ThresholdCompressionPolicy(min_messages=5, min_chars=100)
    messages = [system("s1"), system("s2"), *_long_messages(6, chars=30)[1:]]
    result = compress_message_history(messages, policy=policy, keep_recent=3)
    assert [m.content for m in result if m.role == "system"] == ["s1", "s2"]
    assert result[0].role == "system"
    assert result[1].role == "system"


def test_compress_history_middle_only_not_triggered_when_tail_covers_all():
    """中间无可折叠段（system + 尾段即全部）→ 不压缩。"""
    policy = ThresholdCompressionPolicy(min_messages=5, min_chars=100)
    messages = _long_messages(2, chars=100)  # 5 条全部属于保留尾段
    result = compress_message_history(messages, policy=policy, keep_recent=10)
    assert result == list(messages)


def test_compress_history_accepts_dict_messages():
    policy = ThresholdCompressionPolicy(min_messages=5, min_chars=100)
    messages = [
        {"role": "system", "content": "提示"},
        {"role": "user", "content": "u0" + "x" * 30},
        {"role": "assistant", "content": "a" + "y" * 30},
        {"role": "user", "content": "u1" + "x" * 30},
        {"role": "assistant", "content": "a" + "y" * 30},
        {"role": "user", "content": "u2" + "x" * 30},
        {"role": "assistant", "content": "a" + "y" * 30},
    ]
    result = compress_message_history(messages, policy=policy, keep_recent=2)
    assert len(result) < len(messages)
    assert result[0] == messages[0]
    assert result[-2:] == messages[-2:]
    assert "历史上下文压缩摘要" in result[1].content


def test_compress_history_empty_input():
    policy = ThresholdCompressionPolicy(min_messages=5, min_chars=100)
    assert compress_message_history([], policy=policy) == []


# ── 消息压缩补丁链 ──


def test_compress_patches_assemble_summary_first():
    messages = _messages(5)
    chain = build_message_compress_patches(messages, cutoff=3, summary={"id": "summary", "content": "摘要"})
    assembled = chain.assemble()["messages"]
    assert assembled[0] == {"id": "summary", "content": "摘要"}
    assert assembled[1:] == messages[3:]  # 摘要 + 保留段


def test_compress_patches_delete_ops_are_evidence():
    """删除差集契约由 delete op 吸收：逐条 delete 即删除证据（可回放）。"""
    messages = _messages(5)
    chain = build_message_compress_patches(messages, cutoff=3, summary={"id": "s"})
    deletes = [p for p in chain.patches if p.op is PatchOp.DELETE]
    assert len(deletes) == 2  # 摘要替换链首，其后旧段逐条删除
    assert [p.path for p in deletes] == [("messages", 2), ("messages", 1)]


def test_compress_patches_single_cutoff():
    """cutoff=1：仅摘要替换链首，无删除。"""
    messages = _messages(3)
    chain = build_message_compress_patches(messages, cutoff=1, summary={"id": "s"})
    assert len(chain.patches) == 1
    assert chain.assemble()["messages"] == [{"id": "s"}, *messages[1:]]


def test_compress_patches_full_cutoff():
    messages = _messages(3)
    chain = build_message_compress_patches(messages, cutoff=3, summary={"id": "s"})
    assert chain.assemble()["messages"] == [{"id": "s"}]


def test_compress_patches_cutoff_bounds():
    messages = _messages(3)
    with pytest.raises(ValueError):
        build_message_compress_patches(messages, cutoff=0, summary={})
    with pytest.raises(ValueError):
        build_message_compress_patches(messages, cutoff=-1, summary={})
    with pytest.raises(ValueError):
        build_message_compress_patches(messages, cutoff=4, summary={})


def test_compress_patches_rebase_flattens():
    """rebase = 压缩压扁：组装结果作为新 base，链长收敛。"""
    messages = _messages(5)
    chain = build_message_compress_patches(messages, cutoff=3, summary={"id": "s"})
    flattened = chain.rebase()
    assert flattened.patches == []
    assert flattened.assemble()["messages"] == chain.assemble()["messages"]


def test_compress_patches_serialization_roundtrip():
    """序列化往返保留压缩链（checkpoint 落库形态）。"""
    messages = _messages(4)
    chain = build_message_compress_patches(messages, cutoff=2, summary={"id": "s", "content": "摘要"})
    restored = PatchChain.from_dict(chain.to_dict())
    assert restored.assemble()["messages"] == chain.assemble()["messages"]
    assert len([p for p in restored.patches if p.op is PatchOp.DELETE]) == 1
