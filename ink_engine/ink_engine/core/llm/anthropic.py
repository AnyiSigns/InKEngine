"""Anthropic Messages API 适配器（流式 SSE 自解析，零第三方 SDK 依赖）。

实现 AsyncLLM 契约：astream 分帧、tool schema passthrough（Anthropic
tool_use 块表达）、错误经 classify_llm_error 分类、厂商缓存参数（cache_control）。

行为约定（与 openai_compat 对齐）：
- 传输异常/HTTP 状态码统一经 classify_llm_error 分类抛 LLMError；
- 200 但零数据帧的空流抛 LLMEmptyStreamError（可重试瞬时故障）；
- 取消语义：消费方取消时响应流在退出路径显式 aclose，不悬挂连接；
- 坏 SSE 帧容错跳过（不中断整个流）。
"""
from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import AsyncIterator, Sequence
from typing import Any

import httpx

from ink_engine.core.llm.base import (
    AsyncLLM,
    LLMChunk,
    LLMConfig,
    LLMParams,
    LLMResult,
    ToolCall,
    ToolCallDelta,
)
from ink_engine.core.llm.errors import (
    LLMEmptyStreamError,
    LLMError,
    LLMFormatError,
    classify_llm_error,
    is_transient_llm_error,
)
from ink_engine.core.llm.messages import Message
from ink_engine.core.llm.tools import ToolSpec

DEFAULT_REQUEST_TIMEOUT = 120.0

# 瞬时故障指数退避重试（429/5xx/超时/网络/空流等）：最多 3 次尝试
# （1 原始 + 2 重试），退避 1s→2s→4s，吸收网关抖动与限流尖峰；
# 确定性失败（认证/404/400）不重试，fail-closed 语义不变。
_RETRY_MAX_ATTEMPTS = 3
_RETRY_BASE_DELAY = 1.0
_RETRY_MAX_DELAY = 4.0

_ANTHROPIC_VERSION = "2023-06-01"

# Anthropic stop_reason → 统一 finish_reason（不命中则原样透传）
_STOP_REASON_MAP: dict[str, str] = {
    "end_turn": "stop",
    "stop_sequence": "stop",
    "tool_use": "tool_calls",
    "max_tokens": "length",
}

# Anthropic 上游错误 type → HTTP 状态码（分类提示，无则 None）
_ERROR_TYPE_STATUS: dict[str, int] = {
    "authentication_error": 401,
    "permission_error": 403,
    "not_found_error": 404,
    "rate_limit_error": 429,
    "invalid_request_error": 400,
    "request_too_large": 400,
    "api_error": 500,
    "overloaded_error": 503,
    "service_unavailable": 503,
    "timeout": 408,
}


async def _retry_backoff(attempt: int) -> None:
    """瞬时故障重试前的指数退避（attempt = 已失败次数，0 起）。"""
    delay = min(_RETRY_BASE_DELAY * (2**attempt), _RETRY_MAX_DELAY)
    await asyncio.sleep(delay)


class AnthropicLLM(AsyncLLM):
    """Anthropic Messages API 适配器（chat/completions 等价，流式/非流式）。"""

    adapter = "anthropic"

    def __init__(self, config: LLMConfig, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        super().__init__(config)
        self._transport = transport  # 测试注入（MockTransport）；None = 生产默认
        self._client: httpx.AsyncClient | None = None  # 惰性长生命周期 client
        self._stream_prompt_tokens: int | None = None  # 流式输入用量（message_start 暂存）

    # ------------------------------------------------------------------
    # 请求构造
    # ------------------------------------------------------------------
    @property
    def _endpoint(self) -> str:
        return self.config.base_url.rstrip("/") + "/messages"

    def _timeout(self) -> httpx.Timeout:
        return httpx.Timeout(self.config.request_timeout or DEFAULT_REQUEST_TIMEOUT)

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout(), transport=self._transport)
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _headers(self) -> dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "anthropic-version": _ANTHROPIC_VERSION,
        }
        if self.config.api_key:
            headers["x-api-key"] = self.config.api_key
        return headers

    def _system_text(self, messages: Sequence[Message]) -> str | None:
        """取首个 system 消息内容（多 system 仅取首个，与既有约束一致）。"""
        for m in messages:
            if m.role == "system":
                return m.content or None
        return None

    def _to_messages(self, messages: Sequence[Message]) -> list[dict[str, Any]]:
        """引擎 Message → Anthropic messages（system 已抽离为顶层字段）。"""
        out: list[dict[str, Any]] = []
        for m in messages:
            if m.role == "system":
                continue
            if m.role == "tool":
                out.append(
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": m.tool_call_id,
                                "content": m.content,
                            }
                        ],
                    }
                )
                continue
            blocks: list[dict[str, Any]] = []
            if m.content:
                blocks.append({"type": "text", "text": m.content})
            if m.tool_calls:
                for tc in m.tool_calls:
                    blocks.append(
                        {
                            "type": "tool_use",
                            "id": tc.id,
                            "name": tc.name,
                            "input": tc.parsed_arguments,
                        }
                    )
            out.append({"role": m.role, "content": blocks or [{"type": "text", "text": ""}]})
        return out

    def _to_tools(self, tools: Sequence[ToolSpec]) -> list[dict[str, Any]] | None:
        if not tools:
            return None
        out: list[dict[str, Any]] = []
        for spec in tools:
            data = spec.to_dict()
            out.append(
                {
                    "name": data["name"],
                    "description": data["description"],
                    "input_schema": data["parameters"],
                }
            )
        return out

    def _payload(
        self,
        messages: Sequence[Message],
        tools: Sequence[ToolSpec] | None,
        params: LLMParams | None,
        *,
        stream: bool,
    ) -> dict[str, Any]:
        max_tokens = (
            params.max_tokens
            if params and params.max_tokens is not None
            else self.config.max_tokens or 1024
        )
        payload: dict[str, Any] = {
            "model": self.config.model_id,
            "max_tokens": max_tokens,
            "messages": self._to_messages(messages),
            "stream": stream,
        }
        # 厂商缓存参数（各一行）：extra.cache_control 为真时给 system 块挂
        # ephemeral 缓存断点（prompt 缓存），保持简单，满足契约测试即可
        system = self._system_text(messages)
        if system is not None:
            cache = bool(self.config.extra and self.config.extra.get("cache_control"))
            payload["system"] = (
                [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}]
                if cache
                else system
            )
        anthropic_tools = self._to_tools(list(tools)) if tools else None
        if anthropic_tools:
            payload["tools"] = anthropic_tools
        temperature = params.temperature if params and params.temperature is not None else self.config.temperature
        if temperature is not None:
            payload["temperature"] = temperature
        if params and params.extra_body:
            # extra_body 仅透传厂商扩展键：核心字段由适配器统一装配
            payload.update(
                {
                    k: v
                    for k, v in params.extra_body.items()
                    if k not in ("model", "max_tokens", "messages", "stream", "tools", "system", "temperature")
                }
            )
        return payload

    # ------------------------------------------------------------------
    # 响应解析
    # ------------------------------------------------------------------
    @staticmethod
    def _error_detail(body: bytes) -> str | None:
        try:
            obj = json.loads(body.decode("utf-8", errors="replace"))
        except json.JSONDecodeError:
            return None
        error = obj.get("error") if isinstance(obj, dict) else None
        if isinstance(error, dict):
            return error.get("message") or str(error)
        if isinstance(error, str):
            return error
        return None

    async def _raise_for_status(self, response: httpx.Response) -> None:
        if response.status_code < 400:
            return
        body = b""
        with contextlib.suppress(Exception):
            body = await response.aread()
        raise classify_llm_error(response.status_code, detail=self._error_detail(body))

    @staticmethod
    def _error_status_hint(code: Any) -> int | None:
        """从 Anthropic 错误 type 猜测 HTTP 状态码（分类提示）。"""
        if not isinstance(code, str):
            return None
        return _ERROR_TYPE_STATUS.get(code)

    def _parse_sse_line(self, line: str) -> LLMChunk | None:
        """解析单条 SSE data 帧为 LLMChunk（忽略 event/ping/start/stop 行）。"""
        text = line.strip()
        if not text.startswith("data:"):
            return None
        data = text[len("data:"):].strip()
        if not data or data == "[DONE]":
            return None
        try:
            obj = json.loads(data)
        except json.JSONDecodeError:
            return None  # 坏帧容错跳过
        if not isinstance(obj, dict):
            return None
        etype = obj.get("type")
        if etype == "error":
            err = obj.get("error") if isinstance(obj.get("error"), dict) else {}
            message = err.get("message") if isinstance(err, dict) else str(err)
            code = err.get("type") if isinstance(err, dict) else None
            raise classify_llm_error(self._error_status_hint(code), detail=message)
        if etype == "message_start":
            # message_start 仅携带输入用量，记入后续 message_delta 合并输出
            msg = obj.get("message") or {}
            usage = msg.get("usage") if isinstance(msg, dict) else None
            if isinstance(usage, dict) and isinstance(usage.get("input_tokens"), int):
                self._stream_prompt_tokens = usage["input_tokens"]
            return None
        if etype == "content_block_delta":
            delta = obj.get("delta") or {}
            dtype = delta.get("type")
            if dtype == "text_delta":
                return LLMChunk(token=delta.get("text") or None)
            if dtype == "input_json_delta":
                partial = delta.get("partial_json")
                return LLMChunk(
                    tool_calls_delta=[
                        ToolCallDelta(
                            index=obj.get("index", 0),
                            arguments_delta=partial if isinstance(partial, str) else None,
                        )
                    ]
                )
            return None
        if etype == "content_block_start":
            block = obj.get("content_block") or {}
            if block.get("type") == "tool_use":
                return LLMChunk(
                    tool_calls_delta=[
                        ToolCallDelta(
                            index=obj.get("index", 0),
                            id=block.get("id") if isinstance(block.get("id"), str) else None,
                            name=block.get("name") if isinstance(block.get("name"), str) else None,
                        )
                    ]
                )
            return None
        if etype == "message_delta":
            md = obj.get("delta") or {}
            stop = md.get("stop_reason")
            finish = _STOP_REASON_MAP.get(stop, stop) if isinstance(stop, str) else None
            usage = None
            u = obj.get("usage")
            if isinstance(u, dict) or self._stream_prompt_tokens is not None:
                usage = {
                    "prompt_tokens": (
                        self._stream_prompt_tokens
                        if self._stream_prompt_tokens is not None
                        else (u.get("input_tokens") if isinstance(u, dict) else None)
                    ),
                    "completion_tokens": u.get("output_tokens") if isinstance(u, dict) else None,
                }
            if finish is None and usage is None:
                return None
            return LLMChunk(finish_reason=finish, usage=usage)
        # message_start / content_block_stop / message_stop / ping → 无增量
        return None

    # ------------------------------------------------------------------
    # AsyncLLM 接口
    # ------------------------------------------------------------------
    async def ainvoke(
        self,
        messages: Sequence[Message],
        *,
        tools: Sequence[ToolSpec] | None = None,
        params: LLMParams | None = None,
    ) -> LLMResult:
        payload = self._payload(messages, tools, params, stream=False)
        client = self._get_client()
        response: httpx.Response | None = None
        for attempt in range(_RETRY_MAX_ATTEMPTS):
            try:
                response = await client.post(self._endpoint, json=payload, headers=self._headers())
                await self._raise_for_status(response)
                break
            except (httpx.TimeoutException, httpx.TransportError, httpx.HTTPError) as exc:
                error = classify_llm_error(exc=exc)
            except LLMError as exc:
                error = exc
            if is_transient_llm_error(error) and attempt + 1 < _RETRY_MAX_ATTEMPTS:
                await _retry_backoff(attempt)
                continue
            raise error
        assert response is not None
        try:
            obj = response.json()
        except json.JSONDecodeError as exc:
            raise LLMFormatError(detail=f"非 JSON 响应: {exc}") from exc
        if not isinstance(obj, dict):
            raise LLMFormatError(detail="响应非对象")
        content_blocks = obj.get("content")
        if not isinstance(content_blocks, list):
            raise LLMFormatError(detail=f"响应缺 content: {str(obj)[:200]}")
        text_parts: list[str] = []
        calls: list[ToolCall] = []
        for block in content_blocks:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype == "text":
                text_parts.append(block.get("text") or "")
            elif btype == "tool_use":
                calls.append(
                    ToolCall(
                        id=str(block.get("id") or ""),
                        name=str(block.get("name") or ""),
                        arguments=json.dumps(block.get("input") or {}, ensure_ascii=False),
                    )
                )
        finish = obj.get("stop_reason")
        finish = _STOP_REASON_MAP.get(finish, finish) if isinstance(finish, str) else None
        usage = obj.get("usage")
        usage_out = None
        if isinstance(usage, dict):
            usage_out = {
                "prompt_tokens": usage.get("input_tokens"),
                "completion_tokens": usage.get("output_tokens"),
            }
        return LLMResult(
            content="".join(text_parts),
            tool_calls=calls or None,
            finish_reason=finish,
            usage=usage_out,
        )

    async def astream(
        self,
        messages: Sequence[Message],
        *,
        tools: Sequence[ToolSpec] | None = None,
        params: LLMParams | None = None,
    ) -> AsyncIterator[LLMChunk]:
        payload = self._payload(messages, tools, params, stream=True)
        client = self._get_client()
        self._stream_prompt_tokens = None
        for attempt in range(_RETRY_MAX_ATTEMPTS):
            emitted = False
            try:
                async with client.stream("POST", self._endpoint, json=payload, headers=self._headers()) as response:
                    await self._raise_for_status(response)
                    async for line in response.aiter_lines():
                        chunk = self._parse_sse_line(line)
                        if chunk is None:
                            continue
                        emitted = True
                        yield chunk
                    if not emitted:
                        raise LLMEmptyStreamError(detail=f"{self._endpoint} 流为空")
                return
            except (httpx.TimeoutException, httpx.TransportError, httpx.HTTPError) as exc:
                error = classify_llm_error(exc=exc)
            except LLMError as exc:
                error = exc
            if emitted:
                # 已产出内容后的中断：重试会重复已消费帧，直接上抛不重试
                raise error
            if is_transient_llm_error(error) and attempt + 1 < _RETRY_MAX_ATTEMPTS:
                await _retry_backoff(attempt)
                continue
            raise error


__all__ = ["AnthropicLLM"]
