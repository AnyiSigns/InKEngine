"""LLM 调用缓存单测：指纹命中/失效（TTL/版本/代际）+ 补丁链挂钩。

覆盖：同参重复调用命中（内层不被调用）；不同 messages/tools/model/
tier 指纹区分；TTL 过期（注入时钟推进）；patch_version 提供者变化 =
失效；PatchChain.on_change 挂钩（链内容变更 → 缓存失效）；记录字段
（fingerprint/response/tier/created_at/patch_version）；astream 直通；
无存储直通；补丁链版本号与失效钩子语义。
"""
from __future__ import annotations

import pytest

from ink_engine.core.llm.base import (
    AsyncLLM,
    LLMChunk,
    LLMConfig,
    LLMResult,
)
from ink_engine.core.llm.cache import CACHE_COLLECTION, CachingLLM
from ink_engine.core.llm.fallback import ModelChain
from ink_engine.core.llm.messages import ToolCall, user
from ink_engine.core.llm.tools import ToolSpec
from ink_engine.core.patch_chain import Patch, PatchChain, PatchOp
from ink_engine.core.storage import create_storage


class CountingLLM(AsyncLLM):
    """计数假模型：ainvoke 调用计数 + 可注入结果/异常。"""

    adapter = "counting"

    def __init__(self, *, result: LLMResult | None = None, fail_times: int = 0):
        self._result = result or LLMResult(content="default-answer")
        self._fail_times = fail_times
        self.ainvoke_calls = 0
        self.astream_calls = 0
        self.aclosed = False
        super().__init__(
            LLMConfig(
                adapter="counting",
                model_id="counting-model",
                base_url="http://local",
            )
        )

    async def ainvoke(self, messages, *, tools=None, params=None):
        self.ainvoke_calls += 1
        if self._fail_times > 0:
            self._fail_times -= 1
            raise RuntimeError("boom")
        return self._result

    async def astream(self, messages, *, tools=None, params=None):
        self.astream_calls += 1
        yield LLMChunk(token=f"chunk-{self.astream_calls}")

    async def aclose(self) -> None:
        self.aclosed = True


def make_cached(storage=None, **kw) -> tuple[CachingLLM, CountingLLM]:
    inner = CountingLLM()
    return CachingLLM(inner, storage=storage, **kw), inner


class TestCacheHitMiss:
    async def test_same_request_hits_cache(self):
        storage = create_storage("memory://")
        cached, inner = make_cached(storage)
        messages = [user("你好")]
        first = await cached.ainvoke(messages)
        assert inner.ainvoke_calls == 1
        second = await cached.ainvoke(messages)
        assert inner.ainvoke_calls == 1  # 命中：内层不再调用
        assert second == first
        assert second.content == "default-answer"

    async def test_distinct_messages_miss(self):
        cached, inner = make_cached(create_storage("memory://"))
        await cached.ainvoke([user("a")])
        await cached.ainvoke([user("b")])
        assert inner.ainvoke_calls == 2

    async def test_distinct_params_miss(self):
        cached, inner = make_cached(create_storage("memory://"))
        from ink_engine.core.llm.base import LLMParams

        await cached.ainvoke([user("a")], params=LLMParams(temperature=0.1))
        await cached.ainvoke([user("a")], params=LLMParams(temperature=0.9))
        assert inner.ainvoke_calls == 2

    async def test_distinct_tools_miss(self):
        cached, inner = make_cached(create_storage("memory://"))
        tool_a = ToolSpec(name="a", description="", parameters={})
        tool_b = ToolSpec(name="b", description="", parameters={})
        await cached.ainvoke([user("a")], tools=[tool_a])
        await cached.ainvoke([user("a")], tools=[tool_b])
        assert inner.ainvoke_calls == 2

    async def test_tier_label_partition(self):
        storage = create_storage("memory://")
        cached, inner = make_cached(storage, tier="router")
        await cached.ainvoke([user("a")])
        cached2 = CachingLLM(inner, storage=storage, tier="main")
        await cached2.ainvoke([user("a")])
        assert inner.ainvoke_calls == 2  # tier 不同 → 分桶

    async def test_model_id_partition(self):
        storage = create_storage("memory://")
        inner_a = CountingLLM()
        from ink_engine.core.llm.base import LLMConfig

        class _OtherLLM(AsyncLLM):
            adapter = "counting"

            def __init__(self):
                super().__init__(
                    LLMConfig(adapter="counting", model_id="other-model", base_url="http://x")
                )
                self.calls = 0

            async def ainvoke(self, messages, *, tools=None, params=None):
                self.calls += 1
                return LLMResult(content="other")

            async def astream(self, messages, *, tools=None, params=None):
                yield LLMChunk(token="x")

            async def aclose(self):
                pass

        inner_b = _OtherLLM()
        ca = CachingLLM(inner_a, storage=storage)
        cb = CachingLLM(inner_b, storage=storage)
        await ca.ainvoke([user("x")])
        await cb.ainvoke([user("x")])
        assert inner_a.ainvoke_calls == 1 and inner_b.calls == 1

    async def test_result_round_trip_with_tool_calls(self):
        storage = create_storage("memory://")
        inner = CountingLLM(
            result=LLMResult(
                content="ok",
                reasoning="想",
                tool_calls=[ToolCall(id="c1", name="lookup", arguments='{"a":1}')],
                finish_reason="tool_calls",
                usage={"total_tokens": 5},
            )
        )
        cached = CachingLLM(inner, storage=storage)
        first = await cached.ainvoke([user("q")])
        second = await cached.ainvoke([user("q")])
        assert inner.ainvoke_calls == 1
        assert second.content == "ok"
        assert second.reasoning == "想"
        assert second.tool_calls == first.tool_calls
        assert second.tool_calls[0].arguments == '{"a":1}'
        assert second.finish_reason == "tool_calls"
        # 存储记录契约：usage 的 token 计费键命中敏感键启发式
        # （_tokens 后缀）被置空——缓存内容不依赖计费值
        assert second.usage == {"total_tokens": ""}


class TestCacheRecordFields:
    async def test_record_contains_expected_fields(self):
        storage = create_storage("memory://")
        cached, _inner = make_cached(storage, tier="router")
        await cached.ainvoke([user("r")])
        records = await storage.list_records(CACHE_COLLECTION)
        assert len(records) == 1
        record = records[0]
        assert set(record) >= {
            "fingerprint",
            "response",
            "tier",
            "created_at",
            "patch_version",
        }
        assert record["tier"] == "router"
        assert record["response"]["content"] == "default-answer"
        assert isinstance(record["created_at"], float)
        # fingerprint 长度 = sha256 hex
        assert len(record["fingerprint"]) == 64

    async def test_storage_write_failure_does_not_break_call(self, monkeypatch):
        class _FailingStorage:
            async def put_record(self, collection, key, data):
                raise OSError("disk full")

            async def get_record(self, collection, key):
                return None

        cached, inner = make_cached(_FailingStorage())
        result = await cached.ainvoke([user("q")])
        assert result.content == "default-answer"
        assert inner.ainvoke_calls == 1


class TestCacheExpiry:
    async def test_ttl_expiry_misses(self):
        storage = create_storage("memory://")
        clock_current = [1000.0]

        def fake_clock():
            return clock_current[0]

        cached, inner = make_cached(storage, ttl=60.0, clock=fake_clock)
        await cached.ainvoke([user("q")])
        clock_current[0] = 1000.0 + 61  # 越过 TTL
        await cached.ainvoke([user("q")])
        assert inner.ainvoke_calls == 2

    async def test_zero_ttl_always_expires(self):
        cached, inner = make_cached(create_storage("memory://"), ttl=0)
        await cached.ainvoke([user("q")])
        await cached.ainvoke([user("q")])
        assert inner.ainvoke_calls == 2

    async def test_negative_ttl_rejected(self):
        with pytest.raises(ValueError, match="TTL 不能为负"):
            CachingLLM(CountingLLM(), ttl=-1)


class TestPatchVersionInvalidation:
    async def test_provider_version_change_invalidates(self):
        storage = create_storage("memory://")
        version = [1]
        cached, inner = make_cached(storage, patch_version=lambda: version[0])
        await cached.ainvoke([user("q")])
        records = await storage.list_records(CACHE_COLLECTION)
        assert records[0]["patch_version"] == "1"
        version[0] = 2  # 链演化 → 版本变化
        await cached.ainvoke([user("q")])
        assert inner.ainvoke_calls == 2
        records = await storage.list_records(CACHE_COLLECTION)
        assert all(r["patch_version"] == "2" for r in records)

    async def test_async_provider_supported(self):
        storage = create_storage("memory://")
        version = [1]

        async def provider():
            return version[0]

        cached, inner = make_cached(storage, patch_version=provider)
        await cached.ainvoke([user("q")])
        await cached.ainvoke([user("q")])
        assert inner.ainvoke_calls == 1

    async def test_invalidate_bumps_local_epoch(self):
        """本地失效代际：invalidate() 后既有记录视为 miss。"""
        storage = create_storage("memory://")
        cached, inner = make_cached(storage)
        await cached.ainvoke([user("q")])
        cached.invalidate()
        await cached.ainvoke([user("q")])
        assert inner.ainvoke_calls == 2


class TestPatchChainVersionHook:
    def test_version_bumps_on_content_mutation(self):
        chain = PatchChain()
        assert chain.version == 0
        chain.apply(Patch(op=PatchOp.REPLACE, path=("a",), value=1))
        assert chain.version == 1
        chain.apply_many([Patch(op=PatchOp.REPLACE, path=("b",), value=2)])
        assert chain.version == 2
        chain.truncate(1)
        assert chain.version == 3

    def test_on_change_fires_on_each_mutation(self):
        fired: list[int] = []
        chain = PatchChain(on_change=lambda: fired.append(chain.version))
        chain.apply(Patch(op=PatchOp.REPLACE, path=("a",), value=1))
        chain.apply_many([Patch(op=PatchOp.REPLACE, path=("b",), value=2)])
        assert fired == [1, 2]

    def test_on_change_exception_does_not_block_mutation(self):
        def boom():
            raise RuntimeError("observer failed")

        chain = PatchChain(on_change=boom)
        chain.apply(Patch(op=PatchOp.REPLACE, path=("a",), value=1))
        assert chain.length == 1
        assert chain.assemble() == {"a": 1}

    def test_branch_rebase_are_fresh_chains(self):
        chain = PatchChain()
        chain.apply(Patch(op=PatchOp.REPLACE, path=("a",), value=1))
        assert chain.branch().version == 0
        assert chain.rebase().version == 0

    async def test_chain_hook_wired_to_cache(self):
        """端到端：补丁链 apply → on_change → 缓存失效 → 下个调用 miss。"""
        storage = create_storage("memory://")
        chain = PatchChain()
        cached, inner = make_cached(storage)
        chain.on_change = cached.invalidate
        await cached.ainvoke([user("q")])
        assert inner.ainvoke_calls == 1
        chain.apply(Patch(op=PatchOp.REPLACE, path=("answer",), value="42"))
        await cached.ainvoke([user("q")])
        assert inner.ainvoke_calls == 2  # 链变更 → 缓存失效


class TestStreamPassThrough:
    async def test_astream_always_delegates(self):
        cached, inner = make_cached(create_storage("memory://"))
        chunks = [c async for c in cached.astream([user("s")])]
        assert inner.astream_calls == 1
        assert [c.token for c in chunks] == ["chunk-1"]

    async def test_no_storage_is_passthrough(self):
        cached, inner = make_cached(None)
        await cached.ainvoke([user("q")])
        await cached.ainvoke([user("q")])
        assert inner.ainvoke_calls == 2  # 无存储 → 不缓存

    async def test_aclose_delegates(self):
        cached, inner = make_cached(create_storage("memory://"))
        await cached.aclose()
        assert inner.aclosed is True


class TestCacheWrapsModelChain:
    async def test_caches_model_chain_result(self):
        """协议场景：CachingLLM 包 ModelChain（与 fallback 同族组合）。"""
        storage = create_storage("memory://")
        configs = [
            LLMConfig(adapter="counting", model_id="a", base_url="http://a"),
            LLMConfig(adapter="counting", model_id="b", base_url="http://b"),
        ]
        made: list[CountingLLM] = []

        def create(cfg):
            llm = CountingLLM()
            made.append(llm)
            return llm

        chain = ModelChain(configs, create=create)
        cached = CachingLLM(chain, storage=storage)
        await cached.ainvoke([user("q")])
        await cached.ainvoke([user("q")])
        assert made[0].ainvoke_calls == 1  # 缓存命中 → 链不再进模型


class TestCacheStatsAndClear:
    async def test_stats_counts_hits_and_misses(self):
        storage = create_storage("memory://")
        cached, inner = make_cached(storage)
        messages = [user("q")]
        # 1 miss（落库）+ 1 hit
        await cached.ainvoke(messages)
        await cached.ainvoke(messages)
        assert inner.ainvoke_calls == 1
        stats = await cached.stats()
        assert stats["entries"] == 1
        assert stats["hits"] == 1
        assert stats["misses"] == 1
        assert stats["hit_rate"] == 0.5

    async def test_stats_zero_rate_without_calls(self):
        cached, _inner = make_cached(create_storage("memory://"))
        stats = await cached.stats()
        assert stats["hits"] == 0
        assert stats["misses"] == 0
        assert stats["hit_rate"] == 0.0

    async def test_stats_without_storage(self):
        cached, inner = make_cached(None)
        await cached.ainvoke([user("q")])
        await cached.ainvoke([user("q")])
        # 无存储：条目量 0，计数仍累计（passthrough 也算 miss）
        stats = await cached.stats()
        assert stats["entries"] == 0
        assert stats["misses"] == 2

    async def test_clear_removes_records_and_resets_counters(self):
        storage = create_storage("memory://")
        cached, inner = make_cached(storage)
        await cached.ainvoke([user("q")])
        await cached.ainvoke([user("q")])
        cleared = await cached.clear()
        assert cleared == 1
        # 清后仍可命中计数归零
        stats = await cached.stats()
        assert stats["entries"] == 0
        assert stats["hits"] == 0
        assert stats["misses"] == 0
        # 记录已删：下一轮重新落库（前两次仅内层调用 1 次，清空后第 3 次
        # ainvoke 重新 miss → 内层累计 2 次）
        await cached.ainvoke([user("q")])
        assert len(await storage.list_records(CACHE_COLLECTION)) == 1
        assert inner.ainvoke_calls == 2

    async def test_clear_without_storage_resets_only(self):
        cached, inner = make_cached(None)
        await cached.ainvoke([user("q")])
        cleared = await cached.clear()
        assert cleared == 0
        stats = await cached.stats()
        assert stats["misses"] == 0
