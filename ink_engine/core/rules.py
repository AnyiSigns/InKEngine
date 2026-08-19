"""声明式规则引擎（受限规则 DSL：规则 = 数据，解释器 = 注册谓词）。

核声明式化的机制层：领域算法降维为声明式知识（规则集），「核不用写」——
规则生成方（LLM/用户）产出的是**声明数据**（谓词名 + 参数），执行语义由
注册谓词决定，不提供任意代码执行（DSL 拒绝图灵完备，LLM 判定走
:class:`ConstraintChecker` 的 fail-open 钩子）。

数据形态（全部可 JSON 序列化，随补丁链版本化/回退）：

- :class:`Rule`：一条规则（类型 + 谓词名 + 参数 + 目标路径 + 违规元数据）；
- :class:`RuleSet`：规则集（知识集内规则的载体）；
- :class:`FixtureCase` / :class:`FixtureSet`：样例库（每个知识集自带，
  新规则必须先让 fixture 全绿才允许落库——非谈判项）；
- :class:`RuleViolation`：一条违规（kind/severity/message/entity 可审计留痕）。

执行机制：

- :class:`RuleTypeRegistry`：谓词注册表（内置通用谓词 + 领域注册谓词，
  与 NodeTypeRegistry 同哲学：注册方决定名字存在与执行语义）；
- :class:`RuleEngine`：确定性执行（规则集 × 数据对象 → 违规清单，逐条
  谓词异常 fail-open 跳过并留痕——规则引擎是增强护栏不是写门禁）；
- :class:`ConstraintChecker`：混合判定门面（确定性规则 + 可选 LLM 钩子
  承接规则覆盖不到的深度启发式，钩子异常同样 fail-open）。

违规严重度与类别沿用领域约定（error/warning + 领域 kind 标签），
与领域种子包（``seeds/novel``）的规则集词汇对齐——规则化路径产出的
问题可直接进入既有审核卡。
"""
from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .exceptions import FixtureGateError, GraphDefinitionError
from .state_machine import StateMachine

logger = logging.getLogger(__name__)

# 规则类型（枚举化防魔法值）：constraint = 约束/校验；transition = 状态转换
RULE_CONSTRAINT = "constraint"
RULE_TRANSITION = "transition"

# 规则类型合法取值（Rule.from_dict 校验用）
_VALID_RULE_TYPES = (RULE_CONSTRAINT, RULE_TRANSITION)

# 违规严重度（与领域约定对齐：error = 硬冲突需裁决 / warning = 提示级）
SEVERITY_ERROR = "error"
SEVERITY_WARNING = "warning"
_VALID_SEVERITIES = (SEVERITY_ERROR, SEVERITY_WARNING)

# 谓词签名：(target, config, context) -> 违规清单（空 = 通过）。
# context = 评估上下文，引擎注入 {"root": 数据对象}，调用方可增补
# （如输入文本/调用时参数——规则集保持静态，运行时参数走 context）。
RulePredicate = Callable[
    [Any, dict[str, Any], dict[str, Any] | None], list[dict[str, Any]]
]

# LLM 钩子签名：深度启发式补充判定（返回违规清单；异常 fail-open 跳过）
# 入参 = (数据对象, 评估上下文, 确定性规则已产出的违规)。
RuleHook = Callable[
    [Any, dict[str, Any] | None, tuple["RuleViolation", ...]],
    list[dict[str, Any]],
]

# 钩子违规的 rule_id 占位（区分于规则违规，留痕可审计）
HOOK_RULE_ID = "__llm_hook__"


# -- 规则数据 ----------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class RuleViolation:
    """一条规则违规（可序列化，审核卡 conflicts 字段的可对齐单元）。

    Attributes:
        rule_id: 来源规则 id（钩子违规为 ``__llm_hook__``）。
        kind: 违规类别（领域标签，如 knowledge_gap/causal_chain）。
        severity: error = 硬冲突需裁决 / warning = 提示级。
        message: 人类可读的违规说明。
        entity_type: 关联实体类型（character/event/foreshadowing 等）。
        entity_id: 关联实体 id。
    """

    rule_id: str
    kind: str
    severity: str
    message: str
    entity_type: str | None = None
    entity_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "rule_id": self.rule_id,
            "kind": self.kind,
            "severity": self.severity,
            "message": self.message,
            "entity_type": self.entity_type,
            "entity_id": self.entity_id,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> RuleViolation:
        """从存储/传输数据还原（字段缺失走默认值，兼容增量演进）。"""
        return cls(
            rule_id=str(data["rule_id"]),
            kind=str(data.get("kind", "rule")),
            severity=str(data.get("severity", SEVERITY_ERROR)),
            message=str(data["message"]),
            entity_type=data.get("entity_type"),
            entity_id=data.get("entity_id"),
        )


@dataclass(frozen=True, slots=True)
class Rule:
    """一条声明式规则（纯数据：谓词名 + 参数，不携带执行代码）。

    Attributes:
        id: 规则 id（规则集内唯一，留痕/夹具断言锚点）。
        predicate: 注册谓词名（RuleTypeRegistry 解析；未知谓词建图期拒绝）。
        config: 谓词参数（数据访问路径/目标值/阈值等，谓词自解释）。
        type: 规则类型（constraint = 约束/校验，transition = 状态转换）。
        target_path: 数据对象上的作用域路径（点分路径；None = 整对象）。
        iterate_items: 目标为集合时逐条执行谓词（谓词按单条判定，如
            in_enum 枚举合法性）；False = 谓词接收整个目标（需跨条目
            上下文/去重的谓词，如 unique_pairs）。
        severity: 违规严重度（error/warning）。
        kind: 违规类别标签（领域语义，留痕与夹具断言用）。
        entity_type: 关联实体类型（留痕）。
        description: 规则说明（人类可读，可解释性）。
    """

    id: str
    predicate: str
    config: dict[str, Any] = field(default_factory=dict)
    type: str = RULE_CONSTRAINT
    target_path: str | None = None
    iterate_items: bool = False
    severity: str = SEVERITY_ERROR
    kind: str = "rule"
    entity_type: str | None = None
    description: str = ""

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "id": self.id,
            "predicate": self.predicate,
            "config": dict(self.config),
        }
        if self.type != RULE_CONSTRAINT:
            data["type"] = self.type
        if self.target_path is not None:
            data["target_path"] = self.target_path
        if self.iterate_items:
            data["iterate_items"] = True
        if self.severity != SEVERITY_ERROR:
            data["severity"] = self.severity
        if self.kind != "rule":
            data["kind"] = self.kind
        if self.entity_type is not None:
            data["entity_type"] = self.entity_type
        if self.description:
            data["description"] = self.description
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Rule:
        """从声明数据还原（构造即校验：字段形态/枚举值非法建图期拒绝）。

        Raises:
            GraphDefinitionError: 缺 id/predicate、config 非 dict、
                type/severity 非法取值。
        """
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"规则声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        rule_id = data.get("id")
        predicate = data.get("predicate")
        if not rule_id or not isinstance(rule_id, str):
            raise GraphDefinitionError("规则声明缺 id（字符串）")
        if not predicate or not isinstance(predicate, str):
            raise GraphDefinitionError(f"规则 {rule_id} 缺 predicate（字符串）")
        config = data.get("config") or {}
        if not isinstance(config, dict):
            raise GraphDefinitionError(
                f"规则 {rule_id} 的 config 须为 dict，收到 {type(config).__name__}"
            )
        rule_type = data.get("type", RULE_CONSTRAINT)
        if rule_type not in _VALID_RULE_TYPES:
            raise GraphDefinitionError(
                f"规则 {rule_id} 的类型非法: {rule_type!r}（仅 {_VALID_RULE_TYPES}）"
            )
        severity = data.get("severity", SEVERITY_ERROR)
        if severity not in _VALID_SEVERITIES:
            raise GraphDefinitionError(
                f"规则 {rule_id} 的严重度非法: {severity!r}（仅 {_VALID_SEVERITIES}）"
            )
        target_path = data.get("target_path")
        if target_path is not None and not isinstance(target_path, str):
            raise GraphDefinitionError(
                f"规则 {rule_id} 的 target_path 须为字符串或省略"
            )
        iterate_items = data.get("iterate_items", False)
        if not isinstance(iterate_items, bool):
            raise GraphDefinitionError(
                f"规则 {rule_id} 的 iterate_items 须为布尔值"
            )
        kind = data.get("kind", "rule")
        if not isinstance(kind, str):
            raise GraphDefinitionError(f"规则 {rule_id} 的 kind 须为字符串")
        entity_type = data.get("entity_type")
        if entity_type is not None and not isinstance(entity_type, str):
            raise GraphDefinitionError(f"规则 {rule_id} 的 entity_type 须为字符串或省略")
        description = data.get("description", "")
        if not isinstance(description, str):
            raise GraphDefinitionError(f"规则 {rule_id} 的 description 须为字符串")
        return cls(
            id=rule_id,
            predicate=predicate,
            config=config,
            type=rule_type,
            target_path=target_path,
            iterate_items=iterate_items,
            severity=severity,
            kind=kind,
            entity_type=entity_type,
            description=description,
        )


@dataclass(frozen=True, slots=True)
class RuleSet:
    """规则集（知识集内规则的载体，纯数据可随补丁链版本化/回退）。

    Attributes:
        name: 规则集名（如 novel.world_state）。
        rules: 规则序列（按声明序执行）。
        description: 规则集说明。
    """

    name: str
    rules: tuple[Rule, ...]
    description: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "rules": [rule.to_dict() for rule in self.rules],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> RuleSet:
        """从声明数据还原（逐条规则构造即校验，非法声明建图期拒绝）。"""
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"规则集声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        name = data.get("name")
        if not name or not isinstance(name, str):
            raise GraphDefinitionError("规则集缺 name（字符串）")
        raw_rules = data.get("rules")
        if not isinstance(raw_rules, list):
            raise GraphDefinitionError("规则集缺 rules 清单")
        return cls(
            name=name,
            rules=tuple(Rule.from_dict(raw) for raw in raw_rules),
            description=data.get("description", ""),
        )

    @classmethod
    def parse(
        cls,
        data: dict[str, Any],
        registry: RuleTypeRegistry | None = None,
    ) -> RuleSet:
        """解析并校验规则集声明（谓词名存在性在建图期暴露，不延后到执行期）。

        Args:
            data: 规则集声明数据（LLM 生成/导入形态）。
            registry: 谓词注册表；提供时逐条校验谓词已注册（未知谓词 =
                声明错误，显式拒绝而非执行期静默跳过）。

        Raises:
            GraphDefinitionError: 声明形态非法/规则 id 重复/谓词未注册。
        """
        rule_set = cls.from_dict(data)
        seen: set[str] = set()
        for rule in rule_set.rules:
            if rule.id in seen:
                raise GraphDefinitionError(
                    f"规则集 {rule_set.name} 规则 id 重复: {rule.id}"
                )
            seen.add(rule.id)
            if registry is not None:
                if not registry.has(rule.predicate):
                    raise GraphDefinitionError(
                        f"规则集 {rule_set.name} 引用了未注册的谓词: "
                        f"{rule.predicate}（规则 {rule.id}）"
                    )
                # 谓词 config 形态校验（声明错误在建图期暴露，不延后到
                # 执行期 fail-open 静默失效）
                registry.validate_config(rule.id, rule.predicate, rule.config)
        return rule_set


# -- 谓词注册表 --------------------------------------------------------------


class RuleTypeRegistry:
    """谓词注册表：谓词名 → 执行函数（内置通用谓词 + 领域注册谓词）。

    与 :class:`ink_engine.core.registry.NodeTypeRegistry` 同哲学：谓词名
    是不透明字符串，注册表不解释含义；哪些名字存在、如何判定，由注册方
    决定。内置通用谓词（通用种子：字段存在/比较/枚举/包含/唯一性/状态
    转换）构造时自动登记；领域谓词经 :meth:`register` 增补。重复注册
    （含覆盖内置谓词）视为编程错误，显式拒绝。
    """

    def __init__(self) -> None:
        self._predicates: dict[str, RulePredicate] = dict(_BUILTIN_PREDICATES)
        # 谓词 config 校验器（声明错误建图期暴露；未登记校验器 = 不校验）
        self._config_validators: dict[str, PredicateConfigValidator] = dict(
            _BUILTIN_CONFIG_VALIDATORS
        )

    def register(self, name: str, predicate: RulePredicate) -> None:
        """登记谓词名 → 执行函数（重复登记抛错，防静默覆盖语义）。"""
        if name in self._predicates:
            raise GraphDefinitionError(f"谓词重复注册: {name}")
        self._predicates[name] = predicate

    def register_config_validator(
        self, name: str, validator: PredicateConfigValidator
    ) -> None:
        """登记谓词 config 校验器（校验规则 id + config 形态，非法抛错）。

        领域谓词可随注册登记校验器；未登记 = 该谓词 config 不做建图期
        形态校验（执行期仍由谓词自身兜底 fail-open）。
        """
        if name not in self._predicates:
            raise GraphDefinitionError(f"config 校验器须先登记谓词: {name}")
        if name in self._config_validators:
            raise GraphDefinitionError(f"config 校验器重复登记: {name}")
        self._config_validators[name] = validator

    def validate_config(self, rule_id: str, name: str, config: dict[str, Any]) -> None:
        """按谓词名的 config 形态校验（无登记 = 跳过；非法抛声明错误）。"""
        validator = self._config_validators.get(name)
        if validator is not None:
            validator(rule_id, config)

    def create(self, name: str) -> RulePredicate:
        """按谓词名取执行函数（未知谓词抛错——引用即声明错误）。"""
        predicate = self._predicates.get(name)
        if predicate is None:
            raise GraphDefinitionError(f"未知谓词: {name}")
        return predicate

    def has(self, name: str) -> bool:
        return name in self._predicates

    def names(self) -> tuple[str, ...]:
        """已注册谓词名（插入序，供校验/展示）。"""
        return tuple(self._predicates)

    def __len__(self) -> int:
        return len(self._predicates)


# -- 内置通用谓词（确定性、零 LLM 调用） ---------------------------------------


def _get_path(obj: Any, path: str | None) -> Any:
    """点分路径取值：属性/字典键/列表下标逐段解析；空路径 = 对象本身。

    解析失败或值为 None 均返回 None——「字段缺失 = 规则不适用」由引擎
    跳过（适用性显式断言用 present/absent 谓词，不混在取值里）。
    下划线前缀段（__dunder/私有成员）一律拒绝返回 None：规则 DSL 是
    受限数据访问（LLM 生成声明），不暴露对象内部属性。
    """
    if not path:
        return obj
    current = obj
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
            try:
                current = getattr(current, segment, None)
            except AttributeError:
                # 属性访问器自身抛错（property getter 异常等）：按缺失
                # 处理——取值失败不穿透破坏 fail-open 闭环
                return None
    return current


def _issue(
    config: dict[str, Any], default_message: str, entity_id: Any = None
) -> list[dict[str, Any]]:
    """谓词违规便捷构造：默认消息可被配置覆盖，实体 id 可选。"""
    return [
        {
            "message": str(config.get("message", default_message)),
            "entity_id": config.get("entity_id", entity_id),
        }
    ]


def _pred_present(target: Any, config: dict[str, Any], _context: dict[str, Any] | None):
    """present：字段存在（非 None）。config: {path}。"""
    path = config.get("path")
    if _get_path(target, path) is None:
        return _issue(config, f"字段缺失: {path or '<root>'}")
    return []


def _pred_absent(target: Any, config: dict[str, Any], _context: dict[str, Any] | None):
    """absent：字段缺失（None）。config: {path}。"""
    path = config.get("path")
    if _get_path(target, path) is not None:
        return _issue(config, f"字段不应存在: {path or '<root>'}")
    return []


def _pred_equals(target: Any, config: dict[str, Any], _context: dict[str, Any] | None):
    """equals：字段值等于目标值。config: {path, value}。"""
    path = config.get("path")
    if _get_path(target, path) == config.get("value"):
        return []
    return _issue(
        config,
        f"字段 {path or '<root>'} 不等于期望值 {config.get('value')!r}",
    )


def _pred_not_equals(target: Any, config: dict[str, Any], _context: dict[str, Any] | None):
    """not_equals：字段值不等于目标值。config: {path, value}。"""
    path = config.get("path")
    if _get_path(target, path) != config.get("value"):
        return []
    return _issue(
        config,
        f"字段 {path or '<root>'} 等于禁止值 {config.get('value')!r}",
    )


_COMPARE_OPS = ("lt", "lte", "gt", "gte", "eq", "ne")


def _pred_compare(target: Any, config: dict[str, Any], _context: dict[str, Any] | None):
    """compare：数值比较。config: {path, op, value | other_path}。

    ``value`` = 字面量比较；``other_path`` = 与对象内另一字段比较
    （二选一）。任一侧缺失/不可比较 = 规则不适用（跳过，不误报）。
    """
    op = config.get("op")
    if op not in _COMPARE_OPS:
        raise ValueError(f"compare 谓词的 op 非法: {op!r}（仅 {_COMPARE_OPS}）")
    left = _get_path(target, config.get("path"))
    if "other_path" in config:
        right = _get_path(target, config.get("other_path"))
    else:
        right = config.get("value")
    if left is None or right is None:
        return []
    try:
        matched = {
            "lt": left < right,
            "lte": left <= right,
            "gt": left > right,
            "gte": left >= right,
            "eq": left == right,
            "ne": left != right,
        }[op]
    except TypeError:
        return []  # 类型不可比较 = 数据形态不适用，规则跳过
    if matched:
        return []
    return _issue(
        config,
        f"字段 {config.get('path') or '<root>'} ({left!r}) 不满足 {op} {right!r}",
    )


def _pred_in_enum(target: Any, config: dict[str, Any], _context: dict[str, Any] | None):
    """in_enum：字段值在合法取值集内（枚举合法性）。config: {path, values}。"""
    values = config.get("values")
    if not isinstance(values, (list, tuple, set, frozenset)):
        raise ValueError("in_enum 谓词缺 values 清单")
    value = _get_path(target, config.get("path"))
    if value in values:
        return []
    return _issue(
        config,
        f"字段 {config.get('path') or '<root>'} 取值 {value!r} 不在合法集内: "
        f"{sorted(values)}",
    )


def _pred_not_in_enum(
    target: Any, config: dict[str, Any], _context: dict[str, Any] | None
):
    """not_in_enum：字段值不在禁止集内。config: {path, values}。"""
    values = config.get("values")
    if not isinstance(values, (list, tuple, set, frozenset)):
        raise ValueError("not_in_enum 谓词缺 values 清单")
    value = _get_path(target, config.get("path"))
    if value not in values:
        return []
    return _issue(
        config,
        f"字段 {config.get('path') or '<root>'} 取值 {value!r} 在禁止集内: "
        f"{sorted(values)}",
    )


def _pred_contains(target: Any, config: dict[str, Any], _context: dict[str, Any] | None):
    """contains：字段（字符串/集合）包含指定值。config: {path, value}。"""
    haystack = _get_path(target, config.get("path"))
    needle = config.get("value")
    if haystack is None or needle is None:
        return []
    hit = (
        needle in haystack
        if isinstance(haystack, str)
        else needle in haystack
        if isinstance(haystack, (list, tuple, set, frozenset, dict))
        else False
    )
    if hit:
        return []
    return _issue(config, f"字段 {config.get('path') or '<root>'} 不含 {needle!r}")


def _pred_not_contains(
    target: Any, config: dict[str, Any], _context: dict[str, Any] | None
):
    """not_contains：字段（字符串/集合）不包含指定值。config: {path, value}。"""
    haystack = _get_path(target, config.get("path"))
    needle = config.get("value")
    if haystack is None or needle is None:
        return []
    hit = (
        needle in haystack
        if isinstance(haystack, str)
        else needle in haystack
        if isinstance(haystack, (list, tuple, set, frozenset, dict))
        else False
    )
    if not hit:
        return []
    return _issue(config, f"字段 {config.get('path') or '<root>'} 含禁止值 {needle!r}")


def _pred_unique_pairs(
    target: Any, config: dict[str, Any], _context: dict[str, Any] | None
):
    """unique_pairs：集合内条目在指定键组合上唯一（重复登记检测）。

    config: {keys: [k1, k2]}——target 须为集合（list/tuple），逐条按键
    取值组对；重复对 = 违规。实体锚点 = 组合末键的值（「重复引用同一
    目标」的语义），可经 ``entity_id_key`` 覆盖。
    """
    keys = config.get("keys")
    if not isinstance(keys, (list, tuple)) or not keys:
        raise ValueError("unique_pairs 谓词缺 keys 清单")
    if not isinstance(target, (list, tuple)):
        return []  # 非集合形态 = 规则不适用
    entity_key = config.get("entity_id_key") or keys[-1]
    seen: set[tuple[Any, ...]] = set()
    issues: list[dict[str, Any]] = []
    for item in target:
        pair = tuple(_get_path(item, key) for key in keys)
        if any(value is None for value in pair):
            continue  # 键字段缺失的条目不参与唯一性（缺键 = 数据不完整）
        if pair in seen:
            issues.append(
                {
                    "message": f"条目组合 {pair} 重复登记",
                    "entity_id": str(_get_path(item, entity_key)),
                }
            )
        else:
            seen.add(pair)
    return issues


def _pred_truthy(target: Any, config: dict[str, Any], _context: dict[str, Any] | None):
    """truthy：字段值为真。config: {path}。"""
    if _get_path(target, config.get("path")):
        return []
    return _issue(config, f"字段 {config.get('path') or '<root>'} 应为真")


def _pred_falsy(target: Any, config: dict[str, Any], _context: dict[str, Any] | None):
    """falsy：字段值为假。config: {path}。"""
    if not _get_path(target, config.get("path")):
        return []
    return _issue(config, f"字段 {config.get('path') or '<root>'} 应为假")


# 状态转换谓词的状态机缓存（同一声明不重复构建——高频评估热路径；
# 声明形态不可哈希的部分归一为 frozenset）
_TRANSITION_MACHINES: dict[tuple, StateMachine] = {}


def _transition_machine(config: dict[str, Any]) -> StateMachine:
    """按 config 声明取状态机实例（缓存命中直接复用）。"""
    states = frozenset(config.get("states") or ())
    terminal = frozenset(config.get("terminal_states") or ())
    allowed = config.get("allowed")
    allowed_key = (
        frozenset(allowed)
        if isinstance(allowed, (list, tuple, set, frozenset))
        else allowed
    )
    key = (states, terminal, allowed_key, config.get("name"))
    machine = _TRANSITION_MACHINES.get(key)
    if machine is None:
        machine = StateMachine(
            states,
            terminal_states=terminal,
            allowed=config.get("allowed"),
            name=config.get("name", "rule_transition"),
        )
        _TRANSITION_MACHINES[key] = machine
    return machine


def _pred_state_transition(
    target: Any, config: dict[str, Any], _context: dict[str, Any] | None
):
    """state_transition：状态转换合法性（声明式状态机规则）。

    状态转换规则建在 :class:`~ink_engine.core.state_machine.StateMachine`
    之上：config 携带状态机声明（states/terminal_states/allowed）+ 前后
    状态取值路径（from_path/to_path），非法转换（终态转出/越界状态/不在
    白名单）= 违规。
    """
    states = config.get("states")
    if not isinstance(states, (list, tuple, set, frozenset)) or not states:
        raise ValueError("state_transition 谓词缺 states 清单")
    machine = _transition_machine(config)
    from_state = _get_path(target, config.get("from_path"))
    to_state = _get_path(target, config.get("to_path"))
    if to_state is None:
        return []  # 目标状态缺失 = 规则不适用
    if machine.is_illegal_transition(from_state, to_state):
        return _issue(
            config,
            f"非法状态转换: {from_state!r} -> {to_state!r}"
            f"（违反状态机 {machine.name}）",
        )
    return []


# 内置通用谓词登记表（RuleTypeRegistry 构造时自动注入——通用种子）
_BUILTIN_PREDICATES: dict[str, RulePredicate] = {
    "present": _pred_present,
    "absent": _pred_absent,
    "equals": _pred_equals,
    "not_equals": _pred_not_equals,
    "compare": _pred_compare,
    "in_enum": _pred_in_enum,
    "not_in_enum": _pred_not_in_enum,
    "contains": _pred_contains,
    "not_contains": _pred_not_contains,
    "unique_pairs": _pred_unique_pairs,
    "truthy": _pred_truthy,
    "falsy": _pred_falsy,
    "state_transition": _pred_state_transition,
}

# 谓词 config 校验器签名：规则 id + config → None（非法抛 GraphDefinitionError，
# 声明错误在建图期暴露，不延后到执行期 fail-open 静默失效）
PredicateConfigValidator = Callable[[str, dict[str, Any]], None]


def _path_field(rule_id: str, config: dict[str, Any], key: str = "path") -> None:
    """路径字段校验：str 或省略（其余形态 = 声明错误）。"""
    value = config.get(key)
    if value is not None and not isinstance(value, str):
        raise GraphDefinitionError(
            f"规则 {rule_id} 的 {key} 须为字符串或省略: {value!r}"
        )


def _enum_values_field(rule_id: str, config: dict[str, Any]) -> None:
    """枚举取值集校验：非空集合形态。"""
    values = config.get("values")
    if not isinstance(values, (list, tuple, set, frozenset)) or not values:
        raise GraphDefinitionError(
            f"规则 {rule_id} 的 values 须为非空集合（枚举取值集）"
        )


def _check_compare_config(rule_id: str, config: dict[str, Any]) -> None:
    """compare 声明校验：op 合法 + 字面量/对象内字段比较至少一侧存在。"""
    op = config.get("op")
    if op not in _COMPARE_OPS:
        raise GraphDefinitionError(
            f"规则 {rule_id} 的 compare op 非法: {op!r}（仅 {_COMPARE_OPS}）"
        )
    _path_field(rule_id, config)
    if "other_path" in config:
        _path_field(rule_id, config, "other_path")
    elif "value" not in config:
        raise GraphDefinitionError(
            f"规则 {rule_id} 的 compare 须声明 value 或 other_path 之一"
        )


def _check_enum_config(rule_id: str, config: dict[str, Any]) -> None:
    """in_enum/not_in_enum 声明校验。"""
    _path_field(rule_id, config)
    _enum_values_field(rule_id, config)


def _check_unique_pairs_config(rule_id: str, config: dict[str, Any]) -> None:
    """unique_pairs 声明校验：keys 非空清单。"""
    keys = config.get("keys")
    if not isinstance(keys, (list, tuple)) or not keys:
        raise GraphDefinitionError(f"规则 {rule_id} 的 keys 须为非空清单")
    if not all(isinstance(key, str) for key in keys):
        raise GraphDefinitionError(f"规则 {rule_id} 的 keys 须为字符串清单")


def _check_state_transition_config(rule_id: str, config: dict[str, Any]) -> None:
    """state_transition 声明校验：状态清单非空 + 取值路径合法。"""
    states = config.get("states")
    if not isinstance(states, (list, tuple, set, frozenset)) or not states:
        raise GraphDefinitionError(f"规则 {rule_id} 的 states 须为非空状态清单")
    _path_field(rule_id, config, "from_path")
    _path_field(rule_id, config, "to_path")


def _check_simple_path_config(rule_id: str, config: dict[str, Any]) -> None:
    """present/absent/truthy/falsy 声明校验（仅路径字段）。"""
    _path_field(rule_id, config)


def _check_value_config(rule_id: str, config: dict[str, Any]) -> None:
    """equals/not_equals/contains/not_contains 声明校验（路径 + 任意值）。"""
    _path_field(rule_id, config)
    if "value" not in config:
        raise GraphDefinitionError(f"规则 {rule_id} 缺 value 取值")


# 内置谓词的 config 校验器（注册表构造时自动注入——声明错误建图期暴露）
_BUILTIN_CONFIG_VALIDATORS: dict[str, PredicateConfigValidator] = {
    "present": _check_simple_path_config,
    "absent": _check_simple_path_config,
    "truthy": _check_simple_path_config,
    "falsy": _check_simple_path_config,
    "equals": _check_value_config,
    "not_equals": _check_value_config,
    "contains": _check_value_config,
    "not_contains": _check_value_config,
    "compare": _check_compare_config,
    "in_enum": _check_enum_config,
    "not_in_enum": _check_enum_config,
    "unique_pairs": _check_unique_pairs_config,
    "state_transition": _check_state_transition_config,
}


# -- 执行引擎 ----------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class RuleCheckResult:
    """一次规则评估结果（违规 + 跳过留痕——fail-open 可审计）。

    Attributes:
        issues: 违规清单（按规则声明序）。
        skipped: 跳过规则明细 ((rule_id, reason), ...)——谓词异常/数据
            不适用均在此留痕，观测而不阻断。
        checked: 实际执行（未被跳过）的规则数。
    """

    issues: tuple[RuleViolation, ...]
    skipped: tuple[tuple[str, str], ...] = ()
    checked: int = 0

    def has_hard_conflict(self) -> bool:
        """是否存在需裁决的硬冲突（error 级）——与领域校验语义对齐。"""
        return any(issue.severity == SEVERITY_ERROR for issue in self.issues)


class RuleEngine:
    """确定性规则引擎：规则集 × 数据对象 → 违规清单。

    执行语义：
    - 只执行 constraint/transition 规则（规则集里的其它类型声明在
      :meth:`evaluate` 前经 :meth:`~RuleSet.parse` 校验拒绝）；
    - 每规则按 ``target_path`` 提取检查对象，路径解析失败（字段缺失）
      = 规则不适用，跳过留痕（适用性断言显式用 present/absent 谓词）；
    - 谓词异常 fail-open：跳过该规则并留痕（规则引擎是增强护栏不是
      写门禁，任一环节异常不阻断整体评估）；
    - 未知谓词名 = 声明错误，抛 :class:`GraphDefinitionError`（不静默
      跳过——引用即错误，注册期/解析期暴露）。
    """

    def __init__(self, registry: RuleTypeRegistry | None = None) -> None:
        self.registry = registry or RuleTypeRegistry()

    def evaluate(
        self,
        rule_set: RuleSet,
        data: Any,
        *,
        context: dict[str, Any] | None = None,
    ) -> RuleCheckResult:
        """评估规则集对数据对象的违规清单。

        Args:
            rule_set: 规则集（应经 :meth:`RuleSet.parse` 校验）。
            data: 评估输入（JSON 兼容数据对象）。
            context: 评估上下文（追加注入；``root`` 键保留 = 数据对象，
                调用时参数如输入文本/目标实体经此传递——规则集保持静态）。

        Returns:
            :class:`RuleCheckResult`：违规 + 跳过留痕。
        """
        merged_context = {"root": data, **(context or {})}
        issues: list[RuleViolation] = []
        skipped: list[tuple[str, str]] = []
        checked = 0
        for rule in rule_set.rules:
            if rule.type not in _VALID_RULE_TYPES:
                skipped.append((rule.id, f"规则类型不可执行: {rule.type}"))
                continue
            target = _get_path(data, rule.target_path)
            if target is None and rule.target_path is not None:
                skipped.append(
                    (rule.id, f"目标路径不存在: {rule.target_path}")
                )
                continue
            predicate = self.registry.create(rule.predicate)
            checked += 1
            if rule.iterate_items:
                items = _iterable_items(target)
                if items is None:
                    skipped.append((rule.id, "目标非集合（iterate_items 需集合形态）"))
                    continue
                for item in items:
                    issues.extend(
                        _evaluate_once(
                            predicate, item, rule, merged_context, skipped
                        )
                    )
            else:
                issues.extend(
                    _evaluate_once(predicate, target, rule, merged_context, skipped)
                )
        return RuleCheckResult(
            issues=tuple(issues), skipped=tuple(skipped), checked=checked
        )


def _iterable_items(target: Any) -> list[Any] | None:
    """iterate_items 的逐条形态：dict = 值序列（与领域校验器遍历语义对齐）；
    list/tuple = 原序；其余形态 = 非集合（返回 None 由调用方跳过留痕）。"""
    if isinstance(target, dict):
        return list(target.values())
    if isinstance(target, (list, tuple)):
        return list(target)
    return None


def _evaluate_once(
    predicate: RulePredicate,
    target: Any,
    rule: Rule,
    context: dict[str, Any],
    skipped: list[tuple[str, str]],
) -> list[RuleViolation]:
    """单条目标执行谓词并归一化违规（异常 fail-open 跳过留痕）。"""
    violations: list[RuleViolation] = []
    try:
        raw_issues = predicate(target, rule.config, context)
    except GraphDefinitionError:
        raise  # 声明错误穿透（谓词自身配置校验失败=建图期应暴露）
    except Exception as exc:
        skipped.append((rule.id, f"谓词执行异常（fail-open 跳过）: {exc}"))
        logger.warning(
            "[rules] 谓词 %s 执行异常，规则 %s 跳过: %s",
            rule.predicate,
            rule.id,
            exc,
        )
        return violations
    for raw in raw_issues or []:
        if not isinstance(raw, dict):
            skipped.append((rule.id, f"谓词返回非 dict 违规: {type(raw).__name__}"))
            continue
        message = raw.get("message")
        if not isinstance(message, str) or not message:
            skipped.append((rule.id, "谓词违规缺 message"))
            continue
        violations.append(
            RuleViolation(
                rule_id=rule.id,
                kind=rule.kind,
                severity=raw.get("severity") or rule.severity,
                message=message,
                entity_type=rule.entity_type,
                entity_id=raw.get("entity_id"),
            )
        )
    return violations


# -- 混合判定门面 ------------------------------------------------------------


class ConstraintChecker:
    """约束检查器：确定性规则 + 可选 LLM 钩子的混合判定门面。

    混合判定语义（v4 已确立的 fail-open 模式）：确定性规则引擎跑声明式
    规则（快/可测/可审计）；规则覆盖不到的深度启发式经 ``llm_hook`` 退回
    LLM 判定。钩子异常/超时仅留痕跳过，绝不阻断主流程——检查是增强护栏
    不是写门禁。
    """

    def __init__(
        self,
        engine: RuleEngine | None = None,
        llm_hook: RuleHook | None = None,
    ) -> None:
        self.engine = engine or RuleEngine()
        self.llm_hook = llm_hook

    async def check(
        self,
        rule_set: RuleSet,
        data: Any,
        *,
        context: dict[str, Any] | None = None,
    ) -> RuleCheckResult:
        """组合评估：确定性规则 → LLM 钩子补充（异常 fail-open）。

        Returns:
            :class:`RuleCheckResult`：违规 = 确定性 + 钩子并集；
            skipped 含钩子失败留痕（rule_id = ``__llm_hook__``）。
        """
        result = self.engine.evaluate(rule_set, data, context=context)
        if self.llm_hook is None:
            return result
        merged_context = {"root": data, **(context or {})}
        try:
            hook_issues = await self.llm_hook(data, merged_context, result.issues)
        except Exception as exc:
            logger.warning("[rules] LLM 判定钩子失败（fail-open 跳过）: %s", exc)
            return RuleCheckResult(
                issues=result.issues,
                skipped=(*result.skipped, (HOOK_RULE_ID, f"钩子异常: {exc}")),
                checked=result.checked,
            )
        extra = _normalize_hook_issues(hook_issues)
        return RuleCheckResult(
            issues=result.issues + tuple(extra),
            skipped=result.skipped,
            checked=result.checked,
        )


def _normalize_hook_issues(raw_issues: list[dict[str, Any]]) -> list[RuleViolation]:
    """钩子返回违规清单 → RuleViolation 归一化（形态非法条目丢弃并留痕）。"""
    normalized: list[RuleViolation] = []
    for raw in raw_issues or []:
        if not isinstance(raw, dict):
            logger.warning("[rules] LLM 钩子返回非 dict 违规，丢弃: %r", raw)
            continue
        message = raw.get("message")
        if not isinstance(message, str) or not message:
            logger.warning("[rules] LLM 钩子违规缺 message，丢弃: %r", raw)
            continue
        normalized.append(
            RuleViolation(
                rule_id=raw.get("rule_id") or HOOK_RULE_ID,
                kind=raw.get("kind") or "rule",
                severity=raw.get("severity") or SEVERITY_ERROR,
                message=message,
                entity_type=raw.get("entity_type"),
                entity_id=raw.get("entity_id"),
            )
        )
    return normalized


# -- 样例库机制（新规则必须先让 fixture 全绿才允许落库） -------------------------


@dataclass(frozen=True, slots=True)
class FixtureCase:
    """一个样例用例（纯数据，随规则集导出/导入）。

    Attributes:
        id: 用例 id（样例集内唯一）。
        data: 评估输入数据（JSON 兼容——规则集数据形态的契约）。
        context: 评估上下文（运行时参数，如输入文本/目标实体）。
        expected_pass: True = 期望零违规；False = 期望至少一条违规。
        expected_kinds: 必须出现的违规类别集合（expected_pass=False 时
            逐项断言；允许出现额外类别——子集语义）。
        unexpected_kinds: 禁止出现的违规类别集合（出现即失败——严格
            模式：坏规则除期望类别外不得产生额外违规）。
        description: 用例说明（覆盖的场景）。
    """

    id: str
    data: dict[str, Any]
    context: dict[str, Any] = field(default_factory=dict)
    expected_pass: bool = True
    expected_kinds: tuple[str, ...] = ()
    unexpected_kinds: tuple[str, ...] = ()
    description: str = ""

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {"id": self.id, "data": self.data}
        if self.context:
            data["context"] = self.context
        if not self.expected_pass:
            data["expected_pass"] = False
            if self.expected_kinds:
                data["expected_kinds"] = list(self.expected_kinds)
        if self.unexpected_kinds:
            data["unexpected_kinds"] = list(self.unexpected_kinds)
        if self.description:
            data["description"] = self.description
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> FixtureCase:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"样例用例声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        case_id = data.get("id")
        raw_data = data.get("data")
        if not case_id or not isinstance(case_id, str):
            raise GraphDefinitionError("样例用例缺 id（字符串）")
        if not isinstance(raw_data, dict):
            raise GraphDefinitionError(
                f"样例用例 {case_id} 的 data 须为 dict，收到 {type(raw_data).__name__}"
            )
        context = data.get("context")
        if context is not None and not isinstance(context, dict):
            raise GraphDefinitionError(
                f"样例用例 {case_id} 的 context 须为 dict"
            )
        kinds = data.get("expected_kinds", ())
        if not isinstance(kinds, (list, tuple)) or not all(
            isinstance(kind, str) for kind in kinds
        ):
            raise GraphDefinitionError(
                f"样例用例 {case_id} 的 expected_kinds 须为字符串清单"
            )
        unexpected = data.get("unexpected_kinds", ())
        if not isinstance(unexpected, (list, tuple)) or not all(
            isinstance(kind, str) for kind in unexpected
        ):
            raise GraphDefinitionError(
                f"样例用例 {case_id} 的 unexpected_kinds 须为字符串清单"
            )
        description = data.get("description", "")
        if not isinstance(description, str):
            raise GraphDefinitionError(f"样例用例 {case_id} 的 description 须为字符串")
        return cls(
            id=case_id,
            data=raw_data,
            context=dict(context or {}),
            expected_pass=bool(data.get("expected_pass", True)),
            expected_kinds=tuple(kinds),
            unexpected_kinds=tuple(unexpected),
            description=description,
        )


@dataclass(frozen=True, slots=True)
class FixtureSet:
    """样例库（每个知识集自带；新规则必须全绿才允许落库）。"""

    name: str
    cases: tuple[FixtureCase, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "cases": [case.to_dict() for case in self.cases],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> FixtureSet:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"样例库声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        name = data.get("name")
        raw_cases = data.get("cases")
        if not name or not isinstance(name, str):
            raise GraphDefinitionError("样例库缺 name（字符串）")
        if not isinstance(raw_cases, list):
            raise GraphDefinitionError("样例库缺 cases 清单")
        return cls(
            name=name,
            cases=tuple(FixtureCase.from_dict(raw) for raw in raw_cases),
        )


@dataclass(frozen=True, slots=True)
class FixtureResult:
    """单个样例用例的评估结果（闸门失败原因可读可审计）。"""

    case_id: str
    passed: bool
    violations: tuple[RuleViolation, ...]
    expected_pass: bool
    missing_kinds: tuple[str, ...] = ()
    reason: str = ""


def run_fixtures(
    rule_set: RuleSet,
    fixtures: FixtureSet,
    *,
    engine: RuleEngine | None = None,
) -> tuple[FixtureResult, ...]:
    """样例库全量评估：规则集 × 每个用例 → 逐用例通过与否。

    判定语义：
    - ``expected_pass=True``：零违规才通过；
    - ``expected_pass=False``：至少一条违规，且 ``expected_kinds`` 中
      每个类别都至少出现一次（子集语义，允许额外类别）——声明
      ``unexpected_kinds`` 时额外类别被严格拒绝（坏规则在期望类别之外
      产生别的违规 = 用例失败，退化防线不可绕过）。
    """
    engine = engine or RuleEngine()
    results: list[FixtureResult] = []
    for case in fixtures.cases:
        result = engine.evaluate(rule_set, case.data, context=case.context)
        kinds = {issue.kind for issue in result.issues}
        missing = tuple(kind for kind in case.expected_kinds if kind not in kinds)
        unexpected_hit = tuple(kind for kind in case.unexpected_kinds if kind in kinds)
        passed = (
            not result.issues
            if case.expected_pass
            else bool(result.issues) and not missing and not unexpected_hit
        )
        reason = ""
        if not passed:
            if case.expected_pass:
                reason = (
                    f"期望零违规，实际 {len(result.issues)} 条: "
                    + "; ".join(f"{i.kind}[{i.rule_id}] {i.message}" for i in result.issues[:3])
                )
            elif not result.issues:
                reason = "期望至少一条违规，实际零违规"
            elif unexpected_hit:
                reason = f"出现禁止的违规类别: {unexpected_hit}"
            else:
                reason = f"缺少期望违规类别: {missing}"
        results.append(
            FixtureResult(
                case_id=case.id,
                passed=passed,
                violations=result.issues,
                expected_pass=case.expected_pass,
                missing_kinds=missing,
                reason=reason,
            )
        )
    return tuple(results)


def fixtures_all_green(
    rule_set: RuleSet,
    fixtures: FixtureSet,
    *,
    engine: RuleEngine | None = None,
) -> bool:
    """样例闸门判定：规则集对全部样例通过（新规则落库的前置检查）。"""
    return all(result.passed for result in run_fixtures(rule_set, fixtures, engine=engine))


def assert_fixtures_pass(
    rule_set: RuleSet,
    fixtures: FixtureSet,
    *,
    engine: RuleEngine | None = None,
) -> None:
    """样例闸门（非谈判项）：不满足即抛 :class:`FixtureGateError`。

    规则/规则集变更（新增/修改/回退）落库前必须调用——「新规则必须先
    让 fixture 全绿才允许落库」，失败明细随异常携带可审计。
    """
    failures = [
        result
        for result in run_fixtures(rule_set, fixtures, engine=engine)
        if not result.passed
    ]
    if failures:
        detail = "; ".join(f"[{f.case_id}] {f.reason}" for f in failures)
        raise FixtureGateError(
            f"样例闸门未通过（{len(failures)}/{len(fixtures.cases)} 个用例失败）: {detail}"
        )


__all__ = [
    "HOOK_RULE_ID",
    "RULE_CONSTRAINT",
    "RULE_TRANSITION",
    "SEVERITY_ERROR",
    "SEVERITY_WARNING",
    "ConstraintChecker",
    "FixtureCase",
    "FixtureResult",
    "FixtureSet",
    "Rule",
    "RuleCheckResult",
    "RuleEngine",
    "RuleHook",
    "RulePredicate",
    "RuleSet",
    "RuleTypeRegistry",
    "RuleViolation",
    "assert_fixtures_pass",
    "fixtures_all_green",
    "run_fixtures",
]
