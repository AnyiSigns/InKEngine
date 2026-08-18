"""通用存储服务（Kilo Code 式：引擎内全部持久化统一走存储服务接口）。

structured records + JSON 数据，适配内存/sqlite/postgres，连接串/配置
切换后端。引擎承载两类持久化：
- checkpoint 版本链（快照，乐观锁并发写保护）；
- 执行事件日志（append-only，恢复 = 快照 + 增量日志重放）。

接口只定义存储语义，不绑定图执行——未来回合记录/步骤序列/记忆/世界状态
同走此接口（structured records 通道）。后端切换 = 换连接串（create_storage
工厂），业务代码零改动。
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from .events import EngineEvent
from .logging import get_logger
from .patch_chain import PatchChain
from .security import is_sensitive_key

# 连接串协议前缀 → 后端工厂（memory:// / sqlite:///path / postgresql://）
SCHEME_MEMORY = "memory"
SCHEME_SQLITE = "sqlite"
SCHEME_POSTGRES = "postgresql"

# 补丁链序列化标记键（checkpoint JSON 列内联结构，from_dict 精确还原）
_PATCH_CHAIN_MARKER = "__patch_chain__"
# 引擎消息/工具调用序列化标记键（状态通道可能持有 Message/ToolCall 对象，
# checkpoint 落库前须转为可 JSON 结构，恢复时精确还原）
_MESSAGE_MARKER = "__engine_message__"
_TOOL_CALL_MARKER = "__engine_tool_call__"

logger = get_logger(__name__)


def _jsonable_strip(value: Any) -> Any:
    """状态值 → JSON 可序列化（PatchChain/Message/ToolCall 内联为标记 dict），
    单次递归内联敏感键剥离。

    checkpoint 序列化热路径：剥离与 jsonable 合并为一次遍历（原 strip + jsonable
    两次全量递归）。copy-on-write：子树无敏感键返回原对象。
    """
    if isinstance(value, PatchChain):
        return {
            _PATCH_CHAIN_MARKER: True,
            "base": _jsonable_strip(value.base),
            "patches": [
                {"op": p.op.value, "path": list(p.path), "value": _jsonable_strip(p.value)}
                for p in value.patches
            ],
        }
    from .llm.messages import Message, ToolCall

    if isinstance(value, Message):
        return {_MESSAGE_MARKER: True, "data": _jsonable_strip(value.to_dict())}
    if isinstance(value, ToolCall):
        return {
            _TOOL_CALL_MARKER: True,
            "id": value.id,
            "name": value.name,
            "arguments": value.arguments,
        }
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        changed = False
        for key, item in value.items():
            if is_sensitive_key(key):
                result[key] = ""  # 置空保留（键结构不破坏，下游 .get 恒返回空串）
                changed = True
                continue
            stripped = _jsonable_strip(item)
            if stripped is not item:
                changed = True
            result[key] = stripped
        return result if changed else value
    if isinstance(value, list):
        out = [_jsonable_strip(v) for v in value]
        return out if any(o is not v for o, v in zip(out, value, strict=True)) else value
    if isinstance(value, tuple):
        out = tuple(_jsonable_strip(v) for v in value)
        return out if any(o is not v for o, v in zip(out, value, strict=True)) else value
    return value


def _from_jsonable(value: Any) -> Any:
    """JSON 反序列化还原（标记 dict → PatchChain/Message/ToolCall，其余递归）。"""
    if isinstance(value, dict):
        if value.get(_PATCH_CHAIN_MARKER):
            return PatchChain.from_dict(value)
        if value.get(_MESSAGE_MARKER):
            from .llm.messages import Message

            return Message.from_dict(_from_jsonable(value["data"]))
        if value.get(_TOOL_CALL_MARKER):
            from .llm.messages import ToolCall

            return ToolCall(
                id=value["id"], name=value["name"], arguments=value["arguments"]
            )
        return {k: _from_jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_from_jsonable(v) for v in value]
    return value


@dataclass(frozen=True, slots=True)
class CheckpointRecord:
    """checkpoint 快照记录（版本链节点）。

    Attributes:
        checkpoint_id: 全局自增 id（版本链锚点）。
        thread_id: 会话/线程 id（版本链归属）。
        node: 恢复锚点（该节点完成后写入的快照，重入从该节点继续）。
        graph_path: 嵌套图路径（恢复定位）。
        state: 通道值快照（api_key 已剥离）。
        parent_id: 版本链父指针（None = 链头）。
        reason: 回合终止原因（reply/止损/超限/异常，None = 未终止）。
        created_at: 写入时间戳（epoch 秒）。
        version: 乐观锁版本号（并发写保护，每次写入 +1）。
        event_seq: 执行事件日志锚点（恢复 = 快照 + 该 seq 之后的增量日志重放）。
        error: 异常快照（reason=error 时携带脱敏后的错误消息，可诊断；None = 无）。
    """

    checkpoint_id: int
    thread_id: str
    node: str | None
    graph_path: tuple[str, ...] = ()
    state: dict = field(default_factory=dict)
    parent_id: int | None = None
    reason: str | None = None
    created_at: float = field(default_factory=time.time)
    version: int = 1
    event_seq: int = 0
    error: str | None = None

    def to_dict(self) -> dict:
        return {
            "checkpoint_id": self.checkpoint_id,
            "thread_id": self.thread_id,
            "node": self.node,
            "graph_path": list(self.graph_path),
            "state": _jsonable_strip(self.state),  # 安全：序列化即剥离敏感键
            "parent_id": self.parent_id,
            "reason": self.reason,
            "created_at": self.created_at,
            "version": self.version,
            "event_seq": self.event_seq,
            "error": self.error,
        }

    @classmethod
    def from_dict(cls, data: dict) -> CheckpointRecord:
        return cls(
            checkpoint_id=int(data["checkpoint_id"]),
            thread_id=data["thread_id"],
            node=data.get("node"),
            graph_path=tuple(data.get("graph_path") or ()),
            state=_from_jsonable(data.get("state") or {}),
            parent_id=data.get("parent_id"),
            reason=data.get("reason"),
            created_at=float(data.get("created_at") or time.time()),
            version=int(data.get("version") or 1),
            event_seq=int(data.get("event_seq") or 0),
            error=data.get("error"),
        )


@runtime_checkable
class Storage(Protocol):
    """通用存储服务接口。

    实现要求：
    - checkpoint 写入支持乐观锁（expected_version 不匹配抛
      CheckpointConflictError，调用方重读后重试）；
    - 事件日志 append-only（seq 严格递增，重放按 seq 有序）；
    - 全部方法幂等/可重试（网络抖动场景调用方重试安全）。
    """

    # ── checkpoint 版本链 ──
    async def get_checkpoint(self, checkpoint_id: int) -> CheckpointRecord | None: ...
    async def get_latest_checkpoint(self, thread_id: str) -> CheckpointRecord | None: ...
    async def put_checkpoint(
        self,
        record: CheckpointRecord,
        *,
        expected_version: int | None = None,
        fork: bool = False,
    ) -> CheckpointRecord: ...
    async def list_checkpoints(self, thread_id: str, *, limit: int = 100) -> list[CheckpointRecord]: ...

    # ── 执行事件日志（append-only）──
    async def append_event(self, thread_id: str, event: EngineEvent) -> int: ...
    async def events_after(self, thread_id: str, seq: int) -> list[EngineEvent]: ...
    async def truncate_events(self, thread_id: str, after_seq: int) -> None: ...
    async def latest_event_seq(self, thread_id: str) -> int: ...

    # ── structured records（回合记录/记忆/世界状态共用）──
    async def put_record(self, collection: str, key: str, data: dict) -> None: ...
    async def get_record(self, collection: str, key: str) -> dict | None: ...
    async def list_records(self, collection: str) -> list[dict]: ...

    async def close(self) -> None: ...


def create_storage(conn_string: str) -> Storage:
    """存储后端工厂：连接串协议前缀决定后端（内存/sqlite/postgres）。

    例：memory://、sqlite:///:memory:、sqlite:///./engine.db、
    postgresql://user:pwd@host/db（postgres:// 别名兼容 DATABASE_URL 形态）
    """
    scheme = conn_string.split(":", 1)[0].lower()
    if scheme == SCHEME_MEMORY or conn_string in ("", "memory"):
        from .storage_memory import MemoryStorage

        return MemoryStorage()
    if scheme == SCHEME_SQLITE:
        from .storage_sqlite import SqliteStorage

        if not conn_string.startswith("sqlite://"):
            # 显式前缀校验：sqlite:/path 等少斜杠形态会静默截断成错误相对路径并新建空库
            raise ValueError(
                f"非法 sqlite 连接串（应为 sqlite:///path 或 sqlite:///:memory:）: {conn_string}"
            )
        # 剥离 "sqlite://" 前缀；:memory: 保留原形（内存库），路径去掉前导 /
        db_path = conn_string[len(SCHEME_SQLITE) + 3 :]
        if not db_path:
            # 空路径归一为内存库（"sqlite" 裸协议默认值），持久化未启用需显式
            logger.warning("sqlite 连接串未指定路径，归一为 :memory:（持久化未启用）")
            db_path = ":memory:"
        if db_path.startswith(":") or db_path.startswith("file:"):
            return SqliteStorage(db_path)
        return SqliteStorage(db_path.lstrip("/"))
    if scheme in (SCHEME_POSTGRES, "postgres"):
        from .storage_postgres import PostgresStorage

        return PostgresStorage(conn_string)
    raise ValueError(f"未知存储连接串协议: {conn_string}")


__all__ = [
    "SCHEME_MEMORY",
    "SCHEME_POSTGRES",
    "SCHEME_SQLITE",
    "CheckpointRecord",
    "Storage",
    "create_storage",
]

