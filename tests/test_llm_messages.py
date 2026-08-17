"""消息数据类与工具调用增量累积单测。"""
from __future__ import annotations

import pytest

from ink_engine.core.llm.base import ToolCallDelta
from ink_engine.core.llm.errors import (
    LLMAuthError,
    LLMConfigError,
    LLMError,
    LLMRateLimitError,
    LLMTimeoutError,
    classify_llm_error,
)
from ink_engine.core.llm.messages import (
    Message,
    ToolCall,
    accumulate_tool_calls,
    assistant,
    system,
    tool_result,
    user,
)


class TestMessage:
    def test_roles_round_trip(self):
        assert system("s").to_openai_dict() == {"role": "system", "content": "s"}
        assert user("u").to_openai_dict() == {"role": "user", "content": "u"}
        assert assistant("a").to_openai_dict() == {"role": "assistant", "content": "a"}
        assert tool_result("r", "call_1").to_openai_dict() == {
            "role": "tool",
            "content": "r",
            "tool_call_id": "call_1",
        }

    def test_assistant_with_tool_calls(self):
        msg = assistant(
            "",
            tool_calls=[ToolCall(id="call_1", name="get_weather", arguments='{"city": "北京"}')],
        )
        assert msg.to_openai_dict() == {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "get_weather", "arguments": '{"city": "北京"}'},
                }
            ],
        }

    def test_invalid_role_rejected(self):
        with pytest.raises(LLMConfigError):
            Message(role="robot", content="x")

    def test_tool_message_requires_tool_call_id(self):
        with pytest.raises(LLMConfigError):
            Message(role="tool", content="x")

    def test_to_dict_from_dict_round_trip(self):
        msg = assistant(
            "答",
            tool_calls=[ToolCall(id="c1", name="lookup", arguments='{"a":1}')],
            reasoning="想",
        )
        restored = Message.from_dict(msg.to_dict())
        assert restored == msg
        assert restored.to_openai_dict() == msg.to_openai_dict()


class TestToolCall:
    def test_parsed_arguments_ok(self):
        tc = ToolCall(id="c1", name="n", arguments='{"a": 1}')
        assert tc.parsed_arguments == {"a": 1}

    def test_parsed_arguments_tolerant(self):
        assert ToolCall(id="c1", name="n", arguments="").parsed_arguments == {}
        assert ToolCall(id="c1", name="n", arguments="{bad json").parsed_arguments == {}
        assert ToolCall(id="c1", name="n", arguments='"str"').parsed_arguments == {}


class TestAccumulateToolCalls:
    def test_merge_by_index(self):
        deltas = [
            ToolCallDelta(index=0, id="call_1", name="get_weather", arguments_delta='{"c'),
            ToolCallDelta(index=1, id="call_2", name="get_time", arguments_delta="{}"),
            ToolCallDelta(index=0, arguments_delta='ity": "北京"}'),
        ]
        calls = accumulate_tool_calls(deltas)
        assert len(calls) == 2
        assert calls[0].id == "call_1"
        assert calls[0].name == "get_weather"
        assert calls[0].arguments == '{"city": "北京"}'
        assert calls[1].id == "call_2"
        assert calls[1].arguments == "{}"

    def test_out_of_order_index_keeps_first_seen_order(self):
        deltas = [
            ToolCallDelta(index=1, id="b"),
            ToolCallDelta(index=0, id="a"),
        ]
        calls = accumulate_tool_calls(deltas)
        assert [c.id for c in calls] == ["b", "a"]

    def test_empty(self):
        assert accumulate_tool_calls([]) == []


class TestLLMErrorSanitization:
    """上游错误正文规范化（对象级不变量）：控制字符剥离 → 截断 → 遮蔽。"""

    def test_detail_redacted_in_message_and_detail(self):
        exc = LLMAuthError(detail="Incorrect API key provided: sk-abcdef1234567890xyz")
        assert "sk-abcdef1234567890xyz" not in str(exc)
        assert "sk-abcdef1234567890xyz" not in (exc.detail or "")
        assert "[REDACTED]" in (exc.detail or "")

    def test_control_chars_stripped(self):
        exc = LLMError(detail="line1\r\nline2\x1b[31mANSI\x07")
        assert "\r" not in (exc.detail or "")
        assert "\n" not in (exc.detail or "")
        assert "\x1b" not in (exc.detail or "")
        assert "\x07" not in (exc.detail or "")

    def test_detail_truncated(self):
        exc = LLMError(detail="x" * 500)
        assert exc.detail is not None
        assert len(exc.detail) <= 200

    def test_default_message_when_empty(self):
        assert "超时" in str(LLMTimeoutError())

    def test_status_code_written_to_instance(self):
        assert classify_llm_error(429).status_code == 429
        assert classify_llm_error(401).status_code == 401
        assert classify_llm_error(503).status_code == 503
        assert LLMRateLimitError().status_code == 429  # 类属性兜底

    def test_classify_408_timeout(self):
        exc = classify_llm_error(408)
        assert isinstance(exc, LLMTimeoutError)
        assert exc.status_code == 408

    def test_keyword_fallback_classification(self):
        from ink_engine.core.llm.errors import LLMServerError

        exc = classify_llm_error(detail="服务繁忙，请稍后重试")
        assert isinstance(exc, LLMServerError)
        assert isinstance(exc, LLMError)
