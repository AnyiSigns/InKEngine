"""状态通道与字段级 reducer 注册表。

状态 = 通道字典（channel name → 值）；每个通道可挂 reducer（合并函数），
未挂 reducer 的通道为裸 LastValue（覆盖语义）。执行器把节点返回的增量
overlay 逐通道应用 reducer 合并进状态——无框架 magic，全部自写。

reducer 族（对齐补丁链心智模型）：
- 累积型：add_messages（消息追加，每条消息 = 一个补丁）；
- 内容型：patch_chain（正文/设定 = 基础 + 补丁链，通道值即 PatchChain）；
- 合并型：merge_dicts / merge_metrics；
- 覆盖型：last_value（默认，裸通道语义）。
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .patch_chain import Patch, PatchChain

# reducer 签名：(base, overlay) -> new；None 通道 = 裸 LastValue
Reducer = Callable[[Any, Any], Any]

# 消息删除标记：add_messages 见到此 id 即从累积中移除（编辑重放截断用）
_REMOVE_MESSAGE_TYPE = "RemoveMessage"


def _message_id(msg: Any) -> Any:
    if isinstance(msg, dict):
        return msg.get("id")
    return getattr(msg, "id", None)


def add_messages(base: Any, overlay: Any) -> list:
    """累积型补丁链归约器：消息列表按 id 去重/替换，RemoveMessage 删除。

    每条消息 = 一个补丁（append 语义）；同 id 消息 = 补丁替换（编辑后的新内容
    覆盖旧内容）；RemoveMessage{id} = 删除补丁（T6 编辑重放截断的通道形态）。
    """
    result = list(base) if base is not None else []
    by_id: dict[Any, int] = {}
    for i, msg in enumerate(result):
        mid = _message_id(msg)
        if mid is not None:
            by_id[mid] = i
    for msg in overlay or []:
        mid = _message_id(msg)
        if mid is None:
            result.append(msg)
            continue
        if isinstance(msg, dict) and msg.get("type") == _REMOVE_MESSAGE_TYPE:
            idx = by_id.pop(mid, None)
            if idx is not None:
                result[idx] = None  # 标记删除，尾部统一移除防索引错位
            continue
        if mid in by_id:
            result[by_id[mid]] = msg
        else:
            by_id[mid] = len(result)
            result.append(msg)
    return [m for m in result if m is not None]


def merge_dicts(base: Any, overlay: Any) -> dict:
    """dict 浅合并（overlay 覆盖 base 同键）。"""
    result = dict(base) if base is not None else {}
    if isinstance(overlay, dict):
        result.update(overlay)
    return result


def merge_metrics(base: Any, overlay: Any) -> dict:
    """指标聚合：数值相加、嵌套 dict 递归合并、其余取 overlay。"""
    base = base or {}
    overlay = overlay or {}
    result: dict = {}
    for key in set(base) | set(overlay):
        b, o = base.get(key), overlay.get(key)
        if isinstance(b, dict) and isinstance(o, dict):
            result[key] = merge_metrics(b, o)
        elif isinstance(b, (int, float)) and isinstance(o, (int, float)):
            result[key] = b + o
        elif key in overlay:
            result[key] = o
        else:
            result[key] = b
    return result


def patch_chain_reducer(base: Any, overlay: Any) -> Any:
    """内容型补丁链归约器：通道值 = PatchChain，overlay = Patch 或 Patch 列表。

    反复应用 overlay 即不断追加补丁（append-only）；组装/压扁是读取侧操作
    （assemble/rebase），不写通道——"状态 = 快照"由 checkpoint 承担。

    契约（防重复追加）：overlay 必须是"增量"——仅包含新补丁的 Patch /
    Patch 列表 / 独立新链。节点从 ctx.state 读取链后就地追加、再整链返回
    是常见写法（含子图回流场景）：此时 overlay 与 base 是同一对象，链内
    已含全部补丁，直接短路返回，避免自身补丁被再次追加导致内容翻倍。
    """
    chain = base if isinstance(base, PatchChain) else PatchChain()
    if overlay is chain:
        return chain
    if isinstance(overlay, Patch):
        chain.apply(overlay)
    elif isinstance(overlay, list):
        chain.apply_many([p for p in overlay if isinstance(p, Patch)])
    elif isinstance(overlay, PatchChain):
        chain.apply_many(overlay.patches)
    return chain


def last_value(base: Any, overlay: Any) -> Any:
    """显式覆盖语义（裸 LastValue 的 reducer 表达，兼容嵌套图回流）。"""
    return overlay


# 内置 reducer 注册表（新增 reducer = 注册新函数，引擎开放）
REDUCER_REGISTRY: dict[str, Reducer] = {
    "add_messages": add_messages,
    "merge_dicts": merge_dicts,
    "merge_metrics": merge_metrics,
    "patch_chain": patch_chain_reducer,
    "last_value": last_value,
}

# 累积追加族 reducer（additive）：overlay 条目「追加」进 base（按条目身份去重/
# 滚动），子图回流增量 = 终态 − 入口的条目差集（防整体回流二次追加）。
# 注册自定义追加型 reducer 时须经 register_reducer(additive=True) 声明，
# 嵌套子图回流才会按条目差集计算增量。
ADDITIVE_REDUCERS: set[str] = {"add_messages"}

# 合并累加族 reducer（merge）：overlay 与 base 合并（数值加和/键覆盖），
# 子图入口剥离归零、终态整体回流（父图合并恰好一次，防二次加和翻倍）。
MERGE_REDUCERS: frozenset[str] = frozenset({"merge_metrics", "merge_dicts"})


def register_reducer(
    name: str, reducer: Reducer, *, additive: bool = False
) -> None:
    """注册自定义 reducer（幂等覆盖），additive=True 声明为累积追加族。

    additive 声明决定嵌套子图回流增量算法（条目差集 vs 终态整体），
    注册表开放：业务自定义 reducer 必须经本函数注册并声明分类。
    """
    REDUCER_REGISTRY[name] = reducer
    if additive:
        ADDITIVE_REDUCERS.add(name)
    else:
        ADDITIVE_REDUCERS.discard(name)


def is_additive_reducer(name: str | None) -> bool:
    """判断 reducer 是否为累积追加族（add_messages 及注册时声明 additive 者）。"""
    return name in ADDITIVE_REDUCERS


def is_merge_reducer(name: str | None) -> bool:
    """判断 reducer 是否为合并累加族（merge_metrics/merge_dicts）。"""
    return name in MERGE_REDUCERS


def get_reducer(name: str | None) -> Reducer | None:
    """按名取 reducer；None 表示裸通道（覆盖语义）。"""
    if name is None:
        return None
    return REDUCER_REGISTRY[name]


@dataclass(frozen=True, slots=True)
class Channel:
    """状态通道定义：reducer 名（None = 裸 LastValue）。"""

    reducer: str | None = None


@dataclass(slots=True)
class StateSchema:
    """状态 schema：通道定义表 + 合并入口。

    用法：schema = StateSchema({"messages": "add_messages", "x": None})——
    值为 reducer 名字符串（None/省略 = 裸覆盖通道）；亦可传 Channel 实例。
    执行器每节点完成后调用 schema.apply(state, overlay) 合并增量。
    """

    channels: dict[str, Channel] = field(default_factory=dict)

    def __init__(self, channels: dict[str, str | Channel | None] | None = None) -> None:
        self.channels = {}
        for name, spec in (channels or {}).items():
            if isinstance(spec, Channel):
                self.channels[name] = spec
            else:
                self.channels[name] = Channel(reducer=spec)

    def add(self, name: str, reducer: str | None = None) -> None:
        self.channels[name] = Channel(reducer=reducer)

    def apply(self, state: dict, overlay: dict) -> dict:
        """把节点增量 overlay 按通道 reducer 合并进 state（纯函数，返回新 dict）。

        未知通道（schema 未声明）按裸覆盖处理——引擎对 schema 外键宽容覆盖，
        防子图新增通道回流时静默丢失（v3 T2 教训）。
        """
        if not overlay:
            return dict(state)
        result = dict(state)
        for key, value in overlay.items():
            channel = self.channels.get(key)
            if channel is None:
                result[key] = value  # schema 外键：裸覆盖（宽容模式）
                continue
            reducer = get_reducer(channel.reducer)
            result[key] = reducer(state.get(key), value) if reducer else value
        return result


__all__ = [
    "ADDITIVE_REDUCERS",
    "MERGE_REDUCERS",
    "Channel",
    "Reducer",
    "StateSchema",
    "add_messages",
    "get_reducer",
    "is_additive_reducer",
    "is_merge_reducer",
    "last_value",
    "merge_dicts",
    "merge_metrics",
    "patch_chain_reducer",
    "register_reducer",
]
