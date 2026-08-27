"""事件协议信封单测：序列化 round-trip / 版本门禁 / 增量演进兼容。

语义检查点：
- EngineEvent to_dict/from_dict 往返完整（含 parent_step_id——轨迹树
  字段经存储序列化后仍可还原）；
- 协议版本不符在反序列化入口拒绝（ProtocolVersionError）；
- 旧事件（无 parent_step_id 字段）反序列化兼容（增量演进不破坏）；
- 传输接口的收集器形态（CollectorTransport）原样保留事件。
"""
from __future__ import annotations

import pytest

from ink_engine.core.events import (
    PROTOCOL_VERSION,
    CollectorTransport,
    EngineEvent,
    EngineTransport,
)
from ink_engine.core.exceptions import ProtocolVersionError


def _event(**overrides) -> EngineEvent:
    base = {
        "type": "branch_run",
        "payload": {"delta": 2},
        "step_id": "step-1",
        "parent_step_id": "decision-42",
        "round_id": "round-1",
        "node": "s1",
        "graph_path": ("sim", "0"),
        "seq": 7,
        "trace_id": "trace-9",
        "thread_id": "t1",
        "version": PROTOCOL_VERSION,
    }
    base.update(overrides)
    return EngineEvent(**base)


def test_event_round_trip_preserves_all_fields():
    """事件序列化往返：全部字段（含 parent_step_id 轨迹树引用）还原。"""
    event = _event()
    rebuilt = EngineEvent.from_dict(event.to_dict())
    assert rebuilt == event
    assert rebuilt.parent_step_id == "decision-42"
    assert rebuilt.graph_path == ("sim", "0")


def test_event_parent_step_id_default_none():
    """默认 parent_step_id=None（顶层事件不带父引用，增量演进）。"""
    event = EngineEvent(type="reply_token", payload={"text": "x"})
    assert event.parent_step_id is None
    rebuilt = EngineEvent.from_dict(event.to_dict())
    assert rebuilt.parent_step_id is None


def test_event_legacy_payload_without_parent_step_id_compatible():
    """旧事件（无 parent_step_id 字段）反序列化兼容——协议增量演进。"""
    legacy = {
        "type": "thinking_start",
        "version": PROTOCOL_VERSION,
        "payload": {},
        "step_id": "s-1",
        "round_id": "r-1",
        "node": "n",
        "graph_path": [],
        "seq": 1,
        "trace_id": "-",
        "thread_id": "-",
    }
    rebuilt = EngineEvent.from_dict(legacy)
    assert rebuilt.parent_step_id is None
    assert rebuilt.type == "thinking_start"


def test_event_version_mismatch_rejected():
    """协议版本不符在反序列化入口拒绝（不静默解析错位结构）。"""
    data = _event().to_dict()
    data["version"] = PROTOCOL_VERSION + 1
    with pytest.raises(ProtocolVersionError):
        EngineEvent.from_dict(data)


def test_event_to_json_round_trip():
    """JSON 线格式往返（中文负载 ensure_ascii=False 可读）。"""
    event = _event(payload={"note": "跨分支组装"})
    import json

    rebuilt = EngineEvent.from_dict(json.loads(event.to_json()))
    assert rebuilt == event
    assert rebuilt.payload == {"note": "跨分支组装"}


async def test_collector_transport_keeps_events():
    """收集器传输：原样保留事件对象（测试/日志/回放形态）。"""
    collector = CollectorTransport()
    event = _event()
    await collector.send(event)
    assert collector.events == [event]
    assert isinstance(collector, EngineTransport)


def test_to_json_stringify_is_marked():
    """ENG5-14 回归：to_json 对不可序列化负载降级 default=str 字符串化
    并记 warning（不再静默）——回放类型降级有明确提示。"""
    import json

    event = EngineEvent(type="odd", payload={"obj": object()})
    raw = json.loads(event.to_json())
    assert raw["type"] == "odd"
    assert isinstance(raw["payload"]["obj"], str)  # 字符串化降级
    # 可序列化负载不受影响（无降级）
    assert EngineEvent(type="ok", payload={"n": 1}).to_json() == json.dumps(
        {"type": "ok", "version": PROTOCOL_VERSION, "payload": {"n": 1},
         "step_id": None, "parent_step_id": None, "round_id": None,
         "node": None, "graph_path": [], "seq": None, "trace_id": "-",
         "thread_id": "-"}, ensure_ascii=False
    )


def test_parse_event_lenient_skips_incompatible():
    """ENG5-4 回归：parse_event_lenient 逐条容错——旧版本/结构非法返回 None，
    合法事件正常解析（重放入口不再单条炸整段）。"""
    from ink_engine.core.events import parse_event_lenient

    good = _event()
    assert parse_event_lenient(good.to_dict()) == good
    old = {**good.to_dict(), "version": PROTOCOL_VERSION + 1}
    assert parse_event_lenient(old) is None
    assert parse_event_lenient({"version": PROTOCOL_VERSION}) is None  # 缺 type
    assert parse_event_lenient("not-a-dict") is None  # type: ignore[arg-type]
