"""SQLite 存储实现（aiosqlite，单机/测试默认持久后端）。

三张表：checkpoints（版本链 + 乐观锁）、event_log（append-only 执行日志）、
records（结构化记录，JSON 列）。checkpoint 状态 JSON 序列化入表，
与既有存储 schema 互不兼容（随时删库，不做迁移——schema 变更
即删库重建，启动期自检旧表缺列并给出明确指令）。
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

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS checkpoints (
    checkpoint_id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    node TEXT,
    graph_path TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL DEFAULT '{}',
    parent_id INTEGER,
    reason TEXT,
    created_at REAL NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    event_seq INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    interrupt TEXT,
    graph_version TEXT,
    plan TEXT
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_thread ON checkpoints(thread_id, checkpoint_id DESC);

CREATE TABLE IF NOT EXISTS event_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    event TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_log_thread ON event_log(thread_id, seq);

CREATE TABLE IF NOT EXISTS records (
    collection TEXT NOT NULL,
    key TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (collection, key)
);
"""


class SqliteStorage:
    """SQLite 后端：checkpoint 版本链 + 事件日志 + structured records。

    连接串形如 ``sqlite:///path/to.db``（storage.create_storage 负责剥离前缀）；
    ``:memory:`` 走内存库（测试默认）。乐观锁：UPDATE ... WHERE version = ?，
    影响行数 0 = 冲突抛 CheckpointConflictError。
    """

    def __init__(self, db_path: str = ":memory:") -> None:
        self._db_path = db_path
        self._conn: Any = None
        self._closed = False
        # 初始化互斥：并发首次调用只建一条连接（双重检查）
        self._init_lock = asyncio.Lock()

    async def _connect(self) -> None:
        if self._closed:
            raise StorageError("存储已关闭（use-after-close：close() 后不可再读写）")
        if self._conn is not None:
            return
        async with self._init_lock:
            if self._conn is not None:
                return
            try:
                import aiosqlite

                self._conn = await aiosqlite.connect(self._db_path)
                self._conn.row_factory = aiosqlite.Row
                await self._conn.executescript(_SCHEMA_SQL)
                await self._check_schema()
                await self._conn.commit()
            except Exception as exc:
                # 资源不可用统一归一（缺依赖/文件锁/损坏库等，与 postgres 后端同口径）
                if self._conn is not None:
                    await self._conn.close()
                    self._conn = None
                logger.error(f"sqlite 存储连接失败: {exc}")
                raise StorageError(f"sqlite 存储连接失败: {exc}") from exc

    async def _check_schema(self) -> None:
        """启动期 schema 自检：旧版表缺列时给出明确指令（项目不做迁移，删库重建）。"""
        cur = await self._conn.execute("PRAGMA table_info(checkpoints)")
        rows = await cur.fetchall()
        await cur.close()
        columns = {row["name"] for row in rows}
        if columns and "error" not in columns:
            raise StorageError(
                "检测到旧版 checkpoints 表（缺 error 列）：本项目不做数据迁移，"
                "请删除库/表后重启（DROP TABLE checkpoints, event_log, records;）"
            )
        if columns and "interrupt" not in columns:
            raise StorageError(
                "检测到旧版 checkpoints 表（缺 interrupt 列）：本项目不做数据迁移，"
                "请删除库/表后重启（DROP TABLE checkpoints, event_log, records;）"
            )
        if columns and "graph_version" not in columns:
            raise StorageError(
                "检测到旧版 checkpoints 表（缺 graph_version 列）：本项目不做数据迁移，"
                "请删除库/表后重启（DROP TABLE checkpoints, event_log, records;）"
            )
        if columns and "plan" not in columns:
            raise StorageError(
                "检测到旧版 checkpoints 表（缺 plan 列）：本项目不做数据迁移，"
                "请删除库/表后重启（DROP TABLE checkpoints, event_log, records;）"
            )

    # ── checkpoint 版本链 ──
    async def get_checkpoint(self, checkpoint_id: int) -> CheckpointRecord | None:
        await self._connect()
        try:
            cur = await self._conn.execute(
                "SELECT * FROM checkpoints WHERE checkpoint_id = ?", (checkpoint_id,)
            )
            row = await cur.fetchone()
            await cur.close()
        except Exception as exc:
            raise StorageError(f"sqlite 读取 checkpoint 失败: {exc}") from exc
        return self._row_to_record(row) if row else None

    async def get_latest_checkpoint(self, thread_id: str) -> CheckpointRecord | None:
        await self._connect()
        try:
            cur = await self._conn.execute(
                "SELECT * FROM checkpoints WHERE thread_id = ? ORDER BY checkpoint_id DESC LIMIT 1",
                (thread_id,),
            )
            row = await cur.fetchone()
            await cur.close()
        except Exception as exc:
            raise StorageError(f"sqlite 读取最新 checkpoint 失败: {exc}") from exc
        return self._row_to_record(row) if row else None

    async def put_checkpoint(
        self, record: CheckpointRecord, *, expected_version: int | None = None, fork: bool = False
    ) -> CheckpointRecord:
        await self._connect()
        data = record.to_dict()
        try:
            if record.checkpoint_id == 0:
                # 新链节点：插入后返回自增 id
                if not fork and record.parent_id is not None:
                    # 链一致性不变量（单条语句原子判定，防 TOCTOU）：
                    # - 链尾校验：链尾仍是 parent_id 才插入（NOT EXISTS 查
                    #   不到比 parent 更新的节点）；链已前进（他写并发）→
                    #   0 行 → 冲突；
                    # - 父指针校验：parent 必须存在且属于同一 thread、且
                    #   event_seq 不高于新节点（EXISTS 判定）——悬挂/跨线程
                    #   父指针与 event_seq 回退会在写入期暴露，而非恢复期
                    #   重放错乱才暴露。
                    # fork=True（编辑重放分叉）跳过校验，允许锚点指向历史链节点。
                    cur = await self._conn.execute(
                        "INSERT INTO checkpoints (thread_id, node, graph_path, state,"
                        " parent_id, reason, created_at, version, event_seq, error, interrupt,"
                        " graph_version, plan)"
                        " SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?"
                        " WHERE NOT EXISTS (SELECT 1 FROM checkpoints"
                        " WHERE thread_id = ? AND checkpoint_id > ?)"
                        " AND EXISTS (SELECT 1 FROM checkpoints"
                        " WHERE checkpoint_id = ? AND thread_id = ? AND event_seq <= ?)",
                        (
                            data["thread_id"],
                            data["node"],
                            json.dumps(data["graph_path"]),
                            json.dumps(data["state"], ensure_ascii=False),
                            data["parent_id"],
                            data["reason"],
                            data["created_at"],
                            1,
                            data["event_seq"],
                            data["error"],
                            json.dumps(data["interrupt"], ensure_ascii=False)
                            if data["interrupt"] is not None
                            else None,
                            data["graph_version"],
                            json.dumps(data["plan"], ensure_ascii=False)
                            if data["plan"] is not None
                            else None,
                            data["thread_id"],
                            data["parent_id"],
                            data["parent_id"],
                            data["thread_id"],
                            data["event_seq"],
                        ),
                    )
                else:
                    cur = await self._conn.execute(
                        "INSERT INTO checkpoints (thread_id, node, graph_path, state,"
                        " parent_id, reason, created_at, version, event_seq, error, interrupt,"
                        " graph_version, plan)"
                        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (
                            data["thread_id"],
                            data["node"],
                            json.dumps(data["graph_path"]),
                            json.dumps(data["state"], ensure_ascii=False),
                            data["parent_id"],
                            data["reason"],
                            data["created_at"],
                            1,
                            data["event_seq"],
                            data["error"],
                            json.dumps(data["interrupt"], ensure_ascii=False)
                            if data["interrupt"] is not None
                            else None,
                            data["graph_version"],
                            json.dumps(data["plan"], ensure_ascii=False)
                            if data["plan"] is not None
                            else None,
                        ),
                    )
                await self._conn.commit()
                # 条件插入 0 行 = 链尾已前进（并发写）；lastrowid 在 0 行 INSERT
                # 时保留上次值不可靠，用 rowcount 判定
                updated = cur.rowcount
                checkpoint_id = cur.lastrowid
                await cur.close()
                if updated == 0 or checkpoint_id is None:
                    raise CheckpointConflictError(
                        f"checkpoint 写入被拒绝（链尾已前进/父指针不存在/跨线程/event_seq 回退）: "
                        f"thread={data['thread_id']}"
                    )
                # 返回前规范化（与 _row_to_record 同口径：剥离敏感键 +
                # 类型规范化）——插入分支此前用原始入参构造返回对象，
                # 持久化数据已剥离但活对象未剥离，与内存端契约漂移。
                # 传 json 文本形态（sqlite 列是 TEXT，_row_to_record 内部
                # json.loads + _from_jsonable 还原），与读取路径完全一致。
                return self._row_to_record(
                    {
                        "checkpoint_id": checkpoint_id,
                        "thread_id": data["thread_id"],
                        "node": data["node"],
                        "graph_path": json.dumps(data["graph_path"]),
                        "state": json.dumps(data["state"], ensure_ascii=False),
                        "parent_id": data["parent_id"],
                        "reason": data["reason"],
                        "created_at": data["created_at"],
                        "version": 1,
                        "event_seq": data["event_seq"],
                        "error": data["error"],
                        "interrupt": (
                            json.dumps(data["interrupt"], ensure_ascii=False)
                            if data["interrupt"] is not None
                            else None
                        ),
                        "graph_version": data["graph_version"],
                        "plan": (
                            json.dumps(data["plan"], ensure_ascii=False)
                            if data["plan"] is not None
                            else None
                        ),
                    }
                )
            # 已存在：乐观锁更新（version 期望校验，冲突抛异常）
            if expected_version is None:
                cur = await self._conn.execute(
                    "SELECT version FROM checkpoints WHERE checkpoint_id = ?",
                    (record.checkpoint_id,),
                )
                row = await cur.fetchone()
                await cur.close()
                if row is None:
                    raise StorageError(f"checkpoint 不存在: {record.checkpoint_id}")
                expected_version = row["version"]
            cur = await self._conn.execute(
                "UPDATE checkpoints SET state = ?, node = ?, graph_path = ?, reason = ?,"
                " event_seq = ?, error = ?, interrupt = ?, graph_version = ?, plan = ?,"
                " version = version + 1"
                " WHERE checkpoint_id = ? AND version = ?",
                (
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
                ),
            )
            await self._conn.commit()
            updated = cur.rowcount
            await cur.close()
            if updated == 0:
                raise CheckpointConflictError(
                    f"checkpoint {record.checkpoint_id} 并发写冲突: expected version={expected_version}"
                )
            # 返回库中真值（回读）：父指针不可变（UPDATE 不含 parent_id），
            # 调用方传入的 parent_id 必须被忽略——返回对象与存储一致，
            # 防下游按返回值续链时用错父锚点
            cur = await self._conn.execute(
                "SELECT * FROM checkpoints WHERE checkpoint_id = ?",
                (record.checkpoint_id,),
            )
            row = await cur.fetchone()
            await cur.close()
            return self._row_to_record(row)
        except CheckpointConflictError:
            raise
        except Exception as exc:
            logger.error(f"sqlite checkpoint 写入失败: {exc}")
            raise StorageError(f"sqlite checkpoint 写入失败: {exc}") from exc

    async def list_checkpoints(self, thread_id: str, *, limit: int = 100) -> list[CheckpointRecord]:
        await self._connect()
        try:
            cur = await self._conn.execute(
                "SELECT * FROM checkpoints WHERE thread_id = ? ORDER BY checkpoint_id DESC LIMIT ?",
                (thread_id, limit),
            )
            rows = await cur.fetchall()
            await cur.close()
        except Exception as exc:
            raise StorageError(f"sqlite 列出 checkpoints 失败: {exc}") from exc
        return [self._row_to_record(r) for r in rows]

    async def chain_index(self, thread_id: str) -> list[ChainLink]:
        """轻量链行索引（无 state 快照负载，单次查询取整链，id 降序）。"""
        await self._connect()
        try:
            cur = await self._conn.execute(
                "SELECT checkpoint_id, parent_id, event_seq, graph_path, reason"
                " FROM checkpoints WHERE thread_id = ? ORDER BY checkpoint_id DESC",
                (thread_id,),
            )
            rows = await cur.fetchall()
            await cur.close()
        except Exception as exc:
            raise StorageError(f"sqlite 读取链索引失败: {exc}") from exc
        return [
            ChainLink(
                checkpoint_id=row["checkpoint_id"],
                parent_id=row["parent_id"],
                event_seq=row["event_seq"],
                graph_path=tuple(json.loads(row["graph_path"] or "[]")),
                reason=row["reason"],
            )
            for row in rows
        ]

    async def delete_checkpoints(self, thread_id: str, ids: list[int]) -> int:
        if not ids:
            return 0
        await self._connect()
        placeholders = ",".join("?" * len(ids))
        try:
            cur = await self._conn.execute(
                f"DELETE FROM checkpoints WHERE thread_id = ? AND checkpoint_id IN ({placeholders})",
                (thread_id, *ids),
            )
            await self._conn.commit()
            deleted = cur.rowcount
            await cur.close()
            return deleted
        except Exception as exc:
            raise StorageError(f"sqlite 删除 checkpoints 失败: {exc}") from exc

    async def set_checkpoint_parent(
        self, thread_id: str, checkpoint_id: int, parent_id: int | None
    ) -> None:
        """改写链父指针（链级 rebase：窗口最旧行改写为链头 None）。"""
        await self._connect()
        try:
            cur = await self._conn.execute(
                "UPDATE checkpoints SET parent_id = ? WHERE thread_id = ? AND checkpoint_id = ?",
                (parent_id, thread_id, checkpoint_id),
            )
            await self._conn.commit()
            await cur.close()
        except Exception as exc:
            raise StorageError(f"sqlite 改写 checkpoint 父指针失败: {exc}") from exc

    # ── 执行事件日志（append-only）──
    async def append_event(self, thread_id: str, event: EngineEvent) -> int:
        from dataclasses import replace

        await self._connect()
        try:
            # 安全：事件负载落库前剥离敏感键（与 checkpoint 同口径）
            event = replace(event, seq=0, payload=strip_sensitive(event.payload))
            cur = await self._conn.execute(
                "INSERT INTO event_log (thread_id, event) VALUES (?, ?)",
                (thread_id, event.to_json()),
            )
            await self._conn.commit()
            seq = cur.lastrowid
            await cur.close()
            return seq
        except Exception as exc:
            # 不在此记日志（高频路径，由 executor._publish 统一降频记录）
            raise StorageError(f"sqlite 事件日志写入失败: {exc}") from exc

    async def events_after(self, thread_id: str, seq: int) -> list[EngineEvent]:
        await self._connect()
        try:
            cur = await self._conn.execute(
                "SELECT seq, event FROM event_log WHERE thread_id = ? AND seq > ? ORDER BY seq",
                (thread_id, seq),
            )
            rows = await cur.fetchall()
            await cur.close()
        except Exception as exc:
            raise StorageError(f"sqlite 事件日志读取失败: {exc}") from exc
        return [
            EngineEvent.from_dict({**json.loads(r["event"]), "seq": r["seq"]}) for r in rows
        ]

    async def latest_event_seq(self, thread_id: str) -> int:
        await self._connect()
        try:
            cur = await self._conn.execute(
                "SELECT seq FROM event_log WHERE thread_id = ? ORDER BY seq DESC LIMIT 1",
                (thread_id,),
            )
            row = await cur.fetchone()
            await cur.close()
        except Exception as exc:
            raise StorageError(f"sqlite 读取最新事件 seq 失败: {exc}") from exc
        return int(row["seq"]) if row else 0

    async def truncate_events(self, thread_id: str, after_seq: int) -> None:
        """截断执行日志：删除 seq > after_seq 的事件（编辑重放：日志截断 + 新分支）。"""
        await self._connect()
        try:
            await self._conn.execute(
                "DELETE FROM event_log WHERE thread_id = ? AND seq > ?",
                (thread_id, after_seq),
            )
            await self._conn.commit()
        except Exception as exc:
            raise StorageError(f"sqlite 事件日志截断失败: {exc}") from exc

    async def trim_events(self, thread_id: str, before_seq: int) -> int:
        """裁剪执行日志前缀：删除 seq <= before_seq 的事件（链压缩连带，防日志无界）。"""
        await self._connect()
        try:
            cur = await self._conn.execute(
                "DELETE FROM event_log WHERE thread_id = ? AND seq <= ?",
                (thread_id, before_seq),
            )
            await self._conn.commit()
            deleted = cur.rowcount
            await cur.close()
            return deleted
        except Exception as exc:
            raise StorageError(f"sqlite 事件日志裁剪失败: {exc}") from exc

    # ── structured records ──
    async def put_record(self, collection: str, key: str, data: dict) -> None:
        await self._connect()
        try:
            # 安全：records（记忆等宿主结构化数据）落库前剥离敏感键
            await self._conn.execute(
                "INSERT INTO records (collection, key, data) VALUES (?,?,?)"
                " ON CONFLICT(collection, key) DO UPDATE SET data = excluded.data",
                (collection, key, json.dumps(strip_sensitive(data), ensure_ascii=False)),
            )
            await self._conn.commit()
        except Exception as exc:
            raise StorageError(f"sqlite records 写入失败: {exc}") from exc

    async def get_record(self, collection: str, key: str) -> dict | None:
        await self._connect()
        try:
            cur = await self._conn.execute(
                "SELECT data FROM records WHERE collection = ? AND key = ?", (collection, key)
            )
            row = await cur.fetchone()
            await cur.close()
        except Exception as exc:
            raise StorageError(f"sqlite records 读取失败: {exc}") from exc
        return json.loads(row["data"]) if row else None

    async def list_records(self, collection: str) -> list[dict]:
        await self._connect()
        try:
            cur = await self._conn.execute(
                "SELECT data FROM records WHERE collection = ?", (collection,)
            )
            rows = await cur.fetchall()
            await cur.close()
        except Exception as exc:
            raise StorageError(f"sqlite records 列出失败: {exc}") from exc
        return [json.loads(r["data"]) for r in rows]

    # ── 全量快照（sqlite backup API：目标库 = 源库一致副本）──
    async def snapshot(self, dest: str) -> None:
        """全量备份：把当前库复制到 dest 路径（打开目标连接作备份目标）。

        backup API 为事务级复制（源可并发读），与源自身路径相同时
        显式拒绝（防误覆盖——备份目标须是另一个位置）。
        """
        await self._connect()
        if dest == self._db_path:
            raise StorageError(
                f"快照目标与源相同: {dest}（备份须写入不同位置）"
            )
        import aiosqlite

        dest_conn: Any = None
        try:
            dest_conn = await aiosqlite.connect(dest)
            await self._conn.backup(dest_conn)
            await dest_conn.commit()
        except Exception as exc:
            raise StorageError(f"sqlite 快照失败: {exc}") from exc
        finally:
            if dest_conn is not None:
                await dest_conn.close()

    async def restore(self, src: str) -> None:
        """全量恢复：src 库内容替换当前库（源连接复制进当前连接）。

        backup API 整体替换目标内容（含 schema——源即权威）；与源
        路径相同时 no-op 拒绝（无意义且浪费）。
        """
        await self._connect()
        if src == self._db_path:
            raise StorageError(
                f"恢复源与当前库相同: {src}（当前库已是待恢复内容）"
            )
        import aiosqlite

        src_conn: Any = None
        try:
            src_conn = await aiosqlite.connect(src)
            await src_conn.backup(self._conn)
            await self._conn.commit()
        except Exception as exc:
            raise StorageError(f"sqlite 恢复失败: {exc}") from exc
        finally:
            if src_conn is not None:
                await src_conn.close()

    async def close(self) -> None:
        self._closed = True
        if self._conn is not None:
            await self._conn.close()
            self._conn = None

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
            graph_version=row["graph_version"],
            plan=json.loads(row["plan"]) if row["plan"] else None,
        )


__all__ = ["SqliteStorage"]
