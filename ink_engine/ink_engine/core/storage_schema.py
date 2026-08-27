"""存储 schema 描述层（sqlite/postgres 三表 DDL 的单一权威定义）。

sqlite 与 postgres 后端的 checkpoints/event_log/records 三表结构一致，
仅方言差异（自增主键形态、JSON 列形态）。本模块把表结构声明为
方言映射描述，两后端的 DDL 由同一份描述生成——结构演进只改一处，
两后端永不漂移（ENG5-11）。

方言映射：
- ``id``: INTEGER PRIMARY KEY AUTOINCREMENT（sqlite）/ BIGSERIAL PRIMARY KEY（postgres）；
- ``json``: TEXT（sqlite）/ JSONB（postgres）；
- ``real``: REAL（sqlite）/ DOUBLE PRECISION（postgres）；
- ``bigint``: INTEGER（sqlite）/ BIGINT（postgres）。
"""
from __future__ import annotations

# 方言差异映射（新增后端 = 增加方言条目，结构描述不再复制）
_DIALECT_TYPES = {
    "sqlite": {
        "id": "INTEGER PRIMARY KEY AUTOINCREMENT",
        "json": "TEXT",
        "real": "REAL",
        "bigint": "INTEGER",
        "int": "INTEGER",
        "text": "TEXT",
    },
    "postgres": {
        "id": "BIGSERIAL PRIMARY KEY",
        "json": "JSONB",
        "real": "DOUBLE PRECISION",
        "bigint": "BIGINT",
        "int": "INTEGER",
        "text": "TEXT",
    },
}

# 列声明：(列名, 类型槽位, not_null, 默认值文本)
# 默认值文本按原样拼入 SQL（JSON 列默认值带引号：'[]' / '{}'；数值列裸数字）。
# 主键列（id 槽位）不标 NOT NULL：两方言主键均隐含非空（sqlite INTEGER PK /
# postgres SERIAL PK），显式标注与既有 DDL 形态不符。
_TABLES: dict[str, list[tuple[str, str, bool, str | None]]] = {
    "checkpoints": [
        ("checkpoint_id", "id", False, None),
        ("thread_id", "text", True, None),
        ("node", "text", False, None),
        ("graph_path", "json", True, "'[]'"),
        ("state", "json", True, "'{}'"),
        ("parent_id", "bigint", False, None),
        ("reason", "text", False, None),
        ("created_at", "real", True, None),
        ("version", "int", True, "1"),
        ("event_seq", "bigint", True, "0"),
        ("error", "text", False, None),
        ("interrupt", "json", False, None),
        ("graph_version", "text", False, None),
        ("plan", "json", False, None),
    ],
    "event_log": [
        ("seq", "id", False, None),
        ("thread_id", "text", True, None),
        ("event", "json", True, None),
    ],
    "records": [
        ("collection", "text", True, None),
        ("key", "text", True, None),
        ("data", "json", True, None),
    ],
}

# 表 → (索引名, 列清单)（两方言同一组索引，语义一致）
_INDEXES: dict[str, list[tuple[str, str]]] = {
    "checkpoints": [
        ("idx_checkpoints_thread", "thread_id, checkpoint_id DESC"),
    ],
    "event_log": [
        ("idx_event_log_thread", "thread_id, seq"),
    ],
}

# records 表主键（两方言一致：collection+key 唯一）
_RECORDS_PK = "PRIMARY KEY (collection, key)"


def build_schema_sql(dialect: str) -> str:
    """按方言生成三表 DDL（CREATE TABLE IF NOT EXISTS + 索引）。

    Args:
        dialect: ``sqlite`` / ``postgres``（未知方言抛 ValueError）。

    Returns:
        可 executescript/execute 的完整 DDL 文本。
    """
    if dialect not in _DIALECT_TYPES:
        raise ValueError(f"未知存储方言: {dialect!r}（支持 sqlite/postgres）")
    types = _DIALECT_TYPES[dialect]

    def column_ddl(name: str, slot: str, not_null: bool, default: str | None) -> str:
        type_sql = types.get(slot, slot)
        parts = [f"    {name} {type_sql}"]
        if not_null:
            parts.append("NOT NULL")
        if default is not None:
            parts.append(f"DEFAULT {default}")
        return " ".join(parts)

    statements: list[str] = []
    for table, columns in _TABLES.items():
        body = [
            column_ddl(name, slot, not_null, default)
            for name, slot, not_null, default in columns
        ]
        if table == "records":
            body.append(f"    {_RECORDS_PK}")
        statements.append(
            f"CREATE TABLE IF NOT EXISTS {table} (\n"
            + ",\n".join(body)
            + "\n);"
        )
        for index_name, index_columns in _INDEXES.get(table, ()):
            statements.append(
                f"CREATE INDEX IF NOT EXISTS {index_name}"
                f" ON {table}({index_columns});"
            )
    return "\n".join(statements)


__all__ = ["build_schema_sql"]
