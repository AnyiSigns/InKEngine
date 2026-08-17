"""工具 schema 转换单测（ToolSpec → OpenAI tools JSON）。"""
from __future__ import annotations

import pytest

from ink_engine.core.llm.errors import LLMConfigError
from ink_engine.core.llm.tools import ToolSpec, to_openai_tools

EMPTY_PARAMS = {"type": "object", "properties": {}}


class TestToOpenaiTools:
    def test_none_parameters_defaults_to_empty_object(self):
        tools = to_openai_tools([ToolSpec(name="t1", description="desc")])
        assert tools == [
            {
                "type": "function",
                "function": {"name": "t1", "description": "desc", "parameters": EMPTY_PARAMS},
            }
        ]

    def test_dict_parameters_passthrough(self):
        params = {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        }
        tools = to_openai_tools([ToolSpec(name="get_weather", description="查询天气", parameters=params)])
        assert tools[0]["function"]["parameters"] is params

    def test_multiple_tools(self):
        tools = to_openai_tools(
            [ToolSpec(name="a"), ToolSpec(name="b", description="B")]
        )
        assert [t["function"]["name"] for t in tools] == ["a", "b"]

    def test_empty_name_rejected(self):
        with pytest.raises(LLMConfigError):
            to_openai_tools([ToolSpec(name="")])

    def test_bad_parameters_type_rejected(self):
        with pytest.raises(LLMConfigError):
            to_openai_tools([ToolSpec(name="t", parameters=42)])


class TestPydanticConversion:
    def test_basemodel_parameters(self):
        pydantic = pytest.importorskip("pydantic")

        class WeatherParams(pydantic.BaseModel):
            city: str
            days: int = 1

        tools = to_openai_tools([ToolSpec(name="get_weather", parameters=WeatherParams)])
        schema = tools[0]["function"]["parameters"]
        assert schema["type"] == "object"
        assert "city" in schema["properties"]
        assert "days" in schema["properties"]

    def test_non_pydantic_class_rejected(self):
        class PlainClass:
            pass

        with pytest.raises(LLMConfigError):
            to_openai_tools([ToolSpec(name="t", parameters=PlainClass)])
