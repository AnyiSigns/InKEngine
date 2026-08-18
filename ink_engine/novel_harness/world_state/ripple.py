"""涟漪效应扫描（Ripple Scanner：改设定 → 全书需修订清单）。

引用索引（references）由宿主按正文实体识别构建——本原语只做判定与
清单组装，不承担检索职责。
"""
from __future__ import annotations

from dataclasses import dataclass

from .issues import SEVERITY_ERROR, SEVERITY_WARNING
from .models import _key


@dataclass(frozen=True, slots=True)
class SettingChange:
    """一次设定变更（涟漪扫描输入）。

    Attributes:
        entity_id: 变更实体 id。
        entity_type: 实体类型（character/location 等）。
        field: 变更的字段名（age/location/name 等；None=实体整体变更）。
        old_value: 旧值（展示用）。
        new_value: 新值（展示用）。
    """

    entity_id: str
    entity_type: str
    field: str | None = None
    old_value: str = ""
    new_value: str = ""


@dataclass(frozen=True, slots=True)
class EntityReference:
    """正文中一处实体引用（引用索引条目，宿主扫描章节文本构建）。

    Attributes:
        entity_id: 引用实体 id。
        entity_type: 实体类型。
        chapter_id: 所在章节。
        paragraph_index: 段内序号（0 起，可空）。
        excerpt: 命中片段（展示/跳转用）。
        field: 该处引用涉及的字段（None=泛引用，无法判定是否受影响）。
    """

    entity_id: str
    entity_type: str
    chapter_id: int
    paragraph_index: int | None = None
    excerpt: str = ""
    field: str | None = None


@dataclass(frozen=True, slots=True)
class RippleHit:
    """涟漪扫描命中项（需修订清单条目）。

    Attributes:
        reference: 命中的引用位置。
        reason: 命中原因。
        severity: error=需修订 / warning=需人工核对。
    """

    reference: EntityReference
    reason: str
    severity: str


def scan_ripple(
    change: SettingChange,
    references: list[EntityReference],
) -> list[RippleHit]:
    """涟漪效应扫描：设定变更 → 受影响引用清单（纯函数，可单测）。

    命中规则：
    - 实体整体变更（field=None）→ 该实体全部引用 error（全面受影响）；
    - 引用标注了同一字段（ref.field == change.field）→ error（该处表述
      依赖变更字段，需修订）；
    - 引用为泛引用（ref.field=None）→ warning（无法判定，需人工核对）；
    - 引用标注了其它字段 → 跳过（不受本次变更影响）。
    """
    hits: list[RippleHit] = []
    key = _key(change.entity_id)
    for ref in references:
        if ref.entity_type != change.entity_type or _key(ref.entity_id) != key:
            continue
        if change.field is None:
            hits.append(
                RippleHit(
                    reference=ref,
                    reason=f"{change.entity_type}[{key}] 整体变更，此处引用需修订",
                    severity=SEVERITY_ERROR,
                )
            )
        elif ref.field == change.field:
            hits.append(
                RippleHit(
                    reference=ref,
                    reason=f"字段 {change.field} 已变更（{change.old_value}→{change.new_value}），此处需修订",
                    severity=SEVERITY_ERROR,
                )
            )
        elif ref.field is None:
            hits.append(
                RippleHit(
                    reference=ref,
                    reason=f"字段 {change.field} 已变更，此处为泛引用需人工核对",
                    severity=SEVERITY_WARNING,
                )
            )
    return hits


def group_ripple_hits_by_chapter(hits: list[RippleHit]) -> dict[int, list[RippleHit]]:
    """按章节分组需修订清单（长书维护的修订视图：逐章处理）。"""
    grouped: dict[int, list[RippleHit]] = {}
    for hit in sorted(hits, key=lambda h: (h.reference.chapter_id, h.reference.paragraph_index or 0)):
        grouped.setdefault(hit.reference.chapter_id, []).append(hit)
    return grouped


__all__ = [
    "EntityReference",
    "RippleHit",
    "SettingChange",
    "group_ripple_hits_by_chapter",
    "scan_ripple",
]
