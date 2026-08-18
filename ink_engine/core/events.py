"""事件协议：EngineEvent 信封 + 协议版本化 + 传输接口。

事件即协议：节点经 ctx.emit 发射的事件流 = 前端协议的引擎原生形态
（step_id/round_id 天然有序，无框架事件中间层）。事件携带 step_id/
round_id/graph_path（嵌套图路径，替代 langgraph ns 三元组），负载为
与协议同构的 dict（thinking/plan/tool/node/reply_token/review_card...）。

协议演进策略：版本化结构（PROTOCOL_VERSION 常量）+ payload 增量演进
（加字段不破坏，step_id/round_id 语义长期稳定）；破坏性变更升版本，
不兼容版本在传输入口拒绝（ProtocolVersionError）。

传输接口化：EngineTransport = 事件消费者（SSE/WS/队列可换实现），
引擎只负责产出事件流，消费方式由宿主注入（引擎提供内存传输/收集器）。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from .exceptions import ProtocolVersionError

# 事件协议版本：与前端协议同构（前端零改动约束）
PROTOCOL_VERSION = 2

# 系统信号集合（不入回合步骤序列，与事件协议语义对齐）。
# 机制层默认空：哪些事件属"系统信号"由宿主协议决定（宿主经
# RunOptions.system_events 注入）——core 不预置任何领域事件名。
SYSTEM_EVENTS: frozenset[str] = frozenset()


def is_system_event(etype: str) -> bool:
    """按模块级集合判定（默认空；宿主可覆盖 SYSTEM_EVENTS 常量以全局生效）。"""
    return etype in SYSTEM_EVENTS


@dataclass(frozen=True, slots=True)
class EngineEvent:
    """引擎事件信封（协议原生形态）。

    Attributes:
        type: 事件类型（thinking_start/reply_token/review_card/...）。
        payload: 事件负载（与协议同构 dict，增量演进加字段）。
        step_id: 回合步骤 id（展示事件契约；系统信号为 None）。
        round_id: 回合 id（用户消息边界）。
        node: 发射节点名（None = 执行器自身信号）。
        graph_path: 嵌套图路径（替代 ns 三元组，空 = 顶层图）。
        seq: 执行事件日志序号（append-only，恢复/续流锚点）。
        trace_id: 链路追踪 ID（跨事件传递）。
        thread_id: 会话/线程归属（执行日志分区键）。
        version: 协议版本。
    """

    type: str
    payload: dict = field(default_factory=dict)
    step_id: str | None = None
    round_id: str | None = None
    node: str | None = None
    graph_path: tuple[str, ...] = ()
    seq: int | None = None
    trace_id: str = "-"
    thread_id: str = "-"
    version: int = PROTOCOL_VERSION

    def to_dict(self) -> dict:
        """序列化为协议结构（payload 增量演进，加字段兼容旧消费者）。"""
        return {
            "type": self.type,
            "version": self.version,
            "payload": self.payload,
            "step_id": self.step_id,
            "round_id": self.round_id,
            "node": self.node,
            "graph_path": list(self.graph_path),
            "seq": self.seq,
            "trace_id": self.trace_id,
            "thread_id": self.thread_id,
        }

    @classmethod
    def from_dict(cls, data: dict) -> EngineEvent:
        """反序列化（执行日志回放/断线续流恢复）；版本不符抛 ProtocolVersionError。"""
        version = int(data.get("version", PROTOCOL_VERSION))
        if version != PROTOCOL_VERSION:
            raise ProtocolVersionError(version, PROTOCOL_VERSION)
        return cls(
            type=data["type"],
            payload=data.get("payload") or {},
            step_id=data.get("step_id"),
            round_id=data.get("round_id"),
            node=data.get("node"),
            graph_path=tuple(data.get("graph_path") or ()),
            seq=data.get("seq"),
            trace_id=data.get("trace_id") or "-",
            thread_id=data.get("thread_id") or "-",
            version=version,
        )

    def to_json(self) -> str:
        """JSON 序列化（事件传输线格式，ensure_ascii=False 中文可读）。"""
        return json.dumps(self.to_dict(), ensure_ascii=False, default=str)


@runtime_checkable
class EngineTransport(Protocol):
    """事件传输接口：消费引擎产出的事件（SSE/WS/队列可换实现）。

    引擎只定义契约；宿主注入实现。默认收集器（CollectorTransport）用于
    测试/日志/回放。传输必须无副作用失败：消费者抛异常仅记日志不阻断
    主流程（事件即协议，观测不影响执行）。
    """

    async def send(self, event: EngineEvent) -> None: ...


@dataclass(slots=True)
class CollectorTransport:
    """内存收集传输：累积全部事件（测试/调试/回放用），send 永不失败。"""

    events: list[EngineEvent] = field(default_factory=list)

    async def send(self, event: EngineEvent) -> None:
        self.events.append(event)


__all__ = [
    "PROTOCOL_VERSION",
    "SYSTEM_EVENTS",
    "CollectorTransport",
    "EngineEvent",
    "EngineTransport",
    "is_system_event",
]
