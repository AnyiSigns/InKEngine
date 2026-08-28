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
from .storage import ChainLink, CheckpointRecord, _from_jsonable

logger = get_logger(__name__)


def _decode_jsonb(value: Any, default: Any = None) -> Any:
    """JSONB 列解码（asyncpg 默认已解码为 Python 对象；str 形态兼容再解析）。

    asyncpg 对 jsonb 列的默认编解码器把 JSON 文本解析为 Python 对象
    （dict/list/标量），与 sqlite 的 TEXT 列（须手动 json.loads）不同。
    统一封装后两后端读路径契约等价：已解码对象原样返回、str 兜底解析、
    None 回落默认值。
    """
    if value is None:
        return default
    if isinstance(value, str):
        return json.loads(value)
    return value


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
    interrupt JSONB,
    graph_version TEXT,
    plan JSONB
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
        if columns and "graph_version" not in columns:
            raise StorageError(
                "检测到旧版 checkpoints 表（缺 graph_version 列）：本项目不做数据迁移，"
                "请删除表后重启（DROP TABLE checkpoints, event_log, records;）"
            )
        if columns and "plan" not in columns:
            raise StorageError(
                "检测到旧版 checkpoints 表（缺 plan 列）：本项目不做数据迁移，"
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
                            # 链一致性不变量（事务级咨询锁内原子判定）：
                            # - 链尾校验：链尾仍是 parent_id 才插入（NOT EXISTS
                            #   查不到比 parent 更新的节点）；链已前进（他写并发）
                            #   → 0 行 → 冲突；
                            # - 父指针校验：parent 必须存在且属于同一 thread、
                            #   且 event_seq 不高于新节点（EXISTS 判定）——悬挂/
                            #   跨线程父指针与 event_seq 回退在写入期暴露。
                            # fork=True（编辑重放分叉）跳过校验，允许锚点指向历史链节点。
                            # 参数全部显式转型：asyncpg 对 INSERT ... SELECT 的
                            # 目标列表参数无目标列类型可推断，裸 $n 报
                            # "could not determine data type of parameter"。
                            row = await conn.fetchrow(
                                "INSERT INTO checkpoints (thread_id, node, graph_path, state,"
                                " parent_id, reason, created_at, version, event_seq, error, interrupt,"
                                " graph_version, plan)"
                                " SELECT $1::text,$2::text,$3::jsonb,$4::jsonb,$5::bigint,$6::text,"
                                " $7::double precision,1,$8::bigint,$9::text,$12::jsonb,"
                                " $13::text,$16::jsonb"
                                " WHERE NOT EXISTS (SELECT 1 FROM checkpoints"
                                " WHERE thread_id = $10::text AND checkpoint_id > $11::bigint)"
                                " AND EXISTS (SELECT 1 FROM checkpoints"
                                " WHERE checkpoint_id = $15::bigint"
                                " AND thread_id = $14::text AND event_seq <= $17::bigint)"
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
                                data["graph_version"],
                                data["thread_id"],
                                data["parent_id"],
                                json.dumps(data["plan"], ensure_ascii=False)
                                if data["plan"] is not None
                                else None,
                                data["event_seq"],
                            )
                            if row is None:
                                raise CheckpointConflictError(
                                    f"checkpoint 写入被拒绝（链尾已前进/父指针不存在/跨线程/event_seq 回退）: "
                                    f"thread={data['thread_id']}"
                                )
                        else:
                            row = await conn.fetchrow(
                                "INSERT INTO checkpoints (thread_id, node, graph_path, state,"
                                " parent_id, reason, created_at, version, event_seq, error, interrupt,"
                                " graph_version, plan)"
                                " VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12)"
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
                                json.dumps(data["interrupt"], ensure_ascii=False)
                                if data["interrupt"] is not None
                                else None,
                                data["graph_version"],
                                json.dumps(data["plan"], ensure_ascii=False)
                                if data["plan"] is not None
                                else None,
                            )
                    # 返回前规范化（与 _row_to_record 同口径：JSONB 解码 +
                    # 敏感键剥离 + 类型还原）——插入分支此前用原始入参构造
                    # 返回对象，持久化数据已剥离但活对象未剥离，与内存端
                    # 契约漂移。传 jsonb 解码后形态（dict），_row_to_record
                    # 经 _decode_jsonb 原样透传。
                    return self._row_to_record(
                        {
                            "checkpoint_id": row["checkpoint_id"],
                            "thread_id": data["thread_id"],
                            "node": data["node"],
                            "graph_path": data["graph_path"],
                            "state": data["state"],
                            "parent_id": data["parent_id"],
                            "reason": data["reason"],
                            "created_at": data["created_at"],
                            "version": 1,
                            "event_seq": data["event_seq"],
                            "error": data["error"],
                            "interrupt": data["interrupt"],
                            "graph_version": data["graph_version"],
                            "plan": data["plan"],
                        }
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
                    " graph_version = $8, plan = $9, version = version + 1"
                    " WHERE checkpoint_id = $10 AND version = $11",
                    json.dumps(data["state"], ensure_ascii=False),
                    data["node"],
                    json.dumps(data["graph_path"]),
                    data["reason"],
                    data["event_seq"],
                    data["error"],
                    json.dumps(data["interrupt"], ensure_ascii=False)
                    if data["interrupt"] is not None
                    else None,
                    data["graph_version"],
                    json.dumps(data["plan"], ensure_ascii=False)
                    if data["plan"] is not None
                    else None,
                    record.checkpoint_id,
                    expected_version,
                )
                if updated == "UPDATE 0":
                    raise CheckpointConflictError(
                        f"checkpoint {record.checkpoint_id} 并发写冲突: expected version={expected_version}"
                    )
                # 返回库中真值（回读）：父指针不可变（UPDATE 不含 parent_id），
                # 调用方传入的 parent_id 必须被忽略——返回对象与存储一致，
                # 防下游按返回值续链时用错父锚点
                row = await conn.fetchrow(
                    "SELECT * FROM checkpoints WHERE checkpoint_id = $1",
                    record.checkpoint_id,
                )
                return self._row_to_record(row)
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

    async def chain_index(self, thread_id: str) -> list[ChainLink]:
        """轻量链行索引（无 state 快照负载，单次查询取整链，id 降序）。"""
        await self._connect()
        try:
            async with self._pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT checkpoint_id, parent_id, event_seq, graph_path, reason"
                    " FROM checkpoints WHERE thread_id = $1"
                    " ORDER BY checkpoint_id DESC",
                    thread_id,
                )
        except Exception as exc:
            raise StorageError(f"postgres 读取链索引失败: {exc}") from exc
        return [
            ChainLink(
                checkpoint_id=row["checkpoint_id"],
                parent_id=row["parent_id"],
                event_seq=row["event_seq"],
                graph_path=tuple(_decode_jsonb(row["graph_path"], [])),
                reason=row["reason"],
            )
            for row in rows
        ]

    async def delete_checkpoints(self, thread_id: str, ids: list[int]) -> int:
        if not ids:
            return 0
        await self._connect()
        # 参数从 $2 起（$1 = thread_id），逐位生成占位符
        placeholders = ",".join(f"${i}" for i in range(2, 2 + len(ids)))
        try:
            async with self._pool.acquire() as conn:
                tag = await conn.execute(
                    f"DELETE FROM checkpoints WHERE thread_id = $1"
                    f" AND checkpoint_id IN ({placeholders})",
                    thread_id,
                    *ids,
                )
        except Exception as exc:
            raise StorageError(f"postgres 删除 checkpoints 失败: {exc}") from exc
        # 命令标签形如 "DELETE 5"（asyncpg 无返回值 SQL）
        return int(tag.split()[-1]) if tag.startswith("DELETE") else 0

    async def set_checkpoint_parent(
        self, thread_id: str, checkpoint_id: int, parent_id: int | None
    ) -> None:
        """改写链父指针（链级 rebase：窗口最旧行改写为链头 None）。"""
        await self._connect()
        try:
            async with self._pool.acquire() as conn:
                await conn.execute(
                    "UPDATE checkpoints SET parent_id = $1"
                    " WHERE thread_id = $2 AND checkpoint_id = $3",
                    parent_id,
                    thread_id,
                    checkpoint_id,
                )
        except Exception as exc:
            raise StorageError(f"postgres 改写 checkpoint 父指针失败: {exc}") from exc

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
            EngineEvent.from_dict({**_decode_jsonb(r["event"], {}), "seq": r["seq"]})
            for r in rows
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

    async def trim_events(self, thread_id: str, before_seq: int) -> int:
        """裁剪执行日志前缀：删除 seq <= before_seq 的事件（链压缩连带，防日志无界）。"""
        await self._connect()
        try:
            async with self._pool.acquire() as conn:
                tag = await conn.execute(
                    "DELETE FROM event_log WHERE thread_id = $1 AND seq <= $2",
                    thread_id,
                    before_seq,
                )
        except Exception as exc:
            raise StorageError(f"postgres 事件日志裁剪失败: {exc}") from exc
        return int(tag.split()[-1]) if tag.startswith("DELETE") else 0

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
        return _decode_jsonb(row["data"]) if row else None

    async def list_records(self, collection: str) -> list[dict]:
        await self._connect()
        try:
            async with self._pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT data FROM records WHERE collection = $1", collection
                )
        except Exception as exc:
            raise StorageError(f"postgres records 列出失败: {exc}") from exc
        return [_decode_jsonb(r["data"]) for r in rows]

    async def delete_collection(self, collection: str) -> int:
        """删除集合全部记录，返回删除条数（集合空 = 0，不报错）。"""
        await self._connect()
        try:
            async with self._pool.acquire() as conn:
                result = await conn.execute(
                    "DELETE FROM records WHERE collection = $1", collection
                )
                # asyncpg execute 返回 "DELETE <n>" 形态命令标签
                count = int((result or "0").split()[-1] or 0)
                return count
        except Exception as exc:
            raise StorageError(f"postgres records 删除失败: {exc}") from exc

    # ── 全量快照（显式不支持：服务器级备份归 pg_dump/归档基础设施）──
    async def snapshot(self, dest: str) -> None:
        """不支持（显式 NotImplementedError）。

        Postgres 的引擎侧连接是应用会话（不是文件），引擎无权也不应
        直接复制服务器数据文件——服务器级全量备份是运维基础设施
        （pg_dump/文件系统归档/流式复制）的职责，由宿主在应用之外
        编排；需要引擎内快照的能力（连点导出/迁移引子）时，应走
        structured records 逐集合导出，而非伪造文件级快照。
        """

        raise NotImplementedError(
            "Postgres 后端不支持文件级快照（服务器备份归 pg_dump/"
            "归档基础设施；需要应用内导出请走 records 逐集合或日志流）"
        )

    async def restore(self, src: str) -> None:
        """不支持（显式 NotImplementedError，语义同 :meth:`snapshot`）。"""

        raise NotImplementedError(
            "Postgres 后端不支持文件级恢复（恢复归 pg_restore/归档流程；"
            "请勿把任意文件内容写进线上数据库文件）"
        )

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
            graph_path=tuple(_decode_jsonb(row["graph_path"], [])),
            state=_from_jsonable(_decode_jsonb(row["state"], {})),
            parent_id=row["parent_id"],
            reason=row["reason"],
            created_at=row["created_at"],
            version=row["version"],
            event_seq=row["event_seq"],
            error=row["error"],
            interrupt=(
                InterruptState.from_dict(
                    _from_jsonable(_decode_jsonb(row["interrupt"], {}))
                )
                if _decode_jsonb(row["interrupt"]) is not None
                else None
            ),
            graph_version=row["graph_version"],
            plan=_decode_jsonb(row["plan"]),
        )


__all__ = ["PostgresStorage"]
