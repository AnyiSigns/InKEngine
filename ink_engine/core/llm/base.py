"""统一 LLM 接口（AsyncLLM）与数据模型。

接口形态：AsyncLLM.astream(messages, tools, params) -> AsyncGenerator[LLMChunk]。
LLMChunk 增量语义（{token?, tool_calls_delta?, reasoning_token?} + finish_reason/usage
——增量演进加字段不破坏）；ainvoke 为非流式补全（压缩/审计/
章节生成等非流式路径）。厂商差异全部收敛到适配器内部（流式 SSE 解析、工具
增量、reasoning 透传），上层只消费统一增量模型。
"""
from __future__ import annotations

import abc
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from ink_engine.core.llm.errors import LLMConfigError
from ink_engine.core.llm.messages import Message, ToolCall, ToolCallDelta, accumulate_tool_calls
from ink_engine.core.llm.tools import ToolSpec

# from_dict 白名单键（模型配置形态：adapter/base_url/api_key/model_id/
# temperature/max_tokens/request_timeout）；未知键收进 extra 透传不破坏。
_CONFIG_KEYS = (
    "adapter",
    "base_url",
    "api_key",
    "model_id",
    "temperature",
    "max_tokens",
    "request_timeout",
)


@dataclass(frozen=True, slots=True)
class LLMConfig:
    """单个模型接入配置（主模型与备用模型共用同一形态）。

    Args:
        adapter: 适配器注册名（openai_compat 等，见 registry）。
        model_id: 模型标识（如 deepseek-chat）。
        base_url: API 根地址（如 https://api.deepseek.com/v1）。
        api_key: 调用密钥（可空——本地/免鉴权端点）。
        temperature: 默认采样温度（调用级 params.temperature 可覆盖）。
        max_tokens: 默认最大生成长度（调用级 params.max_tokens 可覆盖）。
        request_timeout: 单请求超时秒数（None = 适配器默认）。
        extra: 厂商扩展字段（透传不校验，适配器按需消费）。
    """

    adapter: str
    model_id: str
    base_url: str
    api_key: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    request_timeout: float | None = None
    extra: dict[str, Any] | None = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> LLMConfig:
        """从配置字典构建（模型配置形态兼容，未知键收进 extra）。

        Raises:
            LLMConfigError: adapter/model_id/base_url 缺失时。
        """
        d = {key: data.get(key) for key in _CONFIG_KEYS}
        for key in ("adapter", "model_id", "base_url"):
            if not d[key]:
                raise LLMConfigError(f"LLM 配置缺少必填字段: {key}")
        extra = {k: v for k, v in data.items() if k not in _CONFIG_KEYS}
        return cls(**d, extra=extra or None)


@dataclass(frozen=True, slots=True)
class LLMParams:
    """单次调用的参数覆盖（None 字段回落到配置默认）。"""

    temperature: float | None = None
    max_tokens: int | None = None
    extra_body: dict[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class LLMChunk:
    """流式增量帧：内容/推理/工具调用均为增量，累积由上层负责。

    - token: 正文内容增量；
    - reasoning_token: 推理内容增量（reasoning_content 透传）；
    - tool_calls_delta: 工具调用增量（同一帧可携带多个 index 的碎片）；
    - finish_reason: 终止原因（stop/tool_calls/length/...，通常末帧携带）；
    - usage: token 用量（服务端带 stream_options.include_usage 时末帧携带）。
    """

    token: str | None = None
    reasoning_token: str | None = None
    tool_calls_delta: list[ToolCallDelta] | None = None
    finish_reason: str | None = None
    usage: dict[str, Any] | None = None

    @property
    def is_empty(self) -> bool:
        """全空帧（仅 role 等无信息字段）——适配器应跳过不产出。"""
        return not any(
            (self.token, self.reasoning_token, self.tool_calls_delta, self.finish_reason, self.usage)
        )


@dataclass(slots=True)
class LLMResult:
    """一次 LLM 调用的最终结果（非流式调用 / 流式累积产物）。"""

    content: str = ""
    reasoning: str | None = None
    tool_calls: list[ToolCall] | None = None
    finish_reason: str | None = None
    usage: dict[str, Any] | None = None


class AsyncLLM(abc.ABC):
    """统一 LLM 接口：厂商适配器实现本类并注册到适配器注册表。

    约定：
    - messages: list[Message]（引擎消息数据类）；
    - tools: Sequence[ToolSpec] | None（引擎工具描述，适配器负责转协议格式）；
    - params: LLMParams | None（调用级覆盖）。
    - 失败一律抛 LLMError 子类（classify_llm_error 分类），
      CancelledError 原样透传（流式中断语义，上游请求由适配器终止）。
    """

    adapter: str = ""

    def __init__(self, config: LLMConfig) -> None:
        self.config = config

    @abc.abstractmethod
    async def ainvoke(
        self,
        messages: Sequence[Message],
        *,
        tools: Sequence[ToolSpec] | None = None,
        params: LLMParams | None = None,
    ) -> LLMResult:
        """非流式补全，返回最终结果。"""

    @abc.abstractmethod
    async def astream(
        self,
        messages: Sequence[Message],
        *,
        tools: Sequence[ToolSpec] | None = None,
        params: LLMParams | None = None,
    ) -> AsyncIterator[LLMChunk]:
        """流式补全，产出增量帧（内容/推理/工具调用/终止原因）。"""

    @abc.abstractmethod
    async def aclose(self) -> None:
        """释放适配器持有的长生命周期资源（如 HTTP 连接池），无资源时为空实现。"""


async def collect_result(stream: AsyncIterator[LLMChunk]) -> LLMResult:
    """把流式增量累积为 LLMResult（内容/推理拼接、工具调用按 index 合并）。"""
    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    deltas: list[ToolCallDelta] = []
    finish_reason: str | None = None
    usage: dict[str, Any] | None = None
    async for chunk in stream:
        if chunk.token:
            content_parts.append(chunk.token)
        if chunk.reasoning_token:
            reasoning_parts.append(chunk.reasoning_token)
        if chunk.tool_calls_delta:
            deltas.extend(chunk.tool_calls_delta)
        if chunk.finish_reason:
            finish_reason = chunk.finish_reason
        if chunk.usage:
            usage = chunk.usage
    tool_calls = accumulate_tool_calls(deltas)
    return LLMResult(
        content="".join(content_parts),
        reasoning="".join(reasoning_parts) or None,
        tool_calls=tool_calls or None,
        finish_reason=finish_reason,
        usage=usage,
    )


__all__ = [
    "AsyncLLM",
    "LLMChunk",
    "LLMConfig",
    "LLMParams",
    "LLMResult",
    "ToolCallDelta",
    "collect_result",
]
