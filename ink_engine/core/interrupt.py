"""interrupt 挂起/注入重入机制（弹卡审批一等能力，替代 langgraph interrupt）。

语义（开放问题已定：节点边界 + 重入幂等）：
- 节点内 ``await ctx.interrupt(key, payload)`` 声明中断点——首次执行时引擎
  捕获 InterruptSignal，持久化 checkpoint（含中断点状态），本轮 run 挂起；
- 外部注入（review_action 值）后从该节点重入：interrupt() 返回注入值，
  节点按状态通道分支执行剩余逻辑（与现状 gated_tool_node 的
  pending_tool.decision 分支一致）；
- 不做"节点内任意点"中断（需保存协程剩余逻辑，复杂无必要）；
- 挂起卡保留：中断点状态随 checkpoint 持久化，执行中新消息打断时
  审批卡不丢弃（打断重定向语义）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .exceptions import InterruptError


class InterruptSignal(BaseException):
    """控制流信号：节点内 interrupt() 抛出的挂起标记（非错误，不记日志）。"""

    def __init__(self, key: str, payload: dict) -> None:
        self.key = key
        self.payload = payload
        super().__init__(f"interrupt[{key}]")


@dataclass(frozen=True, slots=True)
class InterruptState:
    """中断点状态（随 checkpoint 持久化，重入定位锚点）。

    Attributes:
        key: 中断点标识（review_key，如 "gate" / "design_session"）。
        payload: 挂起负载（审批卡内容等）。
        node: 中断节点（重入起点）。
        graph_path: 嵌套图路径（重入定位）。
    """

    key: str
    payload: dict
    node: str | None = None
    graph_path: tuple[str, ...] = ()

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "payload": self.payload,
            "node": self.node,
            "graph_path": list(self.graph_path),
        }

    @classmethod
    def from_dict(cls, data: dict) -> InterruptState:
        return cls(
            key=data["key"],
            payload=data.get("payload") or {},
            node=data.get("node"),
            graph_path=tuple(data.get("graph_path") or ()),
        )


@dataclass(slots=True)
class InterruptCoordinator:
    """中断协调器（执行器内部持有）：注入值挂载 + 重入判定。

    注入语义：inject 后写入 pending_inject 字段，节点内下一次 interrupt()
    调用消费该值（一次性）。已注入决策的审批视为放弃（防门控绕过）。
    """

    pending_inject: dict[str, Any] = field(default_factory=dict)

    def inject(self, values: dict[str, Any]) -> None:
        self.pending_inject.update(values)

    def consume(self, key: str) -> Any:
        if key not in self.pending_inject:
            raise InterruptError(f"中断点无注入值: {key}")
        return self.pending_inject.pop(key)

    def has_inject(self, key: str) -> bool:
        return key in self.pending_inject


__all__ = ["InterruptCoordinator", "InterruptSignal", "InterruptState"]
