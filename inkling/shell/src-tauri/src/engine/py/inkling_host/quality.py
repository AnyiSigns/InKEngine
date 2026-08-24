"""按域产出质量判定（使用方注入组装请求的窄协议实现）与档位映射。

组装请求携带的质量闸门（QualityGate 窄协议）只定义判定的接口形态，
实现归使用方：本模块按域提供**零模型调用的硬规则判定**——判定 = 纯
Python 函数检查产出字典的结构完整性与身份字段，速度毫秒级、结果可
复现（同一产出永远同一结论），与证据采集「纯算法」同一取向：判定不
引入任何模型评审，模型评审一律上移为离线机制。

覆盖的域：

- ``assemble_tools``（声明式工具产出）：工艺完备性——名称（短词、
  ≤24 字符）/说明/入参声明齐备；
- ``research``（研究/知识产出）：查重前提——身份字段（id/标题/内容）
  全部非空（可哈希去重的前提）；
- 其余域（含直答型）：通用完整性——产出为主要文本字段且长度达标，
  低于下限判定为未成形。

档位映射（审批档 → 组装放行档）：

- 0 最严：无审批（L0）任务不得进入高安全结点档位；
- 1：评审（L1）档任务可放行 1 档结点；
- 2：验证（L2）档任务可放行 2 档结点；
- 未知/缺失 = 默认 0（fail-closed：拿不准就最严）。
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from ink_engine.core.contracts import QualityGate

# 审批档 → 组装放行档映射（0 最严；档位含义见模块文档）
APPROVAL_TIER_TO_MAX_SAFETY_TIER: dict[str, int] = {
    "L0": 0,
    "L1": 1,
    "L2": 2,
}

# 缺省放行档（未知/缺失审批档 = 0 最严，fail-closed）
DEFAULT_MAX_SAFETY_TIER = 0

# 工具名短词上限（声明式工具命名规范；含下划线/超长一律拒判）
TOOL_NAME_MAX_CHARS = 24

# 产出文本达标下限（字符；低于 = 未成形产出，不进入下一层）
MIN_TEXT_CHARS = 10

# 工具说明达标下限（字符；工具工艺判定用，低于 = 说明不成句）
MIN_TOOL_DESCRIPTION_CHARS = 4


def approval_tier_to_max_safety_tier(approval_tier: str | None) -> int:
    """审批档 → 组装放行档（缺省/未知档位 = 0 最严，fail-closed）。

    档位映射表为本模块常量（app 赋值数据；使用方按任务审批档取放行档）。
    """
    if not approval_tier:
        return DEFAULT_MAX_SAFETY_TIER
    return APPROVAL_TIER_TO_MAX_SAFETY_TIER.get(
        str(approval_tier).upper(), DEFAULT_MAX_SAFETY_TIER
    )


def _is_usable_text(value: Any, min_chars: int = MIN_TEXT_CHARS) -> bool:
    """非空且有实质内容的文本（剥离空白后长度达标）。"""
    return isinstance(value, str) and len(value.strip()) >= min_chars


def _tool_craft_ok(artifact: Any) -> bool:
    """声明式工具定义（工艺）：名称/说明/入参声明齐备。"""
    if not isinstance(artifact, dict):
        return False
    name = artifact.get("name")
    if not isinstance(name, str) or not name.strip():
        return False
    if len(name) > TOOL_NAME_MAX_CHARS or "_" in name:
        return False
    if not _is_usable_text(
        artifact.get("description"), MIN_TOOL_DESCRIPTION_CHARS
    ):
        return False
    params = artifact.get(
        "params", artifact.get("parameters", artifact.get("args_schema"))
    )
    return isinstance(params, (list, dict)) and len(params) > 0


def _research_dedup_ok(artifact: Any) -> bool:
    """研究域：身份字段齐备——查重（哈希去重）的前提。

    产出缺失身份字段时无法进入去重判断，判定为未成形（严格判失败，
    不静默放行无身份产出）。
    """
    if not isinstance(artifact, dict):
        return False
    for key in ("id", "title", "content"):
        value = artifact.get(key)
        if not isinstance(value, str) or not value.strip():
            return False
    return True


def _direct_answer_ok(artifact: Any) -> bool:
    """直答/通用完整性：主要文本字段存在且长度达标。"""
    if not isinstance(artifact, dict):
        return False
    content = artifact.get("content", artifact.get("answer"))
    return _is_usable_text(content)


# 域 → 硬规则（纯函数；全部零模型调用）
DOMAIN_CHECKS: Mapping[str, Callable[[Any], bool]] = {
    "assemble_tools": _tool_craft_ok,
    "research": _research_dedup_ok,
    "direct_answer": _direct_answer_ok,
    "default": _direct_answer_ok,
}


class DomainQualityGate:
    """按域产出质量判定（QualityGate 协议实现；同步判定，零模型调用）。

    判定 = 纯函数结构检查：拼装时刻不消费本闸门（组装只出候选），
    闸门结论供汇流择优/沉淀质量线使用；域未知 = 回落到通用完整性
    规则（绝不因域未登记而放行空产出）。可注入自定义检查表（检查表
    形态 = 域名 → 纯函数，覆盖 Default 后按表演进）。
    """

    def __init__(
        self, checks: Mapping[str, Callable[[Any], bool]] | None = None
    ) -> None:
        self._checks = dict(DOMAIN_CHECKS if checks is None else checks)

    def judge(self, domain: str, artifact: Any) -> bool:
        """按域判定产出（同步布尔；异常一律判失败，不击穿调用方）。"""
        check = self._checks.get(str(domain or ""), self._checks["default"])
        try:
            return bool(check(artifact))
        except Exception:
            return False


class SettleQualityGate:
    """沉淀钩子闸门适配：域质量判定（judge）→ 沉淀 QualityGate（evaluate）。

    沉淀钩子（指纹入库线/推荐先验晋升线）消费的闸门协议 = 
    ``evaluate(ctx) -> bool``（SettleContext 形态）；本适配把运行期
    产出（顶层图最终状态）喂给域硬规则判定——零模型调用，与组装请求
    侧同源同判。
    """

    def __init__(self, gate: DomainQualityGate | None = None) -> None:
        self._gate = gate or DomainQualityGate()

    async def evaluate(self, ctx: Any) -> bool:
        return self._gate.judge(
            getattr(ctx, "domain", "default"),
            getattr(getattr(ctx, "result", None), "state", {}) or {},
        )


__all__ = [
    "APPROVAL_TIER_TO_MAX_SAFETY_TIER",
    "DEFAULT_MAX_SAFETY_TIER",
    "DOMAIN_CHECKS",
    "MIN_TEXT_CHARS",
    "MIN_TOOL_DESCRIPTION_CHARS",
    "TOOL_NAME_MAX_CHARS",
    "DomainQualityGate",
    "SettleQualityGate",
    "approval_tier_to_max_safety_tier",
]
