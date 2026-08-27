"""审批卡模型与门控分级注册表（通用审批原语）。

四类审核卡（gate/body/audit/candidate）的**数据模型**与构造/校验/截断
逻辑，以及门控分级（``GatingTier``）注册表机制：

- :data:`REVIEW_TYPES`：卡类型枚举（新增卡类型必须在此登记，防「新卡忘登记
  → 前端渲染漂移」）；
- :func:`validate_card` / :func:`truncate_preview`：统一契约校验与预览截断
  （按 node_id 分档限额由宿主注入，上限随卡携带——SSE 出口与发卡点共用
  同一规则，出口零配置）；
- :func:`build_gate_card` / :func:`build_body_card` / :func:`build_audit_card` /
  :func:`build_candidate_card`：**四类卡唯一构建源**（E-P12 拍板）——卡形态
  一律经 build_*_card 构造 + validate_card 统一契约校验，宿主只提供 payload
  数据与语义字段，不在发卡点手工拼卡；
- :class:`GatingTier` + :func:`gating_tier_of`：门控分级判定（L1 直落库 /
  L2 弹卡 / L3 破坏类预留；未登记写操作默认 L2 保守弹卡）。

边界：卡 payload 形状与宿主事件协议强绑定（``target_chapter_id`` /
``chapter_index`` 等字段名为协议锁定，语义由宿主解释）——本模块只提供
模型与纯函数，不发射事件、不落库；事件发射形状由宿主保持，前端协议不变。

白名单审计：``REVIEW_TYPES``（卡类型枚举）= **机制固有**——审批卡协议
（新增卡类型须在此登记，防前端渲染漂移）。
"""
from __future__ import annotations

from collections.abc import Mapping
from enum import StrEnum
from typing import Any

# 四卡类型枚举（新卡类型必须在此登记）
REVIEW_TYPES = ("gate", "body", "audit", "candidate")

# 预览截断默认上限（防撑爆传输通道）；内容类/结构化设定类的大额上限由
# 宿主构造时经 limits 映射注入，构造器把上限写入卡 payload 随卡流动。
PREVIEW_LIMIT_DEFAULT = 1000

# 各卡必填字段（validate_card 校验依据；缺字段视为契约破坏，宁可拒绝发卡）。
# 只列「结构必填」：卡类型标识 + 定位字段；值允许为空的次要字段
# （audit.workflow_id / candidate.target_id / output_preview 等）
# 不在此列——原发卡点允许空值发送，校验过严会破坏既有行为。
_REQUIRED_FIELDS: dict[str, tuple[str, ...]] = {
    "gate": ("node_id", "node_label", "review_type"),
    "body": (
        "node_id",
        "node_label",
        "review_type",
        "target_id",
        "chapter_index",
        "chapter_total",
    ),
    "audit": ("node_id", "node_label", "review_type"),
    "candidate": ("node_id", "node_label", "review_type", "candidates"),
}

# 数值型必填字段的下界（0 合法，负数为越界/异常卡）
_NUMERIC_FIELDS = ("chapter_index", "chapter_total")


def preview_limit_for(
    node_id: str, limits: Mapping[str, int] | None = None
) -> int:
    """按 node_id 分档的预览截断上限（宿主注入映射，未命中回默认档）。

    Args:
        node_id: 节点 ID。
        limits: 宿主注入的 ``node_id -> 上限`` 映射（如内容类节点给大额
            上限）；缺省或未命中返回默认档。
    """
    if limits:
        limit = limits.get(node_id)
        if limit is not None:
            return limit
    return PREVIEW_LIMIT_DEFAULT


def validate_card(card: dict[str, Any]) -> dict[str, Any]:
    """校验卡 payload 契约：review_type 枚举 + 必填字段 + 预览截断。

    返回截断后的卡（可直接写 pending_review / 转 SSE）。校验失败抛
    ValueError——发卡点必须先行修复（契约错误静默放行会导致前端渲染漂移）。
    """
    rtype = card.get("review_type")
    if rtype not in REVIEW_TYPES:
        raise ValueError(f"未知审核卡类型: {rtype!r}（须在 REVIEW_TYPES 登记）")
    missing = [k for k in _REQUIRED_FIELDS[rtype] if card.get(k) in (None, "")]
    if missing:
        raise ValueError(f"审核卡（{rtype}）缺少必填字段: {', '.join(missing)}")
    for _num_key in _NUMERIC_FIELDS:
        if (
            _num_key in _REQUIRED_FIELDS[rtype]
            and isinstance(card.get(_num_key), (int, float))
            and card[_num_key] < 0
        ):
            raise ValueError(f"审核卡（{rtype}）字段 {_num_key} 不能为负")
    return truncate_preview(card)


def truncate_preview(card: dict[str, Any]) -> dict[str, Any]:
    """按卡内 preview_limit（构造时固化）截断 output_preview。

    返回新 dict，不改原卡；卡内无 preview_limit 时按 node_id 回退默认档。
    """
    payload = dict(card)
    preview = payload.get("output_preview") or ""
    limit = payload.get("preview_limit") or preview_limit_for(
        str(payload.get("node_id") or "")
    )
    if isinstance(preview, str) and len(preview) > limit:
        payload["output_preview"] = preview[:limit] + "\n…（已截断）"
    return payload


def build_gate_card(
    action: dict[str, Any] | None = None,
    *,
    actions: list[dict] | None = None,
    payload: dict[str, Any] | None = None,
    limits: Mapping[str, int] | None = None,
) -> dict[str, Any]:
    """写操作审批卡（gate）：动作摘要 + 确认/编辑/取消（四类卡之一）。

    E-P12 统一构建源：四类卡的卡形态一律经本模块 build_*_card 构造
    （唯一构建源 + validate_card 统一契约校验），宿主只提供 payload
    数据与语义字段。本函数同时承接单动作卡（``action`` 键）与合并卡
    （``actions`` 键——同回合多写操作聚合一张卡，仍是 gate 卡形态）。

    Args:
        action: 单动作描述（{tool, args, summary, diff, ...}——渲染与
            策略分级判定用，宿主自定形态）。
        actions: 动作列表（合并卡；与 action 二选一，actions 优先）。
        payload: 宿主提供的卡负载（字段优先：已显式给定的字段不改写，
            与审批语义「宿主 payload 优先」一致）。
        limits: 宿主注入的预览上限映射（可选；output_preview 超限截断）。
    """
    card = dict(payload) if payload else {}
    card.setdefault("review_type", "gate")
    if actions is not None:
        card.setdefault("node_id", "approval_batch")
        card.setdefault("node_label", "批量审批")
        card.setdefault("actions", [dict(a) for a in actions])
        if "output_preview" not in card:
            card["output_preview"] = "\n".join(
                f"- {a.get('tool')}: {a.get('summary') or a.get('diff') or ''}"
                for a in actions
            )
    elif action is not None:
        card.setdefault("node_id", str(action.get("tool") or "approval"))
        card.setdefault("node_label", str(action.get("tool") or "approval"))
        card.setdefault("action", dict(action))
        if "output_preview" not in card:
            card["output_preview"] = str(
                action.get("diff") or action.get("summary") or ""
            )
    card["preview_limit"] = preview_limit_for(str(card.get("node_id") or ""), limits)
    return validate_card(card)


def build_body_card(
    target_id: int,
    index: int,
    total: int,
    content: str,
    node_label: str,
    node_id: str | None = None,
    conflicts: list[dict] | None = None,
    limits: Mapping[str, int] | None = None,
) -> dict[str, Any]:
    """内容审批卡（body）：完整内容 + 确认/编辑/取消（前端 ReviewCard 契约）。

    content 字段为未截断完整内容（供前端编辑回填）；output_preview 由
    validate_card→truncate_preview 截断用于 SSE 展示，二者分离——
    编辑基于全文、展示基于预览，互不影响。

    Args:
        target_id: 卡关联的目标引用 ID（宿主语义，如目标实体 ID）。
        index: 进度序号（第 N/M，协议字段 chapter_index）。
        total: 进度总数（协议字段 chapter_total）。
        content: 完整内容。
        node_label: 卡标签。
        node_id: 节点 ID（宿主必传；缺省会被必填校验拒绝）。
        conflicts: 写时预检命中的冲突列表（可选）。
        limits: 宿主注入的预览上限映射（可选）。
    """
    card = {
        "review_type": "body",
        "node_id": node_id,
        "node_label": node_label,
        "output_preview": content,
        "content": content,
        "reason": "内容已生成，请确认后落库（可在编辑后确认）。",
        "target_id": target_id,
        # 协议锁定字段名（chapter_index/chapter_total），构造点按协议名映射
        "chapter_index": index,
        "chapter_total": total,
        "tokens": 0,
        "elapsed_ms": 0,
    }
    card["preview_limit"] = preview_limit_for(node_id or "", limits)
    if conflicts:
        card["conflicts"] = conflicts
    return validate_card(card)


def build_audit_card(
    node_id: str,
    node_label: str,
    workflow_id: str,
    output: str,
    reason: str,
    target_id: int | None,
    tokens: int = 0,
    elapsed_ms: int = 0,
    limits: Mapping[str, int] | None = None,
) -> dict[str, Any]:
    """质量卡（audit）：输出未过质量审计的拦截卡（接受/重试/终止）。"""
    return validate_card(
        {
            "node_id": node_id,
            "node_label": node_label,
            "workflow_id": workflow_id,
            # 截断统一交给 truncate_preview（validate_card 内按 preview_limit
            # 执行）——旧实现内联 [:1000] 与默认档重复且会先于宿主注入的
            # 大额上限截断（ENG1-15），删去后宿主 limits 映射真实生效
            "output_preview": output or "",
            "reason": reason or "输出质量不满足节点要求",
            "review_type": "audit",
            "target_id": target_id,
            "tokens": tokens,
            "elapsed_ms": elapsed_ms,
            "preview_limit": preview_limit_for(node_id or "", limits),
        }
    )


def build_candidate_card(
    target_id: int | None,
    workflow_id: str,
    candidates: list[dict],
    source: str = "workflow",
    node_id: str | None = None,
    label: str | None = None,
    reason: str | None = None,
    limits: Mapping[str, int] | None = None,
) -> dict[str, Any]:
    """候选选择卡（candidate）：全量文本按候选顺序划分，操作=选择/编辑/取消。

    候选内容不进 messages/上下文（防内容回灌/泄露），落库由调用方在用户
    选定后执行，按 source 分流。

    Args:
        target_id: 卡关联的目标引用 ID（宿主语义，可空）。
        workflow_id: 来源标识（宿主语义，如工作流 ID 或并行候选标识）。
        candidates: 候选列表 [{node_id, node_label, output, summary}, ...]。
        source: 候选来源标识（宿主分流与前端来源标签展示，透传不解释）。
        node_id: 节点 ID（宿主必传；缺省会被必填校验拒绝）。
        label: 卡标签（宿主文案；缺省用通用文案）。
        reason: 卡说明（宿主文案；缺省用通用文案）。
        limits: 宿主注入的预览上限映射（可选）。
    """
    return validate_card(
        {
            "review_type": "candidate",
            "node_id": node_id,
            "node_label": label or "候选选择",
            "candidates": candidates,
            "target_id": target_id,
            "workflow_id": workflow_id,
            "source": source,
            "reason": reason or "已生成多个版本，请选择其一（可编辑后确认）。",
            "tokens": 0,
            "elapsed_ms": 0,
            "preview_limit": preview_limit_for(node_id or "", limits),
        }
    )


# ---------------------------------------------------------------------------
# 门控分级（GatingTier）
# ---------------------------------------------------------------------------


class GatingTier(StrEnum):
    """写操作的确认策略分档。

    - L1 创建/新增类：不弹卡直落库（事后纠正），audit 全量留痕（decision="auto"）；
    - L2 内容类：保留弹卡（内容写入是不可逆的覆盖型写入）；
    - L3 破坏类：删除/批量覆盖/修改锁定内容——保留弹卡（当前无工具登记，预留）。
    """

    L1 = "l1"
    L2 = "l2"
    L3 = "l3"


# 有效覆盖挡位值（gating_overrides 白名单；非法值忽略回退默认挡位）
GATING_OVERRIDE_VALUES: frozenset[str] = frozenset(t.value for t in GatingTier)

# 挡位名称元组（外部校验/展示用）
GATING_TIER_NAMES: tuple[str, ...] = tuple(t.value for t in GatingTier)


def gating_tier_of(
    tool_name: str,
    overrides: dict[str, Any] | None = None,
    registry: dict[str, Any] | None = None,
) -> GatingTier:
    """解析单工具的生效门控挡位（纯函数，可单测）。

    优先级：用户覆盖（overrides[tool_name]，白名单校验）> 注册表 L1/L3
    > L2 默认（未登记写操作默认保守弹卡——新增写工具不弹卡即门控绕过）。

    Args:
        tool_name: 工具名。
        overrides: 宿主设置 gating_overrides（{tool_name: "l1"|"l2"|"l3"}）。
        registry: 工具→挡位注册表（宿主按需传入；默认空表全部落 L2）。

    Returns:
        生效挡位枚举。
    """
    if overrides:
        override = overrides.get(tool_name)
        if override in GATING_OVERRIDE_VALUES:
            return GatingTier(override)
    tier = (registry or {}).get(tool_name)
    if isinstance(tier, GatingTier):
        return tier
    if tier in GATING_OVERRIDE_VALUES:
        return GatingTier(tier)
    return GatingTier.L2


__all__ = [
    "GATING_OVERRIDE_VALUES",
    "GATING_TIER_NAMES",
    "PREVIEW_LIMIT_DEFAULT",
    "REVIEW_TYPES",
    "GatingTier",
    "build_audit_card",
    "build_body_card",
    "build_candidate_card",
    "build_gate_card",
    "gating_tier_of",
    "preview_limit_for",
    "truncate_preview",
    "validate_card",
]
