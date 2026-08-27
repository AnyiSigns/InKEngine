"""事件协议：EngineEvent 信封 + 协议版本化 + 传输接口。

事件即协议：节点经 ctx.emit 发射的事件流 = 前端协议的引擎原生形态
（step_id/round_id 天然有序，无框架事件中间层）。事件携带 step_id/
round_id/graph_path（嵌套图路径），负载为
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
from .logging import get_logger

logger = get_logger(__name__)

# 事件协议版本：与前端协议同构（前端零改动约束）
PROTOCOL_VERSION = 2


@dataclass(frozen=True, slots=True)
class EngineEvent:
    """引擎事件信封（协议原生形态）。

    Attributes:
        type: 事件类型（thinking_start/reply_token/review_card/...）。
        payload: 事件负载（与协议同构 dict，增量演进加字段）。
        step_id: 回合步骤 id（展示事件契约；系统信号为 None）。
        parent_step_id: 父步骤 id（轨迹树引用：模拟分支/子任务事件指向
            决策点/父任务步骤，落选分支可据此回溯对比/换选）。
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
    parent_step_id: str | None = None
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
            "parent_step_id": self.parent_step_id,
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
            parent_step_id=data.get("parent_step_id"),
            round_id=data.get("round_id"),
            node=data.get("node"),
            graph_path=tuple(data.get("graph_path") or ()),
            seq=data.get("seq"),
            trace_id=data.get("trace_id") or "-",
            thread_id=data.get("thread_id") or "-",
            version=version,
        )

    def to_json(self) -> str:
        """JSON 序列化（事件传输线格式，ensure_ascii=False 中文可读）。

        负载须为 JSON 可序列化形态；含非 JSON 对象时降级 ``default=str``
        字符串化落库（回放类型降级），并记 warning 留痕（ENG5-14：
        不再静默——类型降级有明确提示，可在日志中定位到事件）。
        """
        try:
            return json.dumps(self.to_dict(), ensure_ascii=False)
        except (TypeError, ValueError):
            logger.warning(
                f"事件负载含不可 JSON 序列化对象，已字符串化降级"
                f"（回放类型降级）: type={self.type} node={self.node}"
            )
            return json.dumps(self.to_dict(), ensure_ascii=False, default=str)


def parse_event_lenient(data: dict) -> EngineEvent | None:
    """逐条事件解析（回放容错入口）：单条非法事件跳过，不中断整段重放。

    执行日志回放（events_after）的容错语义（ENG5-4）：旧版本协议事件/
    单条结构损坏的事件不应让整个恢复区间失败——逐条 try/except，跳过
    并留痕（warning），其余事件照常回放。

    Args:
        data: 事件字典（含存储侧回填的 seq）。

    Returns:
        解析成功的事件；版本不符/结构非法 = None（调用方跳过）。
    """
    if not isinstance(data, dict):
        logger.warning(f"事件行非 dict 形态，跳过（回放容错）: {type(data).__name__}")
        return None
    try:
        return EngineEvent.from_dict(data)
    except ProtocolVersionError:
        logger.warning(
            f"事件协议版本不符，跳过（回放容错）: "
            f"{data.get('version')!r} != {PROTOCOL_VERSION}"
        )
        return None
    except (KeyError, TypeError, ValueError) as exc:
        logger.warning(f"事件结构非法，跳过（回放容错）: {exc}")
        return None


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
    "CollectorTransport",
    "EngineEvent",
    "EngineTransport",
    "parse_event_lenient",
]
