"""fan_out 并发原语 / 事件协议版本化 单测。"""
from __future__ import annotations

import asyncio

import pytest

from ink_engine.core.events import PROTOCOL_VERSION, EngineEvent, is_system_event
from ink_engine.core.exceptions import ProtocolVersionError
from ink_engine.core.fanout import fan_out

# ── fan_out ──

async def test_fan_out_all_success():
    async def task(i):
        await asyncio.sleep(0)
        return i * 2

    result = await fan_out([task, task, task], limit=2)
    assert result.successes == [0, 2, 4]
    assert result.success_indices == [0, 1, 2]
    assert result.failures == []
    assert result.all_succeeded


async def test_fan_out_partial_failure_removed():
    async def task(i):
        if i == 1:
            raise RuntimeError(f"task {i} failed")
        return i

    result = await fan_out([task, task, task], limit=2)
    assert result.successes == [0, 2]  # 失败剔除，成功保留
    assert result.success_indices == [0, 2]
    assert len(result.failures) == 1
    assert result.failures[0].index == 1
    assert "failed" in result.failures[0].error
    assert not result.all_succeeded


async def test_fan_out_none_result_kept():
    """任务合法返回 None 不被当作失败剔除，成功集经 success_indices 定位。"""

    async def task(i):
        if i == 1:
            raise RuntimeError("boom")
        return None

    result = await fan_out([task, task, task], limit=2)
    assert result.successes == [None, None]  # 0 与 2 成功（值 None），1 失败剔除
    assert result.success_indices == [0, 2]
    assert [f.index for f in result.failures] == [1]


async def test_fan_out_all_failed():
    async def task(i):
        raise ValueError("boom")

    result = await fan_out([task, task], limit=1)
    assert result.successes == []
    assert result.success_indices == []
    assert len(result.failures) == 2


async def test_fan_out_empty():
    result = await fan_out([], limit=3)
    assert result.successes == [] and result.failures == []
    assert result.success_indices == []


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


class _ControlFlow(BaseException):
    """测试控制流异常（模拟 InterruptSignal 的 BaseException 形态）。"""


async def test_fan_out_propagate_cancels_siblings():
    """propagate 语义：控制流异常不做剔除而是传播，并取消未完成兄弟任务
    （修复前：gather 不取消兄弟，任务泄漏到后台继续执行）。"""
    done: list[int] = []

    async def fast(i):
        raise _ControlFlow("stop")

    async def slow(i):
        await asyncio.sleep(0.3)
        done.append(i)

    with pytest.raises(_ControlFlow):
        await fan_out([fast, slow], limit=2, propagate=_ControlFlow)
    assert done == []  # 兄弟任务被取消


async def test_fan_out_propagate_without_cancel_on_normal_failure():
    """propagate 不干扰普通失败剔除语义。"""
    async def fail(i):
        raise ValueError("boom")

    result = await fan_out([fail], limit=1, propagate=_ControlFlow)
    assert len(result.failures) == 1


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
