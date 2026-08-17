"""fan_out 并发原语 / 节点与边注册表 / 事件协议版本化 单测。"""
from __future__ import annotations

import asyncio

import pytest

from engine_core.events import PROTOCOL_VERSION, EngineEvent, is_system_event
from engine_core.exceptions import NodeNotFoundError, ProtocolVersionError
from engine_core.fanout import fan_out
from engine_core.registry import NodeRegistry, register_node, resolve_node

# ── fan_out ──

async def test_fan_out_all_success():
    async def task(i):
        await asyncio.sleep(0)
        return i * 2

    result = await fan_out([task, task, task], limit=2)
    assert result.successes == [0, 2, 4]
    assert result.failures == []
    assert result.all_succeeded


async def test_fan_out_partial_failure_removed():
    async def task(i):
        if i == 1:
            raise RuntimeError(f"task {i} failed")
        return i

    result = await fan_out([task, task, task], limit=2)
    assert result.successes == [0, 2]  # 失败剔除，成功保留
    assert len(result.failures) == 1
    assert result.failures[0].index == 1
    assert "failed" in result.failures[0].error
    assert not result.all_succeeded


async def test_fan_out_none_result_kept():
    """任务合法返回 None 不被当作失败剔除，成功集保持输入下标对齐（A4）。"""

    async def task(i):
        if i == 1:
            raise RuntimeError("boom")
        return None

    result = await fan_out([task, task, task], limit=2)
    assert result.successes == [None, None]  # 0 与 2 成功（值 None），1 失败剔除
    assert [f.index for f in result.failures] == [1]


async def test_fan_out_all_failed():
    async def task(i):
        raise ValueError("boom")

    result = await fan_out([task, task], limit=1)
    assert result.successes == []
    assert len(result.failures) == 2


async def test_fan_out_empty():
    result = await fan_out([], limit=3)
    assert result.successes == [] and result.failures == []


async def test_fan_out_invalid_limit():
    with pytest.raises(ValueError):
        await fan_out([], limit=0)


async def test_fan_out_concurrency_capped():
    """并发上限：semaphore 控制同时执行数。"""
    active = {"now": 0, "max": 0}
    lock = asyncio.Lock()

    async def task(i):
        async with lock:
            active["now"] += 1
            active["max"] = max(active["max"], active["now"])
        await asyncio.sleep(0.01)
        async with lock:
            active["now"] -= 1
        return i

    await fan_out([task] * 8, limit=3)
    assert active["max"] <= 3


# ── 注册表 ──

def test_node_registry_register_resolve():
    reg = NodeRegistry("test")

    async def fn(ctx):
        return {}

    reg.register("my_node", fn)
    assert reg.resolve("my_node") is fn
    assert reg.has("my_node")
    assert reg.names() == ["my_node"]


def test_node_registry_duplicate_rejected():
    reg = NodeRegistry("test")

    async def fn(ctx):
        return {}

    reg.register("n", fn)
    with pytest.raises(ValueError):
        reg.register("n", fn)


def test_node_registry_missing_raises():
    reg = NodeRegistry("test")
    with pytest.raises(NodeNotFoundError):
        reg.resolve("ghost")


def test_global_registry():
    async def fn(ctx):
        return {}

    register_node("g_test_node", fn)
    assert resolve_node("g_test_node") is fn


# ── 事件协议 ──

def test_event_roundtrip():
    e = EngineEvent(type="reply_token", payload={"text": "你好"}, step_id="reply:1")
    d = e.to_dict()
    assert d["version"] == PROTOCOL_VERSION
    restored = EngineEvent.from_dict(d)
    assert restored == e


def test_event_version_mismatch_rejected():
    d = {"type": "x", "version": 99}
    with pytest.raises(ProtocolVersionError):
        EngineEvent.from_dict(d)


def test_event_json_line():
    e = EngineEvent(type="reply_token", payload={"text": "hi"}, step_id="s1")
    j = e.to_json()
    assert '"type": "reply_token"' in j
    assert '"step_id": "s1"' in j


def test_system_events_not_in_step_sequence():
    assert is_system_event("end")
    assert is_system_event("chapter_written")
    assert is_system_event("regenerated_from")
    assert not is_system_event("reply_token")


def test_event_from_dict_missing_keys():
    e = EngineEvent.from_dict({"type": "end", "payload": {"reply": "x"}})
    assert e.type == "end"
    assert e.payload == {"reply": "x"}
    assert e.step_id is None and e.graph_path == ()
