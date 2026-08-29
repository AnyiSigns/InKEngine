"""技能结晶单测：存储 / 分类 / 自动结晶阈值 / 去重版本递增 / 沉淀钩子。

覆盖：SkillStore 派生存储的增删查列与导出格式；视觉技能分类（image 输入
→ visual）；结晶双阈值（命中数 + 命中率）；去重与版本递增；SkillCrystallizeHook
沉淀后处理接入指纹缓存。纯算法、零 LLM、零网络。
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from ink_engine.core.skill_crystal import (
    SKILL_HIT_MIN_DEFAULT,
    SKILL_SUCCESS_RATE_DEFAULT,
    SkillCrystallizeHook,
    SkillEntry,
    SkillStore,
    build_test_report,
    classify_skill_kind,
    crystallize_from_cache,
    export_skill,
)


def _fake_cache_entry(
    *,
    hit_count=0,
    fail_count=0,
    path_fingerprint="fp.default",
    domain="default",
    path=None,
    contract_snapshot=(),
    evidence_snapshot=(),
    model_id="m1",
    invalid=False,
):
    return SimpleNamespace(
        invalid=invalid,
        hit_count=hit_count,
        fail_count=fail_count,
        path_fingerprint=path_fingerprint,
        domain=domain,
        path=path if path is not None else {"nodes": {}},
        contract_snapshot=contract_snapshot,
        evidence_snapshot=evidence_snapshot,
        model_id=model_id,
    )


def _fake_cache(*entries):
    class _Store:
        def __init__(self, items):
            self._items = list(items)

        async def entries(self, domain=None):
            return [e for e in self._items if domain is None or e.domain == domain]

    return _Store(entries)


def test_skill_store_fails_fast_without_aiosqlite(monkeypatch):
    """ENG1-11：SkillStore 构造期 fail-fast——aiosqlite 缺失 = 显式拒绝。

    旧实现惰性 import 且异常被 SettleHooks.run 吞掉 → 技能结晶静默
    失效；构造期探测依赖，装配期即暴露（StorageError 带依赖指引）。
    """
    import builtins

    from ink_engine.core.exceptions import StorageError

    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "aiosqlite":
            raise ImportError("No module named 'aiosqlite'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    with pytest.raises(StorageError, match="aiosqlite"):
        SkillStore(":memory:")


async def test_skill_store_roundtrip():
    store = SkillStore(":memory:")
    entry = SkillEntry(
        name="path.default.abc1234567",
        version=1,
        domain="default",
        fingerprint="fp.abc",
        kind="path",
        path={"nodes": {}},
        contract_snapshot=(("a", "1"),),
        evidence_snapshot=({"src_type": "a", "dst_type": "b", "success_count": 3, "fail_count": 0},),
        model_id="m1",
        hit_count=10,
        fail_count=0,
        test_report={"success_rate": 1.0},
        source_path="fp.abc",
        created_at=1.0,
        updated_at=1.0,
    )
    await store.upsert(entry)
    got = await store.get(entry.name)
    assert got is not None
    assert got.fingerprint == "fp.abc"
    assert got.hit_count == 10
    assert got.contract_snapshot == (("a", "1"),)
    assert await store.count() == 1
    assert await store.delete(entry.name) is True
    assert await store.get(entry.name) is None


async def test_skill_store_list_filters_by_domain():
    store = SkillStore(":memory:")
    await store.upsert(
        SkillEntry(
            name="path.default.x1", version=1, domain="default", fingerprint="f1",
            kind="path", path={"nodes": {}}, contract_snapshot=(), evidence_snapshot=(),
            model_id="m", hit_count=1, fail_count=0, test_report={},
            source_path="f1", created_at=1.0, updated_at=1.0,
        )
    )
    await store.upsert(
        SkillEntry(
            name="path.vision.y1", version=1, domain="vision", fingerprint="f2",
            kind="visual", path={"nodes": {}}, contract_snapshot=(), evidence_snapshot=(),
            model_id="m", hit_count=1, fail_count=0, test_report={},
            source_path="f2", created_at=1.0, updated_at=1.0,
        )
    )
    all_skills = await store.list()
    assert len(all_skills) == 2
    vision_only = await store.list("vision")
    assert len(vision_only) == 1 and vision_only[0].domain == "vision"


def test_classify_skill_kind_visual_on_image_input():
    path = {
        "nodes": {
            "perceive": {
                "type": "vision.perceive",
                "contract": {
                    "version": "1",
                    "input_schema": {
                        "name": "in",
                        "fields": [{"name": "image", "required": True, "kind": "string"}],
                    },
                },
            },
            "extract": {"type": "data.extract"},
        }
    }
    assert classify_skill_kind(path) == "visual"
    assert classify_skill_kind({"nodes": {"a": {"type": "plain"}}}) == "path"


async def test_crystallize_threshold_both_conditions():
    cache = _fake_cache(
        _fake_cache_entry(hit_count=10, fail_count=0, path_fingerprint="fp.good"),
        _fake_cache_entry(hit_count=2, fail_count=0, path_fingerprint="fp.lowhit"),
        _fake_cache_entry(hit_count=10, fail_count=10, path_fingerprint="fp.lowrate"),
    )
    store = SkillStore(":memory:")
    created = await crystallize_from_cache(cache, store)
    assert created == ["path.default.fp.good"]
    assert await store.count() == 1


async def test_crystallize_visual_kind_label():
    path = {
        "nodes": {
            "perceive": {
                "type": "vision.perceive",
                "contract": {
                    "version": "1",
                    "input_schema": {
                        "name": "in",
                        "fields": [{"name": "image", "required": True, "kind": "string"}],
                    },
                },
            }
        }
    }
    cache = _fake_cache(
        _fake_cache_entry(
            hit_count=9, fail_count=1, path_fingerprint="fp.vis", path=path
        )
    )
    store = SkillStore(":memory:")
    created = await crystallize_from_cache(cache, store)
    assert created == ["visual.default.fp.vis"]
    entry = await store.get("visual.default.fp.vis")
    assert entry.kind == "visual"


async def test_crystallize_dedup_version_bump():
    cache = _fake_cache(
        _fake_cache_entry(hit_count=10, fail_count=0, path_fingerprint="fp.dup")
    )
    store = SkillStore(":memory:")
    await crystallize_from_cache(cache, store)
    # 同指纹、同计数 = 去重不重复结晶
    again = await crystallize_from_cache(cache, store)
    assert again == []
    assert await store.count() == 1
    # 计数变化 = 版本递增
    cache2 = _fake_cache(
        _fake_cache_entry(hit_count=20, fail_count=0, path_fingerprint="fp.dup")
    )
    bumped = await crystallize_from_cache(cache2, store)
    assert bumped == ["path.default.fp.dup"]
    entry = await store.get("path.default.fp.dup")
    assert entry.version == 2 and entry.hit_count == 20


async def test_crystallize_fail_closed_when_stores_missing():
    assert await crystallize_from_cache(None, SkillStore(":memory:")) == []
    assert await crystallize_from_cache(_fake_cache(), None) == []


async def test_crystallize_skip_invalid_and_respects_config():
    cache = _fake_cache(
        _fake_cache_entry(
            hit_count=4, fail_count=0, path_fingerprint="fp.b",
            invalid=True,
        ),
    )
    store = SkillStore(":memory:")
    created = await crystallize_from_cache(
        cache, store, hit_min=8, success_rate=0.9
    )
    assert created == []


async def test_skill_crystallize_hook_settle():
    cache = _fake_cache(
        _fake_cache_entry(hit_count=10, fail_count=0, path_fingerprint="fp.h")
    )
    store = SkillStore(":memory:")
    hook = SkillCrystallizeHook(cache, store)
    await hook.settle(None)
    assert hook.crystallized == ["path.default.fp.h"]
    assert await store.count() == 1


def test_build_test_report_shape():
    report = build_test_report(
        name="path.default.x",
        version=1,
        domain="default",
        model_id="m",
        hit_count=9,
        fail_count=1,
        success_rate=0.9,
        evidence_snapshot=[
            {"src_type": "a", "dst_type": "b", "success_count": 9, "fail_count": 1}
        ],
        kind="path",
        now=123.0,
    )
    assert report["skill_name"] == "path.default.x"
    assert report["success_rate"] == 0.9
    assert report["sample_edges"][0]["src_type"] == "a"


def test_export_skill_format_and_file():
    import json
    import tempfile
    from pathlib import Path

    entry = SkillEntry(
        name="path.default.exp", version=1, domain="default", fingerprint="fp.e",
        kind="path", path={"nodes": {}}, contract_snapshot=(), evidence_snapshot=(),
        model_id="m", hit_count=5, fail_count=0, test_report={"success_rate": 1.0},
        source_path="fp.e", created_at=1.0, updated_at=1.0,
    )
    with tempfile.TemporaryDirectory() as tmp:
        dest = str(Path(tmp) / "s.json")
        payload = export_skill(entry, dest=dest)
        assert payload["format"] == "inkling.skill/v1"
        assert payload["_export_path"] == dest
        loaded = json.loads(Path(dest).read_text(encoding="utf-8"))
        assert loaded["name"] == "path.default.exp"
        assert loaded["test_report"]["success_rate"] == 1.0


def test_default_thresholds_exported():
    assert SKILL_HIT_MIN_DEFAULT >= 1
    assert 0.0 < SKILL_SUCCESS_RATE_DEFAULT <= 1.0


def test_build_assembly_skill_entry():
    """组装验证候选 → 技能条目：canary 通过即结晶，低频长尾进技能池。"""
    from ink_engine.core.graph import Graph, NodeContract
    from ink_engine.core.skill_crystal import (
        build_assembly_skill_entry,
        skill_to_knowledge_entry,
    )

    graph = Graph(name="cand", entry="collect")
    graph.add_node_type("collect", "collect_material", contract=NodeContract(version=1))
    graph.add_node_type("parse", "parse_material", contract=NodeContract(version=1))
    graph.add_edge("collect", "parse")

    candidate = SimpleNamespace(graph=graph, chain=("collect", "parse"), rank=1)
    verdict = SimpleNamespace(rank=1, digest="digest-abc", ok=True)
    edge = SimpleNamespace(
        key=SimpleNamespace(src_contract_version="1", dst_contract_version="1"),
        src_type="collect_material",
        dst_type="parse_material",
        context_domain="default",
        success_count=3,
        fail_count=0,
    )

    skill = build_assembly_skill_entry(
        candidate,
        verdict,
        domain="default",
        model_id="m1",
        evidence_edges=[edge],
    )
    assert skill.name == "asm.collect.parse"
    assert skill.kind == "path"
    assert skill.fingerprint == "digest-abc"
    assert skill.hit_count == 0 and skill.fail_count == 0
    assert ("collect_material", "1") in skill.contract_snapshot
    assert skill.evidence_snapshot[0]["success_count"] == 3
    assert skill.test_report["success_rate"] == 1.0

    entry = skill_to_knowledge_entry(skill, now=1234.0)
    assert entry.kind == "path"
    assert entry.id == "skill:asm.collect.parse@v1"
    assert entry.data["skill"]["name"] == "asm.collect.parse"


def test_assembly_skill_evidence_pending_note():
    """冷启动 evidence 全零：test_report 标注「证据待积累」，不谎报。"""
    from ink_engine.core.graph import Graph, NodeContract
    from ink_engine.core.skill_crystal import build_assembly_skill_entry

    graph = Graph(name="cand", entry="collect")
    graph.add_node_type("collect", "collect_material", contract=NodeContract(version=1))
    graph.add_edge("collect", "collect")
    candidate = SimpleNamespace(graph=graph, chain=("collect",), rank=1)
    verdict = SimpleNamespace(rank=1, digest="digest-xyz", ok=True)
    skill = build_assembly_skill_entry(
        candidate, verdict, domain="default", model_id="m1", evidence_edges=()
    )
    assert "证据待积累" in skill.test_report["note"]
    assert skill.evidence_snapshot == ()
