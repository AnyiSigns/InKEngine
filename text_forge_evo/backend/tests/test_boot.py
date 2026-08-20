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
    # 工具表 = 内省 5 + 自指演化 3（提案/应用/回退）
    assert data["count"] == 8
    assert data["harnesses"] == ["forge"]


async def test_self_pipeline_assembled() -> None:
    # 应用管线装配：集版本从 1 起步，审计留痕可用，旁路写防护生效
    app = await boot.init_app()
    assert await app.self_pipeline.chain.current_version() == 1
    assert await app.self_pipeline.audit_log() == []
    import pytest
    from ink_engine.core.exceptions import GraphDefinitionError

    with pytest.raises(GraphDefinitionError, match="旁路写拦截"):
        await app.storage.put_record("ui", "boot.panel", {"spec": {}})


async def test_vetting_assembled() -> None:
    # vetting 闸门装配：L2 沙箱验证钩子已挂（构建产物引用的部署前
    # 静态门禁），L2 类型不被静默降级
    from ink_engine.core.self_application import ApprovalLevel
    from ink_engine.core.self_proposal import PatchKind

    app = await boot.init_app()
    assert app.self_pipeline._l2_vetting is not None
    assert app.self_pipeline._levels[PatchKind.ARTIFACT] is ApprovalLevel.L2


async def test_retrieval_source_assembled() -> None:
    # 检索原语装配：知识集检索源已注册（调配器 evidence 汇入的数据源）
    app = await boot.init_app()
    assert "knowledge" in app.retriever_registry.names()
    chunks = await app.retriever_registry.retrieve("写作", limit=5)
    assert isinstance(chunks, list)


async def test_inspect_graph_sees_round_graph() -> None:
    app = await boot.init_app()
    spec = introspection_tool_specs()[0]  # inspect_graph
    result = await app.introspection_pipeline.execute(None, spec, {})
    assert result.ok is True
    data = json.loads(result.output)
    assert data["graph"]["name"] == "forge_round"
    assert data["graph"]["entry"] == "agent"
