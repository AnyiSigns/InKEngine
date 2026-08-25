"""干预能力四 op 引擎侧测试（调用→状态改变→审计落库→反向操作复原）。

四个 op 全部复用既有机制（assemble 候选选择落库 / PathAssemblyFlags 单块
开关 / FingerprintCacheStore.invalidate / 边证据计数改写 + override 快照），
审计复用事件注册表既有类型，落 set_audit 集合。本文件仅测引擎侧实现，壳
侧命令映射由主会话补。
"""
from __future__ import annotations

import pytest

from ink_engine.core.edge_evidence import (
    EdgeEvidence,
    EdgeEvidenceStore,
    EdgeKey,
    derive_edge_tier,
)
from ink_engine.core.event_types import (
    EVENT_ASSEMBLY_CANDIDATE,
    EVENT_AUDIT_ASSEMBLY,
    EVENT_AUDIT_FINGERPRINT_REPLACE,
    EVENT_AUDIT_POLICY_REVIEW,
)
from ink_engine.core.fingerprint_cache import FingerprintCacheStore
from ink_engine.core.path_assembler import (
    choose_candidate,
    clear_candidate_selection,
    set_multipath,
)


async def _audit_types(storage) -> list[str]:
    """取 set_audit 集合中全部审计记录的 type（落库断言用）。"""
    return [r.get("type") for r in await storage.list_records("set_audit")]


# ── 1. path.choose_candidate ──

async def test_choose_candidate_roundtrip(memory_storage) -> None:
    # 调用
    sel = await choose_candidate(
        memory_storage,
        "c-2",
        domain="code",
        chain=["a", "b", "c"],
        fingerprint="fp-abc",
    )
    assert sel["candidate_id"] == "c-2"
    # 状态改变
    stored = await memory_storage.get_record("path_candidate_selection", "code")
    assert stored is not None
    assert stored["candidate_id"] == "c-2"
    assert stored["chain"] == ["a", "b", "c"]
    # 审计事件落库
    assert EVENT_ASSEMBLY_CANDIDATE in await _audit_types(memory_storage)
    # 反向操作复原（清除选择，恢复多候选观察态）
    await clear_candidate_selection(memory_storage, domain="code")
    cleared = await memory_storage.get_record("path_candidate_selection", "code")
    assert cleared["candidate_id"] == ""


async def test_choose_candidate_rejects_empty_id(memory_storage) -> None:
    with pytest.raises(ValueError):
        await choose_candidate(memory_storage, "")


# ── 2. path.set_multipath ──

async def test_set_multipath_roundtrip(memory_storage) -> None:
    # 调用
    on = await set_multipath(memory_storage, True, domain="code")
    assert on["multipath_enabled"] is True
    # 状态改变
    flags = await memory_storage.get_record("path_flags", "code")
    assert flags["multipath_enabled"] is True
    # 审计事件落库
    assert EVENT_AUDIT_ASSEMBLY in await _audit_types(memory_storage)
    # 反向操作复原
    off = await set_multipath(memory_storage, False, domain="code")
    assert off["multipath_enabled"] is False
    flags = await memory_storage.get_record("path_flags", "code")
    assert flags["multipath_enabled"] is False


# ── 3. cache.invalidate ──

async def test_cache_invalidate_roundtrip() -> None:
    store = FingerprintCacheStore(":memory:")
    fp = "ctx-fp-1"
    ok = await store.upsert(
        fp,
        path={"nodes": {"a": {"type": "a"}}, "edges": {}, "entry": "a"},
        evidence_snapshot=[],
        model_id="m",
        gate_passed=True,
        path_fingerprint="",
        domain="default",
    )
    assert ok
    # 调用前命中
    assert await store.lookup(fp) is not None
    # 调用（语义化失效）
    from ink_engine.core.fingerprint_cache import invalidate_cache

    result = await invalidate_cache(store, fp, storage=None, reason="人工失效")
    assert result["invalidated"] == 1
    # 同一请求指纹 lookup 未命中（核心断言）
    assert await store.lookup(fp) is None
    # 审计事件落库（传存储时）
    from ink_engine.core.storage import create_storage

    audit_store = create_storage("memory://")
    result2 = await invalidate_cache(store, fp, storage=audit_store, reason="人工失效")
    assert result2["invalidated"] == 0  # 已失效，重复失效 0 条
    records = await audit_store.list_records("set_audit")
    assert any(r.get("type") == EVENT_AUDIT_FINGERPRINT_REPLACE for r in records)
    # 反向操作复原（重新 upsert，命中恢复）
    await store.upsert(
        fp,
        path={"nodes": {"a": {"type": "a"}}, "edges": {}, "entry": "a"},
        evidence_snapshot=[],
        model_id="m",
        gate_passed=True,
        path_fingerprint="",
        domain="default",
    )
    assert await store.lookup(fp) is not None
    await store.close()
    await audit_store.close()


async def test_cache_invalidate_rejects_empty_scope() -> None:
    store = FingerprintCacheStore(":memory:")
    from ink_engine.core.fingerprint_cache import invalidate_cache

    with pytest.raises(ValueError):
        await invalidate_cache(store, "", storage=None)
    await store.close()


# ── 4. edge.downgrade_tier ──

async def test_edge_downgrade_tier_roundtrip() -> None:
    store = EdgeEvidenceStore(":memory:")
    key = EdgeKey(src_type="a", dst_type="b", context_domain="default")
    await store.put(
        EdgeEvidence(key=key, success_count=40, fail_count=2, avg_cost=1.0)
    )
    assert derive_edge_tier(40, 2) == "promoted"
    from ink_engine.core.edge_evidence import downgrade_edge_tier
    from ink_engine.core.storage import create_storage

    # 调用（人工降级到观察档，同时落审计）
    audit_store = create_storage("memory://")
    res = await downgrade_edge_tier(
        store, key, target_tier="observing", storage=audit_store, reason="人工降级"
    )
    assert res["from_tier"] == "promoted"
    # 状态改变
    after = await store.get(key)
    assert derive_edge_tier(after.success_count, after.fail_count) == "observing"
    # 审计事件落库
    records = await audit_store.list_records("set_audit")
    assert any(r.get("type") == EVENT_AUDIT_POLICY_REVIEW for r in records)
    # 反向操作复原（restore 回写原始证据）
    from ink_engine.core.edge_evidence import restore_edge_tier

    restored = await restore_edge_tier(store, key, storage=audit_store)
    assert restored is not None and restored["restored"] is True
    back = await store.get(key)
    assert derive_edge_tier(back.success_count, back.fail_count) == "promoted"
    await store.close()
    await audit_store.close()


async def test_edge_downgrade_tier_unknown_id_fail_closed() -> None:
    store = EdgeEvidenceStore(":memory:")
    from ink_engine.core.edge_evidence import downgrade_edge_tier

    key = EdgeKey(src_type="ghost", dst_type="none", context_domain="default")
    with pytest.raises(KeyError):
        await downgrade_edge_tier(store, key, target_tier="observing", storage=None)
    await store.close()


async def test_edge_downgrade_tier_invalid_tier_fail_closed() -> None:
    store = EdgeEvidenceStore(":memory:")
    from ink_engine.core.edge_evidence import downgrade_edge_tier

    key = EdgeKey(src_type="a", dst_type="b", context_domain="default")
    await store.put(EdgeEvidence(key=key, success_count=40, fail_count=2))
    with pytest.raises(ValueError):
        await downgrade_edge_tier(store, key, target_tier="bogus", storage=None)
    await store.close()
