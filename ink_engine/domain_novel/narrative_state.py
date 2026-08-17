"""叙事状态定义（D6 叙事状态机的小说语义层）。

伏笔与情节线的生命周期状态机：

    埋设 set ──> 推进 advancing ──> 回收 resolved（终态）
                      │  ▲
                      ▼  │
                  停滞 stalled

规则要点：

- ``resolved`` 是**终态**——回收后不得回退为埋设/推进/停滞。这是伏笔链
  合法性的核心约束（不能"先回收 B 再埋设 A"，否则读者视角的因果倒置）；
- ``stalled``（停滞待办）经修正后可恢复推进，属合法路径；
- 任意非终态可直达 ``resolved``（伏笔可在推进前直接回收）。

本模块只提供**状态定义与纯函数判定**，不含落库：转换日志的持久化由宿主
用自己的存储实现（引擎不依赖宿主 ORM），校验逻辑与状态定义则在此单点维护，
供写时预检、写工具、派生同步共用，防多处复制导致规则漂移。
"""
from __future__ import annotations

from ink_engine.core.state_machine import StateMachine, TransitionLog

# ---------------------------------------------------------------------------
# 状态枚举
# ---------------------------------------------------------------------------

STATUS_SET = "set"
"""埋设：伏笔/情节线已引入，尚未推进。"""

STATUS_ADVANCING = "advancing"
"""推进：已在后续章节展开。"""

STATUS_RESOLVED = "resolved"
"""回收：已揭示/完结（终态，不得回退）。"""

STATUS_STALLED = "stalled"
"""停滞：长期未推进的待办（可修正后恢复推进）。"""

# 有效状态集合（宿主 world 常量与数据库取值须与此一致，防双源漂移）
NARRATIVE_STATUSES: tuple[str, ...] = (
    STATUS_SET,
    STATUS_ADVANCING,
    STATUS_RESOLVED,
    STATUS_STALLED,
)

# 终态：回收后单向不可逆（伏笔链合法性）
TERMINAL_STATUSES: frozenset[str] = frozenset({STATUS_RESOLVED})

# ---------------------------------------------------------------------------
# 实体类型与触发方
# ---------------------------------------------------------------------------

ENTITY_FORESHADOWING = "foreshadowing"
ENTITY_PLOT_THREAD = "plot_thread"

# 适用本状态机的叙事实体类型
ENTITY_TYPES: tuple[str, ...] = (ENTITY_FORESHADOWING, ENTITY_PLOT_THREAD)

# 转换触发方（写工具=agent / 人工=user / 派生同步=system / 写时预检=precheck）
ACTOR_AGENT = "agent"
ACTOR_USER = "user"
ACTOR_SYSTEM = "system"
ACTOR_PRECHECK = "precheck"

ACTORS: tuple[str, ...] = (ACTOR_AGENT, ACTOR_USER, ACTOR_SYSTEM, ACTOR_PRECHECK)

# ---------------------------------------------------------------------------
# 状态机实例（无状态纯判定，模块级单例可安全共享）
# ---------------------------------------------------------------------------

NARRATIVE_STATE_MACHINE = StateMachine(
    NARRATIVE_STATUSES,
    terminal_states=TERMINAL_STATUSES,
    name="narrative",
)


def is_valid_status(status: str | None) -> bool:
    """状态是否为合法叙事状态枚举值。"""
    return NARRATIVE_STATE_MACHINE.is_valid_state(status)


def is_illegal_transition(from_status: str | None, to_status: str) -> bool:
    """判断状态转换是否非法（伏笔链合法性规则，纯函数可单测）。

    非法情形：目标状态非枚举值；或前态已回收（resolved 终态不得复活）。
    ``from_status=None`` 表示初始写入，只校验目标状态合法性。
    """
    return NARRATIVE_STATE_MACHINE.is_illegal_transition(from_status, to_status)


def is_entity_type(entity_type: str | None) -> bool:
    """实体类型是否适用叙事状态机（foreshadowing/plot_thread）。"""
    return entity_type in ENTITY_TYPES


def new_transition_log(current_status: str | None = None) -> TransitionLog:
    """按叙事规则新建一条 append-only 转换日志（当前状态可选作为起点）。

    用于回溯/回滚场景：宿主从存储读出历史转换后可重建日志推导当前状态。
    """
    return NARRATIVE_STATE_MACHINE.log(initial_state=current_status)


__all__ = [
    "ACTORS",
    "ACTOR_AGENT",
    "ACTOR_PRECHECK",
    "ACTOR_SYSTEM",
    "ACTOR_USER",
    "ENTITY_FORESHADOWING",
    "ENTITY_PLOT_THREAD",
    "ENTITY_TYPES",
    "NARRATIVE_STATE_MACHINE",
    "NARRATIVE_STATUSES",
    "STATUS_ADVANCING",
    "STATUS_RESOLVED",
    "STATUS_SET",
    "STATUS_STALLED",
    "TERMINAL_STATUSES",
    "is_entity_type",
    "is_illegal_transition",
    "is_valid_status",
    "new_transition_log",
]
