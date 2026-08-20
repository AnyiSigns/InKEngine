"""界面数据化观察端点单测：/api/self/ui 与 /api/self/event-types。

覆盖：装配期事件类型注册表接入（boot 内置类型登记 + 集内演化类型
持久化往返）、界面描述装配（boot 面板布局 + 深拷贝快照）、HTTP
观察端点内容与只读性。
"""

from __future__ import annotations

from app import boot
from app import engine as engine_store


def test_ui_endpoint_returns_boot_panel(client) -> None:
    resp = client.get("/api/self/ui")
    assert resp.status_code == 200
    ui_spec = resp.json()["ui_spec"]
    assert ui_spec["name"] == "boot.panel"
    root = ui_spec["root"]
    assert root["kind"] == "container"
    assert root["type"] == "column"
    types = {child["type"] for child in root["children"]}
    assert types == {"message_list", "agent_input"}
    assert ui_spec["theme"]["accent"]


def test_ui_endpoint_snapshot_is_deep_copy(client) -> None:
    # 快照只读：消费方改写响应不得反写引擎源数据
    resp = client.get("/api/self/ui")
    ui_spec = resp.json()["ui_spec"]
    ui_spec["root"] = None
    again = client.get("/api/self/ui").json()["ui_spec"]
    assert again["root"] is not None


def test_event_types_endpoint_lists_boot_types(client) -> None:
    resp = client.get("/api/self/event-types")
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] == 8
    by_name = {item["name"]: item for item in data["types"]}
    assert by_name["thinking_start"]["renderer"] == "ThinkingRow"
    assert by_name["review_card"]["renderer"] == "ReviewCard"
    assert by_name["reply_token"]["system"] is False
    assert by_name["thinking_start"]["meta"]["source"] == "boot"


def test_knowledge_endpoint_returns_seeded_entries(client) -> None:
    # 孵化面板数据源：通用种子注入后知识集非空（模板/权重基线条目）
    resp = client.get("/api/self/knowledge")
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] >= 2
    assert data["by_kind"]["template"] >= 1
    assert data["by_kind"]["weight"] >= 1
    ids = {entry["id"] for entry in data["entries"]}
    assert "seed.general.template.default" in ids
    assert "seed.general.weights.default" in ids


def test_evolution_endpoint_returns_metrics_and_states(client) -> None:
    # 演化指标 + 冷却状态 + 孵化留痕（孵化面板的收敛观测视图）
    resp = client.get("/api/self/evolution")
    assert resp.status_code == 200
    data = resp.json()
    metrics = data["metrics"]
    assert metrics["proposals"] >= 0
    assert metrics["adoption_ratio"] >= 0
    assert metrics["revert_rate"] >= 0
    assert isinstance(metrics["targets"], list)
    assert isinstance(data["cooldowns"], list)
    assert isinstance(data["incubation"], list)


def test_seeds_endpoint_lists_local_store(client) -> None:
    # 种子沉淀池视图（只读清单；空仓库返回空清单不报错）
    resp = client.get("/api/self/seeds")
    assert resp.status_code == 200
    assert isinstance(resp.json()["seeds"], list)


def test_ui_context_report_whitelist(client) -> None:
    # 字段白名单：未知字段显式拒绝（防伪造上下文）
    resp = client.post(
        "/api/self/ui/context",
        json={"active_view": "chat", "evil_key": "注入"},
    )
    assert resp.status_code == 422
    # 值类型约束：非字符串/null 拒绝（防结构注入）
    resp = client.post(
        "/api/self/ui/context",
        json={"focused_component": {"nested": True}},
    )
    assert resp.status_code == 422
    # 合法快照落库
    resp = client.post(
        "/api/self/ui/context",
        json={
            "active_app": "forge",
            "active_view": "chat",
            "current_layout": "boot.panel",
            "focused_component": "agent_input",
            "selection": None,
        },
    )
    assert resp.status_code == 200
    assert resp.json()["ok"] is True


def test_ui_event_report_audit(client) -> None:
    # 交互事件留痕：合法上报成功，缺 type 拒绝
    resp = client.post("/api/self/ui/event", json={"type": "click", "component": "agent_input"})
    assert resp.status_code == 200
    resp = client.post("/api/self/ui/event", json={"component": "x"})
    assert resp.status_code == 422


async def test_inspect_ui_sees_assembled_layout() -> None:
    # 装配后的界面描述对 AI 可观察（inspect_ui 内省通道同源）
    import json

    from ink_engine.core.introspection import introspection_tool_specs

    app = await boot.init_app()
    spec = introspection_tool_specs()[3]  # inspect_ui
    result = await app.introspection_pipeline.execute(None, spec, {})
    assert result.ok is True
    snapshot = json.loads(result.output)
    assert snapshot["ui_spec"]["name"] == "boot.panel"


class _FakeCtx:
    """挂卡审批的假节点上下文（决议注入 accept，验证完整落链路径）。"""

    def __init__(self) -> None:
        self.injects: dict[str, object] = {"patch:event_type": {"decision": "accept"}}

    async def interrupt(self, key: str, payload: dict):
        if key in self.injects:
            return self.injects.pop(key)
        raise AssertionError(f"未预设注入值: {key}")

    async def get_interrupt_payload(self, key: str):
        return None


async def test_event_registry_persists_set_types() -> None:
    # 集内演化类型的唯一写入路径 = 应用管线：提案 → 审批 → 落链 →
    # 注册 + 落库；重启装配从链恢复（集合级可演化资产，回退可还原）
    from ink_engine.core.self_proposal import PatchKind, SelfProposal

    app = await boot.init_app()
    proposal = SelfProposal(
        kind=PatchKind.EVENT_TYPE,
        payload={
            "name": "domain_event",
            "renderer": "DomainRow",
            "meta": {"source": "test", "description": "测试演化类型"},
        },
        base_version=1,
        rationale="测试注册演化事件类型",
    )
    outcome = await app.self_pipeline.apply(_FakeCtx(), proposal)
    assert outcome.applied is True

    boot._app = None
    engine_store._storage = None
    engine_store._process_lock = None
    app2 = await boot.init_app()
    restored = app2.event_type_registry.get("domain_event")
    assert restored is not None
    assert restored.renderer == "DomainRow"
    assert restored.meta["source"] == "test"
