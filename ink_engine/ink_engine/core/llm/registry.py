"""LLM 适配器注册机制（新厂商 = 注册新适配器类，配置驱动选择）。

注册表以适配器名 → 适配器类的映射承载「可插拔扩展点」：
- 内置协议全名（用户可辨别的常见 API 协议）：openai_compatible
  （chat/completions）/ openai_responses（Responses）/ anthropic_messages
  （Messages）；旧简称 openai_compat / openai_response / anthropic 注册为
  兼容别名（既有配置零迁移）；
- 常见 OpenAI 兼容厂商别名（openai/deepseek/zhipu/moonshot/ollama 均指向
  同一类，改 base_url 适配）；
- 新厂商：register_adapter 注册适配器类，配置 dict 的 adapter 字段驱动选择；
- 原生协议厂商：anthropic_messages / gemini 内置注册（各自独立适配器，
  非 OpenAI 兼容包装）；
- DashScope 兼容端点同样走 openai_compatible（base_url = .../compatible-mode/v1），
  专用原生协议适配待实际需要时再补（机制已预留）。

**内置注册惰性化**：核心包零运行时依赖承诺——仅使用 messages/tools 等
纯标准库模块时不要求 httpx；内置适配器在首次 create_llm/adapter_names/
get_adapter_class 时才注册，缺 httpx 时给出可操作的安装提示。
"""
from __future__ import annotations

import contextlib
from collections.abc import Mapping
from typing import Any

from ink_engine.core.llm.base import AsyncLLM, LLMConfig
from ink_engine.core.llm.errors import LLMConfigError

_LLM_REGISTRY: dict[str, type[AsyncLLM]] = {}
_BUILTINS_REGISTERED = False

# OpenAI 兼容厂商别名 → 内置适配器（注册表按需扩容，未知厂商显式报错）
_OPENAI_COMPAT_ALIASES = (
    "openai_compatible",  # 协议全名（规范名）
    "openai_compat",  # 兼容别名（旧配置零迁移）
    "openai",
    "deepseek",
    "zhipu",
    "moonshot",
    "ollama",
)


def register_adapter(name: str, cls: type[AsyncLLM]) -> None:
    """注册适配器类（可覆盖同名——宿主可换掉内置实现）。

    内置注册（_ensure_builtins）用 setdefault 不覆盖宿主注册；本入口显式
    赋值允许宿主/后注册覆盖同名适配器。
    """
    if not name:
        raise LLMConfigError("适配器注册名不能为空")
    # 缺 httpx 时自定义适配器注册不受阻（内置惰性，用不到即不依赖）
    with contextlib.suppress(LLMConfigError):
        _ensure_builtins()
    _LLM_REGISTRY[name] = cls


def _ensure_builtins() -> None:
    """惰性注册内置适配器（首次访问注册表面时执行，防 import 即要求 httpx）。

    只补缺省名（setdefault）：宿主已注册的同名适配器保持生效。
    """
    global _BUILTINS_REGISTERED
    if _BUILTINS_REGISTERED:
        return
    try:
        from ink_engine.core.llm.openai_compat import OpenAICompatibleLLM
    except ModuleNotFoundError as exc:
        if getattr(exc, "name", None) == "httpx":
            raise LLMConfigError(
                "LLM HTTP 适配器需要 httpx：请安装 textforge-engine-core[llm]"
            ) from exc
        raise
    for name in _OPENAI_COMPAT_ALIASES:
        _LLM_REGISTRY.setdefault(name, OpenAICompatibleLLM)
    # 原生协议厂商：anthropic_messages / gemini 各自独立适配器（非 OpenAI
    # 兼容包装），缺 httpx 时跳过（内置惰性，用不到即不依赖）
    try:
        from ink_engine.core.llm.anthropic import AnthropicLLM

        _LLM_REGISTRY.setdefault("anthropic_messages", AnthropicLLM)
        _LLM_REGISTRY.setdefault("anthropic", AnthropicLLM)  # 兼容别名
    except ModuleNotFoundError as exc:
        if getattr(exc, "name", None) == "httpx":
            pass  # 缺 httpx 时跳过原生适配器注册
        else:
            raise
    try:
        from ink_engine.core.llm.openai_response import OpenAIResponsesLLM

        _LLM_REGISTRY.setdefault("openai_responses", OpenAIResponsesLLM)
        _LLM_REGISTRY.setdefault("openai_response", OpenAIResponsesLLM)  # 兼容别名
    except ModuleNotFoundError as exc:
        if getattr(exc, "name", None) == "httpx":
            pass  # 缺 httpx 时跳过原生适配器注册
        else:
            raise
    try:
        from ink_engine.core.llm.gemini import GeminiLLM

        _LLM_REGISTRY.setdefault("gemini", GeminiLLM)
    except ModuleNotFoundError as exc:
        if getattr(exc, "name", None) == "httpx":
            pass  # 缺 httpx 时跳过原生适配器注册
        else:
            raise
    _BUILTINS_REGISTERED = True


def adapter_names() -> list[str]:
    _ensure_builtins()
    return sorted(_LLM_REGISTRY)


def get_adapter_class(name: str) -> type[AsyncLLM] | None:
    _ensure_builtins()
    return _LLM_REGISTRY.get(name)


def create_llm(config: LLMConfig | Mapping[str, Any]) -> AsyncLLM:
    """按配置创建 LLM 实例（配置驱动选择适配器）。

    Args:
        config: LLMConfig 或配置字典（dict 形态与既有模型配置兼容）。

    Raises:
        LLMConfigError: 适配器未注册 / 配置缺字段 / 缺 httpx 依赖时。
    """
    cfg = config if isinstance(config, LLMConfig) else LLMConfig.from_dict(config)
    _ensure_builtins()
    cls = _LLM_REGISTRY.get(cfg.adapter)
    if cls is None:
        raise LLMConfigError(
            f"未注册的 LLM 适配器: {cfg.adapter!r}（已注册: {', '.join(adapter_names()) or '无'}）"
        )
    return cls(cfg)


__all__ = [
    "adapter_names",
    "create_llm",
    "get_adapter_class",
    "register_adapter",
]
