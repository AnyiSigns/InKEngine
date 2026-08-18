"""Postgres 存储实现（asyncpg，多 worker/部署环境持久后端）。

与 sqlite 后端同构（三张表 + JSON 列），连接串 ``postgresql://user:pwd@host/db``
（``postgres://`` 别名兼容 DATABASE_URL）。独立实现（不复用 sqlite 代码）：
SQL 方言差异（INSERT ... RETURNING、乐观锁 UPDATE 返回行数）与连接管理
（asyncpg pool）各自封装，保持模块内聚。schema 变更即删库重建（不做迁移），
启动期自检旧表缺列并给出明确指令。
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

from .events import EngineEvent
from .exceptions import CheckpointConflictError, StorageError
from .logging import get_logger
from .security import strip_sensitive
from .storage import CheckpointRecord, _from_jsonable

logger = get_logger(__name__)

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS checkpoints (
    checkpoint_id BIGSERIAL PRIMARY KEY,
    thread_id TEXT NOT NULL,
    node TEXT,
    graph_path JSONB NOT NULL DEFAULT '[]',
    state JSONB NOT NULL DEFAULT '{}',
    parent_id BIGINT,
    reason TEXT,
    created_at DOUBLE PRECISION NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    event_seq BIGINT NOT NULL DEFAULT 0,
    error TEXT,
    interrupt JSONB
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_thread ON checkpoints(thread_id, checkpoint_id DESC);

CREATE TABLE IF NOT EXISTS event_log (
    seq BIGSERIAL PRIMARY KEY,
    thread_id TEXT NOT NULL,
    event JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_log_thread ON event_log(thread_id, seq);

CREATE TABLE IF NOT EXISTS records (
    collection TEXT NOT NULL,
    key TEXT NOT NULL,
    data JSONB NOT NULL,
    PRIMARY KEY (collection, key)
);
"""


class PostgresStorage:
    """Postgres 后端：checkpoint 版本链 + 事件日志 + structured records。

    连接串 ``postgresql://user:pwd@host:5432/db``（storage.create_storage
    原样透传）。乐观锁：UPDATE ... WHERE version = ?，返回行数 0 = 冲突。
    """

    def __init__(self, conn_string: str) -> None:
        self._conn_string = conn_string
        self._pool: Any = None
        self._closed = False
        # 初始化互斥：并发首次调用只建一个 pool（双重检查）
        self._init_lock = asyncio.Lock()

    async def _connect(self) -> None:
        if self._closed:
            raise StorageError("存储已关闭（use-after-close：close() 后不可再读写）")
        if self._pool is not None:
            return
        async with self._init_lock:
            if self._pool is not None:
                return
            try:
                import asyncpg

                self._pool = await asyncpg.create_pool(self._conn_string, min_size=1, max_size=5)
                async with self._pool.acquire() as conn:
                    await conn.execute(_SCHEMA_SQL)
                    await self._check_schema(conn)
            except Exception as exc:
                # 失败必须关池并复位（半初始化会把后端永钉在坏状态，DDL 永不重试）
                if self._pool is not None:
                    await self._pool.close()
                    self._pool = None
                logger.error(f"postgres 存储连接失败: {exc}")
                raise StorageError(f"postgres 存储连接失败: {exc}") from exc

    async def _check_schema(self, conn: Any) -> None:
        """启动期 schema 自检：旧版表缺列时给出明确指令（项目不做迁移，删库重建）。"""
        rows = await conn.fetch(
            "SELECT column_name FROM information_schema.columns"
            " WHERE table_name = 'checkpoints'"
        )
        columns = {r["column_name"] for r in rows}
        if columns and "error" not in columns:
            raise StorageError(
                "检测到旧版 checkpoints 表（缺 error 列）：本项目不做数据迁移，"
                "请删除表后重启（DROP TABLE checkpoints, event_log, records;）"
            )
        if columns and "interrupt" not in columns:
            raise StorageError(
                "检测到旧版 checkpoints 表（缺 interrupt 列）：本项目不做数据迁移，"
                "请删除表后重启（DROP TABLE checkpoints, event_log, records;）"
            )

    async def get_checkpoint(self, checkpoint_id: int) -> CheckpointRecord | None:
        await self._connect()
        try:
            async with self._pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT * FROM checkpoints WHERE checkpoint_id = $1", checkpoint_id
                )
        except StorageError:
            raise
        except Exception as exc:
            raise StorageError(f"postgres 读取 checkpoint 失败: {exc}") from exc
        return self._row_to_record(row) if row else None

    async def get_latest_checkpoint(self, thread_id: str) -> CheckpointRecord | None:
        await self._connect()
        try:
            async with self._pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT * FROM checkpoints WHERE thread_id = $1"
                    " ORDER BY checkpoint_id DESC LIMIT 1",
                    thread_id,
                )
        except StorageError:
            raise
        except Exception as exc:
            raise StorageError(f"postgres 读取最新 checkpoint 失败: {exc}") from exc
        return self._row_to_record(row) if row else None

    async def put_checkpoint(
        self, record: CheckpointRecord, *, expected_version: int | None = None, fork: bool = False
    ) -> CheckpointRecord:
        await self._connect()
        data = record.to_dict()
        try:
            async with self._pool.acquire() as conn:
                if record.checkpoint_id == 0:
                    # 新链节点：per-thread 事务级咨询锁串行化并发续链——
                    # READ COMMITTED 下 NOT EXISTS 看不到并发未提交行，裸条件插入
                    # 会让两个 worker 各自成功、产生同 parent_id 兄弟节点（静默分叉）。
                    async with conn.transaction():
                        await conn.execute(
                            "SELECT pg_advisory_xact_lock(hashtext($1))", record.thread_id
                        )
                        if not fork and record.parent_id is not None:
                            # 并发写保护（乐观锁语义）：链尾仍是 parent_id 才插入；
                            # fork=True（编辑重放分叉）跳过校验，允许锚点指向历史链节点。
                            row = await conn.fetchrow(
                                "INSERT INTO checkpoints (thread_id, node, graph_path, state,"
                                " parent_id, reason, created_at, version, event_seq, error, interrupt)"
                                " SELECT $1,$2,$3,$4,$5,$6,$7,1,$8,$9,$12"
                                " WHERE NOT EXISTS (SELECT 1 FROM checkpoints"
                                " WHERE thread_id = $10 AND checkpoint_id > $11)"
                                " RETURNING checkpoint_id",
                                data["thread_id"],
                                data["node"],
                                json.dumps(data["graph_path"]),
                                json.dumps(data["state"], ensure_ascii=False),
                                data["parent_id"],
                                data["reason"],
                                data["created_at"],
                                data["event_seq"],
                                data["error"],
                                data["thread_id"],
                                data["parent_id"],
                                json.dumps(data["interrupt"], ensure_ascii=False)
                                if data["interrupt"] is not None
                                else None,
                            )
                            if row is None:
                                raise CheckpointConflictError(
                                    f"checkpoint 并发写冲突（链尾已前进）: thread={data['thread_id']}"
                                )
                        else:
                            row = await conn.fetchrow(
                                "INSERT INTO checkpoints (thread_id, node, graph_path, state,"
                                " parent_id, reason, created_at, version, event_seq, error, interrupt)"
                                " VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10) RETURNING checkpoint_id",
                                data["thread_id"],
                                data["node"],
                                json.dumps(data["graph_path"]),
                                json.dumps(data["state"], ensure_ascii=False),
                                data["parent_id"],
                                data["reason"],
                                data["created_at"],
                                data["event_seq"],
                                data["error"],
                                json.dumps(data["interrupt"], ensure_ascii=False)
                                if data["interrupt"] is not None
                                else None,
                            )
                    return CheckpointRecord(
                        checkpoint_id=row["checkpoint_id"],
                        thread_id=record.thread_id,
                        node=record.node,
                        graph_path=record.graph_path,
                        state=record.state,
                        parent_id=record.parent_id,
                        reason=record.reason,
                        created_at=record.created_at,
                        version=1,
                        event_seq=record.event_seq,
                        error=record.error,
                        interrupt=record.interrupt,
                    )
                if expected_version is None:
                    row = await conn.fetchrow(
                        "SELECT version FROM checkpoints WHERE checkpoint_id = $1",
                        record.checkpoint_id,
                    )
                    if row is None:
                        raise StorageError(f"checkpoint 不存在: {record.checkpoint_id}")
                    expected_version = row["version"]
                updated = await conn.execute(
                    "UPDATE checkpoints SET state = $1, node = $2, graph_path = $3,"
                    " reason = $4, event_seq = $5, error = $6, interrupt = $7,"
                    " version = version + 1"
                    " WHERE checkpoint_id = $8 AND version = $9",
                    json.dumps(data["state"], ensure_ascii=False),
                    data["node"],
                    json.dumps(data["graph_path"]),
                    data["reason"],
                    data["event_seq"],
                    data["error"],
                    json.dumps(data["interrupt"], ensure_ascii=False)
                    if data["interrupt"] is not None
                    else None,
                    record.checkpoint_id,
                    expected_version,
                )
                if updated == "UPDATE 0":
                    raise CheckpointConflictError(
                        f"checkpoint {record.checkpoint_id} 并发写冲突: expected version={expected_version}"
                    )
                return CheckpointRecord(
                    checkpoint_id=record.checkpoint_id,
                    thread_id=record.thread_id,
                    node=data["node"],
                    graph_path=record.graph_path,
                    state=record.state,
                    parent_id=record.parent_id,
                    reason=record.reason,
                    created_at=record.created_at,
                    version=expected_version + 1,
                    event_seq=record.event_seq,
                    error=record.error,
                    interrupt=record.interrupt,
                )
        except CheckpointConflictError:
            raise
        except Exception as exc:
            logger.error(f"postgres checkpoint 写入失败: {exc}")
            raise StorageError(f"postgres checkpoint 写入失败: {exc}") from exc

    async def list_checkpoints(self, thread_id: str, *, limit: int = 100) -> list[CheckpointRecord]:
        await self._connect()
        try:
            async with self._pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT * FROM checkpoints WHERE thread_id = $1"
                    " ORDER BY checkpoint_id DESC LIMIT $2",
                    thread_id,
                    limit,
                )
        except Exception as exc:
            raise StorageError(f"postgres 列出 checkpoints 失败: {exc}") from exc
        return [self._row_to_record(r) for r in rows]

    async def append_event(self, thread_id: str, event: EngineEvent) -> int:
        from dataclasses import replace

        await self._connect()
        try:
            async with self._pool.acquire() as conn:
                # 安全：事件负载落库前剥离敏感键（与 checkpoint 同口径）
                event = replace(event, seq=0, payload=strip_sensitive(event.payload))
                row = await conn.fetchrow(
                    "INSERT INTO event_log (thread_id, event) VALUES ($1, $2) RETURNING seq",
                    thread_id,
                    event.to_json(),
                )
                return row["seq"]
        except Exception as exc:
            # 不在此记日志（高频路径，由 executor._publish 统一降频记录）
            raise StorageError(f"postgres 事件日志写入失败: {exc}") from exc

    async def events_after(self, thread_id: str, seq: int) -> list[EngineEvent]:
        await self._connect()
        try:
            async with self._pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT seq, event FROM event_log WHERE thread_id = $1 AND seq > $2 ORDER BY seq",
                    thread_id,
                    seq,
                )
        except Exception as exc:
            raise StorageError(f"postgres 事件日志读取失败: {exc}") from exc
        return [
            EngineEvent.from_dict({**json.loads(r["event"]), "seq": r["seq"]}) for r in rows
        ]

    async def latest_event_seq(self, thread_id: str) -> int:
        await self._connect()
        try:
            async with self._pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT seq FROM event_log WHERE thread_id = $1"
                    " ORDER BY seq DESC LIMIT 1",
                    thread_id,
                )
        except Exception as exc:
            raise StorageError(f"postgres 读取最新事件 seq 失败: {exc}") from exc
        return int(row["seq"]) if row else 0

    async def truncate_events(self, thread_id: str, after_seq: int) -> None:
        await self._connect()
        try:
            async with self._pool.acquire() as conn:
                await conn.execute(
                    "DELETE FROM event_log WHERE thread_id = $1 AND seq > $2", thread_id, after_seq
                )
        except Exception as exc:
            raise StorageError(f"postgres 事件日志截断失败: {exc}") from exc

    async def put_record(self, collection: str, key: str, data: dict) -> None:
        await self._connect()
        try:
            async with self._pool.acquire() as conn:
                # 安全：records（记忆等宿主结构化数据）落库前剥离敏感键
                await conn.execute(
                    "INSERT INTO records (collection, key, data) VALUES ($1,$2,$3)"
                    " ON CONFLICT (collection, key) DO UPDATE SET data = excluded.data",
                    collection,
                    key,
                    json.dumps(strip_sensitive(data), ensure_ascii=False),
                )
        except Exception as exc:
            raise StorageError(f"postgres records 写入失败: {exc}") from exc

    async def get_record(self, collection: str, key: str) -> dict | None:
        await self._connect()
        try:
            async with self._pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT data FROM records WHERE collection = $1 AND key = $2",
                    collection,
                    key,
                )
        except Exception as exc:
            raise StorageError(f"postgres records 读取失败: {exc}") from exc
        return json.loads(row["data"]) if row else None

    async def list_records(self, collection: str) -> list[dict]:
        await self._connect()
        try:
            async with self._pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT data FROM records WHERE collection = $1", collection
                )
        except Exception as exc:
            raise StorageError(f"postgres records 列出失败: {exc}") from exc
        return [json.loads(r["data"]) for r in rows]

    async def close(self) -> None:
        self._closed = True
        if self._pool is not None:
            await self._pool.close()
            self._pool = None

    @staticmethod
    def _row_to_record(row: Any) -> CheckpointRecord:
        from .interrupt import InterruptState

        return CheckpointRecord(
            checkpoint_id=row["checkpoint_id"],
            thread_id=row["thread_id"],
            node=row["node"],
            graph_path=tuple(json.loads(row["graph_path"] or "[]")),
            state=_from_jsonable(json.loads(row["state"] or "{}")),
            parent_id=row["parent_id"],
            reason=row["reason"],
            created_at=row["created_at"],
            version=row["version"],
            event_seq=row["event_seq"],
            error=row["error"],
            interrupt=(
                InterruptState.from_dict(_from_jsonable(json.loads(row["interrupt"])))
                if row["interrupt"]
                else None
            ),
        )


__all__ = ["PostgresStorage"]
