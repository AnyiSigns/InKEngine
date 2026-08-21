"""Schema 校验器（L1 准入的机制件：字段必填/类型/枚举/范围声明校验）。

声明式数据形态：:class:`SchemaSpec` = 可序列化声明（字段清单 + 校验
约束），随补丁链版本化，与规则集/样例库同构（全部纯数据）；执行体
:class:`SchemaValidator` 按声明校验数据对象——L1「schema 校验（形式
合法）」的执行体，同时复用为知识条目标签化准入与调优样本采集的字段
口径校验。

设计取舍：
- 校验约束取「声明式够用」子集（必填/类型/枚举/数值范围/正则），不做
  Python 任意表达式——LLM 生成声明比代码安全可控（与规则 DSL 同哲学）；
- 未知字段默认忽略（schema 演进宽容：加字段不破坏旧数据校验），字段
  缺失按必填声明判定，不按「出现即合法」；
- 违规清单可读可审计（每条违规带字段名与原因，闸门失败原因直接可用）。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .exceptions import GraphDefinitionError

# 字段类型（声明式枚举，防魔法字符串）
FIELD_STRING = "string"
FIELD_NUMBER = "number"
FIELD_BOOL = "boolean"
FIELD_OBJECT = "object"
FIELD_ARRAY = "array"

_VALID_KINDS = (FIELD_STRING, FIELD_NUMBER, FIELD_BOOL, FIELD_OBJECT, FIELD_ARRAY)


@dataclass(frozen=True, slots=True)
class SchemaField:
    """一个字段的声明（名称 + 必填 + 类型 + 可选约束）。

    Attributes:
        name: 字段名（数据对象内的点分路径，如 "rule.predicate"）。
        required: 是否必填（缺失 = 违规；False = 缺失跳过其余约束）。
        kind: 字段类型（string/number/boolean/object/array）。
        enum: 枚举取值（kind=string 时校验取值 ∈ 枚举；空 = 不限）。
        min/max: 数值范围（kind=number 时校验；None = 不做边界判定）。
        pattern: 正则约束（kind=string 时整串匹配；None = 不限）。
    """

    name: str
    required: bool = False
    kind: str = FIELD_STRING
    enum: tuple[str, ...] = ()
    min: float | None = None
    max: float | None = None
    pattern: str | None = None

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {"name": self.name, "kind": self.kind}
        if self.required:
            data["required"] = True
        if self.enum:
            data["enum"] = list(self.enum)
        if self.min is not None:
            data["min"] = self.min
        if self.max is not None:
            data["max"] = self.max
        if self.pattern is not None:
            data["pattern"] = self.pattern
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SchemaField:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"字段声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        name = data.get("name")
        if not name or not isinstance(name, str):
            raise GraphDefinitionError("字段声明缺 name（字符串）")
        kind = data.get("kind", FIELD_STRING)
        if kind not in _VALID_KINDS:
            raise GraphDefinitionError(
                f"字段 {name} 的类型非法: {kind!r}（仅 {_VALID_KINDS}）"
            )
        enum = data.get("enum") or ()
        if not isinstance(enum, (list, tuple)) or not all(
            isinstance(item, str) for item in enum
        ):
            raise GraphDefinitionError(f"字段 {name} 的 enum 须为字符串清单")
        minimum = data.get("min")
        maximum = data.get("max")
        for bound in (minimum, maximum):
            if bound is not None:
                try:
                    float(bound)
                except (TypeError, ValueError) as exc:
                    raise GraphDefinitionError(
                        f"字段 {name} 的范围边界非法: {bound!r}"
                    ) from exc
        if minimum is not None and maximum is not None and float(minimum) > float(maximum):
            raise GraphDefinitionError(
                f"字段 {name} 的范围声明自相矛盾: min={minimum} > max={maximum}"
            )
        pattern = data.get("pattern")
        if pattern is not None:
            if not isinstance(pattern, str):
                raise GraphDefinitionError(f"字段 {name} 的 pattern 须为字符串")
            try:
                re.compile(pattern)
            except re.error as exc:
                raise GraphDefinitionError(
                    f"字段 {name} 的正则非法: {exc}"
                ) from exc
        return cls(
            name=name,
            required=bool(data.get("required", False)),
            kind=kind,
            enum=tuple(enum),
            min=float(minimum) if minimum is not None else None,
            max=float(maximum) if maximum is not None else None,
            pattern=pattern,
        )


@dataclass(frozen=True, slots=True)
class SchemaSpec:
    """Schema 声明（可序列化，随补丁链版本化/回退）。

    Attributes:
        name: schema 名（如 "knowledge_entry"）。
        fields: 字段声明序列（按声明序校验，违规输出同序稳定可断言）。
    """

    name: str
    fields: tuple[SchemaField, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "fields": [f.to_dict() for f in self.fields]}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SchemaSpec:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"schema 声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        name = data.get("name")
        if not name or not isinstance(name, str):
            raise GraphDefinitionError("schema 声明缺 name（字符串）")
        raw_fields = data.get("fields")
        if not isinstance(raw_fields, list):
            raise GraphDefinitionError("schema 声明缺 fields 清单")
        fields = tuple(SchemaField.from_dict(raw) for raw in raw_fields)
        seen: set[str] = set()
        for field in fields:
            if field.name in seen:
                raise GraphDefinitionError(f"schema 字段名重复: {field.name}")
            seen.add(field.name)
        return cls(name=name, fields=fields)


def _resolve_path(data: Any, path: str) -> Any:
    """点分路径取值（与规则 DSL 的 _get_path 同语义：缺段返回 None）。"""
    current = data
    for segment in path.split("."):
        if current is None or segment.startswith("_"):
            return None
        if isinstance(current, dict):
            current = current.get(segment)
        elif isinstance(current, (list, tuple)):
            try:
                current = current[int(segment)]
            except (ValueError, IndexError):
                return None
        else:
            current = getattr(current, segment, None)
    return current


def _type_mismatch(kind: str, value: Any) -> bool:
    """类型匹配判定（number 兼容 int/float；boolean 只认原生 bool）。"""
    if kind == FIELD_STRING:
        return not isinstance(value, str)
    if kind == FIELD_NUMBER:
        return not isinstance(value, (int, float)) or isinstance(value, bool)
    if kind == FIELD_BOOL:
        return not isinstance(value, bool)
    if kind == FIELD_OBJECT:
        return not isinstance(value, dict)
    if kind == FIELD_ARRAY:
        return not isinstance(value, list)
    return False


class SchemaValidator:
    """按声明校验数据对象：返回违规清单（空 = 通过）。

    校验语义：
    - 必填字段缺失 → 违规（required 声明）；
    - 类型不匹配 → 违规（枚举/范围/正则约束仅对匹配类型的值继续判定）；
    - 枚举：值 ∉ enum → 违规（kind=string 且声明了枚举时）；
    - 数值范围：min/max 越界 → 违规（kind=number 且声明了边界时）；
    - 正则：整串不匹配 → 违规（kind=string 且声明了 pattern 时）；
    - 未知字段忽略（schema 演进宽容），缺失字段仅按必填判定。
    """

    def validate(self, schema: SchemaSpec, data: dict[str, Any]) -> list[str]:
        """执行校验（纯函数式、无状态，可作模块级复用）。

        Returns:
            违规消息清单（空 = 通过）；每条消息含字段名与原因，闸门失败
            原因可直接展示/留痕。
        """
        if not isinstance(data, dict):
            return [f"数据对象须为 dict，收到 {type(data).__name__}"]
        violations: list[str] = []
        for field in schema.fields:
            value = _resolve_path(data, field.name)
            if value is None:
                if field.required:
                    violations.append(f"字段 {field.name} 缺失（必填）")
                continue
            if _type_mismatch(field.kind, value):
                violations.append(
                    f"字段 {field.name} 类型不匹配: 期望 {field.kind}，"
                    f"收到 {type(value).__name__}"
                )
                continue
            if field.kind == FIELD_STRING:
                if field.enum and value not in field.enum:
                    violations.append(
                        f"字段 {field.name} 取值非法: {value!r}（仅 {field.enum}）"
                    )
                if field.pattern is not None and re.fullmatch(field.pattern, value) is None:
                    violations.append(
                        f"字段 {field.name} 不满足正则约束: {field.pattern!r}"
                    )
            elif field.kind == FIELD_NUMBER:
                number = float(value)
                if field.min is not None and number < field.min:
                    violations.append(
                        f"字段 {field.name} 低于下限: {number} < {field.min}"
                    )
                if field.max is not None and number > field.max:
                    violations.append(
                        f"字段 {field.name} 超过上限: {number} > {field.max}"
                    )
        return violations

    def validate_ok(self, schema: SchemaSpec, data: dict[str, Any]) -> bool:
        """布尔判定便捷入口（零违规 = True；闸门组装用）。"""
        return not self.validate(schema, data)


__all__ = [
    "FIELD_ARRAY",
    "FIELD_BOOL",
    "FIELD_NUMBER",
    "FIELD_OBJECT",
    "FIELD_STRING",
    "SchemaField",
    "SchemaSpec",
    "SchemaValidator",
]
