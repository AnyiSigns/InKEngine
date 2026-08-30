"""实体注册表单测（协作者目录：声明形态 + 注册表 + 集内持久化 + 内省快照）。

覆盖：
- EntitySpec 声明往返 + 形态校验（缺 id / 命名非法 / model/meta 类型）；
- EntityRegistry 注册/查询/废弃 + 重复/配额拒绝；
- load/save 集内持久化（内存存储往返）；
- inspect_entities 内省快照（目录概览：id/label/model，不含 persona 全文）。
"""
from __future__ import annotations

import pytest

from ink_engine.core.entities import (
    DEFAULT_MAX_ENTITIES,
    EntityRegistry,
    EntitySpec,
    entity_collection,
)
from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.introspection import IntrospectionService, IntrospectionSources


def _spec(entity_id: str = "security_reviewer", **kw) -> EntitySpec:
    base = {
        "id": entity_id,
        "label": "安全评审",
        "persona": "你是安全评审专家…",
        "model": {"provider": "moonshotai-cn", "model_id": "kimi-k2"},
    }
    base.update(kw)
    return EntitySpec.from_dict(base)


class TestEntitySpec:
    def test_round_trip(self):
        spec = _spec()
        restored = EntitySpec.from_dict(spec.to_dict())
        assert restored == spec
        assert restored.model == {"provider": "moonshotai-cn", "model_id": "kimi-k2"}

    def test_minimal_spec(self):
        spec = EntitySpec.from_dict({"id": "analyst"})
        assert spec.label == "" and spec.persona == "" and spec.model is None

    def test_missing_id_rejected(self):
        with pytest.raises(GraphDefinitionError):
            EntitySpec.from_dict({"label": "x"})
        with pytest.raises(GraphDefinitionError):
            EntitySpec.from_dict({"id": 123})

    def test_invalid_id_name_rejected(self):
        # 宽松标识符：空白/控制字符/超长拒绝；下划线（协作者常用形态）放行
        with pytest.raises(GraphDefinitionError):
            _spec(entity_id="security reviewer")
        with pytest.raises(GraphDefinitionError):
            _spec(entity_id="bad\tid")
        with pytest.raises(GraphDefinitionError):
            _spec(entity_id="x" * 60)
        _spec(entity_id="security_reviewer")  # 下划线形态合法

    def test_bad_field_types_rejected(self):
        with pytest.raises(GraphDefinitionError):
            _spec(label={"nested": True})
        with pytest.raises(GraphDefinitionError):
            _spec(model="kimi-k2")  # model 须为 dict
        with pytest.raises(GraphDefinitionError):
            _spec(meta=["not-a-dict"])

    def test_model_empty_values_normalized_to_none(self):
        spec = EntitySpec.from_dict(
            {"id": "analyst", "model": {"provider": "", "model_id": "m1"}}
        )
        assert spec.model == {"model_id": "m1"}
        spec2 = EntitySpec.from_dict({"id": "analyst", "model": {}})
        assert spec2.model is None


class TestEntityRegistry:
    def test_register_get_names_specs(self):
        reg = EntityRegistry()
        reg.register(_spec("a"))
        reg.register(_spec("b"))
        assert reg.get("a").label == "安全评审"
        assert reg.get("missing") is None
        assert reg.names() == ("a", "b")
        assert len(reg.specs()) == 2

    def test_duplicate_register_rejected(self):
        reg = EntityRegistry()
        reg.register(_spec("a"))
        with pytest.raises(GraphDefinitionError):
            reg.register(_spec("a"))

    def test_unregister(self):
        reg = EntityRegistry()
        reg.register(_spec("a"))
        reg.unregister("a")
        assert reg.get("a") is None
        with pytest.raises(GraphDefinitionError):
            reg.unregister("a")

    def test_quota_rejected(self):
        reg = EntityRegistry(max_entities=1)
        reg.register(_spec("a"))
        with pytest.raises(GraphDefinitionError):
            reg.register(_spec("b"))

    def test_collection_by_set(self):
        assert entity_collection("default") == "entities:default"


@pytest.mark.asyncio
class TestEntityRegistryPersistence:
    async def test_save_load_round_trip(self, memory_storage):
        reg = EntityRegistry(storage=memory_storage, set_id="default")
        reg.register(_spec("a"))
        reg.register(_spec("b"))
        await reg.save()

        reg2 = EntityRegistry(storage=memory_storage, set_id="default")
        loaded = await reg2.load()
        assert loaded == 2
        assert reg2.names() == ("a", "b")
        assert reg2.get("a").persona == "你是安全评审专家…"

    async def test_dirty_record_skipped(self, memory_storage):
        await memory_storage.put_record(
            "entities:default", "bad", {"id": "bad", "label": 1}
        )
        reg = EntityRegistry(storage=memory_storage, set_id="default")
        assert await reg.load() == 0  # 脏记录跳过不阻断启动


class TestIntrospectionEntities:
    def test_snapshot_entities(self):
        reg = EntityRegistry()
        reg.register(_spec("a"))
        service = IntrospectionService(
            IntrospectionSources(entity_registry=reg)
        )
        snap = service.snapshot_entities()
        assert snap["count"] == 1
        entry = snap["entities"][0]
        assert entry["id"] == "a"
        assert entry["label"] == "安全评审"
        assert "persona" not in entry  # 目录概览不含 persona 全文
        assert entry["model"] == {"provider": "moonshotai-cn", "model_id": "kimi-k2"}

    def test_snapshot_entities_without_registry(self):
        service = IntrospectionService(IntrospectionSources())
        assert service.snapshot_entities() == {"entities": [], "count": 0}


class TestCollabEndpointDerivation:
    """collab_request 端点的判定目标推导（collab:request:<entity_id>，fail-closed）。"""

    def test_operation_derivation(self):
        from ink_engine.core.declarative_tools import (
            EndpointType,
            endpoint_operation,
            endpoint_operation_failure_reason,
        )

        assert endpoint_operation(
            EndpointType.COLLAB_REQUEST, {"entity_id": "security_reviewer"}
        ) == ("request", "security_reviewer")
        assert endpoint_operation(EndpointType.COLLAB_REQUEST, {}) is None
        assert endpoint_operation(EndpointType.COLLAB_REQUEST, {"entity_id": ""}) is None
        assert (
            endpoint_operation_failure_reason(EndpointType.COLLAB_REQUEST, {})
            == "entity_id 参数缺失或非法（须为已注册实体 id）"
        )
        assert (
            endpoint_operation_failure_reason(
                EndpointType.COLLAB_REQUEST, {"entity_id": "ok"}
            )
            is None
        )


class TestEntityPatchLifecycle:
    """实体补丁路径推导（ENTITY 走集补丁链 entities/<id>，演化闭环）。"""

    def test_entity_patch_path(self):
        from ink_engine.core.self_application import patch_path
        from ink_engine.core.self_proposal import PatchKind

        path, value = patch_path(PatchKind.ENTITY, {"id": "analyst", "persona": "x"})
        assert path == ("entities", "analyst")
        assert value == {"id": "analyst", "persona": "x"}
        with pytest.raises(GraphDefinitionError):
            patch_path(PatchKind.ENTITY, {"persona": "x"})
