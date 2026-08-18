"""创作审批卡模型与门控分级注册表（创作审批原语）。

四类审核卡（gate/body/audit/candidate）的**数据模型**与构造/校验/截断
逻辑，以及门控分级（``GatingTier``）注册表机制：

- :data:`REVIEW_TYPES`：卡类型枚举（新增卡类型必须在此登记，防「新卡忘登记
  → 前端渲染漂移」）；
- :func:`validate_card` / :func:`truncate_preview`：统一契约校验与预览截断
  （按 node_id 分档限额，SSE 出口与发卡点共用同一规则）；
- :func:`build_body_card` / :func:`build_audit_card` / :func:`build_candidate_card`：
  纯构造器（gate 卡依赖宿主写操作摘要，构造留在宿主注入）；
- :class:`GatingTier` + :func:`gating_tier_of`：门控分级判定（L1 直落库 /
  L2 弹卡 / L3 破坏类预留；未登记写操作默认 L2 保守弹卡）。

边界：卡 payload 形状与 SSE 事件协议强绑定——本模块只提供模型与纯函数，
不发射事件、不落库；事件发射形状由宿主保持，前端协议不变。
"""
from __future__ import annotations

from enum import StrEnum
from typing import Any

# 四卡类型枚举（新卡类型必须在此登记）
REVIEW_TYPES = ("gate", "body", "audit", "candidate")

# 预览截断上限（按 node_id 分档，防撑爆 SSE 通道）：
# - 章节直写 / 生成通道正文审批：放宽到 8000 字（正文预览需可读、编辑基于全文）；
# - 实体/设定更新：设定全文（世界观等）可能很长，给足量；
# - 其余卡片：保持 1000 字。
PREVIEW_LIMIT_CHAPTER = 8000
PREVIEW_LIMIT_ENTITY = 6000
PREVIEW_LIMIT_DEFAULT = 1000

# 各卡必填字段（validate_card 校验依据；缺字段视为契约破坏，宁可拒绝发卡）。
# 只列「结构必填」：卡类型标识 + 定位字段；值允许为空的次要字段
# （audit.workflow_id / candidate.target_chapter_id / output_preview 等）
# 不在此列——原发卡点允许空值发送，校验过严会破坏既有行为。
_REQUIRED_FIELDS: dict[str, tuple[str, ...]] = {
    "gate": ("node_id", "node_label", "review_type"),
    "body": (
        "node_id",
        "node_label",
        "review_type",
        "target_chapter_id",
        "chapter_index",
        "chapter_total",
    ),
    "audit": ("node_id", "node_label", "review_type"),
    "candidate": ("node_id", "node_label", "review_type", "candidates"),
}

# 数值型必填字段的下界（0 合法，负数为越界/异常卡）
_NUMERIC_FIELDS = ("chapter_index", "chapter_total")


def preview_limit_for(node_id: str) -> int:
    """按 node_id 分档的预览截断上限（章节直写/生成通道放宽，设定更新足量）。"""
    if node_id in ("write_chapter_content", "generate_chapter"):
        return PREVIEW_LIMIT_CHAPTER
    if node_id == "update_entity":
        return PREVIEW_LIMIT_ENTITY
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
    """按 node_id 分档截断 output_preview（返回新 dict，不改原卡）。"""
    payload = dict(card)
    preview = payload.get("output_preview") or ""
    limit = preview_limit_for(str(payload.get("node_id") or ""))
    if isinstance(preview, str) and len(preview) > limit:
        payload["output_preview"] = preview[:limit] + "\n…（已截断）"
    return payload


def build_body_card(
    chapter_id: int,
    chapter_index: int,
    chapter_total: int,
    content: str,
    node_label: str,
    node_id: str = "generate_chapter",
    conflicts: list[dict] | None = None,
) -> dict[str, Any]:
    """正文审批卡（body）：正文全文 + 确认/编辑/取消（前端 ReviewCard 契约）。

    content 字段为未截断完整正文（供前端编辑回填）；output_preview 由
    validate_card→truncate_preview 截断用于 SSE 展示，二者分离——
    编辑基于全文、展示基于预览，互不影响。

    Args:
        chapter_id: 目标章节 ID。
        chapter_index: 章序号（第 N/M）。
        chapter_total: 队列总数。
        content: 完整正文。
        node_label: 卡标签。
        node_id: 节点 ID（默认 generate_chapter）。
        conflicts: 写时预检命中的冲突列表（可选）。
    """
    card = {
        "review_type": "body",
        "node_id": node_id,
        "node_label": node_label,
        "output_preview": content,
        "content": content,
        "reason": "章节正文已生成，请确认后落库（可在编辑后确认）。",
        "target_chapter_id": chapter_id,
        "chapter_index": chapter_index,
        "chapter_total": chapter_total,
        "tokens": 0,
        "elapsed_ms": 0,
    }
    if conflicts:
        card["conflicts"] = conflicts
    return validate_card(card)


def build_audit_card(
    node_id: str,
    node_label: str,
    workflow_id: str,
    output: str,
    reason: str,
    target_chapter_id: int | None,
    tokens: int = 0,
    elapsed_ms: int = 0,
) -> dict[str, Any]:
    """质量卡（audit）：输出未过质量审计的拦截卡（接受/重试/终止）。"""
    return validate_card(
        {
            "node_id": node_id,
            "node_label": node_label,
            "workflow_id": workflow_id,
            "output_preview": (output or "")[:1000],
            "reason": reason or "输出质量不满足角色节点要求",
            "review_type": "audit",
            "target_chapter_id": target_chapter_id,
            "tokens": tokens,
            "elapsed_ms": elapsed_ms,
        }
    )


def build_candidate_card(
    target_chapter_id: int | None,
    workflow_id: str,
    candidates: list[dict],
    source: str = "workflow",
) -> dict[str, Any]:
    """候选选择卡（candidate）：全量文本按候选顺序划分，操作=选择/编辑/取消。

    候选正文不进 messages/上下文（防内容回灌/泄露），落库由调用方
    （write_workflow_candidate / write_chapter_content）在用户选定后执行，
    按 source 分流。

    Args:
        target_chapter_id: 目标章节 ID。
        workflow_id: 来源标识（工作流 ID 或 "divergent"）。
        candidates: 候选列表 [{node_id, node_label, output, summary}, ...]。
        source: 候选来源（workflow=工作流节点输出 / divergent=平行起草变体）。
    """
    is_divergent = source == "divergent"
    return validate_card(
        {
            "review_type": "candidate",
            "node_id": "divergent_draft" if is_divergent else "workflow_candidate",
            "node_label": (
                f"平行起草候选（{('第' + str(target_chapter_id) + '章') if target_chapter_id else '本章'}）"
                if is_divergent
                else f"工作流候选选择（{('第' + str(target_chapter_id) + '章') if target_chapter_id else '本章'}）"
            ),
            "candidates": candidates,
            "target_chapter_id": target_chapter_id,
            "workflow_id": workflow_id,
            # source 供落库分流（divergent → write_chapter_content；
            # workflow → write_workflow_candidate）与前端来源标签展示
            "source": source,
            "reason": (
                "平行起草完成，已生成多个版本，请选择其一作为本章正文（可编辑后确认）。"
                if is_divergent
                else "工作流执行完成，请选择哪个节点的输出作为本章正文（可编辑后确认）。"
            ),
            "tokens": 0,
            "elapsed_ms": 0,
        }
    )


# ---------------------------------------------------------------------------
# 门控分级（GatingTier）
# ---------------------------------------------------------------------------


class GatingTier(StrEnum):
    """写操作的确认策略分档。

    - L1 创建/新增类：不弹卡直落库（事后纠正），audit 全量留痕（decision="auto"）；
    - L2 正文类：保留弹卡（写正文是不可逆的覆盖型写入）；
    - L3 破坏类：删除/批量覆盖/修改锁定章节——保留弹卡（当前无工具登记，预留）。
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
        overrides: 书籍设置 gating_overrides（{tool_name: "l1"|"l2"|"l3"}）。
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
    "PREVIEW_LIMIT_CHAPTER",
    "PREVIEW_LIMIT_DEFAULT",
    "PREVIEW_LIMIT_ENTITY",
    "REVIEW_TYPES",
    "GatingTier",
    "build_audit_card",
    "build_body_card",
    "build_candidate_card",
    "gating_tier_of",
    "preview_limit_for",
    "truncate_preview",
    "validate_card",
]
