"""工具 schema 自写转换（引擎 ToolSpec → OpenAI 兼容 tools JSON）。

工具描述自持：ToolSpec 携带 name/description/parameters
（parameters 为 JSON Schema dict，或 pydantic BaseModel 类——检测到
时经 model_json_schema() 转换，pydantic 为可选依赖，未安装则报错）。
业务工具元数据（门控分级/敏感性等）不属引擎，由宿主注册表维护；
permissions 为引擎侧声明式权限（``core.permissions`` 判定输入，
形态 ``domain:action:pattern``，缺省空 = 由宿主默认策略判定）。
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
    """引擎侧工具描述（宿主工具注册表 → 引擎 → OpenAI tools JSON）。

    Attributes:
        name: 工具名。
        description: 工具描述。
        parameters: 参数 schema（dict 或 pydantic 类）。
        permissions: 声明式权限（如 ``filesystem:write:/book/**``、
            ``process:exec:git|python``、``network:*.github.com``）；
            未声明权限的工具由 PermissionGate 按宿主默认策略判定
            （fail-closed 默认拒绝）。
    """

    name: str
    description: str = ""
    parameters: Any = None
    permissions: tuple[str, ...] = ()

    def to_dict(self) -> dict:
        """序列化为数据形态（工具 = 数据：可入 checkpoint/知识集/仓库）。

        parameters 统一解析为 JSON Schema dict（pydantic 类 → schema）——
        数据形态即 OpenAI 兼容形态，语义无损。
        """
        return {
            "name": self.name,
            "description": self.description,
            "parameters": _resolve_parameters(self.parameters),
            "permissions": list(self.permissions),
        }

    @classmethod
    def from_dict(cls, data: dict) -> ToolSpec:
        """从数据形态还原（未知键忽略，兼容增量演进）。"""
        return cls(
            name=data["name"],
            description=data.get("description") or "",
            parameters=data.get("parameters"),
            permissions=tuple(data.get("permissions") or ()),
        )


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
