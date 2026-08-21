"""boot 装配闭环 e2e：配方 17 字段全落值 + 三层白名单 + ui_spec 存活。

覆盖 PLAN §6 M3「boot 装配闭环」：装配数据（recipe）与装配动作
（Runtime.boot）的分界——recipe 是数据（纯映射可断言），boot 是
机制（产物可断言）。出厂零预挂在此层断言（无任何 MCP 会话/工具）。
"""
from __future__ import annotations

import json

from conftest import SEED_ROOT, load_seed
from helpers import domain_tool_specs
from ink_engine.core.runtime import AssemblyRecipe
from ink_engine.core.self_proposal import PatchKind
from ink_engine.core.ui_schema import UISchemaValidator


def _build_recipe() -> AssemblyRecipe:
    from host.recipe_loader import build_recipe, load_seed_data

    return build_recipe(load_seed_data(SEED_ROOT))


def test_recipe_17_fields_all_populated():
    """配方 17 字段全落值（缺一不可：引擎 boot 对 tool_wiring/graph_recipe 硬校验）。

    落值语义逐字段断言：数据驱动的字段必须有内容；语义上允许为空的
    字段（文件级静态钩子缺数据、宿主钩子未接）断言其形态正确而非非空。
    """
    recipe = _build_recipe()
    populated = {
        "set_id": recipe.set_id,
        "seeds": recipe.seeds,
        "harness_definitions": recipe.harness_definitions,
        "event_type_specs": recipe.event_type_specs,
        "ui_spec": recipe.ui_spec,
        "ui_allowed_channels": recipe.ui_allowed_channels,
        "ui_allowed_components": recipe.ui_allowed_components,
        "ui_allowed_theme_tokens": recipe.ui_allowed_theme_tokens,
        "tool_wiring": recipe.tool_wiring,
        "vetting_l2_hook": recipe.vetting_l2_hook,
        "approval_levels": recipe.approval_levels,
        "retrieval_sources": recipe.retrieval_sources,
        "apply_targets": recipe.apply_targets,
        "graph_recipe": recipe.graph_recipe,
    }
    assert len(populated) == 14
    for name, value in populated.items():
        assert value not in (None, [], (), {}), f"配方字段未落值: {name}"
    # 语义上允许为空的字段（数据无文件级静态钩子；宿主回退/收敛钩子未接）
    assert recipe.vetting_static_hooks == []
    assert recipe.on_reverted is None
    assert recipe.convergence_provider is None
    assert recipe.set_id == "inkling"


def test_three_layer_whitelists_derived_from_seed_data():
    """三层白名单与 seed_data 同源（防数据与白名单双源漂移）。"""
    recipe = _build_recipe()
    ui_spec = load_seed("ui_spec.json")
    manifest = json.loads((SEED_ROOT / "manifest.json").read_text(encoding="utf-8"))

    # 组件白名单 = manifest 渲染组件清单（全量覆盖 ui_spec 组件类型）
    assert set(recipe.ui_allowed_components) == set(
        manifest["contracts"]["renderer_components"]
    )

    # 主题 token 白名单 = ui_spec.theme 键
    assert set(recipe.ui_allowed_theme_tokens) == set(ui_spec["theme"])

    # 绑定通道白名单 = ui_spec bind 通道 ∪ 事件名 ∪ inspect 五元
    channels = set(recipe.ui_allowed_channels)
    for event in load_seed("event_types.json")["events"]:
        assert f"events.{event['name']}" in channels
    for inspect in (
        "inspect_graph",
        "inspect_rules",
        "inspect_knowledge",
        "inspect_ui",
        "inspect_tools",
    ):
        assert inspect in channels
    assert "state" in channels


def test_ui_spec_passes_three_layer_validation():
    """ui_spec 经三层白名单校验零违规（损坏回落是兜底，基线必须合法）。"""
    recipe = _build_recipe()
    violations = UISchemaValidator().validate(
        recipe.ui_spec,
        allowed_components=recipe.ui_allowed_components,
        allowed_channels=recipe.ui_allowed_channels,
        allowed_theme_tokens=recipe.ui_allowed_theme_tokens,
    )
    assert violations == []


def test_approval_levels_tool_l2_for_mount():
    """挂载类工具强制 L2（propose_mcp_mount 语义 → TOOL 补丁分级表）。"""
    recipe = _build_recipe()
    assert recipe.approval_levels[PatchKind.TOOL].value == "L2"
    assert recipe.approval_levels[PatchKind.THEME].value == "L0"
    assert recipe.approval_levels[PatchKind.ARTIFACT].value == "L2"


async def test_boot_assembly_loop(booted):
    """boot 装配闭环：种子/harness/事件类型/界面基线/工具表/引擎齐备。"""
    runtime, _host, mount_service = booted

    assert runtime.state.value == "running"
    assert runtime.storage is not None
    assert runtime.engine is not None
    assert runtime.self_pipeline is not None

    # 领域种子直注（knowledge.json + templates.json 条目幂等注入）
    for entry_id in (
        "seed.inkling.domain_guide",
        "seed.inkling.template.research_incubation",
        "seed.inkling.source_credibility",
    ):
        assert runtime.knowledge_set.get(entry_id) is not None, entry_id

    # harness 自举定义注册 + 仓库落库
    assert "inkling.research" in runtime.harness_registry.names()

    # 事件类型基线登记（事件流绑定通道的数据来源）
    names = runtime.event_type_registry.names()
    for event in (
        "reply_token",
        "plan_start",
        "review_card",
        "simulate_decision",
        "device_sensed",
    ):
        assert event in names

    # 领域工具进统一工具表（tools.json 声明式数据形态）
    for spec in domain_tool_specs():
        assert spec.name in runtime.tool_registry

    # 出厂零预挂：无任何 MCP 会话，无 mcp 端点工具
    assert runtime.mcp_manager.list_servers() == []
    assert mount_service.mounted_servers == ()


async def test_ui_spec_survives_boot_and_inspectable(booted):
    """ui_spec 存活断言：装配期校验通过 → 内省快照可查（inspect_ui 五元之一）。"""
    runtime, _host, _mount_service = booted
    ui_spec = load_seed("ui_spec.json")

    snapshot = runtime.introspection_service.snapshot("inspect_ui", {})
    assert snapshot["ui_spec"] == ui_spec

    graph_snapshot = runtime.introspection_service.snapshot("inspect_graph", {})
    assert graph_snapshot["graph"]["entry"] == "research_orchestrator"
    assert "collect_material" in graph_snapshot["graph"]["nodes"]

    tools_snapshot = runtime.introspection_service.snapshot("inspect_tools", {})
    assert tools_snapshot["count"] >= 20


async def test_round_default_plan_graceful(booted):
    """回合默认研究规划：未挂载执行件时工具调用降级为明确失败（不崩溃）。"""
    runtime, host, _mount_service = booted
    offset = len(host.events)

    result = await runtime.engine.ainvoke(
        {"input": "研究墨引擎机制"},
        thread_id="boot-round-1",
        round_id="round-boot-1",
        transports=[host.build_transport()],
    )
    events = list(host.events[offset:])
    assert result.reason == "reply"
    assert any(e.type == "plan_start" for e in events)
    tool_ends = [e for e in events if e.type == "tool_end"]
    assert len(tool_ends) == 6  # workflow 六步骤各执行一次
    assert all(e.payload["success"] is False for e in tool_ends)  # 未挂载 → 降级路径
    assert result.state.get("results")  # 六步结果回填状态通道


async def test_round_with_mounted_exec_full_loop(booted, approval_ctx):
    """挂载 inkling_exec（嵌入式 server）→ 回合计划六步全绿（统一流水线闭环）。"""
    runtime, host, mount_service = booted
    ctx = approval_ctx()
    from fixtures.mcp_fixture_server import build_server
    from ink_engine.core.mcp_client import McpServerConfig, McpTransport

    from host.mcp_service import in_memory_server_factory

    config = McpServerConfig(
        id="inkling_exec",
        transport=McpTransport.IN_MEMORY,
        source="model",
    )
    outcome = await mount_service.mount_config(
        ctx, config, server_factory=in_memory_server_factory(build_server())
    )
    assert outcome.ok, outcome.error
    assert outcome.status == "mounted"
    assert "collect_material" in outcome.tool_names

    offset = len(host.events)
    result = await runtime.engine.ainvoke(
        {
            "input": "研究墨引擎机制",
            "step_args": {"collect_material": {"text": "墨引擎机制概览"}},
        },
        thread_id="boot-round-2",
        round_id="round-boot-2",
        transports=[host.build_transport()],
    )
    events = list(host.events[offset:])
    assert result.reason == "reply"
    tool_ends = [e for e in events if e.type == "tool_end"]
    assert len(tool_ends) == 6
    assert all(e.payload["success"] for e in tool_ends)
    assert result.state["results"]["distill_knowledge"].startswith("{")

    # 挂载留痕：补丁链已推进（7 工具挂载补丁落链）
    chain_version = await runtime.self_pipeline.chain.current_version()
    assert chain_version > 1

    # 回退卸载：工具表移除 + 会话断开（可回退断言在 MCP 用例细化）
    unmounted = await mount_service.unmount(ctx, "inkling_exec")
    assert unmounted.ok, unmounted.error
    assert "collect_material" not in runtime.tool_registry
    assert "inkling_exec" not in runtime.mcp_manager.list_servers()


def test_graph_recipe_uses_seed_data():
    """图配方 = graph.json + workflow.json 实例化（节点类型注册数据形态）。"""
    from helpers import build_ctx, domain_tool_specs
    from ink_engine.core.registry import GraphRegistries

    from host.graph_recipe import (
        TYPE_ORCHESTRATOR,
        TYPE_TOOL_PIPELINE,
        build_round_graph,
    )

    registries = GraphRegistries()
    graph = build_round_graph(
        build_ctx(pipeline=None, tool_specs=domain_tool_specs(), registries=registries),
        graph_data=load_seed("graph.json"),
        workflow_data=load_seed("workflow.json"),
    )
    assert graph.entry == "research_orchestrator"
    assert set(graph.node_bindings) == {
        "research_orchestrator",
        "tool_pipeline",
        "end",
        "collect_material",
        "parse_material",
        "validate_material",
        "score_material",
        "review_material",
        "distill_knowledge",
    }
    assert graph.node_bindings["research_orchestrator"].type_name == TYPE_ORCHESTRATOR
    assert graph.node_bindings["collect_material"].type_name == TYPE_TOOL_PIPELINE
    assert "end" in graph.exits
    graph.resolve_types(registries.nodes)
    digest = graph.compile().graph.digest()
    assert len(digest) == 64
