"""LLM 适配器注册机制（新厂商 = 注册新适配器类，配置驱动选择）。

注册表以适配器名 → 适配器类的映射承载「可插拔扩展点」：
- 内置：openai_compat（规范名）+ 常见 OpenAI 兼容厂商别名
  （openai/deepseek/zhipu/moonshot/ollama 均指向同一类，改 base_url 适配）；
- 新厂商：register_adapter 注册适配器类，配置 dict 的 adapter 字段驱动选择；
- DashScope 兼容端点同样走 openai_compat（base_url = .../compatible-mode/v1），
  专用原生协议适配待实际需要时再补（机制已预留）。

**内置注册惰性化**：核心包零运行时依赖承诺——仅使用 messages/tools 等
纯标准库模块时不要求 httpx；内置适配器在首次 create_llm/adapter_names/
get_adapter_class 时才注册，缺 httpx 时给出可操作的安装提示。
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from engine_core.llm.base import AsyncLLM, LLMConfig
from engine_core.llm.errors import LLMConfigError

_LLM_REGISTRY: dict[str, type[AsyncLLM]] = {}
_BUILTINS_REGISTERED = False

# OpenAI 兼容厂商别名 → 内置适配器（注册表按需扩容，未知厂商显式报错）
_OPENAI_COMPAT_ALIASES = ("openai_compat", "openai", "deepseek", "zhipu", "moonshot", "ollama")


def register_adapter(name: str, cls: type[AsyncLLM]) -> None:
    """注册适配器类（可覆盖同名——宿主可换掉内置实现）。"""
    if not name:
        raise LLMConfigError("适配器注册名不能为空")
    _LLM_REGISTRY[name] = cls


def _ensure_builtins() -> None:
    """惰性注册内置适配器（首次访问注册表面时执行，防 import 即要求 httpx）。"""
    global _BUILTINS_REGISTERED
    if _BUILTINS_REGISTERED:
        return
    try:
        from engine_core.llm.openai_compat import OpenAICompatibleLLM
    except ModuleNotFoundError as exc:
        if getattr(exc, "name", None) == "httpx":
            raise LLMConfigError(
                "LLM HTTP 适配器需要 httpx：请安装 textforge-engine-core[llm]"
            ) from exc
        raise
    for name in _OPENAI_COMPAT_ALIASES:
        _LLM_REGISTRY[name] = OpenAICompatibleLLM
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
        config: LLMConfig 或配置字典（dict 形态与 v3 模型配置兼容）。

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
