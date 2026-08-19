"""novel 领域种子的 schema 基座（纯数据：知识条目与世界观视图的字段口径）。

schema 基座是「如何声明领域知识」的示范数据——经引擎
:class:`~ink_engine.core.schema_validator.SchemaValidator` 校验知识条目
（L1 准入）与领域数据视图（组装/落库前的形式合法关）。全部为可序列化
声明数据（随补丁链版本化，与规则集/样例库同构），不携带执行代码。

基座含两个独立口径（校验对象不同，分开声明防误用）：
- 知识条目口径（``novel.knowledge_entry``）：知识集机制统一形态字段；
- 世界观视图口径（``novel.world_view``）：写时校验输入视图字段
  （与样例库用例同构的 JSON 兼容数据契约）。
"""
from __future__ import annotations

from ink_engine.core.schema_validator import SchemaField, SchemaSpec

# schema 基座名称（知识集内引用的稳定键）
NOVEL_KNOWLEDGE_ENTRY_SCHEMA = "novel.knowledge_entry"
NOVEL_WORLD_VIEW_SCHEMA = "novel.world_view"

# 知识条目的字段口径（知识集机制统一形态 + novel 领域字段）
_KNOWLEDGE_ENTRY_FIELDS = (
    SchemaField(name="id", required=True, kind="string"),
    SchemaField(name="level", required=True, kind="string"),
    SchemaField(name="kind", required=True, kind="string"),
    SchemaField(name="data", required=True, kind="object"),
    SchemaField(name="source", required=True, kind="string"),
    SchemaField(name="credibility", kind="number", min=0.0, max=1.0),
    SchemaField(name="title", kind="string"),
    SchemaField(name="tags", kind="array"),
)

# 世界观视图（规则集校验输入）的字段口径：视图 = JSON 兼容数据，
# 与样例库用例同构（写时校验/组装消费同一份数据契约）
_WORLD_VIEW_FIELDS = (
    SchemaField(name="characters", kind="object"),
    SchemaField(name="knowledge", kind="object"),
    SchemaField(name="events", kind="object"),
    SchemaField(name="causal_links", kind="array"),
    SchemaField(name="foreshadowings", kind="object"),
    SchemaField(name="changes", kind="array"),
)


def build_novel_schema_base() -> tuple[SchemaSpec, SchemaSpec]:
    """novel 领域 schema 基座：(知识条目口径, 世界观视图口径)。"""
    return (
        SchemaSpec(name=NOVEL_KNOWLEDGE_ENTRY_SCHEMA, fields=_KNOWLEDGE_ENTRY_FIELDS),
        SchemaSpec(name=NOVEL_WORLD_VIEW_SCHEMA, fields=_WORLD_VIEW_FIELDS),
    )


__all__ = [
    "NOVEL_KNOWLEDGE_ENTRY_SCHEMA",
    "NOVEL_WORLD_VIEW_SCHEMA",
    "build_novel_schema_base",
]
