"""LLM 适配器注册机制单测（新厂商 = 注册新适配器类，配置驱动选择）。"""
from __future__ import annotations

import pytest

from ink_engine.core.llm.base import AsyncLLM, LLMConfig
from ink_engine.core.llm.errors import LLMConfigError
from ink_engine.core.llm.openai_compat import OpenAICompatibleLLM
from ink_engine.core.llm.registry import (
    adapter_names,
    create_llm,
    get_adapter_class,
    register_adapter,
)


class TestRegistry:
    def test_builtin_adapters(self):
        names = adapter_names()
        assert "openai_compat" in names
        # OpenAI 兼容厂商别名齐备（adapter 名直接可用）
        for alias in ("openai", "deepseek", "zhipu", "moonshot", "ollama"):
            assert alias in names

    def test_builtin_aliases_share_class(self):
        cls = get_adapter_class("openai_compat")
        assert cls is OpenAICompatibleLLM
        for alias in ("openai", "deepseek", "zhipu", "moonshot", "ollama"):
            assert get_adapter_class(alias) is cls

    def test_create_llm_from_dict(self):
        llm = create_llm(
            {
                "adapter": "deepseek",
                "model_id": "deepseek-chat",
                "base_url": "https://api.deepseek.com/v1",
                "api_key": "k",
                "temperature": 0.3,
            }
        )
        assert isinstance(llm, OpenAICompatibleLLM)
        assert llm.config.model_id == "deepseek-chat"
        assert llm.config.temperature == 0.3

    def test_create_llm_from_config(self):
        cfg = LLMConfig(adapter="openai_compat", model_id="m", base_url="http://x")
        llm = create_llm(cfg)
        assert isinstance(llm, OpenAICompatibleLLM)
        assert llm.config is cfg

    def test_unknown_adapter_rejected(self):
        with pytest.raises(LLMConfigError) as exc_info:
            create_llm({"adapter": "unknown_vendor", "model_id": "m", "base_url": "http://x"})
        assert "未注册的 LLM 适配器" in str(exc_info.value)

    def test_custom_adapter_registration(self):
        class CustomLLM(AsyncLLM):
            adapter = "custom"

            def __init__(self, config):
                super().__init__(config)
                self.created_with = config

            async def ainvoke(self, messages, *, tools=None, params=None):
                raise NotImplementedError

            async def astream(self, messages, *, tools=None, params=None):
                raise NotImplementedError

            async def aclose(self) -> None:
                pass

        try:
            register_adapter("custom", CustomLLM)
            assert get_adapter_class("custom") is CustomLLM
            llm = create_llm({"adapter": "custom", "model_id": "m", "base_url": "http://x"})
            assert isinstance(llm, CustomLLM)
            assert llm.created_with.model_id == "m"
        finally:
            register_adapter("custom", CustomLLM)  # 覆盖回（同名键语义）
            from ink_engine.core.llm.registry import _LLM_REGISTRY

            _LLM_REGISTRY.pop("custom", None)

    def test_register_overwrites_same_name(self):
        class V2LLM(OpenAICompatibleLLM):
            adapter = "openai_compat"

        register_adapter("openai_compat", V2LLM)
        try:
            assert get_adapter_class("openai_compat") is V2LLM
        finally:
            register_adapter("openai_compat", OpenAICompatibleLLM)

    def test_builtins_do_not_overwrite_host_registration(self):
        """回归：宿主先注册的同名适配器不被惰性内置注册静默覆盖（setdefault）。"""

        class MineLLM(OpenAICompatibleLLM):
            adapter = "openai"

        register_adapter("openai", MineLLM)
        try:
            assert get_adapter_class("openai") is MineLLM
        finally:
            register_adapter("openai", OpenAICompatibleLLM)

    def test_empty_name_rejected(self):
        with pytest.raises(LLMConfigError):
            register_adapter("", OpenAICompatibleLLM)
