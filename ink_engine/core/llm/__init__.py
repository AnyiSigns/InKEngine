"""LLM 层（AsyncLLM + 厂商适配 + 工具 schema + 重试/备用链）。

替代 langchain 模型接入：统一接口、自写流式 SSE 解析、工具增量累积、
reasoning 透传、适配器注册机制（新厂商 = 新适配器类）、挡位级备用链
（重试/退避/备用切换/流式中断）。依赖 httpx（可选 extra [llm]）——
HTTP 适配器经 __getattr__ 惰性导入，仅使用消息/工具/异常等纯标准库
模块时不需要 httpx（核心包零运行时依赖承诺）。
"""
from __future__ import annotations

from ink_engine.core.llm.base import (
    AsyncLLM,
    LLMChunk,
    LLMConfig,
    LLMParams,
    LLMResult,
    ToolCallDelta,
    collect_result,
)
from ink_engine.core.llm.errors import (
    LLMAuthError,
    LLMBadRequestError,
    LLMConfigError,
    LLMEmptyStreamError,
    LLMError,
    LLMFormatError,
    LLMNetworkError,
    LLMNotFoundError,
    LLMRateLimitError,
    LLMServerError,
    LLMTimeoutError,
    LLMUnknownError,
    classify_llm_error,
    is_transient_llm_error,
)
from ink_engine.core.llm.fallback import ModelChain, RetryPolicy
from ink_engine.core.llm.messages import (
    Message,
    ToolCall,
    accumulate_tool_calls,
    assistant,
    system,
    tool_result,
    user,
)
from ink_engine.core.llm.registry import adapter_names, create_llm, get_adapter_class, register_adapter
from ink_engine.core.llm.tools import ToolSpec, to_openai_tools


def __getattr__(name: str):
    """PEP 562 惰性导出：OpenAICompatibleLLM 依赖 httpx，用到才导入。"""
    if name == "OpenAICompatibleLLM":
        try:
            from ink_engine.core.llm.openai_compat import OpenAICompatibleLLM
        except ModuleNotFoundError as exc:
            if getattr(exc, "name", None) == "httpx":
                raise ModuleNotFoundError(
                    "OpenAICompatibleLLM 需要 httpx：请安装 textforge-engine-core[llm]"
                ) from exc
            raise
        return OpenAICompatibleLLM
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

__all__ = [
    "AsyncLLM",
    "LLMAuthError",
    "LLMBadRequestError",
    "LLMChunk",
    "LLMConfig",
    "LLMConfigError",
    "LLMEmptyStreamError",
    "LLMError",
    "LLMFormatError",
    "LLMNetworkError",
    "LLMNotFoundError",
    "LLMParams",
    "LLMRateLimitError",
    "LLMResult",
    "LLMServerError",
    "LLMTimeoutError",
    "LLMUnknownError",
    "Message",
    "ModelChain",
    "OpenAICompatibleLLM",
    "RetryPolicy",
    "ToolCall",
    "ToolCallDelta",
    "ToolSpec",
    "accumulate_tool_calls",
    "adapter_names",
    "assistant",
    "classify_llm_error",
    "collect_result",
    "create_llm",
    "get_adapter_class",
    "is_transient_llm_error",
    "register_adapter",
    "system",
    "to_openai_tools",
    "tool_result",
    "user",
]
