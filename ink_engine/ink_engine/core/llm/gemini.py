"""Google Gemini API 适配器（流式 SSE 自解析，零第三方 SDK 依赖）。

实现 AsyncLLM 契约：astream 分帧、tool schema passthrough（Gemini
functionDeclaration/functionCall 等价表达）、错误经 classify_llm_error 分类、
厂商缓存参数（context caching 的 cachedContent 字段）。

行为约定（与 openai_compat / anthropic 对齐）：
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
    REASONING_EFFORTS,
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

# Gemini finishReason → 统一 finish_reason（不命中则原样小写透传）
_FINISH_REASON_MAP: dict[str, str] = {
    "STOP": "stop",
    "MAX_TOKENS": "length",
    "END_TURN": "stop",
}

# 推理档位 → thinkingConfig.thinkingBudget（低/中/高 token 预算；
# off = 0 显式关闭——仅 Gemini 2.5 Flash 等支持关闭的模型生效）。
_GEMINI_THINKING_BUDGET: dict[str, int] = {
    "low": 1024,
    "medium": 8192,
    "high": 16384,
}


async def _retry_backoff(attempt: int) -> None:
    """瞬时故障重试前的指数退避（attempt = 已失败次数，0 起）。"""
    delay = min(_RETRY_BASE_DELAY * (2**attempt), _RETRY_MAX_DELAY)
    await asyncio.sleep(delay)


class GeminiLLM(AsyncLLM):
    """Google Gemini generateContent / streamGenerateContent 适配器。"""

    adapter = "gemini"

    def __init__(self, config: LLMConfig, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        super().__init__(config)
        self._transport = transport  # 测试注入（MockTransport）；None = 生产默认
        self._client: httpx.AsyncClient | None = None  # 惰性长生命周期 client

    # ------------------------------------------------------------------
    # 请求构造
    # ------------------------------------------------------------------
    @property
    def _base_endpoint(self) -> str:
        return self.config.base_url.rstrip("/") + "/models/" + self.config.model_id

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
        headers = {"Content-Type": "application/json"}
        if self.config.api_key:
            # Gemini 用 x-goog-api-key 头（等效 ?key= 查询参数，免 URL 拼装）
            headers["x-goog-api-key"] = self.config.api_key
        return headers

    def _system_text(self, messages: Sequence[Message]) -> str | None:
        for m in messages:
            if m.role == "system":
                return m.content or None
        return None

    def _to_contents(self, messages: Sequence[Message]) -> list[dict[str, Any]]:
        """引擎 Message → Gemini contents（system 抽离为 systemInstruction）。"""
        out: list[dict[str, Any]] = []
        for m in messages:
            if m.role == "system":
                continue
            if m.role == "tool":
                out.append(
                    {
                        "role": "user",
                        "parts": [
                            {"functionResponse": {"name": "", "response": {"result": m.content}}}
                        ],
                    }
                )
                continue
            role = "model" if m.role == "assistant" else "user"
            parts: list[dict[str, Any]] = []
            if m.content:
                parts.append({"text": m.content})
            if m.tool_calls:
                for tc in m.tool_calls:
                    parts.append(
                        {"functionCall": {"name": tc.name, "args": tc.parsed_arguments}}
                    )
            out.append({"role": role, "parts": parts})
        return out

    def _to_tools(self, tools: Sequence[ToolSpec]) -> dict[str, Any] | None:
        if not tools:
            return None
        declarations: list[dict[str, Any]] = []
        for spec in tools:
            data = spec.to_dict()
            declarations.append(
                {
                    "name": data["name"],
                    "description": data["description"],
                    "parameters": data["parameters"],
                }
            )
        return {"functionDeclarations": declarations}

    def _payload(
        self,
        messages: Sequence[Message],
        tools: Sequence[ToolSpec] | None,
        params: LLMParams | None,
        *,
        stream: bool,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"contents": self._to_contents(messages)}
        system = self._system_text(messages)
        if system is not None:
            payload["systemInstruction"] = {"parts": [{"text": system}]}
        gemini_tools = self._to_tools(list(tools)) if tools else None
        if gemini_tools:
            payload["tools"] = [gemini_tools]
        gen_config: dict[str, Any] = {}
        temperature = params.temperature if params and params.temperature is not None else self.config.temperature
        if temperature is not None:
            gen_config["temperature"] = temperature
        max_tokens = params.max_tokens if params and params.max_tokens is not None else self.config.max_tokens
        if max_tokens is not None:
            gen_config["maxOutputTokens"] = max_tokens
        # 推理档位（Gemini thinkingConfig）：显式档写入 generationConfig。
        # off = budget 0（模型支持关闭时生效）；低/中/高 = token 预算。
        effort = params.reasoning_effort if params is not None else None
        if effort is not None and effort in REASONING_EFFORTS:
            if effort == "off":
                gen_config["thinkingConfig"] = {"thinkingBudget": 0}
            else:
                gen_config["thinkingConfig"] = {
                    "thinkingBudget": _GEMINI_THINKING_BUDGET[effort]
                }
        if gen_config:
            payload["generationConfig"] = gen_config
        # 厂商缓存参数（各一行）：extra.cached_content 为真时引用已缓存上下文
        # （context caching），保持简单，满足契约测试即可
        cached = self.config.extra and self.config.extra.get("cached_content")
        if cached:
            payload["cachedContent"] = cached
        if params and params.extra_body:
            # extra_body 仅透传厂商扩展键：核心字段由适配器统一装配
            payload.update(
                {
                    k: v
                    for k, v in params.extra_body.items()
                    if k
                    not in (
                        "contents",
                        "systemInstruction",
                        "tools",
                        "generationConfig",
                        "cachedContent",
                    )
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

    def _chunk_from_response(self, obj: dict[str, Any]) -> LLMChunk | None:
        """把一个 Gemini 响应对象（含 candidates/usageMetadata）解析为 LLMChunk。"""
        token_parts: list[str] = []
        tool_deltas: list[ToolCallDelta] = []
        finish: str | None = None
        usage: dict[str, Any] | None = None
        candidates = obj.get("candidates")
        if isinstance(candidates, list):
            for cand in candidates:
                if not isinstance(cand, dict):
                    continue
                content = cand.get("content") or {}
                for part in content.get("parts") or []:
                    if not isinstance(part, dict):
                        continue
                    if "text" in part and isinstance(part["text"], str):
                        token_parts.append(part["text"])
                    elif "functionCall" in part:
                        fc = part["functionCall"] or {}
                        name = fc.get("name")
                        args = fc.get("args")
                        arguments = (
                            json.dumps(args, ensure_ascii=False)
                            if isinstance(args, (dict, list))
                            else (str(args) if args is not None else None)
                        )
                        tool_deltas.append(
                            ToolCallDelta(
                                index=0,
                                id=fc.get("id") if isinstance(fc.get("id"), str) else None,
                                name=name if isinstance(name, str) else None,
                                arguments_delta=arguments,
                            )
                        )
                reason = cand.get("finishReason")
                if isinstance(reason, str):
                    finish = _FINISH_REASON_MAP.get(reason, reason.lower())
        meta = obj.get("usageMetadata")
        if isinstance(meta, dict):
            usage = {
                "prompt_tokens": meta.get("promptTokenCount"),
                "completion_tokens": meta.get("candidatesTokenCount"),
            }
        if not token_parts and not tool_deltas and finish is None and usage is None:
            return None
        return LLMChunk(
            token="".join(token_parts) or None,
            tool_calls_delta=tool_deltas or None,
            finish_reason=finish,
            usage=usage,
        )

    def _parse_sse_line(self, line: str) -> LLMChunk | None:
        """解析单条 SSE data 帧（Gemini streamGenerateContent?alt=sse）。"""
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
        if "error" in obj:
            error = obj["error"]
            detail = error.get("message") if isinstance(error, dict) else str(error)
            code = error.get("status") if isinstance(error, dict) else None
            raise classify_llm_error(self._error_status_hint(code), detail=detail)
        return self._chunk_from_response(obj)

    @staticmethod
    def _error_status_hint(code: Any) -> int | None:
        """从 Gemini 错误 status 串猜 HTTP 状态码（分类提示）。"""
        if not isinstance(code, str):
            return None
        lowered = code.lower()
        if "unauthenticated" in lowered or "permission" in lowered:
            return 401
        if "not_found" in lowered:
            return 404
        if "resource_exhausted" in lowered or "quota" in lowered:
            return 429
        if "invalid" in lowered or "bad_request" in lowered:
            return 400
        if "unavailable" in lowered or "internal" in lowered or "deadline" in lowered:
            return 503
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
        endpoint = self._base_endpoint + ":generateContent"
        client = self._get_client()
        response: httpx.Response | None = None
        for attempt in range(_RETRY_MAX_ATTEMPTS):
            try:
                response = await client.post(endpoint, json=payload, headers=self._headers())
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
        candidates = obj.get("candidates")
        if not isinstance(candidates, list) or not candidates:
            raise LLMFormatError(detail=f"响应缺 candidates: {str(obj)[:200]}")
        cand = candidates[0]
        content = cand.get("content") if isinstance(cand, dict) else None
        text_parts: list[str] = []
        calls: list[ToolCall] = []
        if isinstance(content, dict):
            for part in content.get("parts") or []:
                if not isinstance(part, dict):
                    continue
                if "text" in part and isinstance(part["text"], str):
                    text_parts.append(part["text"])
                elif "functionCall" in part:
                    fc = part["functionCall"] or {}
                    args = fc.get("args")
                    arguments = (
                        json.dumps(args, ensure_ascii=False)
                        if isinstance(args, (dict, list))
                        else (str(args) if args is not None else "")
                    )
                    calls.append(
                        ToolCall(
                            id=str(fc.get("id") or ""),
                            name=str(fc.get("name") or ""),
                            arguments=arguments,
                        )
                    )
        finish = cand.get("finishReason")
        finish = _FINISH_REASON_MAP.get(finish, finish.lower()) if isinstance(finish, str) else None
        meta = obj.get("usageMetadata")
        usage_out = None
        if isinstance(meta, dict):
            usage_out = {
                "prompt_tokens": meta.get("promptTokenCount"),
                "completion_tokens": meta.get("candidatesTokenCount"),
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
        endpoint = self._base_endpoint + ":streamGenerateContent?alt=sse"
        client = self._get_client()
        for attempt in range(_RETRY_MAX_ATTEMPTS):
            emitted = False
            try:
                async with client.stream("POST", endpoint, json=payload, headers=self._headers()) as response:
                    await self._raise_for_status(response)
                    async for line in response.aiter_lines():
                        chunk = self._parse_sse_line(line)
                        if chunk is None:
                            continue
                        emitted = True
                        yield chunk
                    if not emitted:
                        raise LLMEmptyStreamError(detail=f"{endpoint} 流为空")
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


__all__ = ["GeminiLLM"]
