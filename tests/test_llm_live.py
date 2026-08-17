"""真实厂商冒烟测试（opt-in：-m live + INKENGINE_LIVE_* 环境变量）。

验证清单第 2 条：E2 LLM 层真实厂商冒烟（流式/tool/reasoning 三项）。
默认不跑（pyproject addopts 排除 live marker）；显式 `pytest -m live` 时
必须设置 INKENGINE_LIVE_BASE_URL / INKENGINE_LIVE_API_KEY / INKENGINE_LIVE_MODEL
——环境变量缺失直接 fail（门禁不允许空跑：显式选中即代表要真实验证，
全 skip 的绿灯会掩盖"什么都没测"）。
单测主体（mock SSE）保证确定性；本文件只做端到端协议验证。
"""
from __future__ import annotations

import os

import pytest

pytestmark = pytest.mark.live

pytest.importorskip("httpx")

from engine_core.llm.base import LLMConfig, collect_result  # noqa: E402
from engine_core.llm.messages import user  # noqa: E402
from engine_core.llm.registry import create_llm  # noqa: E402
from engine_core.llm.tools import ToolSpec  # noqa: E402

WEATHER_TOOL = ToolSpec(
    name="get_weather",
    description="查询指定城市的天气",
    parameters={
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"],
    },
)


def _live_config() -> LLMConfig:
    base_url = os.environ.get("INKENGINE_LIVE_BASE_URL")
    api_key = os.environ.get("INKENGINE_LIVE_API_KEY")
    model = os.environ.get("INKENGINE_LIVE_MODEL")
    if not (base_url and api_key and model):
        pytest.fail(
            "显式运行 live 冒烟（-m live）但缺少 INKENGINE_LIVE_BASE_URL/"
            "API_KEY/MODEL 环境变量——门禁不允许空跑"
        )
    return LLMConfig(
        adapter="openai_compat",
        model_id=model,
        base_url=base_url,
        api_key=api_key,
        request_timeout=120.0,
    )


async def test_live_ainvoke():
    llm = create_llm(_live_config())
    result = await llm.ainvoke([user("请用一句话回答：今天是星期几？")])
    assert result.content.strip(), "非流式调用无内容产出"


async def test_live_stream_and_reasoning():
    llm = create_llm(_live_config())
    result = await collect_result(
        llm.astream([user("请用一句话回答：1+1 等于几？")])
    )
    assert result.content.strip(), "流式调用无内容产出"
    if result.reasoning:
        assert isinstance(result.reasoning, str) and len(result.reasoning) > 0


async def test_live_tool_call():
    llm = create_llm(_live_config())
    result = await llm.ainvoke(
        [user("请调用 get_weather 工具查询北京的天气")],
        tools=[WEATHER_TOOL],
    )
    assert result.tool_calls, "模型未产出工具调用"
    call = result.tool_calls[0]
    assert call.name == "get_weather"
    assert "city" in call.parsed_arguments
