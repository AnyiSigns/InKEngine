"""事件类型注册表单测：声明序列化 + 注册门禁 + 发射判定 + 随集持久化。

覆盖：EventTypeSpec 序列化往返、非法声明拒绝、注册/枚举/重复与配额
门禁、classify 语义（未注册宽松 + 折叠、已注册 schema 校验、renderer
缺失折叠、违规宽松标记）、system 标记合成、storage 持久化往返与脏
记录跳过。
"""
from __future__ import annotations

import pytest

from ink_engine.core.event_types import (
    DEFAULT_MAX_EVENT_TYPES,
    EVENT_STATUS_REGISTERED,
    EVENT_STATUS_UNKNOWN,
    EventTypeRegistry,
    EventTypeSpec,
)
from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.schema_validator import FIELD_STRING, SchemaField, SchemaSpec


def _spec(
    name: str = "thinking_start", *, renderer: str = "ThinkingRow", system: bool = False
) -> EventTypeSpec:
    return EventTypeSpec(
        name=name,
        schema=SchemaSpec(
            name=f"{name}.payload",
            fields=(),
        ),
        renderer=renderer,
        system=system,
        meta={"source": "boot", "description": "思考开始"},
    )


def test_spec_roundtrip() -> None:
    spec = _spec(system=True)
    restored = EventTypeSpec.from_dict(spec.to_dict())
    assert restored == spec
    assert restored.schema is not None
    assert restored.schema.name == "thinking_start.payload"
    assert restored.system is True
    assert restored.meta["source"] == "boot"


def test_spec_roundtrip_bare() -> None:
    # 无 schema/renderer 的极简声明（仅名称 + 系统标记）：序列化往返保持
    spec = EventTypeSpec(name="ping", system=True)
    restored = EventTypeSpec.from_dict(spec.to_dict())
    assert restored == spec
    assert restored.schema is None
    assert restored.renderer == ""


def test_spec_from_dict_rejects_invalid() -> None:
    with pytest.raises(GraphDefinitionError, match="缺 name"):
        EventTypeSpec.from_dict({"renderer": "X"})
    with pytest.raises(GraphDefinitionError, match="schema 声明缺 fields 清单"):
        EventTypeSpec.from_dict(
            {"name": "x", "schema": {"name": "x.payload", "fields": "not-a-list"}}
        )
    with pytest.raises(GraphDefinitionError, match="renderer 须为字符串"):
        EventTypeSpec.from_dict({"name": "x", "renderer": 7})
    with pytest.raises(GraphDefinitionError, match="meta 须为 dict"):
        EventTypeSpec.from_dict({"name": "x", "meta": "oops"})


def test_register_get_names_order() -> None:
    registry = EventTypeRegistry()
    registry.register(_spec("a"))
    registry.register(_spec("b"))
    assert registry.names() == ("a", "b")
    assert registry.get("a") == _spec("a")
    assert registry.get("missing") is None


def test_register_duplicate_rejected() -> None:
    registry = EventTypeRegistry()
    registry.register(_spec("a"))
    with pytest.raises(GraphDefinitionError, match="重复注册"):
        registry.register(_spec("a"))


def test_register_quota_rejected() -> None:
    registry = EventTypeRegistry(max_types=2)
    registry.register(_spec("a"))
    registry.register(_spec("b"))
    with pytest.raises(GraphDefinitionError, match="配额上限"):
        registry.register(_spec("c"))
    # 配额上限与常量默认值一致（防实现漂移）
    assert DEFAULT_MAX_EVENT_TYPES >= 1


def test_unregister_unknown_rejected() -> None:
    registry = EventTypeRegistry()
    with pytest.raises(GraphDefinitionError, match="未注册"):
        registry.unregister("missing")
    registry.register(_spec("a"))
    registry.unregister("a")
    assert registry.names() == ()


def test_classify_unknown_fold() -> None:
    # 未注册类型：宽松允许（不阻断执行）+ 折叠兜底（回放不崩）
    verdict = EventTypeRegistry().classify("unregistered_type", {"anything": 1})
    assert verdict.status == EVENT_STATUS_UNKNOWN
    assert verdict.violations == ()
    assert verdict.fold is True


def test_classify_registered_schema_pass() -> None:
    registry = EventTypeRegistry()
    registry.register(_spec())
    verdict = registry.classify("thinking_start", {"content": "..."})
    assert verdict.status == EVENT_STATUS_REGISTERED
    assert verdict.violations == ()
    assert verdict.fold is False


def test_classify_registered_violations_lenient() -> None:
    # 已注册类型 schema 违规：宽松标记不阻断（宿主决定告警/留痕）
    registry = EventTypeRegistry()
    registry.register(
        EventTypeSpec(
            name="weighed",
            schema=SchemaSpec(
                name="weighed.payload",
                fields=(
                    SchemaField(name="content", required=True, kind=FIELD_STRING),
                ),
            ),
            renderer="WeightRow",
        )
    )
    verdict = registry.classify("weighed", {})
    assert verdict.status == EVENT_STATUS_REGISTERED
    assert verdict.fold is False
    assert any("content" in item and "缺失" in item for item in verdict.violations)


def test_classify_renderer_missing_fold() -> None:
    # 无渲染组件 = 只能折叠展示（注册时显式告知；直播 = 回放不变）
    registry = EventTypeRegistry()
    registry.register(EventTypeSpec(name="raw_event"))
    verdict = registry.classify("raw_event", {})
    assert verdict.status == EVENT_STATUS_REGISTERED
    assert verdict.fold is True


def test_system_events_composed() -> None:
    registry = EventTypeRegistry()
    registry.register(_spec("a", system=True))
    registry.register(_spec("b", system=False))
    registry.register(_spec("c", system=True))
    assert registry.system_events() == frozenset({"a", "c"})


async def test_persistence_roundtrip(memory_storage) -> None:
    registry = EventTypeRegistry(storage=memory_storage, set_id="u1")
    registry.register(_spec("a", system=True))
    registry.register(EventTypeSpec(name="b"))
    await registry.save()

    restored = EventTypeRegistry(storage=memory_storage, set_id="u1")
    loaded = await restored.load()
    assert loaded == 2
    assert restored.names() == ("a", "b")
    assert restored.get("a").system is True
    assert restored.system_events() == frozenset({"a"})
    verdict = restored.classify("a", {})
    assert verdict.status == EVENT_STATUS_REGISTERED


async def test_persistence_load_skips_dirty_record(memory_storage) -> None:
    # 脏记录跳过不阻断启动（回放不崩原则：坏类型折叠显示，不拦启动）
    await memory_storage.put_record("event_types", "good", _spec("good").to_dict())
    await memory_storage.put_record("event_types", "bad", {"name": 42})
    registry = EventTypeRegistry(storage=memory_storage)
    assert await registry.load() == 1
    assert registry.names() == ("good",)


async def test_persistence_without_storage_skips() -> None:
    registry = EventTypeRegistry()
    registry.register(_spec("a"))
    assert await registry.load() == 0
    await registry.save()  # 无存储 = 静默跳过，不抛错
    assert registry.names() == ("a",)


# ── 审计事件类型注册（四类留痕；只注册类型不产出事件）──


def test_audit_event_specs_registered():
    from ink_engine.core.event_types import (
        EVENT_AUDIT_ASSEMBLY,
        EVENT_AUDIT_FINGERPRINT_REPLACE,
        EVENT_AUDIT_JUNCTION,
        EVENT_AUDIT_POLICY_REVIEW,
        EVENT_AUDIT_PROMOTION,
        audit_event_specs,
    )

    specs = audit_event_specs()
    names = {s.name for s in specs}
    assert names == {
        EVENT_AUDIT_ASSEMBLY,
        EVENT_AUDIT_JUNCTION,
        EVENT_AUDIT_FINGERPRINT_REPLACE,
        EVENT_AUDIT_POLICY_REVIEW,
        EVENT_AUDIT_PROMOTION,
    }
    # 全部为审计用途声明，schema 可序列化往返
    for spec in specs:
        assert spec.meta.get("purpose") == "audit"
        restored = EventTypeSpec.from_dict(spec.to_dict())
        assert restored == spec


def test_register_audit_event_types():
    from ink_engine.core.event_types import (
        EVENT_AUDIT_ASSEMBLY,
        register_audit_event_types,
    )

    registry = EventTypeRegistry()
    register_audit_event_types(registry)
    assert len(registry.names()) == 5
    assert registry.get(EVENT_AUDIT_ASSEMBLY) is not None
    # 重复注册 = 显式拒绝（注册表既有语义）
    with pytest.raises(GraphDefinitionError, match="重复注册"):
        register_audit_event_types(registry)


def test_audit_event_payload_schema():
    from ink_engine.core.event_types import (
        EVENT_AUDIT_ASSEMBLY,
        EVENT_AUDIT_FINGERPRINT_REPLACE,
        audit_event_specs,
    )

    specs = {s.name: s for s in audit_event_specs()}
    registry = EventTypeRegistry()
    for spec in specs.values():
        registry.register(spec)
    # 已注册类型按 schema 校验负载（宽松标记不阻断）
    verdict = registry.classify(EVENT_AUDIT_ASSEMBLY, {"domain": "code"})
    assert verdict.status == EVENT_STATUS_REGISTERED
    assert verdict.violations == ()
    verdict = registry.classify(EVENT_AUDIT_FINGERPRINT_REPLACE, {"domain": "code"})
    assert verdict.status == EVENT_STATUS_REGISTERED
    assert verdict.violations == ()
