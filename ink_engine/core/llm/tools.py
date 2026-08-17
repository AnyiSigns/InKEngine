"""工具 schema 自写转换（引擎 ToolSpec → OpenAI 兼容 tools JSON）。

工具描述与 langchain 解耦：ToolSpec 携带 name/description/parameters
（parameters 为 JSON Schema dict，或 pydantic BaseModel 类——检测到
时经 model_json_schema() 转换，pydantic 为可选依赖，未安装则报错）。
业务工具元数据（门控分级/敏感性等）不属引擎，由宿主注册表维护。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ink_engine.core.llm.errors import LLMConfigError

_EMPTY_PARAMETERS: dict[str, Any] = {"type": "object", "properties": {}}


def _pydantic_base():
    try:
        from pydantic import BaseModel
    except ImportError:
        return None
    return BaseModel


@dataclass(frozen=True, slots=True)
class ToolSpec:
    """引擎侧工具描述（宿主工具注册表 → 引擎 → OpenAI tools JSON）。"""

    name: str
    description: str = ""
    parameters: Any = None


def _resolve_parameters(parameters: Any) -> dict[str, Any]:
    """解析参数 schema：None → 空对象；dict 直通；pydantic 类转换。"""
    if parameters is None:
        return _EMPTY_PARAMETERS
    if isinstance(parameters, dict):
        return parameters
    base = _pydantic_base()
    if isinstance(parameters, type) and base is not None and issubclass(parameters, base):
        try:
            return parameters.model_json_schema()
        except Exception as exc:  # pydantic 版本差异/schema 生成失败
            raise LLMConfigError(f"pydantic 模型转 JSON Schema 失败: {parameters.__name__}") from exc
    if isinstance(parameters, type):
        raise LLMConfigError(
            f"parameters 需为 JSON Schema dict 或 pydantic BaseModel 类（pydantic 未安装时仅支持 dict）: {parameters!r}"
        )
    raise LLMConfigError(f"parameters 需为 JSON Schema dict 或 pydantic BaseModel 类: {type(parameters).__name__}")


def to_openai_tools(specs: list[ToolSpec]) -> list[dict[str, Any]]:
    """ToolSpec 列表 → OpenAI 兼容 tools 数组（type=function 形态）。"""
    result: list[dict[str, Any]] = []
    for spec in specs:
        if not spec.name:
            raise LLMConfigError("工具 name 必填")
        result.append(
            {
                "type": "function",
                "function": {
                    "name": spec.name,
                    "description": spec.description,
                    "parameters": _resolve_parameters(spec.parameters),
                },
            }
        )
    return result


__all__ = ["ToolSpec", "to_openai_tools"]
