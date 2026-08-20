"""通用存储服务（Kilo Code 式：引擎内全部持久化统一走存储服务接口）。

structured records + JSON 数据，适配内存/sqlite/postgres，连接串/配置
切换后端。引擎承载两类持久化：
- checkpoint 版本链（快照，乐观锁并发写保护）；
- 执行事件日志（append-only，恢复 = 快照 + 增量日志重放）。

接口只定义存储语义，不绑定图执行——回合记录/步骤序列/记忆等宿主
结构化数据同走此接口（structured records 通道）。后端切换 = 换连接串
（create_storage 工厂），业务代码零改动。
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

from .events import EngineEvent
from .logging import get_logger
from .patch_chain import PatchChain
from .security import is_sensitive_key

if TYPE_CHECKING:
    from .interrupt import InterruptState

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
        interrupt: 挂起卡状态（reason=interrupted 时携带：中断键 + 卡负载 +
            中断节点定位，续流恢复定位锚点；其余终止形态为 None）。
        graph_version: 图定义内容指纹（执行时图的身份；恢复时与当前图比对，
            不一致拒绝续跑——图定义变了恢复语义不保证）。
        plan: 运行中计划快照（{steps, index}，None = 无计划/计划已耗尽）。
            计划随 checkpoint 版本链落盘与回滚——回溯决策点时计划与状态
            一起回到当时版本。
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
    interrupt: InterruptState | None = None
    graph_version: str | None = None
    plan: dict | None = None

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
            "interrupt": (
                _jsonable_strip(self.interrupt.to_dict())
                if self.interrupt is not None
                else None
            ),
            "graph_version": self.graph_version,
            "plan": self.plan,
        }

    @classmethod
    def from_dict(cls, data: dict) -> CheckpointRecord:
        from .interrupt import InterruptState

        interrupt = data.get("interrupt")
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
            interrupt=(
                InterruptState.from_dict(_from_jsonable(interrupt))
                if isinstance(interrupt, dict)
                else None
            ),
            graph_version=data.get("graph_version"),
            plan=data.get("plan"),
        )


@dataclass(frozen=True, slots=True)
class ChainLink:
    """版本链轻量行索引（回溯/巡检/压缩用，不含 state 快照负载）。

    与 :class:`CheckpointRecord` 的区别：只携带链遍历所需的元数据字段，
    单次查询即可取得整链（快照负载可能很大，回溯逐条取全量记录是
    O(链长) 次串行重查询）。

    Attributes:
        checkpoint_id: 全局自增 id（版本链锚点）。
        parent_id: 版本链父指针（None = 链头）。
        event_seq: 执行事件日志锚点（恢复 = 快照 + 该 seq 之后的增量重放）。
        graph_path: 嵌套图路径（恢复定位；() = 顶层）。
        reason: 回合终止原因（None = 未终止）。
    """

    checkpoint_id: int
    parent_id: int | None
    event_seq: int
    graph_path: tuple[str, ...] = ()
    reason: str | None = None


@runtime_checkable
class Storage(Protocol):
    """通用存储服务接口。

    实现要求：
    - checkpoint 写入支持乐观锁（expected_version 不匹配抛
      CheckpointConflictError，调用方重读后重试）；
    - 事件日志 append-only（seq 严格递增，重放按 seq 有序）；
    - 全部方法幂等/可重试（网络抖动场景调用方重试安全）。
    - 链压缩原语（chain_index/delete_checkpoints/set_checkpoint_parent/
      trim_events）为链级 rebase 提供底座：不实现的后端在调用方
      fail-open 兜底下跳过压缩（版本链照常增长，功能不受损）。
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
    async def chain_index(self, thread_id: str) -> list[ChainLink]: ...
    async def delete_checkpoints(self, thread_id: str, ids: list[int]) -> int: ...
    async def set_checkpoint_parent(
        self, thread_id: str, checkpoint_id: int, parent_id: int | None
    ) -> None: ...

    # ── 执行事件日志（append-only）──
    async def append_event(self, thread_id: str, event: EngineEvent) -> int: ...
    async def events_after(self, thread_id: str, seq: int) -> list[EngineEvent]: ...
    async def truncate_events(self, thread_id: str, after_seq: int) -> None: ...
    async def trim_events(self, thread_id: str, before_seq: int) -> int: ...
    async def latest_event_seq(self, thread_id: str) -> int: ...

    # ── structured records（回合记录/记忆等宿主结构化数据共用）──
    async def put_record(self, collection: str, key: str, data: dict) -> None: ...
    async def get_record(self, collection: str, key: str) -> dict | None: ...
    async def list_records(self, collection: str) -> list[dict]: ...

    async def close(self) -> None: ...


async def validate_chain(
    storage: Storage,
    thread_id: str,
    *,
    max_walk: int = 10000,
    check_event_seq: bool = True,
) -> list[str]:
    """版本链一致性校验（存储层断言工具：调试/测试/巡检）。

    从链尾沿 parent_id 回溯，校验：
    - parent 引用存在且属于同一 thread（防悬挂/跨线程父指针静默成链）；
    - checkpoint_id 沿父链严格递减（防环/自引用）；
    - event_seq 沿链单调不减（checkpoint 快照锚点与增量日志重放顺序一致）。

    fork 分叉（编辑重放：truncate_log_after + parent_checkpoint）的新分支
    首节点 event_seq 允许低于历史父锚点（事件日志已截断回退），此时调用方
    应传 ``check_event_seq=False`` 或知晓该豁免。

    遍历实现：整链索引一次取回（:meth:`Storage.chain_index`，轻量行，
    无快照负载），内存内按 parent_id 回溯——避免逐跳重查询的 O(链长)
    次串行 DB 往返；链级 rebase 压缩后链长有界，巡检成本随之有界。

    Args:
        storage: 存储服务（任意后端，只依赖 Storage 协议）。
        thread_id: 版本链归属线程。
        max_walk: 回溯步数上限（防意外成环死循环；超限报违规并停止）。
        check_event_seq: 是否校验 event_seq 单调性（分叉链豁免场景置 False）。

    Returns:
        违规描述列表（空 = 链一致）。
    """
    violations: list[str] = []
    links = await storage.chain_index(thread_id)
    if not links:
        return violations
    by_id = {link.checkpoint_id: link for link in links}
    node: ChainLink | None = links[0]  # 最新行（chain_index 按 id 降序）
    walked = 0
    while node is not None:
        walked += 1
        if walked > max_walk:
            violations.append(
                f"链遍历超限（>{max_walk} 节点，疑似成环）: 停于 #{node.checkpoint_id}"
            )
            break
        parent = by_id.get(node.parent_id) if node.parent_id is not None else None
        if node.parent_id is not None and parent is None:
            # 父不在本线程索引：悬挂或跨线程二选一，单次查询区分
            # （巡检低频路径，不引入每跳重查询）
            cross = await storage.get_checkpoint(node.parent_id)
            if cross is None:
                violations.append(
                    f"悬挂父指针: #{node.checkpoint_id} -> parent #{node.parent_id} 不存在"
                )
            else:
                violations.append(
                    f"跨线程父指针: #{node.checkpoint_id}(thread={thread_id}) "
                    f"-> #{cross.checkpoint_id}(thread={cross.thread_id})"
                )
            break
        if parent is not None:
            if parent.checkpoint_id >= node.checkpoint_id:
                violations.append(
                    f"父链非递减（环/自引用）: #{node.checkpoint_id} "
                    f"-> #{parent.checkpoint_id}"
                )
                break  # 环/自引用：继续回溯无意义且死循环
            if check_event_seq and parent.event_seq > node.event_seq:
                violations.append(
                    f"event_seq 回退: #{node.checkpoint_id} event_seq={node.event_seq} "
                    f"< 父 #{parent.checkpoint_id} event_seq={parent.event_seq}"
                )
        node = parent
    return violations


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
    "ChainLink",
    "CheckpointRecord",
    "Storage",
    "create_storage",
    "validate_chain",
]

