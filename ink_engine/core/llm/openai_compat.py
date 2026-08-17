"""OpenAI 兼容适配器（流式 SSE 解析自写，零 langchain/openai SDK 依赖）。

覆盖 OpenAI/DeepSeek/Zhipu/Moonshot/Ollama 等全部 OpenAI 兼容端点
（含 DashScope compatible-mode 端点，改 base_url 即可用）；
DeepSeek 系模型的 reasoning_content 增量透传为 reasoning_token。

行为约定：
- 传输异常/HTTP 状态码统一经 classify_llm_error 分类抛 LLMError；
- 200 但零数据帧的空流抛 LLMEmptyStreamError（可重试瞬时故障）；
- 取消语义：消费方任务被取消（CancelledError）时，响应流在退出路径
  显式 aclose——上游请求终止，不悬挂连接；
- 坏 SSE 帧容错跳过（不中断整个流）。
"""
from __future__ import annotations

import contextlib
import json
from collections.abc import AsyncIterator, Sequence
from dataclasses import replace
from typing import Any

import httpx

from ink_engine.core.llm.base import (
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
)
from ink_engine.core.llm.messages import Message, ToolCall
from ink_engine.core.llm.tools import ToolSpec, to_openai_tools

DEFAULT_REQUEST_TIMEOUT = 120.0

# 兼容端点常见但非标准的推理字段（DeepSeek/DashScope qwq 等）
_REASONING_FIELDS = ("reasoning_content", "reasoning")


def _status_hint(code: Any) -> int | None:
    """从上游错误 code 猜测 HTTP 状态码（分类提示，无则 None）。

    分支序即优先级：400 族（invalid_request 含 "invalid" 子串，须先于
    401 的宽松匹配判）→ 429 限流/额度 → 404 → 401 → 408 超时。
    精确前缀/白名单优先，避免子串误判（如 "key" 命中 "invalid_request"）。
    """
    if not isinstance(code, str):
        return None
    lowered = code.lower()
    if any(
        marker in lowered
        for marker in (
            "invalid_request",
            "invalid_parameter",
            "invalid_params",
            "context_length",
            "context_overflow",
            "max_tokens",
            "length",
            "bad_request",
            "request_error",
        )
    ):
        return 400
    if any(marker in lowered for marker in ("rate", "quota", "limit", "throttl")):
        return 429
    if "not_found" in lowered or ("not" in lowered and "exist" in lowered):
        return 404
    if any(marker in lowered for marker in ("auth", "api_key", "apikey", "key invalid", "invalid key")):
        return 401
    if any(marker in lowered for marker in ("timeout", "timed")):
        return 408
    return None


class OpenAICompatibleLLM(AsyncLLM):
    """OpenAI 兼容聊天补全适配器（chat/completions，流式/非流式）。"""

    adapter = "openai_compat"

    def __init__(self, config: LLMConfig, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        super().__init__(config)
        self._transport = transport  # 测试注入（MockTransport）；None = 生产默认
        self._client: httpx.AsyncClient | None = None  # 惰性长生命周期 client（连接池复用）

    # ------------------------------------------------------------------
    # 请求构造
    # ------------------------------------------------------------------
    @property
    def _endpoint(self) -> str:
        return self.config.base_url.rstrip("/") + "/chat/completions"

    def _timeout(self) -> httpx.Timeout:
        return httpx.Timeout(self.config.request_timeout or DEFAULT_REQUEST_TIMEOUT)

    def _get_client(self) -> httpx.AsyncClient:
        """惰性构建长生命周期 client：连接池跨调用复用（TCP/TLS 免重复握手）。

        生命周期由宿主显式管理：调用 aclose() 释放（ModelChain.aclose 一并关闭）。
        """
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
            "messages": [m.to_openai_dict() for m in messages],
            "stream": stream,
        }
        if tools:
            payload["tools"] = to_openai_tools(list(tools))
        temperature = params.temperature if params and params.temperature is not None else self.config.temperature
        if temperature is not None:
            payload["temperature"] = temperature
        max_tokens = params.max_tokens if params and params.max_tokens is not None else self.config.max_tokens
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        if params and params.extra_body:
            payload.update(params.extra_body)
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
    def _chunk_from_choice(choice: dict[str, Any]) -> LLMChunk | None:
        """把一个 SSE choice 帧解析为 LLMChunk（无信息内容返回 None 跳过）。"""
        delta = choice.get("delta")
        if not isinstance(delta, dict):
            delta = {}
        reasoning = None
        for key in _REASONING_FIELDS:
            value = delta.get(key)
            if isinstance(value, str):
                reasoning = value
                break
        tool_calls = None
        raw_calls = delta.get("tool_calls")
        if isinstance(raw_calls, list):
            deltas: list[ToolCallDelta] = []
            for item in raw_calls:
                if not isinstance(item, dict):
                    continue
                function = item.get("function")
                fn_name = fn_args = None
                if isinstance(function, dict):
                    fn_name = function.get("name") if isinstance(function.get("name"), str) else None
                    fn_args = function.get("arguments") if isinstance(function.get("arguments"), str) else None
                deltas.append(
                    ToolCallDelta(
                        index=item.get("index", 0),
                        id=item.get("id") if isinstance(item.get("id"), str) else None,
                        name=fn_name,
                        arguments_delta=fn_args,
                    )
                )
            tool_calls = deltas or None
        finish = choice.get("finish_reason")
        return LLMChunk(
            token=delta.get("content") if isinstance(delta.get("content"), str) else None,
            reasoning_token=reasoning,
            tool_calls_delta=tool_calls,
            finish_reason=finish if isinstance(finish, str) else None,
        )

    def _parse_sse_line(self, line: str, state: dict[str, Any]) -> LLMChunk | None:
        """解析单条 SSE data 帧（[DONE] 忽略；usage 帧/同帧 usage 合并；error 帧抛 LLMError）。"""
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
        usage = obj.get("usage")
        if usage is not None:
            state["usage"] = usage
        choices = obj.get("choices")
        if not isinstance(choices, list) or not choices:
            # 纯 usage 帧（include_usage 末帧）；无 usage 无 choices 属非法帧
            if usage is not None:
                return LLMChunk(usage=usage)
            raise LLMFormatError(detail=f"响应缺 choices: {data[:200]}")
        chunk = self._chunk_from_choice(choices[0])
        if chunk is None or chunk.is_empty:
            return LLMChunk(usage=usage) if usage is not None else None
        if usage is not None:
            # 同帧携带 choices+usage：合并产出，不丢内容
            return replace(chunk, usage=usage)
        return chunk

    # ------------------------------------------------------------------
    # 传输异常包装（httpx 异常 → LLMError 分类；CancelledError 穿透）
    # ------------------------------------------------------------------
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
        try:
            response = await client.post(self._endpoint, json=payload, headers=self._headers())
        except (httpx.TimeoutException, httpx.TransportError, httpx.HTTPError) as exc:
            raise self._wrap_transport_error(exc) from exc
        await self._raise_for_status(response)
        try:
            obj = response.json()
        except json.JSONDecodeError as exc:
            raise LLMFormatError(detail=f"非 JSON 响应: {exc}") from exc
        if not isinstance(obj, dict):
            raise LLMFormatError(detail="响应非对象")
        choices = obj.get("choices")
        if not isinstance(choices, list) or not choices:
            raise LLMFormatError(detail=f"响应缺 choices: {str(obj)[:200]}")
        choice = choices[0]
        message = choice.get("message") if isinstance(choice, dict) else None
        if not isinstance(message, dict):
            raise LLMFormatError(detail="choices[0].message 缺失")
        content = message.get("content") or ""
        reasoning = None
        for key in _REASONING_FIELDS:
            value = message.get(key)
            if isinstance(value, str):
                reasoning = value
                break
        tool_calls = None
        raw_calls = message.get("tool_calls")
        if isinstance(raw_calls, list):
            calls: list[ToolCall] = []
            for item in raw_calls:
                if not isinstance(item, dict):
                    continue
                function = item.get("function")
                if not isinstance(function, dict):
                    continue
                calls.append(
                    ToolCall(
                        id=str(item.get("id") or ""),
                        name=str(function.get("name") or ""),
                        arguments=str(function.get("arguments") or ""),
                    )
                )
            tool_calls = calls or None
        finish = choice.get("finish_reason") if isinstance(choice, dict) else None
        return LLMResult(
            content=content,
            reasoning=reasoning,
            tool_calls=tool_calls,
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
        try:
            # async with 语义：__aenter__ 失败不调 __aexit__；正常退出/
            # 异常/消费方取消（生成器 aclose）均走 __aexit__ → 关闭上游连接
            async with client.stream("POST", self._endpoint, json=payload, headers=self._headers()) as response:
                await self._raise_for_status(response)
                state: dict[str, Any] = {"usage": None}
                emitted = False
                async for line in response.aiter_lines():
                    chunk = self._parse_sse_line(line, state)
                    if chunk is None:
                        continue
                    emitted = True
                    yield chunk
                if not emitted:
                    raise LLMEmptyStreamError(detail=f"{self._endpoint} 流为空")
        except (httpx.TimeoutException, httpx.TransportError, httpx.HTTPError) as exc:
            raise self._wrap_transport_error(exc) from exc
