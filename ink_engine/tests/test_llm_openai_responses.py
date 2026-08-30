"""OpenAI Responses API 适配器单测（httpx.MockTransport 本地模拟，零真实网络）。

覆盖：非流式/流式解析（内容/工具调用/终态/用量）、请求负载构造
（input 数组消息/工具回环项/tools 形态）、错误分类、空流、注册表
协议全名（openai_responses）与兼容别名（openai_response）。
"""
from __future__ import annotations

import json

import httpx
import pytest

from ink_engine.core.llm.base import LLMConfig, LLMParams
from ink_engine.core.llm.errors import (
    LLMAuthError,
    LLMRateLimitError,
    LLMEmptyStreamError,
)
from ink_engine.core.llm.messages import assistant, system, tool_result, user
from ink_engine.core.llm.openai_response import OpenAIResponsesLLM
from ink_engine.core.llm.tools import ToolSpec

JSON_HEADERS = {"content-type": "application/json"}


def make_adapter(handler, retry=None, **config_kw) -> tuple[OpenAIResponsesLLM, dict]:
    """构造注入 MockTransport 的适配器；seen 记录最后一次请求与调用次数。"""
    seen = {"request": None, "calls": 0}

    def wrapper(request: httpx.Request) -> httpx.Response:
        seen["calls"] += 1
        seen["request"] = request
        return handler(request)

    transport = httpx.MockTransport(wrapper)
    base_config = {
        "adapter": "openai_responses",
        "model_id": "gpt-5",
        "base_url": "https://api.openai.com/v1/",
        "api_key": "sk-test",
    }
    base_config.update(config_kw)
    config = LLMConfig(**base_config)
    return OpenAIResponsesLLM(config, transport=transport, retry=retry), seen


def sse_frame(payload: dict) -> bytes:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode()


def ok_json(payload: dict) -> httpx.Response:
    return httpx.Response(200, json=payload, headers=JSON_HEADERS)


def stream_response(frames: list[bytes]) -> httpx.Response:
    """模拟 SSE 流式响应（async 迭代内容，MockTransport 要求 AsyncByteStream）。"""

    async def gen():
        for frame in frames:
            yield frame

    return httpx.Response(200, content=gen(), headers=JSON_HEADERS)


async def _ainvoke(llm, messages, **kwargs):
    return await llm.ainvoke(messages, **kwargs)


# ---------------------------------------------------------------------------
# 请求负载构造
# ---------------------------------------------------------------------------
class TestRequestPayload:
    @staticmethod
    def _body(seen) -> dict:
        return json.loads(seen["request"].content.decode())

    async def test_payload_shape_and_endpoint(self):
        llm, seen = make_adapter(lambda r: ok_json({"output": [], "finish_reason": "stop"}))
        await _ainvoke(llm, [user("hi")])
        assert seen["request"].url.path.endswith("/responses")
        body = self._body(seen)
        assert body["model"] == "gpt-5"
        assert body["stream"] is False
        assert body["input"] == [{"role": "user", "content": "hi"}]

    async def test_input_items_convert_messages_and_tool_roundtrip(self):
        llm, seen = make_adapter(lambda r: ok_json({"output": [], "finish_reason": "stop"}))
        messages = [
            system("你是助手"),
            user("分析下"),
            assistant(
                "调用工具",
                tool_calls=[{"id": "call_1", "name": "web_search", "arguments": '{"q":"x"}'}],
            ),
            tool_result("结果", tool_call_id="call_1"),
            user("继续"),
        ]
        await _ainvoke(llm, messages)
        items = self._body(seen)["input"]
        assert items[0] == {"role": "system", "content": "你是助手"}
        assert items[1] == {"role": "user", "content": "分析下"}
        assert items[2] == {
            "type": "function_call",
            "call_id": "call_1",
            "name": "web_search",
            "arguments": '{"q":"x"}',
        }
        assert items[3] == {
            "type": "function_call_output",
            "call_id": "call_1",
            "output": "结果",
        }
        assert items[4] == {"role": "user", "content": "继续"}

    async def test_tools_carry_function_type(self):
        llm, seen = make_adapter(lambda r: ok_json({"output": [], "finish_reason": "stop"}))
        spec = ToolSpec(
            name="web_search",
            description="联网检索",
            parameters={
                "type": "object",
                "properties": {"q": {"type": "string"}},
                "required": ["q"],
            },
        )
        await _ainvoke(llm, [user("hi")], tools=[spec])
        tools = self._body(seen)["tools"]
        assert isinstance(tools, list) and len(tools) == 1
        assert tools[0]["type"] == "function"
        assert tools[0]["name"] == "web_search"
        assert tools[0]["description"] == "联网检索"
        assert tools[0]["parameters"]["properties"]["q"]["type"] == "string"

    async def test_user_attachments_become_input_text_parts(self):
        from ink_engine.core.llm.messages import Attachment

        llm, seen = make_adapter(lambda r: ok_json({"output": [], "finish_reason": "stop"}))
        msg = user("看图", attachments=(Attachment(kind="image", url="https://x/i.png"),))
        await _ainvoke(llm, [msg])
        item = self._body(seen)["input"][0]
        assert item["role"] == "user"
        assert item["content"][0] == {"type": "input_text", "text": "看图"}
        assert item["content"][1]["type"] == "image_url"

    async def test_max_output_tokens_and_temperature(self):
        llm, seen = make_adapter(lambda r: ok_json({"output": [], "finish_reason": "stop"}))
        await _ainvoke(llm, [user("hi")], params=LLMParams(max_tokens=100, temperature=0.2))
        body = self._body(seen)
        assert body["max_output_tokens"] == 100
        assert body["temperature"] == 0.2


# ---------------------------------------------------------------------------
# 非流式解析
# ---------------------------------------------------------------------------
class TestAinvokeParse:
    async def test_message_and_function_call_items(self):
        def handler(r: httpx.Request) -> httpx.Response:
            return ok_json(
                {
                    "id": "resp_1",
                    "output": [
                        {"type": "message", "content": [{"type": "output_text", "text": "结论"}]},
                        {
                            "type": "function_call",
                            "call_id": "fc_1",
                            "name": "web_search",
                            "arguments": {"q": "x"},
                        },
                    ],
                    "finish_reason": "function_call",
                    "usage": {"input_tokens": 10, "output_tokens": 20},
                }
            )

        llm, seen = make_adapter(handler)
        result = await _ainvoke(llm, [user("hi")])
        assert result.content == "结论"
        assert result.tool_calls is not None and len(result.tool_calls) == 1
        assert result.tool_calls[0].name == "web_search"
        # 对象形态 arguments 归一为 JSON 字符串
        assert json.loads(result.tool_calls[0].arguments) == {"q": "x"}
        assert result.finish_reason == "function_call"
        assert result.usage["input_tokens"] == 10

    async def test_string_arguments_preserved(self):
        def handler(r: httpx.Request) -> httpx.Response:
            return ok_json(
                {
                    "output": [
                        {
                            "type": "function_call",
                            "call_id": "fc_2",
                            "name": "f",
                            "arguments": '{"a":1}',
                        }
                    ],
                    "finish_reason": "function_call",
                }
            )

        llm, seen = make_adapter(handler)
        result = await _ainvoke(llm, [user("hi")])
        assert result.tool_calls[0].arguments == '{"a":1}'


# ---------------------------------------------------------------------------
# 流式解析
# ---------------------------------------------------------------------------
class TestStreamParse:
    async def test_streaming_deltas_tool_call_and_finish(self):
        frames = [
            sse_frame({"type": "response.output_text.delta", "delta": "你"}),
            sse_frame({"type": "response.output_text.delta", "delta": "好"}),
            sse_frame(
                {
                    "type": "response.output_item.done",
                    "item": {
                        "type": "function_call",
                        "call_id": "fc_s",
                        "name": "web_search",
                        "arguments": {"q": "y"},
                    },
                }
            ),
            sse_frame({"type": "response.completed"}),
            sse_frame({"type": "response.usage", "usage": {"output_tokens": 5}}),
        ]
        llm, seen = make_adapter(lambda r: stream_response(frames))
        chunks = [c async for c in llm.astream([user("hi")])]
        tokens = "".join(c.token for c in chunks if c.token)
        assert tokens == "你好"
        tool_deltas = [c for c in chunks if c.tool_calls_delta]
        assert len(tool_deltas) == 1
        assert tool_deltas[0].tool_calls_delta[0].name == "web_search"
        assert tool_deltas[0].tool_calls_delta[0].id == "fc_s"
        # 终态 finish_reason（completed）与 usage 帧
        finishes = [c.finish_reason for c in chunks if c.finish_reason]
        assert finishes == ["completed"]
        usages = [c.usage for c in chunks if c.usage]
        assert usages and usages[-1]["output_tokens"] == 5

    async def test_empty_stream_raises(self):
        llm, seen = make_adapter(lambda r: stream_response([]))
        with pytest.raises(LLMEmptyStreamError):
            async for _ in llm.astream([user("hi")]):
                pass

    async def test_bad_frames_skipped(self):
        frames = [b"data: not-json\n\n", sse_frame({"type": "response.output_text.delta", "delta": "ok"})]
        llm, seen = make_adapter(lambda r: stream_response(frames))
        chunks = [c async for c in llm.astream([user("hi")])]
        assert "".join(c.token for c in chunks if c.token) == "ok"


# ---------------------------------------------------------------------------
# 错误分类
# ---------------------------------------------------------------------------
class TestErrors:
    async def test_http_401_classified_as_auth(self):
        llm, seen = make_adapter(
            lambda r: httpx.Response(401, json={"error": {"message": "bad key"}})
        )
        with pytest.raises(LLMAuthError):
            await _ainvoke(llm, [user("hi")])

    async def test_http_429_classified_as_rate_limit(self):
        llm, seen = make_adapter(
            lambda r: httpx.Response(429, json={"error": {"message": "rate limited"}})
        )
        with pytest.raises(LLMRateLimitError):
            await _ainvoke(llm, [user("hi")])


# ---------------------------------------------------------------------------
# 注册表：协议全名 + 兼容别名
# ---------------------------------------------------------------------------
class TestRegistry:
    def test_adapter_name_is_full_protocol_name(self):
        assert OpenAIResponsesLLM.adapter == "openai_responses"

    def test_registry_resolves_full_name_and_alias(self):
        from ink_engine.core.llm.registry import create_llm, get_adapter_class

        assert get_adapter_class("openai_responses") is OpenAIResponsesLLM
        # 兼容别名（旧配置零迁移）
        assert get_adapter_class("openai_response") is OpenAIResponsesLLM
        # 协议全名可在配置驱动创建
        llm = create_llm(
            {
                "adapter": "openai_responses",
                "model_id": "gpt-5",
                "base_url": "https://x/v1",
            }
        )
        assert isinstance(llm, OpenAIResponsesLLM)
