"""状态机原语与 append-only 转换日志（D6 叙事状态机的通用底座）。

心智模型与引擎的补丁链一致：**转换 = 补丁（append-only），当前状态 =
最后应用结果**。状态机不持有可变状态字段，而是持有一条不可回写的转换
日志——因此天然支持回溯（"这个状态何时变成这样"）、回滚（截断日志重推）
与分支（复制日志前缀）。

三个组件各司其职：

- :class:`StateMachine`：声明式规则（合法状态集 + 终态 + 可选转换白名单），
  纯判定、无状态、可共享为模块级单例；
- :class:`StateTransition`：一条转换记录（不可变，可序列化落库）；
- :class:`TransitionLog`：append-only 日志容器，当前状态由日志推导。

领域中立：状态名、终态、触发方（actor）取值均由使用方声明，引擎不内置任何
业务状态语义（叙事伏笔/情节线的具体状态定义见 domain_novel 包）。
"""
from __future__ import annotations

import time
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from .logging import get_logger

logger = get_logger(__name__)

# 初始写入（实体首次获得状态）的 from_state 约定值：无前态
INITIAL_STATE: str | None = None


@dataclass(frozen=True, slots=True)
class StateTransition:
    """一条状态转换记录（append-only 日志条目，不可变）。

    Attributes:
        to_state: 转换后状态。
        from_state: 转换前状态（None = 初始写入）。
        actor: 触发方（业务自定义枚举，如 agent/user/system）。
        note: 转换说明（可读留痕）。
        at: 发生时间戳（epoch 秒）。
        meta: 业务元数据（关联章节/实体等，落库时随记录序列化）。
    """

    to_state: str
    from_state: str | None = INITIAL_STATE
    actor: str = "system"
    note: str | None = None
    at: float = field(default_factory=time.time)
    meta: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "to_state": self.to_state,
            "from_state": self.from_state,
            "actor": self.actor,
            "note": self.note,
            "at": self.at,
            "meta": self.meta,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> StateTransition:
        """从存储记录还原（字段缺失走默认值，兼容 schema 增量演进）。"""
        return cls(
            to_state=str(data["to_state"]),
            from_state=data.get("from_state"),
            actor=str(data.get("actor") or "system"),
            note=data.get("note"),
            at=float(data.get("at") or time.time()),
            meta=dict(data.get("meta") or {}),
        )


class StateMachine:
    """声明式状态机规则（纯判定，无状态，线程安全可作模块级单例）。

    规则按以下顺序判定一次转换是否非法：

    1. 目标状态不在 ``states`` 中 → 非法（防拼写错误/越界状态写入）；
    2. 前态属于 ``terminal_states`` → 非法（终态单向，不得复活）；
    3. 声明了 ``allowed`` 白名单且该转换不在白名单内 → 非法。

    未声明 ``allowed`` 时，除终态约束外的任意转换都合法——多数领域只需
    "终态单向"这一条规则，无需枚举全部转换对（避免声明爆炸）。

    Args:
        states: 合法状态集合。
        terminal_states: 终态集合（进入后不得转出）；须为 ``states`` 子集。
        allowed: 可选转换白名单（``前态 -> 允许的后态集合``）。初始写入
            （前态 None）不受白名单约束，只校验目标状态合法性。
        name: 状态机名称（日志可读性用）。

    Raises:
        ValueError: 终态或白名单引用了 ``states`` 之外的状态（声明期即暴露
            配置错误，而非留到运行期静默误判）。
    """

    __slots__ = ("_allowed", "_name", "_states", "_terminal")

    def __init__(
        self,
        states: Iterable[str],
        *,
        terminal_states: Iterable[str] = (),
        allowed: Mapping[str, Iterable[str]] | None = None,
        name: str = "state_machine",
    ) -> None:
        self._name = name
        self._states = frozenset(states)
        self._terminal = frozenset(terminal_states)
        unknown_terminal = self._terminal - self._states
        if unknown_terminal:
            raise ValueError(
                f"{name}: 终态 {sorted(unknown_terminal)} 不在合法状态集内"
            )
        self._allowed: dict[str, frozenset[str]] | None = None
        if allowed is not None:
            self._allowed = {src: frozenset(dsts) for src, dsts in allowed.items()}
            referenced = set(self._allowed) | {
                dst for dsts in self._allowed.values() for dst in dsts
            }
            unknown = referenced - self._states
            if unknown:
                raise ValueError(
                    f"{name}: 转换白名单引用了非法状态 {sorted(unknown)}"
                )

    @property
    def name(self) -> str:
        return self._name

    @property
    def states(self) -> frozenset[str]:
        return self._states

    @property
    def terminal_states(self) -> frozenset[str]:
        return self._terminal

    def is_valid_state(self, state: str | None) -> bool:
        """状态是否为合法枚举值（None 不是合法状态，仅作初始前态占位）。"""
        return state in self._states

    def is_terminal(self, state: str | None) -> bool:
        """状态是否为终态（进入后不得转出）。"""
        return state in self._terminal

    def is_illegal_transition(self, from_state: str | None, to_state: str) -> bool:
        """判断一次转换是否非法（纯函数，可直接用于写时预检）。"""
        if not self.is_valid_state(to_state):
            return True
        if self.is_terminal(from_state):
            return True
        if self._allowed is not None and from_state is not INITIAL_STATE:
            return to_state not in self._allowed.get(str(from_state), frozenset())
        return False

    def log(
        self, *, initial_state: str | None = INITIAL_STATE, entries: Sequence[StateTransition] = ()
    ) -> TransitionLog:
        """按本规则新建一条转换日志（便捷工厂）。"""
        return TransitionLog(self, initial_state=initial_state, entries=entries)


class TransitionLog:
    """append-only 转换日志：当前状态由日志推导，不单独存可变状态字段。

    ``append`` 只拦截"无变化"与"目标状态非法"两类写入；**非法转换不在此
    强制拦截**——拦截策略按场景不同（写时预检要拦并提示用户，派生同步要
    容忍历史数据），故由调用方用
    :meth:`StateMachine.is_illegal_transition` 自行决定，本原语只保证
    日志 append-only 与当前状态可推导。
    """

    __slots__ = ("_entries", "_initial", "_machine")

    def __init__(
        self,
        machine: StateMachine,
        *,
        initial_state: str | None = INITIAL_STATE,
        entries: Sequence[StateTransition] = (),
    ) -> None:
        self._machine = machine
        self._initial = initial_state
        self._entries: list[StateTransition] = list(entries)

    @property
    def machine(self) -> StateMachine:
        return self._machine

    @property
    def current_state(self) -> str | None:
        """当前状态 = 最后一条转换的目标状态（空日志 = 初始状态）。"""
        return self._entries[-1].to_state if self._entries else self._initial

    def history(self) -> list[StateTransition]:
        """完整转换链（正序：最早 → 最新），供回溯查询。"""
        return list(self._entries)

    def append(
        self,
        to_state: str,
        *,
        actor: str = "system",
        note: str | None = None,
        meta: dict[str, Any] | None = None,
        at: float | None = None,
    ) -> StateTransition | None:
        """追加一次转换。

        Returns:
            落日志的转换记录；无实际变化（目标 = 当前状态）或目标状态非法
            时返回 None 且不写日志。
        """
        from_state = self.current_state
        if to_state == from_state:
            return None
        if not self._machine.is_valid_state(to_state):
            logger.warning(
                f"[{self._machine.name}] 状态转换被忽略，目标状态非法: "
                f"{from_state!r} -> {to_state!r}"
            )
            return None
        entry = StateTransition(
            to_state=to_state,
            from_state=from_state,
            actor=actor,
            note=note,
            at=time.time() if at is None else at,
            meta=dict(meta or {}),
        )
        self._entries.append(entry)
        return entry

    def rollback(self, steps: int = 1) -> str | None:
        """回滚最近 N 次转换（截断日志，当前状态随之重推）。

        Args:
            steps: 回滚步数；≤0 为空操作，超过日志长度则回到初始状态。

        Returns:
            回滚后的当前状态。
        """
        if steps > 0:
            del self._entries[max(0, len(self._entries) - steps):]
        return self.current_state

    def __len__(self) -> int:
        return len(self._entries)


__all__ = [
    "INITIAL_STATE",
    "StateMachine",
    "StateTransition",
    "TransitionLog",
]
