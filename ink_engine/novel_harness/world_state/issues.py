"""世界状态层统一问题模型（审核卡 conflicts 字段的可序列化单元）。

写时校验已规则化：确定性校验器由声明式规则集（ruleset 模块 + 注册谓词）
替代，规则违规经 :class:`~ink_engine.core.rules.RuleViolation` 产出；
本模块保留领域问题模型与类别/严重度词汇——变更应用期拒绝分支
（:mod:`.apply`）与规则违规的 kind/severity/entity 对齐基准共用同一套
常量，防双源漂移。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# 校验问题严重度（error=硬冲突需裁决 / warning=提示级）
SEVERITY_ERROR = "error"
SEVERITY_WARNING = "warning"

# 校验问题类型（WorldIssue.kind / RuleViolation.kind 对齐词汇）
ISSUE_KNOWLEDGE_GAP = "knowledge_gap"
ISSUE_CAUSAL = "causal_chain"
ISSUE_FORESHADOWING = "foreshadowing_chain"
ISSUE_FINGERPRINT = "fingerprint"
# 变更应用期结构问题（apply_state_changes 拒绝分支：未知实体/非法状态迁移）
ISSUE_APPLY = "apply"


@dataclass(frozen=True, slots=True)
class WorldIssue:
    """写时校验问题（审核卡 conflicts 字段的可序列化单元）。

    Attributes:
        kind: 问题类型（knowledge_gap/causal_chain/foreshadowing_chain/fingerprint/apply）。
        severity: error=硬冲突（建议弹卡裁决）/ warning=提示级。
        message: 人类可读的冲突说明。
        entity_type: 关联实体类型（character/foreshadowing/event 等）。
        entity_id: 关联实体 id。
    """

    kind: str
    severity: str
    message: str
    entity_type: str | None = None
    entity_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "severity": self.severity,
            "message": self.message,
            "entity_type": self.entity_type,
            "entity_id": self.entity_id,
        }


def has_hard_conflict(issues: list[WorldIssue]) -> bool:
    """是否存在需用户裁决的硬冲突（error 级）。"""
    return any(i.severity == SEVERITY_ERROR for i in issues)


__all__ = [
    "ISSUE_APPLY",
    "ISSUE_CAUSAL",
    "ISSUE_FINGERPRINT",
    "ISSUE_FORESHADOWING",
    "ISSUE_KNOWLEDGE_GAP",
    "SEVERITY_ERROR",
    "SEVERITY_WARNING",
    "WorldIssue",
    "has_hard_conflict",
]
