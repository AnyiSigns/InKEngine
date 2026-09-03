"""推理档位（ReasoningTierLLM / 提供方推理样式推断）宿主层单测。

零网络：ReasoningTierLLM 用记录型 inner 校验 params 合并语义；
_infer_reasoning_style 为纯函数映射校验。
"""
from __future__ import annotations

import asyncio

from ink_engine.core.llm import LLMParams

from inkling_host.host import ReasoningTierLLM, _infer_reasoning_style


class _RecordingInner:
    def __init__(self) -> None:
        self.params_seen: list = []

    async def ainvoke(self, messages, *, tools=None, params=None):
        self.params_seen.append(params)
        return None

    async def astream(self, messages, *, tools=None, params=None):
        self.params_seen.append(params)
        return
        yield  # pragma: no cover

    async def aclose(self) -> None:
        return None


class TestReasoningTierLLM:
    def test_tier_fills_default_when_params_none(self):
        inner = _RecordingInner()
        llm = ReasoningTierLLM(inner, "low")
        asyncio.run(llm.ainvoke([{"role": "user", "content": "hi"}]))
        assert inner.params_seen[0] is not None
        assert inner.params_seen[0].reasoning_effort == "low"

    def test_no_tier_passes_params_untouched(self):
        inner = _RecordingInner()
        llm = ReasoningTierLLM(inner, None)
        asyncio.run(
            llm.ainvoke(
                [{"role": "user", "content": "hi"}],
                params=LLMParams(enable_thinking=True),
            )
        )
        assert inner.params_seen[0] == LLMParams(enable_thinking=True)
        assert inner.params_seen[0].reasoning_effort is None

    def test_explicit_effort_not_overridden(self):
        inner = _RecordingInner()
        llm = ReasoningTierLLM(inner, "medium")
        asyncio.run(
            llm.ainvoke(
                [{"role": "user", "content": "hi"}],
                params=LLMParams(reasoning_effort="high"),
            )
        )
        assert inner.params_seen[0].reasoning_effort == "high"

    def test_existing_fields_preserved_on_fill(self):
        inner = _RecordingInner()
        llm = ReasoningTierLLM(inner, "off")
        asyncio.run(
            llm.ainvoke(
                [{"role": "user", "content": "hi"}],
                params=LLMParams(enable_thinking=True, temperature=0.2),
            )
        )
        seen = inner.params_seen[0]
        assert seen.reasoning_effort == "off"
        assert seen.enable_thinking is True
        assert seen.temperature == 0.2

    def test_invalid_tier_ignored(self):
        inner = _RecordingInner()
        llm = ReasoningTierLLM(inner, "ultra")
        asyncio.run(llm.ainvoke([{"role": "user", "content": "hi"}]))
        assert inner.params_seen[0] is None


class TestInferReasoningStyle:
    def test_openai_defaults_effort(self):
        assert _infer_reasoning_style("openai", "openai_compatible") == "effort"
        assert _infer_reasoning_style("custom", "openai_compatible") == "effort"

    def test_boolean_family(self):
        assert _infer_reasoning_style("dashscope", "openai_compatible") == "boolean"
        assert _infer_reasoning_style("moonshot", "openai_compatible") == "boolean"
        assert _infer_reasoning_style("zhipu", "openai_compatible") == "boolean"
        assert _infer_reasoning_style("ollama", "openai_compatible") == "boolean"

    def test_deepseek_no_knob(self):
        assert _infer_reasoning_style("deepseek", "openai_compatible") == "none"

    def test_intrinsic_protocol_adapters(self):
        assert _infer_reasoning_style("anthropic", "anthropic_messages") == "effort"
        assert _infer_reasoning_style("google", "gemini") == "effort"
        assert _infer_reasoning_style("openai", "openai_responses") == "effort"
