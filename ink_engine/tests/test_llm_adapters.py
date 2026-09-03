"""Anthropic / Gemini LLM 适配器契约测试（httpx.MockTransport 本地模拟，零真实网络）。

覆盖三类契约用例，每个厂商各覆盖：
- astream 分帧（文本增量 + tool_call 增量累积）；
- tool schema passthrough（请求负载以厂商原生形态携带工具描述）；
- 错误分类（瞬时/确定性对齐 errors.classify_llm_error）；
- 厂商缓存参数（anthropic cache_control / gemini cachedContent 各一行）。
"""
from __future__ import annotations

import json

import httpx
import pytest

from ink_engine.core.llm.anthropic import AnthropicLLM
from ink_engine.core.llm.base import LLMConfig, LLMParams, collect_result
from ink_engine.core.llm.errors import (
    LLMAuthError,
    LLMBadRequestError,
    LLMEmptyStreamError,
    LLMNotFoundError,
    LLMRateLimitError,
    LLMServerError,
)
from ink_engine.core.llm.gemini import GeminiLLM
from ink_engine.core.llm.messages import system, user
from ink_engine.core.llm.registry import adapter_names, create_llm
from ink_engine.core.llm.tools import ToolSpec

JSON_HEADERS = {"content-type": "application/json"}


def sse(obj: dict) -> bytes:
    """构造一条 SSE data 帧（非 ASCII 经 ensure_ascii=False 编码）。"""
    return ("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode("utf-8")


def make_adapter(cls, handler, **config_kw) -> tuple:
    """构造注入 MockTransport 的适配器；seen 记录最后一次请求与调用次数。"""
    seen = {"request": None, "calls": 0}

    def wrapper(request: httpx.Request) -> httpx.Response:
        seen["calls"] += 1
        seen["request"] = request
        return handler(request)

    transport = httpx.MockTransport(wrapper)
    base_config = {
        "adapter": "stub",
        "model_id": "test-model",
        "base_url": config_kw.pop("base_url", "https://example.com/v1"),
        "api_key": "sk-test",
    }
    base_config.update(config_kw)
    config = LLMConfig(**base_config)
    return cls(config, transport=transport), seen


def ok_json(payload: dict) -> httpx.Response:
    return httpx.Response(200, json=payload, headers=JSON_HEADERS)


def stream_response(frames: list[bytes]) -> httpx.Response:
    async def gen():
        for frame in frames:
            yield frame

    return httpx.Response(200, content=gen(), headers=JSON_HEADERS)


def body_of(seen) -> dict:
    return json.loads(seen["request"].content.decode())


WEATHER_TOOL = ToolSpec(
    name="get_weather",
    description="查询天气",
    parameters={"type": "object", "properties": {"city": {"type": "string"}}},
)


# ===========================================================================
# Anthropic
# ===========================================================================
def _anthropic(handler, **kw):
    return make_adapter(
        AnthropicLLM,
        handler,
        base_url="https://api.anthropic.com/v1",
        **kw,
    )


class TestAnthropicAstreamFraming:
    async def test_content_streamed(self):
        frames = [
            sse({"type": "message_start", "message": {"usage": {"input_tokens": 5}}}),
            sse({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "你"}}),
            sse({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "好"}}),
            sse({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 2}}),
            b"data: [DONE]\n\n",
        ]
        llm, _ = _anthropic(lambda r: stream_response(frames))
        result = await collect_result(llm.astream([user("hi")]))
        assert result.content == "你好"
        assert result.finish_reason == "stop"
        assert result.usage == {"prompt_tokens": 5, "completion_tokens": 2}

    async def test_tool_call_deltas_accumulated(self):
        frames = [
            sse({"type": "message_start", "message": {}}),
            sse(
                {
                    "type": "content_block_start",
                    "index": 1,
                    "content_block": {"type": "tool_use", "id": "toolu_1", "name": "get_weather", "input": {}},
                }
            ),
            sse({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": '{"city"'}}),
            sse({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": ':"北京"}'}}),
            sse({"type": "message_delta", "delta": {"stop_reason": "tool_use"}}),
            b"data: [DONE]\n\n",
        ]
        llm, _ = _anthropic(lambda r: stream_response(frames))
        result = await collect_result(llm.astream([user("hi")], tools=[WEATHER_TOOL]))
        assert result.finish_reason == "tool_calls"
        assert result.tool_calls is not None
        assert len(result.tool_calls) == 1
        assert result.tool_calls[0].id == "toolu_1"
        assert result.tool_calls[0].name == "get_weather"
        assert result.tool_calls[0].parsed_arguments == {"city": "北京"}

    async def test_empty_stream_raises(self):
        llm, _ = _anthropic(lambda r: stream_response([b": ping\n\n"]))
        with pytest.raises(LLMEmptyStreamError):
            await collect_result(llm.astream([user("hi")]))


class TestAnthropicToolPassthrough:
    async def test_tools_converted_to_input_schema(self):
        llm, seen = _anthropic(lambda r: ok_json({"content": [{"type": "text", "text": "ok"}]}))
        await llm.ainvoke([user("hi")], tools=[WEATHER_TOOL])
        body = body_of(seen)
        assert body["tools"][0]["name"] == "get_weather"
        assert body["tools"][0]["input_schema"]["properties"]["city"]["type"] == "string"
        # 顶层不应出现 OpenAI 兼容的 function 形态
        assert "function" not in body["tools"][0]

    async def test_system_extracted_to_top_level(self):
        llm, seen = _anthropic(lambda r: ok_json({"content": [{"type": "text", "text": "ok"}]}))
        await llm.ainvoke([system("sys"), user("hi")])
        body = body_of(seen)
        assert body["system"] == "sys"
        assert all(m["role"] != "system" for m in body["messages"])


class TestAnthropicCacheParam:
    async def test_cache_control_appended_when_enabled(self):
        llm, seen = _anthropic(
            lambda r: ok_json({"content": [{"type": "text", "text": "ok"}]}),
            extra={"cache_control": True},
        )
        await llm.ainvoke([system("sys"), user("hi")])
        body = body_of(seen)
        assert isinstance(body["system"], list)
        assert body["system"][0]["cache_control"] == {"type": "ephemeral"}

    async def test_no_cache_control_by_default(self):
        llm, seen = _anthropic(lambda r: ok_json({"content": [{"type": "text", "text": "ok"}]}))
        await llm.ainvoke([system("sys"), user("hi")])
        assert body_of(seen)["system"] == "sys"


class TestAnthropicErrorClassification:
    @pytest.mark.parametrize(
        ("status", "expected"),
        [
            (401, LLMAuthError),
            (403, LLMAuthError),
            (429, LLMRateLimitError),
            (500, LLMServerError),
            (503, LLMServerError),
            (400, LLMBadRequestError),
            (404, LLMNotFoundError),
        ],
    )
    async def test_status_classified(self, status, expected):
        def handler(request):
            return httpx.Response(
                status,
                json={"type": "error", "error": {"type": "x", "message": "上游错误"}},
                headers=JSON_HEADERS,
            )

        llm, _ = _anthropic(handler)
        with pytest.raises(expected):
            await llm.ainvoke([user("hi")])

    async def test_stream_error_event_classified(self):
        frames = [sse({"type": "error", "error": {"type": "rate_limit_error", "message": "限流了"}})]
        llm, _ = _anthropic(lambda r: stream_response(frames))
        with pytest.raises(LLMRateLimitError) as exc_info:
            await collect_result(llm.astream([user("hi")]))
        assert "限流了" in str(exc_info.value)


# ===========================================================================
# Gemini
# ===========================================================================
def _gemini(handler, **kw):
    return make_adapter(
        GeminiLLM,
        handler,
        base_url="https://generativelanguage.googleapis.com/v1beta",
        **kw,
    )


class TestGeminiAstreamFraming:
    async def test_content_streamed(self):
        frames = [
            sse(
                {
                    "candidates": [
                        {
                            "content": {"parts": [{"text": "你"}], "role": "model"},
                            "finishReason": "STOP",
                        }
                    ],
                    "usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 2},
                }
            ),
            b"data: [DONE]\n\n",
        ]
        llm, _ = _gemini(lambda r: stream_response(frames))
        result = await collect_result(llm.astream([user("hi")]))
        assert result.content == "你"
        assert result.finish_reason == "stop"
        assert result.usage == {"prompt_tokens": 5, "completion_tokens": 2}

    async def test_tool_call_parsed(self):
        frames = [
            sse(
                {
                    "candidates": [
                        {
                            "content": {
                                "parts": [
                                    {"functionCall": {"name": "get_weather", "args": {"city": "北京"}}}
                                ],
                                "role": "model",
                            },
                            "finishReason": "STOP",
                        }
                    ]
                }
            ),
            b"data: [DONE]\n\n",
        ]
        llm, _ = _gemini(lambda r: stream_response(frames))
        result = await collect_result(llm.astream([user("hi")], tools=[WEATHER_TOOL]))
        assert result.finish_reason == "stop"
        assert result.tool_calls is not None
        assert result.tool_calls[0].name == "get_weather"
        assert result.tool_calls[0].parsed_arguments == {"city": "北京"}

    async def test_empty_stream_raises(self):
        llm, _ = _gemini(lambda r: stream_response([b": ping\n\n"]))
        with pytest.raises(LLMEmptyStreamError):
            await collect_result(llm.astream([user("hi")]))


class TestGeminiToolPassthrough:
    async def test_tools_converted_to_function_declarations(self):
        llm, seen = _gemini(lambda r: ok_json({"candidates": [{"content": {"parts": [{"text": "ok"}]}}]}))
        await llm.ainvoke([user("hi")], tools=[WEATHER_TOOL])
        body = body_of(seen)
        decls = body["tools"][0]["functionDeclarations"]
        assert decls[0]["name"] == "get_weather"
        assert decls[0]["parameters"]["properties"]["city"]["type"] == "string"

    async def test_system_extracted_to_instruction(self):
        llm, seen = _gemini(lambda r: ok_json({"candidates": [{"content": {"parts": [{"text": "ok"}]}}]}))
        await llm.ainvoke([system("sys"), user("hi")])
        body = body_of(seen)
        assert body["systemInstruction"]["parts"][0]["text"] == "sys"
        assert all(c["role"] != "system" for c in body["contents"])


class TestGeminiCacheParam:
    async def test_cached_content_appended_when_enabled(self):
        llm, seen = _gemini(
            lambda r: ok_json({"candidates": [{"content": {"parts": [{"text": "ok"}]}}]}),
            extra={"cached_content": "cache-abc"},
        )
        await llm.ainvoke([user("hi")])
        assert body_of(seen)["cachedContent"] == "cache-abc"

    async def test_no_cached_content_by_default(self):
        llm, seen = _gemini(lambda r: ok_json({"candidates": [{"content": {"parts": [{"text": "ok"}]}}]}))
        await llm.ainvoke([user("hi")])
        assert "cachedContent" not in body_of(seen)


class TestGeminiErrorClassification:
    @pytest.mark.parametrize(
        ("status", "expected"),
        [
            (401, LLMAuthError),
            (403, LLMAuthError),
            (429, LLMRateLimitError),
            (500, LLMServerError),
            (503, LLMServerError),
            (400, LLMBadRequestError),
            (404, LLMNotFoundError),
        ],
    )
    async def test_status_classified(self, status, expected):
        def handler(request):
            return httpx.Response(
                status,
                json={"error": {"code": status, "message": "上游错误", "status": "x"}},
                headers=JSON_HEADERS,
            )

        llm, _ = _gemini(handler)
        with pytest.raises(expected):
            await llm.ainvoke([user("hi")])

    async def test_stream_error_event_classified(self):
        frames = [sse({"error": {"code": 429, "message": "限流了", "status": "RESOURCE_EXHAUSTED"}})]
        llm, _ = _gemini(lambda r: stream_response(frames))
        with pytest.raises(LLMRateLimitError) as exc_info:
            await collect_result(llm.astream([user("hi")]))
        assert "限流了" in str(exc_info.value)


# ===========================================================================
# 注册表选择
# ===========================================================================
class TestRegistrySelection:
    async def test_adapter_names_includes_both(self):
        names = adapter_names()
        assert "anthropic" in names
        assert "gemini" in names

    async def test_create_llm_selects_anthropic(self):
        llm = create_llm(
            {
                "adapter": "anthropic",
                "model_id": "claude-x",
                "base_url": "https://api.anthropic.com/v1",
                "api_key": "sk",
            }
        )
        assert isinstance(llm, AnthropicLLM)

    async def test_create_llm_selects_gemini(self):
        llm = create_llm(
            {
                "adapter": "gemini",
                "model_id": "gemini-x",
                "base_url": "https://generativelanguage.googleapis.com/v1beta",
                "api_key": "key",
            }
        )
        assert isinstance(llm, GeminiLLM)


class TestAnthropicReasoningEffort:
    async def test_medium_sets_thinking_budget(self):
        llm, seen = _anthropic(lambda r: ok_json({"content": [{"type": "text", "text": "ok"}]}))
        await llm.ainvoke([user("hi")], params=LLMParams(reasoning_effort="medium"))
        body = body_of(seen)
        assert body["thinking"] == {"type": "enabled", "budget_tokens": 8192}
        assert "temperature" not in body
        # 默认 max_tokens=1024 < budget，自动抬升到 budget+1024
        assert body["max_tokens"] > 8192

    async def test_off_omits_thinking_and_keeps_temperature(self):
        llm, seen = _anthropic(
            lambda r: ok_json({"content": [{"type": "text", "text": "ok"}]}),
            temperature=0.3,
        )
        await llm.ainvoke([user("hi")], params=LLMParams(reasoning_effort="off"))
        body = body_of(seen)
        assert "thinking" not in body
        assert body["temperature"] == 0.3


class TestGeminiReasoningEffort:
    async def test_high_sets_thinking_budget(self):
        llm, seen = _gemini(lambda r: ok_json({"candidates": [{"content": {"parts": [{"text": "ok"}]}}]}))
        await llm.ainvoke([user("hi")], params=LLMParams(reasoning_effort="high"))
        body = body_of(seen)
        assert body["generationConfig"]["thinkingConfig"] == {"thinkingBudget": 16384}

    async def test_off_sets_zero_budget(self):
        llm, seen = _gemini(lambda r: ok_json({"candidates": [{"content": {"parts": [{"text": "ok"}]}}]}))
        await llm.ainvoke([user("hi")], params=LLMParams(reasoning_effort="off"))
        body = body_of(seen)
        assert body["generationConfig"]["thinkingConfig"] == {"thinkingBudget": 0}
