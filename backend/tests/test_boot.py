"""开局装配单测：11 步装配产物完整性 + 内省工具可用性。"""

from __future__ import annotations

import json

from ink_engine.core.introspection import introspection_tool_specs

from app import boot


async def test_init_app_assembles_all_steps() -> None:
    app = await boot.init_app()
    # ① 存储已接线（SQLite 集目录）
    assert app.storage is not None
    # ② 图注册表
    assert app.graph_registries is not None
    # ③ 通用种子已注入（知识集非空）
    assert len(app.knowledge_set.entries()) > 0
    # ④ forge 领域已注册 + 落库
    assert "forge" in app.harness_registry.names()
    saved = await app.harness_repository.get("forge")
    assert saved is not None and saved.name == "forge"
    # ⑥ 内省工具装配完成
    assert [s.name for s in app.introspection_specs] == [
        "inspect_graph",
        "inspect_rules",
        "inspect_knowledge",
        "inspect_ui",
        "inspect_tools",
    ]
    # ⑧ 未配置模型 → LLM 解析为 None（前端引导）
    assert await app.resolve_llm() is None
    # ⑩ Engine 实例已装配（图可观察）
    assert app.engine is not None


async def test_init_app_idempotent() -> None:
    first = await boot.init_app()
    second = await boot.init_app()
    assert first is second


async def test_introspection_pipeline_works_after_assembly() -> None:
    app = await boot.init_app()
    spec = introspection_tool_specs()[4]  # inspect_tools
    result = await app.introspection_pipeline.execute(None, spec, {})
    assert result.ok is True
    data = json.loads(result.output)
    assert data["count"] == 5
    assert data["harnesses"] == ["forge"]


async def test_inspect_graph_sees_round_graph() -> None:
    app = await boot.init_app()
    spec = introspection_tool_specs()[0]  # inspect_graph
    result = await app.introspection_pipeline.execute(None, spec, {})
    assert result.ok is True
    data = json.loads(result.output)
    assert data["graph"]["name"] == "forge_round"
    assert data["graph"]["entry"] == "agent"
