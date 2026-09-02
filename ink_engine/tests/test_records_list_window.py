"""records_list 读取侧窗口下推测试（）。

引擎 `engine.records_list` 的可选窗口参数（limit/after/before/asc）在读取
侧过滤/倒序/截断——无窗口参数 = 原集合顺序/全量直通（历史契约零变化，
knowledge/entities 等既有调用方不受影响）。时间戳识别 ts/created_at，
时间窗含端点，与壳侧 apply_audit_window 语义一致（幂等归一）。
"""
from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pytest

from ink_engine.core.runtime import Runtime
from ink_engine.core.storage_memory import MemoryStorage


def _load_bridge():
    """加载桥模块（路径含点，需手动加载）。"""
    repo_root = Path(__file__).resolve().parents[2]
    bridge_path = (
        repo_root / "inkling" / "shell" / "src-tauri" / "src" / "engine" / "py" / "bridge.py"
    )
    if "inkling_bridge" not in sys.modules:
        spec = importlib.util.spec_from_file_location("inkling_bridge", bridge_path)
        bridge = importlib.util.module_from_spec(spec)
        sys.modules["inkling_bridge"] = bridge
        spec.loader.exec_module(bridge)
    return sys.modules["inkling_bridge"]


def _invoke_async(bridge, op_name: str, args: dict | None = None) -> dict:
    import asyncio

    raw = asyncio.run(bridge.invoke_async(op_name, json.dumps(args or {})))
    return json.loads(raw)


def _window(bridge, records: list[dict], **kw) -> list[dict]:
    return bridge._apply_records_window(records, **kw)


def _ts_record(ts: float, key: str) -> dict:
    return {"key": key, "ts": ts}


# ── 纯函数窗口语义（与壳侧 apply_audit_window 同源镜像）──

class TestWindowSemantics:
    def test_no_window_params_passthrough(self):
        bridge = _load_bridge()
        records = [_ts_record(3.0, "c"), _ts_record(1.0, "a"), _ts_record(2.0, "b")]
        out = _window(bridge, records)
        assert out == records, "无窗口参数须原样透传（集合顺序/全量）"

    def test_limit_truncates_newest_first(self):
        bridge = _load_bridge()
        records = [_ts_record(1.0, "a"), _ts_record(5.0, "e"), _ts_record(3.0, "c")]
        out = _window(bridge, records, limit=2)
        assert [r["key"] for r in out] == ["e", "c"], "limit 应倒序取最近 2 条"

    def test_time_bounds_inclusive(self):
        bridge = _load_bridge()
        records = [
            _ts_record(1.0, "a"),
            _ts_record(3.0, "c"),
            _ts_record(4.0, "d"),
            _ts_record(5.0, "e"),
        ]
        out = _window(bridge, records, after=2.5, before=4.5)
        assert [r["key"] for r in out] == ["d", "c"], "时间窗含端点，倒序 d,c"

    def test_asc_ordering_within_window(self):
        bridge = _load_bridge()
        records = [_ts_record(5.0, "e"), _ts_record(1.0, "a"), _ts_record(3.0, "c")]
        out = _window(bridge, records, asc=True)
        assert out == records, "asc 单传（无窗口参数）= 直通不排序（现状契约）"
        out = _window(bridge, records, limit=10, asc=True)
        assert [r["key"] for r in out] == ["a", "c", "e"], "窗口内 asc=True 时间正序"

    def test_created_at_recognized(self):
        bridge = _load_bridge()
        records = [
            {"key": "a", "created_at": 1.0},
            {"key": "c", "created_at": 3.0},
        ]
        out = _window(bridge, records, limit=1)
        assert [r["key"] for r in out] == ["c"], "created_at 应为时间戳字段"

    def test_timeless_records_kept_only_without_bounds(self):
        bridge = _load_bridge()
        timeless = {"key": "x"}
        with_limit = _window(bridge, [timeless, _ts_record(5.0, "e")], limit=5)
        assert len(with_limit) == 2, "仅 limit（无窗界）时无时间戳记录保留"
        with_bounds = _window(bridge, [timeless, _ts_record(5.0, "e")], after=4.0)
        assert [r["key"] for r in with_bounds] == ["e"], "带窗界时无时间戳记录被过滤"


# ── op 级：records_list 带窗口参数收敛返回体 ──

class TestRecordsListWindow:
    def _make_runtime(self):
        runtime = Runtime()
        runtime._state = "running"
        runtime.storage = MemoryStorage()
        bridge = _load_bridge()
        bridge.bind_runtime(runtime, None)
        return bridge, runtime

    def test_no_param_returns_full(self):
        import asyncio

        bridge, runtime = self._make_runtime()
        try:
            for i, ts in enumerate((1.0, 2.0, 3.0)):
                asyncio.run(runtime.storage.put_record("set_audit", f"op-{i}", _ts_record(ts, f"k{i}")))
            result = _invoke_async(bridge, "engine.records_list", {"collection": "set_audit"})
            assert len(result) == 3, "无窗口参数 = 全量"
        finally:
            bridge.bind_runtime(None, None)

    def test_limit_pushdown(self):
        import asyncio

        bridge, runtime = self._make_runtime()
        try:
            for i, ts in enumerate((1.0, 2.0, 3.0)):
                asyncio.run(runtime.storage.put_record("set_audit", f"op-{i}", _ts_record(ts, f"k{i}")))
            result = _invoke_async(
                bridge, "engine.records_list", {"collection": "set_audit", "limit": 2}
            )
            assert [r["ts"] for r in result] == [3.0, 2.0], "limit 下推 = 倒序最近 2 条"
        finally:
            bridge.bind_runtime(None, None)

    def test_after_before_pushdown(self):
        import asyncio

        bridge, runtime = self._make_runtime()
        try:
            for i, ts in enumerate((1.0, 2.0, 3.0, 4.0)):
                asyncio.run(runtime.storage.put_record("set_audit", f"op-{i}", _ts_record(ts, f"k{i}")))
            result = _invoke_async(
                bridge,
                "engine.records_list",
                {"collection": "set_audit", "after": 1.5, "before": 3.5},
            )
            assert [r["ts"] for r in result] == [3.0, 2.0], "时间窗含端点倒序"
        finally:
            bridge.bind_runtime(None, None)

    def test_invalid_window_param_errors(self):
        import asyncio

        bridge, runtime = self._make_runtime()
        try:
            asyncio.run(runtime.storage.put_record("set_audit", "op-0", _ts_record(1.0, "k0")))
            with pytest.raises(Exception):
                _invoke_async(
                    bridge, "engine.records_list", {"collection": "set_audit", "limit": 0}
                )
        finally:
            bridge.bind_runtime(None, None)
