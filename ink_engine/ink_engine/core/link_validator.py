"""链接校验器（纯函数：结点契约间链接的合法性判定）。

两级校验语义：

- 前缀可达性（弱校验，组装/路径校验用）：序列中每个结点的必填输入 ⊆
  入口字段 ∪ 前置结点产出并集——线性序列天然支持多源汇聚（下游结点
  同时消费多个前置结点的产出），相邻覆盖校验会误杀这类合法路径；
- 相邻覆盖（强校验，显式边/手绘图用）：起点产出必须覆盖目标全部必填
  输入字段。

其余规则（全部算法化，毫秒级）：

- 无契约结点不可参与组装（仅可被手绘图引用——旧行为零破坏）；
- 安全档：目标安全档不得超过组装请求档位（高安全结点不可进低信任
  路径；路径档位 = 请求参数，默认 0 最严；映射策略归使用方）；
- 版本：引用的契约版本必须已登记（旧图定义可解析）；
- 通道写入：跨状态通道写入遵循 StateSchema.apply 既有语义
  （累积追加通道须序列写入、合并累加通道须对象写入，按
  is_additive_reducer / is_merge_reducer 分类检查）。

结构校验器不检查语义条件——策略边（声明式条件边）的运行时成立性由
上下文谓词判定，不在本模块职责内。全部函数为纯函数：同输入必同输出
（理由清单顺序稳定，可断言）。
"""
from __future__ import annotations

from collections.abc import Collection, Mapping, Sequence

from .contracts import SAFETY_TIER_MAX, NodeContract
from .exceptions import GraphDefinitionError
from .schema_validator import FIELD_ARRAY, FIELD_OBJECT, SchemaSpec
from .state import StateSchema, is_additive_reducer, is_merge_reducer


def required_field_names(schema: SchemaSpec | None) -> frozenset[str]:
    """schema 必填字段名集合（缺省 schema = 无必填）。

    与 SchemaValidator 的必填语义同源：字段缺失按必填声明判定。
    """
    if schema is None:
        return frozenset()
    return frozenset(f.name for f in schema.fields if f.required)


def produced_field_names(schema: SchemaSpec | None) -> frozenset[str]:
    """schema 声明字段名全集（缺省 schema = 无产出）。

    覆盖判定按声明名精确匹配（点分字段不做前缀推断——结构层不解释
    值形态，宁可拒不可误放）。
    """
    if schema is None:
        return frozenset()
    return frozenset(f.name for f in schema.fields)


def _check_request_tier(max_safety_tier: int) -> None:
    """组装请求档位范围校验（档位是数据形态约束，越界 = 声明错误）。"""
    if isinstance(max_safety_tier, bool) or not isinstance(max_safety_tier, int):
        raise GraphDefinitionError(
            f"组装请求档位须为整数: {max_safety_tier!r}"
        )
    if not 0 <= max_safety_tier <= SAFETY_TIER_MAX:
        raise GraphDefinitionError(
            f"组装请求档位越界: {max_safety_tier}（仅 0-{SAFETY_TIER_MAX}）"
        )


def _version_reasons(
    node: NodeContract | None,
    type_name: str | None,
    known_versions: Mapping[str, Collection[int]] | None,
    label: str,
) -> list[str]:
    """契约版本存在性判定（未提供类型名/登记表 = 跳过，纯增量宽容）。"""
    if node is None or type_name is None or known_versions is None:
        return []
    versions = known_versions.get(type_name)
    if versions is None or node.version not in versions:
        registered = f"（已登记 {sorted(versions)}）" if versions else "（未登记任何版本）"
        return [
            f"{label}契约版本未登记: 类型 {type_name} 的版本 {node.version}{registered}"
        ]
    return []


def _channel_write_reasons(
    node: NodeContract,
    state_schema: StateSchema | None,
    label: str,
) -> list[str]:
    """通道写入形态判定（缺省 schema = 跳过；仅检查带 reducer 的通道）。

    遵循 StateSchema.apply 既有语义：累积追加通道（add_messages 族）
    的写入须为条目序列（array）；合并累加通道（merge_metrics/
    merge_dicts 族）的写入须为对象（object）。未分类的自定义 reducer
    不做形态推断（无声明语义，宽容跳过）。
    """
    if state_schema is None or node.output_schema is None:
        return []
    reasons: list[str] = []
    for field in node.output_schema.fields:
        channel = state_schema.channels.get(field.name)
        if channel is None or channel.reducer is None:
            continue
        if is_additive_reducer(channel.reducer):
            if field.kind != FIELD_ARRAY:
                reasons.append(
                    f"{label}字段 {field.name} 写入累积追加通道"
                    f"（reducer={channel.reducer}），类型须为 array，声明为 {field.kind}"
                )
        elif is_merge_reducer(channel.reducer) and field.kind != FIELD_OBJECT:
            reasons.append(
                f"{label}字段 {field.name} 写入合并累加通道"
                f"（reducer={channel.reducer}），类型须为 object，声明为 {field.kind}"
            )
    return reasons


def validate_link(
    src: NodeContract | None,
    dst: NodeContract | None,
    *,
    max_safety_tier: int = 0,
    src_type: str | None = None,
    dst_type: str | None = None,
    known_versions: Mapping[str, Collection[int]] | None = None,
    state_schema: StateSchema | None = None,
) -> tuple[bool, list[str]]:
    """相邻覆盖（强校验，显式边/手绘图用）+ 安全档/版本/通道写入规则。

    Args:
        src: 起点结点契约（None = 无契约结点，不可参与组装）。
        dst: 目标结点契约（None = 无契约结点，不可参与组装）。
        max_safety_tier: 组装请求放行档位（默认 0 最严；高安全结点不可
            进低信任路径，映射策略归使用方）。
        src_type/dst_type: 两端类型名（契约版本存在性判定用）。
        known_versions: 类型名 → 已登记契约版本集（缺省 None = 跳过版本
            存在性规则；来源 = 注册表契约登记或补丁链版本快照）。
        state_schema: 状态通道 schema（缺省 None = 跳过通道写入规则）。

    Returns:
        (是否通过, 理由清单)；理由顺序稳定，可断言。
    """
    _check_request_tier(max_safety_tier)
    reasons: list[str] = []
    if src is None:
        reasons.append("起点结点无契约，不可参与组装")
    if dst is None:
        reasons.append("目标结点无契约，不可参与组装")
    if src is not None and dst is not None:
        missing = sorted(
            required_field_names(dst.input_schema)
            - produced_field_names(src.output_schema)
        )
        if missing:
            reasons.append(f"目标必填输入字段未被起点产出覆盖: {'、'.join(missing)}")
    if dst is not None and dst.safety_tier > max_safety_tier:
        reasons.append(
            f"目标安全档 {dst.safety_tier} 超过组装请求档位 {max_safety_tier}"
        )
    reasons.extend(_version_reasons(src, src_type, known_versions, "起点"))
    reasons.extend(_version_reasons(dst, dst_type, known_versions, "目标"))
    # 通道写入规则对链接两端都生效：两端结点都会向状态通道写产出
    if src is not None:
        reasons.extend(_channel_write_reasons(src, state_schema, "起点结点"))
    if dst is not None:
        reasons.extend(_channel_write_reasons(dst, state_schema, "目标结点"))
    return (not reasons, reasons)


def validate_prefix_reachability(
    sequence: Sequence[NodeContract | None],
    *,
    entry_fields: Collection[str] = (),
    max_safety_tier: int = 0,
    state_schema: StateSchema | None = None,
) -> tuple[bool, list[str]]:
    """前缀可达性（弱校验，组装/路径校验用）。

    序列中每个结点的必填输入 ⊆ 入口字段 ∪ 前置结点产出并集——支持
    多源汇聚：下游结点的输入可由多个前置结点的产出合并满足；相邻
    覆盖（:func:`validate_link`）会误杀这类合法路径，组装/路径校验
    须用本函数。安全档按序列逐结点剪枝，通道写入规则逐结点检查。

    Args:
        sequence: 按执行序排列的结点契约序列。
        entry_fields: 入口字段（外部注入的初始可用字段）。
        max_safety_tier: 组装请求放行档位（默认 0 最严）。
        state_schema: 状态通道 schema（缺省 None = 跳过通道写入规则）。

    Returns:
        (是否通过, 理由清单)；理由顺序稳定，可断言。
    """
    _check_request_tier(max_safety_tier)
    reasons: list[str] = []
    available = set(entry_fields)
    for index, node in enumerate(sequence):
        label = f"序列第 {index + 1} 个结点"
        if node is None:
            reasons.append(f"{label}无契约，不可参与组装")
            continue
        if node.safety_tier > max_safety_tier:
            reasons.append(
                f"{label}安全档 {node.safety_tier} 超过组装请求档位 {max_safety_tier}"
            )
        missing = sorted(required_field_names(node.input_schema) - available)
        if missing:
            reasons.append(f"{label}输入字段不可达: {'、'.join(missing)}")
        available |= produced_field_names(node.output_schema)
        reasons.extend(_channel_write_reasons(node, state_schema, label))
    return (not reasons, reasons)


__all__ = [
    "produced_field_names",
    "required_field_names",
    "validate_link",
    "validate_prefix_reachability",
]
