"""OpenAI Responses API 适配器（/responses 端点，流式 SSE 事件自写解析）。

覆盖 OpenAI 新一代 Responses 协议（与 chat/completions 的 openai_compat
并列的常见 API 协议）：请求体以 ``input`` 数组承载消息（含 function_call /
function_call_output 工具回环项）、``tools`` 用 ``{type: "function"}`` 声明、
流式事件按 ``type`` 字段分发（``response.output_text.delta`` 文本增量 /
``response.output_item.done`` 工具调用定型 / ``response.completed`` 终态 /
``response.usage`` 用量帧）。

行为约定（与 openai_compat / anthropic 对齐）：
- 传输异常/HTTP 状态码统一经 classify_llm_error 分类抛 LLMError；
- 200 但零内容帧的空流抛 LLMEmptyStreamError（可重试瞬时故障）；
- 取消语义：消费方任务被取消时响应流在退出路径显式关闭上游；
- 坏 SSE 帧/未知事件类型容错跳过（不中断整个流）。
"""
from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import AsyncIterator, Sequence
from dataclasses import replace
from typing import Any

import httpx

from ink_engine.core.llm.base import (
    REASONING_EFFORTS,
    AsyncLLM,
    LLMChunk,
    LLMConfig,
    LLMParams,
    LLMResult,
    ToolCallDelta,
)
from ink_engine.core.llm.errors import (
    LLMEmptyStreamError,
    LLMError,
    LLMFormatError,
    classify_llm_error,
    is_transient_llm_error,
)
from ink_engine.core.llm.fallback import RetryPolicy
from ink_engine.core.llm.messages import Message, ToolCall
from ink_engine.core.llm.tools import ToolSpec, to_openai_tools

DEFAULT_REQUEST_TIMEOUT = 120.0

_LLM_RETRY_BASE_DELAY = 1.0
_LLM_RETRY_MAX_DELAY = 4.0

# 适配器统一装配的核心请求字段：extra_body 不得覆盖（防替换对话/强制关流）
_CORE_PAYLOAD_KEYS = frozenset(
    {
        "model",
        "input",
        "instructions",
        "tools",
        "stream",
        "temperature",
        "max_output_tokens",
        "reasoning",
    }
)


async def _retry_backoff(policy: RetryPolicy, attempt: int) -> None:
    """瞬时故障重试前的指数退避（attempt = 已失败次数，0 起）。"""
    delay = min(policy.base_delay * (2**attempt), policy.max_delay)
    await asyncio.sleep(delay)


def _status_hint(code: Any) -> int | None:
    """从上游错误 code 猜测 HTTP 状态码（与 openai_compat 同优先级序）。"""
    if not isinstance(code, str):
        return None
    lowered = code.lower()
    if any(
        marker in lowered
        for marker in (
            "invalid_request",
            "invalid_parameter",
            "context_length",
            "max_output_tokens",
            "bad_request",
        )
    ):
        return 400
    if any(marker in lowered for marker in ("rate", "quota", "limit", "throttl")):
        return 429
    if "not_found" in lowered:
        return 404
    if any(marker in lowered for marker in ("auth", "api_key", "apikey")):
        return 401
    if any(marker in lowered for marker in ("timeout", "timed")):
        return 408
    return None


def _content_text(content: Any) -> str:
    """Responses content 字段 → 文本（消息内容为内容段数组或字符串）。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if not isinstance(item, dict):
                continue
            if item.get("type") in ("output_text", "input_text") and isinstance(
                item.get("text"), str
            ):
                parts.append(item["text"])
            elif item.get("type") == "text" and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "".join(parts)
    return ""


class OpenAIResponsesLLM(AsyncLLM):
    """OpenAI Responses API 适配器（chat 补全新协议，流式/非流式）。"""

    adapter = "openai_responses"

    def __init__(
        self,
        config: LLMConfig,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        retry: RetryPolicy | None = None,
    ) -> None:
        super().__init__(config)
        self._transport = transport  # 测试注入（MockTransport）；None = 生产默认
        self._client: httpx.AsyncClient | None = None  # 惰性长生命周期 client
        self._retry = retry

    # ------------------------------------------------------------------
    # 请求构造
    # ------------------------------------------------------------------
    @property
    def _endpoint(self) -> str:
        return self.config.base_url.rstrip("/") + "/responses"

    def _timeout(self) -> httpx.Timeout:
        return httpx.Timeout(self.config.request_timeout or DEFAULT_REQUEST_TIMEOUT)

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout(), transport=self._transport)
        return self._client

    async def aclose(self) -> None:
        """释放长连接 client（幂等；关闭后再次调用会重建）。"""
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.config.api_key:
            headers["Authorization"] = f"Bearer {self.config.api_key}"
        return headers

    def _to_input_items(self, messages: Sequence[Message]) -> list[dict[str, Any]]:
        """Message 序列 → Responses ``input`` 数组（工具回环项/角色项）。

        转换映射（与 openai_compat 的 to_openai_dict 对齐语义）：
        - system/user/assistant 角色项：{role, content}（name 仅 user/
          assistant 携带——Responses 协议支持 name 字段）；
        - assistant 的工具调用 → {type: "function_call", call_id, name,
          arguments}（紧跟其后，供模型消费）；
        - tool 角色 → {type: "function_call_output", call_id, output}。
        """
        items: list[dict[str, Any]] = []
        for message in messages:
            if message.role == "tool":
                items.append(
                    {
                        "type": "function_call_output",
                        "call_id": message.tool_call_id,
                        "output": message.content,
                    }
                )
                continue
            if message.role == "assistant" and message.tool_calls:
                # 纯工具调用回复：无文本内容项，函数调用项入列
                for tc in message.tool_calls:
                    items.append(
                        {
                            "type": "function_call",
                            "call_id": tc.id,
                            "name": tc.name,
                            "arguments": tc.arguments,
                        }
                    )
                continue
            if message.role == "user" and message.attachments:
                parts: list[dict[str, Any]] = []
                if message.content:
                    parts.append({"type": "input_text", "text": message.content})
                parts.extend(a.to_openai_segment() for a in message.attachments)
                item: dict[str, Any] = {"role": "user", "content": parts}
                if message.name:
                    item["name"] = message.name
                items.append(item)
                continue
            item = {"role": message.role, "content": message.content}
            if message.name and message.role in ("user", "assistant"):
                item["name"] = message.name
            items.append(item)
        return items

    def _payload(
        self,
        messages: Sequence[Message],
        tools: Sequence[ToolSpec] | None,
        params: LLMParams | None,
        *,
        stream: bool,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.config.model_id,
            "input": self._to_input_items(messages),
            "stream": stream,
        }
        if tools:
            # Responses 工具段为扁平 {type, name, description, parameters}
            # （chat 段把 name/description/parameters 嵌套在 function 键下），
            # 解包既有 to_openai_tools 的 function 段复用转换。
            payload["tools"] = [
                {"type": "function", **t["function"]}
                for t in to_openai_tools(list(tools))
            ]
        temperature = params.temperature if params and params.temperature is not None else self.config.temperature
        if temperature is not None:
            payload["temperature"] = temperature
        max_tokens = params.max_tokens if params and params.max_tokens is not None else self.config.max_tokens
        if max_tokens is not None:
            payload["max_output_tokens"] = max_tokens
        if params and params.extra_body:
            payload.update(
                {
                    k: v
                    for k, v in params.extra_body.items()
                    if k not in _CORE_PAYLOAD_KEYS
                }
            )
        # 推理链开关 / 推理档位（与 openai_compat 对齐语义）：Responses 协议
        # 经 reasoning.effort 群体现。显式档位优先于 enable_thinking 布尔：
        #   off      → 不携带 reasoning（模型默认/无思考路径）
        #   low/med/high → reasoning.effort 对应档
        #   enable_thinking=True（无显式档）→ 默认 medium 档
        if params is not None and params.reasoning_effort is not None:
            if params.reasoning_effort in REASONING_EFFORTS and params.reasoning_effort != "off":
                payload["reasoning"] = {"effort": params.reasoning_effort}
        elif params is not None and params.enable_thinking is True:
            payload["reasoning"] = {"effort": "medium"}
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
    def _finish_from_event_type(event_type: str) -> str | None:
        """终态事件 → finish_reason（completed/incomplete/failed/in_progress）。"""
        if event_type in ("response.completed", "response.incomplete", "response.failed"):
            return event_type.removeprefix("response.")  # completed / incomplete / failed
        return None

    @staticmethod
    def _chunk_from_event(obj: dict[str, Any]) -> LLMChunk | None:
        """把一个 Responses SSE 事件解析为 LLMChunk（无信息事件返回 None 跳过）。"""
        event_type = obj.get("type")
        if not isinstance(event_type, str):
            return None
        # 文本增量
        if event_type == "response.output_text.delta":
            delta = obj.get("delta")
            return LLMChunk(token=delta if isinstance(delta, str) else None)
        # 工具调用定型（done 事件携带完整 function_call 项）
        if event_type == "response.output_item.done":
            item = obj.get("item")
            if isinstance(item, dict) and item.get("type") == "function_call":
                arguments = item.get("arguments")
                if isinstance(arguments, (dict, list)):
                    arguments = json.dumps(arguments, ensure_ascii=False)
                name = item.get("name")
                return LLMChunk(
                    tool_calls_delta=[
                        ToolCallDelta(
                            index=0,
                            id=item.get("call_id")
                            if isinstance(item.get("call_id"), str)
                            else None,
                            name=name if isinstance(name, str) else None,
                            arguments_delta=arguments
                            if isinstance(arguments, str)
                            else None,
                        )
                    ]
                )
            return None
        # 终态 / 用量帧
        finish = OpenAIResponsesLLM._finish_from_event_type(event_type)
        usage = obj.get("usage")
        if finish is not None or usage is not None:
            return LLMChunk(finish_reason=finish, usage=usage)
        return None

    def _parse_sse_line(self, line: str) -> LLMChunk | None:
        """解析单条 SSE data 帧（[DONE] 忽略；error 帧抛 LLMError）。"""
        text = line.strip()
        if not text.startswith("data:"):
            return None
        data = text[len("data:") :].strip()
        if not data or data == "[DONE]":
            return None
        try:
            obj = json.loads(data)
        except json.JSONDecodeError:
            return None  # 坏帧容错跳过
        if not isinstance(obj, dict):
            return None
        if "error" in obj:
            error = obj["error"]
            detail = error.get("message") if isinstance(error, dict) else str(error)
            code = error.get("code") if isinstance(error, dict) else None
            raise classify_llm_error(_status_hint(code), detail=detail)
        return self._chunk_from_event(obj)

    @staticmethod
    def _wrap_transport_error(exc: Exception) -> LLMError:
        """把 httpx 传输异常分类为 LLMError（失败安全：未知异常兜底包装）。"""
        return classify_llm_error(exc=exc)

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
        attempts = self._retry.attempts if self._retry is not None else 1
        for attempt in range(attempts):
            try:
                response = await client.post(
                    self._endpoint, json=payload, headers=self._headers()
                )
                await self._raise_for_status(response)
                break
            except (httpx.TimeoutException, httpx.TransportError, httpx.HTTPError) as exc:
                error = self._wrap_transport_error(exc)
            except LLMError as exc:
                error = exc
            if is_transient_llm_error(error) and attempt + 1 < attempts:
                await _retry_backoff(self._retry, attempt)
                continue
            raise error
        assert response is not None
        try:
            obj = response.json()
        except json.JSONDecodeError as exc:
            raise LLMFormatError(detail=f"非 JSON 响应: {exc}") from exc
        if not isinstance(obj, dict):
            raise LLMFormatError(detail="响应非对象")
        output = obj.get("output")
        if not isinstance(output, list):
            raise LLMFormatError(detail=f"响应缺 output: {str(obj)[:200]}")
        content_parts: list[str] = []
        tool_calls: list[ToolCall] = []
        for item in output:
            if not isinstance(item, dict):
                continue
            item_type = item.get("type")
            if item_type == "message":
                content_parts.append(_content_text(item.get("content")))
            elif item_type == "function_call":
                arguments = item.get("arguments")
                if isinstance(arguments, (dict, list)):
                    arguments = json.dumps(arguments, ensure_ascii=False)
                name = item.get("name")
                call_id = item.get("call_id")
                if isinstance(name, str) and isinstance(arguments, str):
                    tool_calls.append(
                        ToolCall(
                            id=str(call_id or ""),
                            name=name,
                            arguments=arguments,
                        )
                    )
        finish = obj.get("finish_reason")
        return LLMResult(
            content="".join(content_parts),
            tool_calls=tool_calls or None,
            finish_reason=finish if isinstance(finish, str) else None,
            usage=obj.get("usage"),
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
        attempts = self._retry.attempts if self._retry is not None else 1
        for attempt in range(attempts):
            emitted = False
            try:
                # async with 语义：__aenter__ 失败不调 __aexit__；正常退出/
                # 异常/消费方取消（生成器 aclose）均走 __aexit__ → 关闭上游连接
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
                error = self._wrap_transport_error(exc)
            except LLMError as exc:
                error = exc
            if emitted:
                # 已产出内容后的中断：重试会重复已消费帧，直接上抛不重试
                raise error
            if is_transient_llm_error(error) and attempt + 1 < attempts:
                await _retry_backoff(self._retry, attempt)
                continue
            raise error


__all__ = ["OpenAIResponsesLLM"]
