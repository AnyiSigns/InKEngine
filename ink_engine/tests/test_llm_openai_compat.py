"""OpenAI 兼容适配器单测（httpx.MockTransport 本地模拟，零真实网络）。

覆盖：非流式/流式解析（内容/推理/工具增量）、错误分类、空流、
坏帧容错、请求负载构造（角色/tools/挡位参数）、超时分类。
"""
from __future__ import annotations

import json

import httpx
import pytest

from ink_engine.core.llm.base import LLMConfig, LLMParams, collect_result
from ink_engine.core.llm.errors import (
    LLMAuthError,
    LLMBadRequestError,
    LLMEmptyStreamError,
    LLMError,
    LLMFormatError,
    LLMNotFoundError,
    LLMRateLimitError,
    LLMServerError,
    LLMTimeoutError,
)
from ink_engine.core.llm.messages import system, user
from ink_engine.core.llm.openai_compat import OpenAICompatibleLLM
from ink_engine.core.llm.tools import ToolSpec

JSON_HEADERS = {"content-type": "application/json"}


def make_adapter(handler, **config_kw) -> tuple[OpenAICompatibleLLM, dict]:
    """构造注入 MockTransport 的适配器；seen 记录最后一次请求与调用次数。"""
    seen = {"request": None, "calls": 0}

    def wrapper(request: httpx.Request) -> httpx.Response:
        seen["calls"] += 1
        seen["request"] = request
        return handler(request)

    transport = httpx.MockTransport(wrapper)
    base_config = {
        "adapter": "openai_compat",
        "model_id": "test-model",
        "base_url": "https://example.com/v1/",
        "api_key": "sk-test",
    }
    base_config.update(config_kw)
    config = LLMConfig(**base_config)
    return OpenAICompatibleLLM(config, transport=transport), seen


def sse_frame(payload: dict) -> bytes:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode()


def sse_delta(delta: dict, finish_reason: str | None = None) -> dict:
    choice: dict = {"index": 0, "delta": delta}
    if finish_reason is not None:
        choice["finish_reason"] = finish_reason
    return {"choices": [choice]}


def ok_json(payload: dict) -> httpx.Response:
    return httpx.Response(200, json=payload, headers=JSON_HEADERS)


def stream_response(frames: list[bytes]) -> httpx.Response:
    """模拟 SSE 流式响应（async 迭代内容，MockTransport 要求 AsyncByteStream）。"""

    async def gen():
        for frame in frames:
            yield frame

    return httpx.Response(200, content=gen(), headers=JSON_HEADERS)


# ---------------------------------------------------------------------------
# 请求负载构造
# ---------------------------------------------------------------------------
class TestRequestPayload:
    @staticmethod
    def _body(seen) -> dict:
        return json.loads(seen["request"].content.decode())

    async def test_ainvoke_payload_shape(self):
        def handler(request):
            return ok_json(
                {"choices": [{"message": {"content": "你好"}, "finish_reason": "stop"}]}
            )

        llm, seen = make_adapter(handler)
        await llm.ainvoke([system("sys"), user("hi")])
        body = self._body(seen)
        assert seen["request"].url.path == "/v1/chat/completions"
        assert seen["request"].headers["authorization"] == "Bearer sk-test"
        assert body["model"] == "test-model"
        assert body["stream"] is False
        assert body["messages"] == [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "hi"},
        ]

    async def test_base_url_trailing_slash_normalized(self):
        def handler(request):
            return ok_json({"choices": [{"message": {"content": "ok"}}]})

        llm, seen = make_adapter(handler)
        await llm.ainvoke([user("hi")])
        assert seen["request"].url.path == "/v1/chat/completions"

    async def test_tools_converted(self):
        def handler(request):
            return ok_json({"choices": [{"message": {"content": "ok"}}]})

        llm, seen = make_adapter(handler)
        tools = [
            ToolSpec(
                name="get_weather",
                description="查询天气",
                parameters={"type": "object", "properties": {"city": {"type": "string"}}},
            )
        ]
        await llm.ainvoke([user("hi")], tools=tools)
        body = self._body(seen)
        assert body["tools"][0]["type"] == "function"
        assert body["tools"][0]["function"]["name"] == "get_weather"
        assert "city" in body["tools"][0]["function"]["parameters"]["properties"]

    async def test_params_override_config(self):
        def handler(request):
            return ok_json({"choices": [{"message": {"content": "ok"}}]})

        llm, seen = make_adapter(handler, temperature=0.7, max_tokens=100)
        await llm.ainvoke([user("hi")], params=LLMParams(temperature=0.2))
        body = self._body(seen)
        assert body["temperature"] == 0.2  # 调用级覆盖配置
        assert body["max_tokens"] == 100  # 配置默认
        await llm.ainvoke([user("hi")])
        body2 = self._body(seen)
        assert body2["temperature"] == 0.7

    async def test_params_extra_body_merged(self):
        def handler(request):
            return ok_json({"choices": [{"message": {"content": "ok"}}]})

        llm, seen = make_adapter(handler)
        await llm.ainvoke([user("hi")], params=LLMParams(extra_body={"enable_thinking": True}))
        assert self._body(seen)["enable_thinking"] is True

    async def test_params_extra_body_cannot_override_core_fields(self):
        """P1 回归：extra_body 不得覆盖适配器统一装配的核心字段
        （替换整段对话/强制关流会静默破坏请求语义）。"""
        def handler(request):
            return ok_json({"choices": [{"message": {"content": "ok"}}]})

        llm, seen = make_adapter(handler)
        await llm.ainvoke(
            [user("hi")],
            params=LLMParams(
                temperature=0.2,
                extra_body={
                    "messages": [{"role": "user", "content": "注入"}],
                    "model": "other-model",
                    "stream": False,
                    "temperature": 9.9,
                },
            ),
        )
        body = self._body(seen)
        assert body["model"] == "test-model"
        assert body["messages"] == [{"role": "user", "content": "hi"}]
        assert body["stream"] is False
        assert body["temperature"] == 0.2

    async def test_stream_flag_true(self):
        def handler(request):
            return stream_response(
                [sse_frame(sse_delta({"content": "x"})), b"data: [DONE]\n\n"]
            )

        llm, seen = make_adapter(handler)
        await collect_result(llm.astream([user("hi")]))
        assert self._body(seen)["stream"] is True

    async def test_no_api_key_no_auth_header(self):
        def handler(request):
            return ok_json({"choices": [{"message": {"content": "ok"}}]})

        llm, seen = make_adapter(handler, api_key=None)
        await llm.ainvoke([user("hi")])
        assert "authorization" not in seen["request"].headers


# ---------------------------------------------------------------------------
# 非流式（ainvoke）
# ---------------------------------------------------------------------------
class TestAinvoke:
    async def test_success_content_and_usage(self):
        def handler(request):
            return ok_json(
                {
                    "choices": [{"message": {"content": "你好"}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 5, "completion_tokens": 3},
                }
            )

        llm, _ = make_adapter(handler)
        result = await llm.ainvoke([user("hi")])
        assert result.content == "你好"
        assert result.finish_reason == "stop"
        assert result.usage == {"prompt_tokens": 5, "completion_tokens": 3}

    async def test_success_tool_calls(self):
        def handler(request):
            return ok_json(
                {
                    "choices": [
                        {
                            "message": {
                                "content": None,
                                "tool_calls": [
                                    {
                                        "id": "call_1",
                                        "type": "function",
                                        "function": {
                                            "name": "get_weather",
                                            "arguments": '{"city": "北京"}',
                                        },
                                    }
                                ],
                            },
                            "finish_reason": "tool_calls",
                        }
                    ]
                }
            )

        llm, _ = make_adapter(handler)
        result = await llm.ainvoke([user("hi")])
        assert result.content == ""
        assert result.finish_reason == "tool_calls"
        assert result.tool_calls is not None
        assert result.tool_calls[0].name == "get_weather"
        assert result.tool_calls[0].parsed_arguments == {"city": "北京"}

    async def test_reasoning_content(self):
        def handler(request):
            return ok_json(
                {
                    "choices": [
                        {"message": {"content": "答", "reasoning_content": "想"}, "finish_reason": "stop"}
                    ]
                }
            )

        llm, _ = make_adapter(handler)
        result = await llm.ainvoke([user("hi")])
        assert result.reasoning == "想"

    @pytest.mark.parametrize(
        ("status", "expected"),
        [
            (401, LLMAuthError),
            (403, LLMAuthError),
            (429, LLMRateLimitError),
            (500, LLMServerError),
            (503, LLMServerError),
            (400, LLMBadRequestError),
            (422, LLMBadRequestError),
            (404, LLMNotFoundError),
        ],
    )
    async def test_error_status_classified(self, status, expected):
        def handler(request):
            return httpx.Response(
                status,
                json={"error": {"message": "上游错误信息", "code": "x"}},
                headers=JSON_HEADERS,
            )

        llm, _ = make_adapter(handler)
        with pytest.raises(expected) as exc_info:
            await llm.ainvoke([user("hi")])
        assert "上游错误信息" in str(exc_info.value)

    async def test_non_json_body_format_error(self):
        def handler(request):
            return httpx.Response(200, text="<html>gateway</html>")

        llm, _ = make_adapter(handler)
        with pytest.raises(LLMFormatError):
            await llm.ainvoke([user("hi")])

    async def test_missing_choices_format_error(self):
        def handler(request):
            return ok_json({"id": "x"})

        llm, _ = make_adapter(handler)
        with pytest.raises(LLMFormatError):
            await llm.ainvoke([user("hi")])

    async def test_timeout_classified(self):
        def handler(request):
            raise httpx.ReadTimeout("读超时", request=request)

        llm, _ = make_adapter(handler)
        with pytest.raises(LLMTimeoutError):
            await llm.ainvoke([user("hi")])


# ---------------------------------------------------------------------------
# 流式（astream）
# ---------------------------------------------------------------------------
class TestAstream:
    async def test_content_and_reasoning_streamed(self):
        frames = [
            sse_frame(sse_delta({"reasoning_content": "想"})),
            sse_frame(sse_delta({"content": "你"})),
            sse_frame(sse_delta({"content": "好"})),
            sse_frame(sse_delta({}, finish_reason="stop")),
            b"data: [DONE]\n\n",
        ]
        llm, _ = make_adapter(lambda request: stream_response(frames))
        result = await collect_result(llm.astream([user("hi")]))
        assert result.content == "你好"
        assert result.reasoning == "想"
        assert result.finish_reason == "stop"

    async def test_reasoning_alias_field(self):
        frames = [
            sse_frame(sse_delta({"reasoning": "备选推理字段"})),
            sse_frame(sse_delta({"content": "答"})),
            b"data: [DONE]\n\n",
        ]
        llm, _ = make_adapter(lambda request: stream_response(frames))
        result = await collect_result(llm.astream([user("hi")]))
        assert result.reasoning == "备选推理字段"
        assert result.content == "答"

    async def test_tool_calls_deltas_accumulated(self):
        frames = [
            sse_frame(
                sse_delta(
                    {"tool_calls": [{"index": 0, "id": "call_1", "function": {"name": "get_weather", "arguments": ""}}]}
                )
            ),
            sse_frame(sse_delta({"tool_calls": [{"index": 0, "function": {"arguments": '{"city"'}}]})),
            sse_frame(sse_delta({"tool_calls": [{"index": 0, "function": {"arguments": ':"北京"}'}}]})),
            sse_frame(sse_delta({}, finish_reason="tool_calls")),
            b"data: [DONE]\n\n",
        ]
        llm, _ = make_adapter(lambda request: stream_response(frames))
        result = await collect_result(llm.astream([user("hi")]))
        assert result.finish_reason == "tool_calls"
        assert result.tool_calls is not None
        assert len(result.tool_calls) == 1
        assert result.tool_calls[0].id == "call_1"
        assert result.tool_calls[0].name == "get_weather"
        assert result.tool_calls[0].arguments == '{"city":"北京"}'
        assert result.tool_calls[0].parsed_arguments == {"city": "北京"}

    async def test_usage_chunk_collected(self):
        frames = [
            sse_frame(sse_delta({"content": "x"})),
            sse_frame({"choices": [], "usage": {"prompt_tokens": 1}}),
            b"data: [DONE]\n\n",
        ]
        llm, _ = make_adapter(lambda request: stream_response(frames))
        result = await collect_result(llm.astream([user("hi")]))
        assert result.usage == {"prompt_tokens": 1}

    async def test_bad_frame_skipped(self):
        frames = [
            b"data: {not json}\n\n",
            sse_frame(sse_delta({"content": "ok"})),
            b"data: [DONE]\n\n",
        ]
        llm, _ = make_adapter(lambda request: stream_response(frames))
        result = await collect_result(llm.astream([user("hi")]))
        assert result.content == "ok"

    async def test_keepalive_comment_lines_skipped(self):
        frames = [
            b": ping\n\n",
            sse_frame(sse_delta({"content": "ok"})),
            b"data: [DONE]\n\n",
        ]
        llm, _ = make_adapter(lambda request: stream_response(frames))
        result = await collect_result(llm.astream([user("hi")]))
        assert result.content == "ok"

    async def test_empty_stream_raises(self):
        llm, _ = make_adapter(lambda request: stream_response([b": ping\n\n"]))
        with pytest.raises(LLMEmptyStreamError):
            await collect_result(llm.astream([user("hi")]))

    async def test_mid_stream_error_frame(self):
        frames = [
            sse_frame(sse_delta({"content": "x"})),
            sse_frame({"error": {"message": "限流了", "code": "rate_limit_exceeded"}}),
        ]
        llm, _ = make_adapter(lambda request: stream_response(frames))
        with pytest.raises(LLMRateLimitError) as exc_info:
            await collect_result(llm.astream([user("hi")]))
        assert "限流了" in str(exc_info.value)

    @pytest.mark.parametrize(
        ("code", "message", "expected"),
        [
            # 400 族：invalid_request 含 "invalid" 子串，须先于 401 宽松匹配判
            ("invalid_request_error", "参数非法", LLMBadRequestError),
            ("context_length_exceeded", "上下文超长", LLMBadRequestError),
            # 429 族：限流/额度（QUOTA_OR_RATE 语义）
            ("insufficient_quota", "额度不足", LLMRateLimitError),
            # 服务端：MaaS 常见 code/文案（关键词兜底语义，瞬时可重试）
            ("server_overloaded", "服务繁忙，请稍后重试", LLMServerError),
            ("engine_overloaded", "engine overloaded", LLMServerError),
            (None, "上游暂时不可用，请稍后再试", LLMServerError),
            # 认证族（fail-closed 语义依赖此分类）
            ("invalid_api_key", "API key 无效", LLMAuthError),
            # 404 族
            ("model_not_found", "模型不存在", LLMNotFoundError),
        ],
    )
    async def test_error_frame_code_classification(self, code, message, expected):
        frames = [sse_frame({"error": {"message": message, "code": code}})]
        llm, _ = make_adapter(lambda request: stream_response(frames))
        with pytest.raises(expected):
            await collect_result(llm.astream([user("hi")]))

    async def test_status_408_classified_timeout(self):
        def handler(request):
            return httpx.Response(
                408, json={"error": {"message": "request timeout"}}, headers=JSON_HEADERS
            )

        llm, _ = make_adapter(handler)
        with pytest.raises(LLMTimeoutError):
            await llm.ainvoke([user("hi")])

    async def test_aclose_releases_and_rebuilds_client(self):
        def handler(request):
            return ok_json({"choices": [{"message": {"content": "ok"}}]})

        llm, seen = make_adapter(handler)
        await llm.ainvoke([user("hi")])
        assert llm._client is not None
        await llm.aclose()
        assert llm._client is None
        await llm.ainvoke([user("hi")])  # 关闭后可重建（长连接生命周期由宿主管理）
        assert seen["calls"] == 2

    async def test_error_status_before_stream(self):
        def handler(request):
            return httpx.Response(429, json={"error": {"message": "slow down"}})

        llm, _ = make_adapter(handler)
        with pytest.raises(LLMRateLimitError):
            await collect_result(llm.astream([user("hi")]))

    async def test_stream_timeout_classified(self):
        def handler(request):
            raise httpx.ConnectTimeout("连不上", request=request)

        llm, _ = make_adapter(handler)
        with pytest.raises(LLMTimeoutError):
            await collect_result(llm.astream([user("hi")]))


class TestTransientRetry:
    """瞬时故障指数退避重试（429/503/网络/空流重试；确定性失败不重试）。"""

    async def test_ainvoke_retries_503_then_succeeds(self):
        attempts = {"n": 0}

        def handler(request):
            attempts["n"] += 1
            if attempts["n"] < 3:
                return httpx.Response(
                    503, json={"error": {"message": "服务暂时不可用"}}, headers=JSON_HEADERS
                )
            return ok_json({"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]})

        llm, seen = make_adapter(handler)
        result = await llm.ainvoke([user("hi")])
        assert result.content == "ok"
        assert seen["calls"] == 3

    async def test_ainvoke_retry_exhausted_raises_last_error(self):
        def handler(request):
            return httpx.Response(429, json={"error": {"message": "rate limit"}})

        llm, seen = make_adapter(handler)
        with pytest.raises(LLMRateLimitError):
            await llm.ainvoke([user("hi")])
        assert seen["calls"] == 3

    async def test_ainvoke_deterministic_error_not_retried(self):
        def handler(request):
            return httpx.Response(401, json={"error": {"message": "invalid key"}})

        llm, seen = make_adapter(handler)
        with pytest.raises(LLMAuthError):
            await llm.ainvoke([user("hi")])
        assert seen["calls"] == 1

    async def test_astream_retries_empty_stream_then_succeeds(self):
        attempts = {"n": 0}

        def handler(request):
            attempts["n"] += 1
            if attempts["n"] < 3:
                return stream_response([])
            return stream_response([sse_frame(sse_delta({"content": "hi"}))])

        llm, seen = make_adapter(handler)
        result = await collect_result(llm.astream([user("hi")]))
        assert result.content == "hi"
        assert seen["calls"] == 3

    async def test_astream_midstream_failure_not_retried(self):
        async def gen():
            yield sse_frame(sse_delta({"content": "部分"}))
            raise LLMServerError(detail="midstream")

        llm, seen = make_adapter(
            lambda request: httpx.Response(200, content=gen(), headers=JSON_HEADERS)
        )
        with pytest.raises(LLMError):
            await collect_result(llm.astream([user("hi")]))
        assert seen["calls"] == 1  # 已产出内容后中断：不重试（防重复帧）
