"""E3 壳侧验证：cache.stats / cache.clear op + metrics.snapshot 的 caching_llm 子键。

直接加载 bridge.py，绑定一个含 CachingLLM 的运行期桩（engine_llm），
断言命中统计导出、缓存清空、以及指标快照聚合到 caching_llm 子键；
未挂缓存时 available=False。无 pytest 依赖：``py test_cache_ops.py``，
也兼容 pytest。
"""

import asyncio
import importlib.util
import os

from ink_engine.core.llm.base import AsyncLLM, LLMConfig, LLMResult, LLMChunk
from ink_engine.core.llm.cache import CachingLLM
from ink_engine.core.llm.messages import user
from ink_engine.core.storage import create_storage

_HERE = os.path.dirname(os.path.abspath(__file__))
_BRIDGE_PATH = os.path.join(_HERE, "..", "bridge.py")


def _load_bridge():
    spec = importlib.util.spec_from_file_location("bridge_under_test", _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _FakeLLM(AsyncLLM):
    adapter = "fake"

    def __init__(self):
        super().__init__(LLMConfig(adapter="fake", model_id="fake", base_url="http://fake"))
        self.calls = 0

    async def ainvoke(self, messages, *, tools=None, params=None):
        self.calls += 1
        return LLMResult(content="r")

    async def astream(self, messages, *, tools=None, params=None):
        yield LLMChunk(token="x")

    async def aclose(self):
        pass


class _BehaviorWrap:
    """模拟 BehaviorLLM：仅暴露 ``_inner`` 供 _find_caching_llm 穿透。"""

    def __init__(self, inner):
        self._inner = inner


def _runtime_with_cache():
    storage = create_storage("memory://")
    cached = CachingLLM(_FakeLLM(), storage=storage)
    runtime = type("R", (), {"engine_llm": _BehaviorWrap(cached)})()
    return runtime, cached


def _msg():
    return [user("hi")]


def test_cache_stats_op_and_find():
    bridge = _load_bridge()
    runtime, cached = _runtime_with_cache()
    bridge._RUNTIME = runtime
    asyncio.run(cached.ainvoke(_msg()))
    asyncio.run(cached.ainvoke(_msg()))  # 命中
    out = asyncio.run(bridge._cache_stats({}))
    assert out["ok"] is True
    assert out["available"] is True
    assert out["stats"]["hits"] == 1
    assert out["stats"]["misses"] == 1
    assert out["stats"]["entries"] == 1
    assert abs(out["stats"]["hit_rate"] - 0.5) < 1e-9


def test_cache_clear_op():
    bridge = _load_bridge()
    runtime, cached = _runtime_with_cache()
    bridge._RUNTIME = runtime
    asyncio.run(cached.ainvoke(_msg()))
    out = asyncio.run(bridge._cache_clear({}))
    assert out["ok"] is True
    assert out["available"] is True
    assert out["cleared"] == 1
    stats = asyncio.run(cached.stats())
    assert stats["entries"] == 0
    assert stats["hits"] == 0


def test_metrics_snapshot_includes_caching_llm():
    bridge = _load_bridge()
    runtime, cached = _runtime_with_cache()
    bridge._RUNTIME = runtime
    asyncio.run(cached.ainvoke(_msg()))
    asyncio.run(cached.ainvoke(_msg()))
    out = asyncio.run(bridge._metrics_snapshot({}))
    assert out["ok"] is True
    cl = out["cache"]["caching_llm"]
    assert cl["hits"] == 1 and cl["misses"] == 1
    assert cl["entries"] == 1


def test_cache_ops_unavailable_without_cache():
    bridge = _load_bridge()
    bridge._RUNTIME = type("R", (), {"engine_llm": _FakeLLM()})()
    out = asyncio.run(bridge._cache_stats({}))
    assert out["available"] is False
    out2 = asyncio.run(bridge._cache_clear({}))
    assert out2["available"] is False


if __name__ == "__main__":
    test_cache_stats_op_and_find()
    test_cache_clear_op()
    test_metrics_snapshot_includes_caching_llm()
    test_cache_ops_unavailable_without_cache()
    print("E3 cache ops all assertions passed")
