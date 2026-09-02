"""interrupt 挂起/注入重入机制（弹卡审批一等能力）。

语义（开放问题已定：节点边界 + 重入幂等）：
- 节点内 ``await ctx.interrupt(key, payload)`` 声明中断点——首次执行时引擎
  捕获 InterruptSignal，持久化 checkpoint（含中断点状态），本轮 run 挂起；
- 外部注入（review_action 值）后从该节点重入：interrupt() 返回注入值，
  节点按状态通道分支执行剩余逻辑（与现状 gated_tool_node 的
  pending_tool.decision 分支一致）；
- 不做"节点内任意点"中断（需保存协程剩余逻辑，复杂无必要）；
- 挂起卡保留：中断点状态随 checkpoint 持久化，执行中新消息打断时
  审批卡不丢弃（打断重定向语义）。

审批键调用级唯一指纹（批 3 审批语义）：``gate:<tool>`` 中断键为工具名
粒度——同轮同工具第二次触发审批（如首次拒绝后再次升级）若复用同一键，
前端 pending 卡/决议按键去重会丢第二张卡、续跑命中旧中断。协调器按
(thread, base) 对 gate 命名空间的中断发卡做单调计数：首次保持原键
（兼容既有续跑/断言），后续发卡掺入 ``#<序号>`` 后缀——同一工具的第二
次审批产生新键与新卡，决议只命中对应中断；注入消费与挂起负载读取按
``base`` / ``base#N`` 前缀宽容匹配（后缀只作卡身份，基底键仍是判定面）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .exceptions import InterruptError

# gate 审批键前缀（唯一指纹作用域）：工具门禁审批统一经 approve_before_execute
# 以 ``gate:<tool>`` 挂卡。其余中断键（宿主自备唯一键 / 批处理合并卡 /
# 补丁审批）本身已是调用级或同类合并语义，不掺指纹，零行为变化。
GATE_KEY_PREFIX = "gate:"

# 指纹分隔符：``gate:<tool>#<序号>``。基底键判定（has_inject / 注入消费 /
# 挂起负载读取）对 ``base`` 与 ``base#N`` 宽容匹配——序号是卡身份不是新语义。
_FINGERPRINT_SEP = "#"


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
        key: 中断点标识（review_key，如 "gate" / "design_session"；gate 审批
            第二次起带 ``#N`` 调用级唯一指纹）。
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


def interrupt_base_key(key: str) -> str:
    """中断键基底（剥离调用级唯一指纹后缀；无后缀 = 原键）。"""
    base, sep, _tail = key.partition(_FINGERPRINT_SEP)
    return base if sep else key


def interrupt_key_matches(interrupt_key: str, review_key: str) -> bool:
    """中断键是否命中判定面键（宽容匹配：base == base 或 base#N 前缀命中）。

    gate 审批的卡身份键（``base#N``）与判定面键（``base``）属同一中断：
    注入消费 / 挂起负载读取以基底命中，保证「第二次审批的新卡决议只命中
    对应中断」且重入（按卡键注入）仍能被同一中断点消费。
    """
    if interrupt_key == review_key:
        return True
    if not review_key.startswith(GATE_KEY_PREFIX):
        return False
    return interrupt_key.startswith(review_key + _FINGERPRINT_SEP)


@dataclass(slots=True)
class InterruptCoordinator:
    """中断协调器（执行器内部持有）：注入值挂载 + 重入判定。

    注入语义：inject 后写入 pending_inject 字段，节点内下一次 interrupt()
    调用消费该值（一次性）。已注入决策的审批视为放弃（防门控绕过）。

    gate 审批的调用级唯一指纹按 (thread, base) 发卡计数：``next_gate_key``
    在每次真正发卡（无注入可消费 = 新中断）时推进序号；首次保持原键，
    之后返回 ``base#N``。已消费（注入命中）不推进——同一次中断的决议
    注入与重入消费保持同一键。
    """

    pending_inject: dict[str, Any] = field(default_factory=dict)
    _gate_issue_count: dict[tuple[str, str], int] = field(default_factory=dict)

    def inject(self, values: dict[str, Any]) -> None:
        self.pending_inject.update(values)

    def consume(self, key: str) -> Any:
        if key not in self.pending_inject:
            raise InterruptError(f"中断点无注入值: {key}")
        return self.pending_inject.pop(key)

    def has_inject(self, key: str) -> bool:
        return key in self.pending_inject

    def consume_review(self, review_key: str) -> Any | None:
        """按判定面键消费注入（宽容匹配 base / base#N）。

        gate 审批重入时节点以基底键调用 interrupt()，注入值可能挂在
        带指纹后缀的卡键（``base#N``）上——先精确命中基底，再前缀命中
        指纹键（同一中断的一次决议只挂一个键，命中即消费）。返回消费值，
        无注入返回 None（调用方按新中断处理）。
        """
        if self.has_inject(review_key):
            return self.consume(review_key)
        if not review_key.startswith(GATE_KEY_PREFIX):
            return None
        for candidate in tuple(self.pending_inject):
            if interrupt_key_matches(candidate, review_key):
                return self.consume(candidate)
        return None

    def next_gate_key(self, thread_id: str, base_key: str) -> str:
        """gate 命名空间新中断发卡键（首次 = 原键，之后掺入序号）。

        每次真正发卡推进 (thread, base) 计数；消费/重入不经过本方法
        （同一次中断保持同一键），第二次起同工具审批产生 ``base#N``。
        """
        if not base_key.startswith(GATE_KEY_PREFIX):
            return base_key
        count = self._gate_issue_count.get((thread_id, base_key), 0)
        count += 1
        self._gate_issue_count[(thread_id, base_key)] = count
        if count <= 1:
            return base_key
        return f"{base_key}{_FINGERPRINT_SEP}{count}"

    def reset_thread_gate_count(self, thread_id: str) -> None:
        """新回合入口复位该线程的 gate 发卡计数。

        回合边界（用户消息 → round_send/ainvoke 无 resume_from）清掉上一
        回合的计数：新回合同一工具的首张卡回到原键，避免跨回合序号漂移；
        回合内（round_resume 带 resume_from）保留计数——同回合同工具第二
        次审批仍产新键（调用级唯一指纹的作用域 = 回合）。
        """
        stale = [
            key
            for key in self._gate_issue_count
            if key[0] == thread_id
        ]
        for key in stale:
            self._gate_issue_count.pop(key, None)


__all__ = [
    "FINGERPRINT_SEP",
    "GATE_KEY_PREFIX",
    "InterruptCoordinator",
    "InterruptSignal",
    "InterruptState",
    "interrupt_base_key",
    "interrupt_key_matches",
]
