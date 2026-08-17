"""E1 性能基准测试（验收指标门禁）。

指标（本地基准，CI 门禁）：
- checkpoint 单次写入 <10ms
- 事件流吞吐 ≥500 事件/s
- 长链组装（100 补丁）<5ms
- rebase 压扁 <10ms

说明：断言阈值取宽松值（CI 抖动容差），精确数值用 pytest-benchmark
单独统计（pytest --benchmark-only -m benchmark）。基准实现可注入 mock
存储以隔离磁盘抖动，真实 sqlite 冒烟在 test_storage 覆盖。
"""
from __future__ import annotations

import asyncio
import time

import pytest

from ink_engine.core.patch_chain import Patch, PatchChain, PatchOp
from ink_engine.core.storage import CheckpointRecord, create_storage

# 验收指标（毫秒/秒），CI 门禁宽松阈值
CHECKPOINT_WRITE_MS = 10.0
EVENT_THROUGHPUT_EPS = 500.0
PATCH_CHAIN_ASSEMBLE_MS = 5.0
PATCH_CHAIN_REBASE_MS = 10.0

# 基准规模
PATCH_COUNT = 100


def _elapsed_ms(start: float) -> float:
    return (time.perf_counter() - start) * 1000


@pytest.mark.benchmark
def test_checkpoint_write_latency():
    """checkpoint 单次写入 <10ms（内存后端，纯引擎路径）。"""
    storage = create_storage("memory://")
    record = CheckpointRecord(
        checkpoint_id=0,
        thread_id="bench",
        node="n",
        state={"messages": [{"role": "user", "content": "x" * 200}]},
    )

    async def _warm():
        for _ in range(5):  # 预热
            await storage.put_checkpoint(record)

    async def _measure() -> float:
        start = time.perf_counter()
        for _ in range(50):
            await storage.put_checkpoint(record)
        return _elapsed_ms(start) / 50

    asyncio.run(_warm())
    avg_ms = asyncio.run(_measure())
    assert avg_ms < CHECKPOINT_WRITE_MS, f"checkpoint 写入 {avg_ms:.2f}ms 超限"


@pytest.mark.benchmark
def test_event_throughput():
    """事件流吞吐 ≥500 事件/s（内存收集传输，纯 emit 路径）。"""
    from ink_engine.core.events import EngineEvent

    storage = create_storage("memory://")
    event = EngineEvent(type="reply_token", payload={"text": "x"})

    async def _run(n: int) -> float:
        start = time.perf_counter()
        for _ in range(n):
            await storage.append_event("bench", event)
        return time.perf_counter() - start

    asyncio.run(_run(20))  # 预热
    elapsed = asyncio.run(_run(500))
    eps = 500 / elapsed
    assert eps >= EVENT_THROUGHPUT_EPS, f"事件吞吐 {eps:.0f}/s 低于 {EVENT_THROUGHPUT_EPS}/s"


@pytest.mark.benchmark
def test_patch_chain_100_patches_assemble():
    """长链组装（100 补丁）<5ms。"""
    chain = PatchChain(base={"content": ""})
    for i in range(PATCH_COUNT):
        chain.apply(Patch(op=PatchOp.APPEND, path=("content",), value=f"段{i}"))

    chain.assemble()  # 预热
    start = time.perf_counter()
    for _ in range(10):
        chain.assemble()
    avg_ms = _elapsed_ms(start) / 10
    assert avg_ms < PATCH_CHAIN_ASSEMBLE_MS, f"100 补丁组装 {avg_ms:.3f}ms 超限"


@pytest.mark.benchmark
def test_patch_chain_rebase():
    """rebase 压扁 <10ms（100 补丁）。"""
    chain = PatchChain(base={"content": ""})
    for i in range(PATCH_COUNT):
        chain.apply(Patch(op=PatchOp.APPEND, path=("content",), value=f"段{i}"))

    chain.rebase()  # 预热
    start = time.perf_counter()
    for _ in range(10):
        chain.rebase()
    avg_ms = _elapsed_ms(start) / 10
    assert avg_ms < PATCH_CHAIN_REBASE_MS, f"rebase 压扁 {avg_ms:.3f}ms 超限"


# 精确统计（pytest --benchmark-only 运行，与断言门禁互补）
@pytest.mark.benchmark
def test_benchmark_checkpoint(benchmark):
    storage = create_storage("memory://")
    record = CheckpointRecord(checkpoint_id=0, thread_id="bench", node="n", state={})

    async def _write():
        await storage.put_checkpoint(record)

    def _run():
        asyncio.run(_write())

    benchmark(_run)


@pytest.mark.benchmark
def test_benchmark_assemble(benchmark):
    chain = PatchChain(base={"content": ""})
    for i in range(PATCH_COUNT):
        chain.apply(Patch(op=PatchOp.APPEND, path=("content",), value=f"段{i}"))

    benchmark(chain.assemble)
