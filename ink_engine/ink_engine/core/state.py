"""状态通道与字段级 reducer 注册表。

状态 = 通道字典（channel name → 值）；每个通道可挂 reducer（合并函数），
未挂 reducer 的通道为裸 LastValue（覆盖语义）。执行器把节点返回的增量
overlay 逐通道应用 reducer 合并进状态——无框架 magic，全部自写。

reducer 族（对齐补丁链心智模型）：
- 累积型：add_messages（消息追加，每条消息 = 一个补丁）；
- 内容型：patch_chain（内容工作区 = 基础 + 补丁链，通道值即 PatchChain）；
- 合并型：merge_dicts / merge_metrics；
- 覆盖型：last_value（默认，裸通道语义）。
"""
from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .exceptions import GraphDefinitionError
from .patch_chain import Patch, PatchChain, _deep_copy

# reducer 签名：(base, overlay) -> new；None 通道 = 裸 LastValue
Reducer = Callable[[Any, Any], Any]

# 消息删除标记：add_messages 见到此 id 即从累积中移除（编辑重放截断用）
_REMOVE_MESSAGE_TYPE = "RemoveMessage"


def _message_id(msg: Any) -> Any:
    if isinstance(msg, dict):
        return msg.get("id")
    return getattr(msg, "id", None)


def _msg_content_key(msg: Any) -> Any:
    """无 id 消息的稳定内容键（恢复重放 + 重执行去重用）。

    消息按 (role, content) 归一化；content 为不可 JSON 化对象时退化为 repr，
    保证同一消息在两次合并中产出同一键。无 id 消息不可单独寻址，按内容去重
    是消除「恢复重放 + 节点重执行」重复累积的安全取舍（合法同内容无 id 消息
    会被合并，因它们本就无法被单独引用/替换）。
    """
    if isinstance(msg, dict):
        role = msg.get("role")
        content = msg.get("content")
    else:
        role = getattr(msg, "role", None)
        content = getattr(msg, "content", None)
    try:
        content_key = json.dumps(content, sort_keys=True, ensure_ascii=False)
    except TypeError:
        content_key = repr(content)
    return ("msg", role, content_key)


def add_messages(base: Any, overlay: Any) -> list:
    """累积型补丁链归约器：消息列表按 id 去重/替换，RemoveMessage 删除。

    每条消息 = 一个补丁（append 语义）；同 id 消息 = 补丁替换（编辑后的新内容
    覆盖旧内容）；RemoveMessage{id} = 删除补丁（编辑重放截断的通道形态）。

    无 id 消息按内容去重：恢复重放与节点重执行会两次应用同一无 id 消息，
    若直接 append 会重复累积；按内容键跳过重复项（取舍见 :func:`_msg_content_key`）。
    """
    result = list(base) if base is not None else []
    by_id: dict[Any, int] = {}
    for i, msg in enumerate(result):
        mid = _message_id(msg)
        if mid is not None:
            by_id[mid] = i
    # 已存在于 base 的无 id 消息内容键（用于跨重放去重）
    seen_no_id: set = set()
    for msg in result:
        if _message_id(msg) is None:
            key = _msg_content_key(msg)
            if key is not None:
                seen_no_id.add(key)
    for msg in overlay or []:
        mid = _message_id(msg)
        if mid is None:
            # 无 id 消息：按内容去重，跳过已存在的同内容消息（恢复重执行重复累积防护）
            key = _msg_content_key(msg)
            if key is not None and key in seen_no_id:
                continue
            result.append(msg)
            if key is not None:
                seen_no_id.add(key)
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
    """指标聚合：数值相加、嵌套 dict 递归合并、其余取 overlay。

    特殊值：overlay 含 "__reset__": True 时整体重置（新用户回合由
    业务层输入注入，避免 checkpoint 旧值跨回合累计）。
    """
    overlay = overlay or {}
    if isinstance(overlay, dict) and overlay.get("__reset__"):
        return {k: v for k, v in overlay.items() if k != "__reset__"}
    base = base or {}
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

    契约（防重复追加）：
    - overlay 必须是"增量"——仅包含新补丁的 Patch / Patch 列表 / 独立新链；
    - 节点从 ctx.state 读取链后就地追加、再整链返回是常见写法（含子图
      回流场景）：overlay 与 base 是同一对象时直接短路返回；
    - 整链回流（子图终态链回父图）：overlay 补丁若以链上已有补丁为前缀
      （同源链的隔离拷贝），只追加差集段，防自身补丁被再次追加导致
      内容翻倍；base 非链时的整链写入整体保留基础文本（不丢弃）。
    """
    if overlay is None:
        return base if isinstance(base, PatchChain) else PatchChain()
    if isinstance(base, PatchChain):
        chain = base
    elif isinstance(overlay, PatchChain):
        # base 非链而 overlay 是链：patch_chain 通道基底须为 PatchChain（首值
        # 非链形态仅允许 None/dict，见下方分支）；str/list 等基底无法以 patch
        # 链形态保留，静默丢弃会丢失数据 → 显式拒绝（fail-fast，让调用方用
        # PatchChain 作为通道初值）。dict 基底走下方分支整体保留为链 base。
        if base is not None and not isinstance(base, dict):
            raise GraphDefinitionError(
                f"patch_chain 通道基底类型为 {type(base).__name__}，与 PatchChain "
                f"overlay 合并会静默丢弃基底（str/list 无法以 patch 链形态保留）；"
                f"请使用 PatchChain 或 dict 作为通道初值"
            )
        return overlay.branch()
    elif isinstance(overlay, dict):
        # 裸 dict 初值（通道首值非链形态）：作为基础文本（深拷贝防共享污染）
        return PatchChain(base=_deep_copy(overlay))
    else:
        chain = PatchChain()
    if overlay is chain:
        return chain
    if isinstance(overlay, PatchChain):
        n = chain.length
        if overlay.length >= n and overlay.patches[:n] == chain.patches:
            # 同源链新拷贝（就地追加后整链回流）：只追加差集段
            chain.apply_many(overlay.patches[n:])
        else:
            chain.apply_many(overlay.patches)
    elif isinstance(overlay, Patch):
        # 单补丁前缀去重：已是链尾（恢复重执行重复追加）则跳过，防内容翻倍
        if chain.length and chain.patches[-1] == overlay:
            pass
        else:
            chain.apply(overlay)
    elif isinstance(overlay, list):
        patches = [p for p in overlay if isinstance(p, Patch)]
        # list 形态与 PatchChain 等价前缀去重：overlay 是已并入链的前缀段
        # （恢复重执行整段回流）时只追加差集段，防补丁被再次追加导致内容翻倍
        n = chain.length
        if len(patches) >= n and patches[:n] == chain.patches:
            chain.apply_many(patches[n:])
        else:
            chain.apply_many(patches)
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


def _item_key(m: Any) -> Any:
    """条目身份键（additive 差集用）：消息按 id；{kind,text} 条目按内容对；
    其余对象无稳定身份 → None（视为新增，宽容不丢）。"""
    if isinstance(m, dict):
        mid = m.get("id")
        if mid is not None:
            return ("id", mid)
        if m.get("text") is not None:
            return ("content", m.get("kind"), m["text"])
        return None
    mid = getattr(m, "id", None)
    return ("id", mid) if mid is not None else None


def subgraph_overlay_delta(
    entry_state: dict, final_state: dict, schema: StateSchema | None
) -> dict:
    """计算子图回流增量（入口快照 → 终态，按通道 reducer 语义分类）。

    - additive（累积追加族，add_messages 及 register_reducer(additive=True)）：
      返回终态中「入口未见」的条目（按条目身份键差集），父图追加恰好一次；
    - 其余（merge 类/裸通道）：入口已剥离归零（merge 类）或未变化跳过，
      终态即子图内新增（减少回流噪音）。

    嵌套子图与 spawn 实例共用：入口剥离（run_subgraph 内同口径）决定
    「子图内新增」的起算基准，两处增量口径一致防二次加和翻倍。
    """
    if schema is None:
        return dict(final_state)
    delta: dict = {}
    for key, value in final_state.items():
        channel = schema.channels.get(key)
        reducer = channel.reducer if channel is not None else None
        if is_additive_reducer(reducer):
            # additive 通道值必须是可迭代条目序列（list/tuple）；非序列值
            # 是非法增量（dict 会被当迭代产出 (k,v) 元组导致错误增量），
            # 显式报错而非静默产出脏增量（与 docstring 的 additive 条目语义对齐）
            if value is not None and not isinstance(value, (list, tuple)):
                raise GraphDefinitionError(
                    f"additive 通道 {key!r} 的终态值非法：期望条目序列，"
                    f"收到 {type(value).__name__}"
                )
            entry_msgs = entry_state.get(key) or []
            entry_keys = {
                k for m in entry_msgs if (k := _item_key(m)) is not None
            }
            new_msgs = [
                m for m in (value or []) if _item_key(m) not in entry_keys
            ]
            if new_msgs:
                delta[key] = new_msgs
        else:
            # merge 类/裸通道：入口剥离后终态即新增；未变化的键跳过（减少回流噪音）
            if value != entry_state.get(key):
                delta[key] = value
    return delta


def get_reducer(name: str | None) -> Reducer | None:
    """按名取 reducer；None 表示裸通道（覆盖语义）。"""
    if name is None:
        return None
    reducer = REDUCER_REGISTRY.get(name)
    if reducer is None:
        raise GraphDefinitionError(f"未知 reducer: {name}")
    return reducer


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
                # fail-fast：直接构造时也对声明的 reducer 名做存在性校验，
                # 与 from_dict 反序列化期口径一致（None 跳过 = 裸覆盖通道），
                # 避免未知 reducer 推迟到 apply 运行期才 KeyError
                get_reducer(spec)
                self.channels[name] = Channel(reducer=spec)

    def add(self, name: str, reducer: str | None = None) -> None:
        self.channels[name] = Channel(reducer=reducer)

    def to_dict(self) -> dict:
        """序列化为数据形态（通道名 → reducer 名，None = 裸覆盖通道）。

        与图定义数据同链路：schema 是图的可恢复定义的一部分，随图定义
        导出/导入与版本化。
        """
        return {
            "channels": {
                name: channel.reducer for name, channel in self.channels.items()
            }
        }

    @classmethod
    def from_dict(cls, data: dict | None) -> StateSchema | None:
        """反序列化（None/缺省 → None = 全部裸通道语义，兼容无 schema 图）。

        Raises:
            GraphDefinitionError: reducer 名未注册（图定义数据来自 LLM/
                外部时在反序列化处闸门化，不等到执行期合并才 KeyError）。
        """
        if not data or not isinstance(data, dict):
            return None
        raw = data.get("channels")
        if raw is not None and not isinstance(raw, dict):
            raise GraphDefinitionError(
                f"状态 schema channels 字段非法: 期望 dict，收到 {type(raw).__name__}"
            )
        for _name, reducer in (raw or {}).items():
            if reducer is not None:
                get_reducer(reducer)  # 未注册 reducer 在此暴露（fail-fast）
        return cls(dict(raw or {}))

    def apply(self, state: dict, overlay: dict) -> dict:
        """把节点增量 overlay 按通道 reducer 合并进 state（纯函数，返回新 dict）。

        未知通道（schema 未声明）按裸覆盖处理——引擎对 schema 外键宽容覆盖，
        防子图新增通道回流时静默丢失（子图通道回流静默丢失的教训）。
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
    "subgraph_overlay_delta",
]
