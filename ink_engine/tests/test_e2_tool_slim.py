"""工具注入瘦身单测：保底工具集 + 工具向量索引 + 自指检索/绑定。

覆盖：
- collect_specs 保底 10（≤12）完整 schema 进 tools 参数
- 工具向量索引构建（全量 merged_specs → 向量/关键词基线）
- search_tools 检索行为（关键词降级 + 向量优先）
- request_tool 绑定/非法名校验
- 工具注册表增量刷新（MCP 挂载/补丁链工具）
- 工具调配器保底加成（baseline_names priority 高 + weight 倍率）
"""
from __future__ import annotations

import json
from typing import Any

from ink_engine.core.event_types import EventTypeSpec
from ink_engine.core.harness import HarnessDefinition
from ink_engine.core.llm.tools import ToolSpec
from ink_engine.core.self_application import ApprovalLevel, SelfApplicationPipeline
from ink_engine.core.self_proposal import PatchKind, ProposalValidator
from ink_engine.core.self_tools import SelfToolContext, make_self_executor, self_tool_specs
from ink_engine.core.storage import create_storage
from ink_engine.core.tool_index import ToolVectorIndex
from ink_engine.core.tool_orchestrator import ToolCandidate, ToolSelector
from ink_engine.seeds.boot import BOOT_UI_SPEC, build_boot_seed_entries


def _spec(name: str, description: str = "") -> ToolSpec:
    return ToolSpec(name=name, description=description, parameters={})


class _StubCtx:
    def __init__(self, round_id: str = "r-e2") -> None:
        self.round_id = round_id


class FakeHost:
    def __init__(self) -> None:
        self.calls = []

    async def create_storage(self) -> Any:
        self.calls.append("create_storage")
        return create_storage("memory://")

    async def resolve_llm(self) -> Any:
        self.calls.append("resolve_llm")
        return None

    def interrupt_policy(self) -> Any:
        self.calls.append("interrupt_policy")
        from ink_engine.core.approval import DefaultInterruptPolicy
        return DefaultInterruptPolicy()

    def build_transport(self) -> Any:
        self.calls.append("build_transport")
        from ink_engine.core.events import CollectorTransport
        return CollectorTransport()

    async def close(self) -> None:
        self.calls.append("host_close")


async def _echo_agent(ctx) -> dict:
    await ctx.emit("reply_token", {"token": "ok"}, step_id="reply:1")
    return {"reply": "ok"}


def _echo_graph_recipe(ctx):
    from ink_engine.core.graph import Graph
    g = Graph(name="echo", entry="agent")
    g.add_node("agent", _echo_agent)
    g.add_exit("agent")
    return g


def _minimal_recipe(**overrides):
    import dataclasses

    from ink_engine.core.runtime import AssemblyRecipe, ToolWiring

    base = AssemblyRecipe(
        set_id="default",
        seeds=[("boot", build_boot_seed_entries)],
        harness_definitions=[
            HarnessDefinition(name="forge", description="自举领域", keywords=("自举",))
        ],
        event_type_specs=[EventTypeSpec(name="reply_token", renderer="StreamingRow")],
        ui_spec=BOOT_UI_SPEC,
        ui_allowed_components=("column", "message_list", "agent_input"),
        ui_allowed_theme_tokens=("bg", "fg", "accent"),
        tool_wiring=ToolWiring(
            self_specs=self_tool_specs,
            self_executor_factory=make_self_executor,
            self_operation_of=lambda spec: ("propose", "patch"),
        ),
        approval_levels={PatchKind.THEME: ApprovalLevel.L0},
        graph_recipe=_echo_graph_recipe,
    )
    return dataclasses.replace(base, **overrides)


# ── 1. collect_specs 保底 10（≤12）完整 schema ──


async def test_collect_specs_baseline_count_and_limit():
    from ink_engine.core.runtime import Runtime
    host = FakeHost()
    runtime = await Runtime().boot(host, _minimal_recipe())
    # 模拟声明式工具注册（生产环境由 harness 定义载入）
    for name in ("file_read", "file_write", "file_edit", "grep", "glob"):
        runtime.tool_registry[name] = ToolSpec(name=name, description=f"{name} 工具")
    specs = runtime.collect_specs()
    names = {s.name for s in specs}
    assert len(specs) == 10
    assert names == {
        "file_read", "file_write", "file_edit", "grep", "glob",
        "propose_patch", "propose_domain_manifest", "inspect_tools",
        "search_tools", "request_tool",
    }
    # 预算护栏：保底集永不超 12
    assert len(specs) <= 12
    await host.close()


# ── 2. 工具向量索引构建（链恢复后、引擎重建前） ──


async def test_tool_index_built_after_restore_before_rebuild():
    from ink_engine.core.runtime import Runtime
    host = FakeHost()
    runtime = await Runtime().boot(host, _minimal_recipe())
    # 工具索引已在 boot 中构建
    assert runtime.tool_index is not None
    # 全量 merged_specs 已入索引
    merged_names = {s.name for s in runtime.merged_specs()}
    assert merged_names == {e.spec.name for e in runtime.tool_index._entries.values()}
    # 工具调配器已接线
    assert runtime.tool_selector is not None
    assert runtime.tool_selector.max_tools == 12
    await host.close()


# ── 3. request_tool 非法名校验 ──


async def test_request_tool_rejects_illegal_name():
    storage = create_storage("memory://")
    _, executor, _context = _make_self_env(storage)
    specs = {s.name: s for s in self_tool_specs()}
    ctx = _StubCtx()
    result = await executor(
        ctx, specs["request_tool"], {"name": "no_such_tool_xyz"}, None
    )
    data = json.loads(result)
    assert data["ok"] is False
    assert "未注册工具名 no_such_tool_xyz" in data["error"]


# ── 4. MCP 挂载增量刷新索引 ──


async def test_mcp_mount_incremental_refresh():
    from ink_engine.core.runtime import Runtime
    host = FakeHost()
    runtime = await Runtime().boot(host, _minimal_recipe())
    before = len(runtime.tool_index)
    runtime.tool_registry["mcp_new_tool"] = _spec("mcp_new_tool", "MCP 新挂载工具")
    runtime.refresh_tool_index()
    after = len(runtime.tool_index)
    assert after == before + 1
    assert runtime.tool_index.has("mcp_new_tool")
    assert runtime.tool_index.spec("mcp_new_tool").name == "mcp_new_tool"
    await host.close()


# ── 5. 无嵌入器降级关键词基线 ──


async def test_keyword_fallback_without_embedder():
    specs = [
        _spec("file_read", "读取文件内容"),
        _spec("file_write", "写入文件"),
        _spec("grep", "搜索文本"),
    ]
    index = ToolVectorIndex(embedder=None)
    index.build(specs)
    assert not index.uses_vectors()
    results = index.search("读文件", limit=2)
    assert len(results) > 0
    assert results[0].name == "file_read"
    assert results[0].score > 0


# ── 6. 工具调配器保底加成 ──


async def test_tool_selector_baseline_boost():
    baseline = {"file_read", "search_tools"}
    selector = ToolSelector(max_tools=3, baseline_names=baseline)
    candidates = [
        ToolCandidate(spec=_spec("file_read", "读取文件"), relevance=0.3, weight=1.0, priority=1),
        ToolCandidate(spec=_spec("search_tools", "检索工具"), relevance=0.3, weight=1.0, priority=1),
        ToolCandidate(spec=_spec("other_tool", "其他工具"), relevance=0.9, weight=1.0, priority=1),
    ]
    selected = selector.select(candidates)
    names = [s.name for s in selected]
    # 保底工具因 priority boost 应优先入选
    assert "file_read" in names
    assert "search_tools" in names


# ── 7. search_tools 返回格式 + degraded 标记 ──


async def test_search_tools_returns_degraded_without_vectors():
    storage = create_storage("memory://")
    _, executor, context = _make_self_env(storage)
    # 注入无嵌入器索引
    context.tool_index = ToolVectorIndex(embedder=None)
    context.tool_index.build([*self_tool_specs(), _spec("extra_tool", "额外工具")])
    specs = {s.name: s for s in self_tool_specs()}
    ctx = _StubCtx()
    result = await executor(ctx, specs["search_tools"], {"query": "检索工具"}, None)
    data = json.loads(result)
    assert data["ok"] is True
    assert data["degraded"] is True
    assert len(data["results"]) <= 8
    assert all("name" in r and "tier" in r for r in data["results"])


# ── 8. request_tool 合法绑定返回完整 schema ──


async def test_request_tool_binds_and_returns_spec():
    storage = create_storage("memory://")
    _, executor, context = _make_self_env(storage)
    context.tool_index = ToolVectorIndex(embedder=None)
    context.tool_index.build(self_tool_specs())
    specs = {s.name: s for s in self_tool_specs()}
    ctx = _StubCtx()
    result = await executor(ctx, specs["request_tool"], {"name": "search_tools"}, None)
    data = json.loads(result)
    assert data["ok"] is True
    assert data["message"] == "已绑定 search_tools，可调用"
    assert data["spec"]["name"] == "search_tools"
    assert "parameters" in data["spec"]


# ── 内部辅助 ──


def _make_self_env(storage):
    validator = ProposalValidator(
        allowed_components=("column", "message_list", "agent_input"),
        allowed_channels=("state",),
        allowed_theme_tokens=("bg", "fg", "accent"),
    )
    pipeline = SelfApplicationPipeline(
        storage,
        validator=validator,
        approval_levels={PatchKind.THEME: ApprovalLevel.L0},
    )
    context = SelfToolContext(self_pipeline=pipeline)
    executor = make_self_executor(pipeline, lambda: context)
    return pipeline, executor, context
