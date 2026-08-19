"""harness 声明式定义单测：集内激活/注册表重建/仓库补丁链版本回退。

语义检查点：harness = 用户集内能力包（图定义数据 + 工具清单 + 能力
描述 + 可选编排模板），定义即数据、注册即插拔；集内激活 = 任务描述
→ 集内相关度裁剪（无跨集选择）；仓库版本 = 补丁链（append-only 可
回退——回退 = 组装到指定版本，非物理删除）。
"""
from __future__ import annotations

import pytest
from conftest import make_engine

from ink_engine.core.declarative_tools import DeclarativeToolSpec, EndpointType
from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.graph import Graph, TerminateReason
from ink_engine.core.harness import (
    HarnessDefinition,
    HarnessRegistry,
    HarnessRepository,
)
from ink_engine.core.llm.tools import ToolSpec
from ink_engine.core.registry import GraphRegistries, NodeTypeRegistry


def _registry() -> GraphRegistries:
    nodes = NodeTypeRegistry()

    def write_factory(config: dict):
        async def node(ctx):
            return {"seen": [*ctx.state.get("seen", []), config.get("tag", "write")]}
        return node

    nodes.register("write", write_factory)
    return GraphRegistries(nodes=nodes)


def _harness(
    name: str = "plotter",
    keywords=("推演", "大纲"),
    description: str | None = None,
) -> HarnessDefinition:
    graph = Graph(name=name, entry="w1")
    graph.add_node_type("w1", "write", {"tag": name})
    graph.add_exit("w1")
    graph.resolve_types(_registry().nodes)
    return HarnessDefinition(
        name=name,
        description=description or f"{name} 能力包",
        keywords=keywords,
        graph=graph.to_dict(),
        tools=[
            {
                "name": f"{name}_tool",
                "description": "工具",
                "parameters": {},
                "permissions": ["process:exec:git"],
                "endpoint": "process_exec",
                "endpoint_config": {"allowlist": ["git"]},
            }
        ],
        schema={"channels": {"seen": None}},
        default_plan={"steps": [{"nodes": ["w1"]}], "index": 0},
        meta={"source": "seed"},
    )


def test_definition_round_trip():
    """harness 定义数据往返（导出/导入形态，字段完整）。"""
    definition = _harness()
    rebuilt = HarnessDefinition.from_dict(definition.to_dict())
    assert rebuilt.name == "plotter"
    assert rebuilt.keywords == ("推演", "大纲")
    assert rebuilt.graph is not None and rebuilt.graph["name"] == "plotter"
    assert rebuilt.tools[0]["endpoint"] == "process_exec"
    assert rebuilt.default_plan is not None
    assert rebuilt.meta == {"source": "seed"}


def test_registry_builds_graph_and_tools():
    """注册表重建：图/工具/schema 从定义数据还原（注册即可用）。"""
    registry = HarnessRegistry(registries=_registry())
    registry.register(_harness())
    graph = registry.build_graph("plotter")
    assert graph is not None and graph.entry == "w1"
    tools = registry.build_tools("plotter")
    assert [t.name for t in tools] == ["plotter_tool"]
    assert isinstance(tools[0], ToolSpec)
    schema = registry.build_schema("plotter")
    assert schema is not None and "seen" in schema.channels


async def test_registry_graph_runs_end_to_end(memory_storage):
    """注册表重建的图可直接执行（图定义数据 → 注册表解析 → 引擎联跑）。"""
    registry = HarnessRegistry(registries=_registry())
    registry.register(_harness())
    graph = registry.build_graph("plotter")
    engine = make_engine(graph, storage=memory_storage)
    state, result = await engine._execute(
        state={}, thread_id="t1", round_id=None, resume_from=None,
        trace_id="trace", queue=None,
    )
    assert result.reason == TerminateReason.REPLY
    assert state["seen"] == ["plotter"]


def test_route_activation_within_set():
    """集内激活：任务描述 → 相关度激活清单（降序 + 阈值过滤）。"""
    registry = HarnessRegistry(registries=_registry())
    registry.register(_harness(name="plotter", keywords=("推演", "大纲")))
    registry.register(_harness(name="editor", keywords=("润色", "修改")))
    activated = registry.route("帮我推演一下这个大纲走向，然后润色一下")
    assert activated[0][0] == "plotter"  # 相关度最高者居首
    assert activated[0][1] > activated[1][1]
    assert {name for name, _ in activated} == {"plotter", "editor"}
    assert registry.route("完全无关的任务") == []


def test_route_custom_matcher():
    """自定义激活匹配器可注入（换匹配器不改装配）。"""
    registry = HarnessRegistry(
        registries=_registry(),
        matcher=lambda task, definition: 1.0 if definition.name in task else 0.0,
    )
    registry.register(_harness())
    assert registry.route("请 plotter 处理")[0][0] == "plotter"
    assert registry.route("别的任务") == []


def test_route_threshold_configurable():
    """激活阈值可配：低于阈值的弱相关能力包不激活。"""
    registry = HarnessRegistry(registries=_registry())
    registry.register(_harness(keywords=("推演", "大纲")))
    assert registry.route("推演", threshold=0.5)[0][0] == "plotter"
    assert registry.route("推演", threshold=0.8) == []  # 只命中 1/2 关键词，低于阈值


async def test_repository_versioning_and_rollback(memory_storage):
    """仓库版本链：新版本 append、历史保留、回退 = 组装到指定版本。"""
    repo = HarnessRepository(memory_storage)
    v1 = await repo.save(_harness(description="v1 描述"))
    v2 = await repo.save(_harness(description="v2 描述"), note="调整")
    assert (v1, v2) == (1, 2)

    current = await repo.get("plotter")
    assert current is not None and current.description == "v2 描述"
    rolled_back = await repo.get("plotter", version=1)
    assert rolled_back is not None and rolled_back.description == "v1 描述"

    versions = await repo.versions("plotter")
    assert [v.version for v in versions] == [1, 2]
    assert versions[1].note == "调整"

    # 越界版本/不存在 harness → None
    assert await repo.get("plotter", version=99) is None
    assert await repo.get("ghost") is None


async def test_repository_versions_keep_history(memory_storage):
    """多版本演进后旧版本数据完整可回退（append-only 不物理删除）。"""
    repo = HarnessRepository(memory_storage)
    await repo.save(_harness(description="初版"))
    await repo.save(_harness(description="二版"))
    await repo.save(_harness(description="三版"))
    assert (await repo.get("plotter", version=1)).description == "初版"
    assert (await repo.get("plotter", version=2)).description == "二版"
    assert (await repo.get("plotter", version=3)).description == "三版"


async def test_repository_list_latest(memory_storage):
    """仓库列表返回各能力包最新版本。"""
    repo = HarnessRepository(memory_storage)
    await repo.save(_harness(name="a", description="a1"))
    await repo.save(_harness(name="a", description="a2"))
    await repo.save(_harness(name="b", description="b1"))
    definitions = await repo.list()
    by_name = {d.name: d for d in definitions}
    assert set(by_name) == {"a", "b"}
    assert by_name["a"].description == "a2"  # 最新版本
    assert by_name["b"].description == "b1"


def test_register_rejects_invalid_graph_data():
    """注册即校验：非法图定义数据在注册期拒绝（回归 P1-5 接线）。

    修复前 register 只存定义，悬挂出口/边源缺失的 LLM 生成图定义
    延后到执行期才暴露（spawn 子图 compile 失败被剔除 → 静默降级）。
    """
    registry = HarnessRegistry(registries=_registry())
    graph = Graph(name="bad", entry="w1")
    graph.add_node_type("w1", "write", {"tag": "x"})
    graph.add_exit("w1")
    graph.resolve_types(_registry().nodes)
    data = graph.to_dict()
    data["exits"] = ["w1", "ghost"]  # 悬挂出口
    with pytest.raises(GraphDefinitionError, match="节点不存在"):
        registry.register(_harness().from_dict({**_harness().to_dict(), "graph": data}))


def test_register_rejects_invalid_default_plan():
    """注册即校验：默认编排模板引用未知节点在注册期拒绝（不落到执行期）。"""
    from ink_engine.core.plan import Plan  # noqa: F401  （校验路径引用）

    registry = HarnessRegistry(registries=_registry())
    definition = _harness()
    data = definition.to_dict()
    data["default_plan"] = {"steps": [{"nodes": ["ghost_plan_node"]}]}
    with pytest.raises(GraphDefinitionError, match="未知节点"):
        registry.register(HarnessDefinition.from_dict(data))

    # 无图定义却带编排模板 = 模板无处可执行，同样拒绝
    bare = HarnessDefinition(
        name="bare",
        description="无图",
        keywords=(),
        graph=None,
        tools=(),
        default_plan={"steps": [{"nodes": ["w1"]}]},
    )
    with pytest.raises(GraphDefinitionError, match="要求 graph 定义"):
        registry.register(bare)


def test_build_tools_registers_definitions():
    """build_tools 登记副作用：声明式定义登记进执行体注册表（分发反查）。"""
    registry = HarnessRegistry(registries=_registry())
    registry.register(_harness())
    registry.build_tools("plotter")
    registered = registry.declarative.definitions
    assert "plotter_tool" in registered
    assert isinstance(registered["plotter_tool"], DeclarativeToolSpec)
    assert registered["plotter_tool"].endpoint.value == "process_exec"


async def test_build_pipeline_runs_declarative_tool(memory_storage):
    """harness 声明式工具经 build_pipeline 走完整流水线（轻路径接线）。

    回归 P1-1：修复前 harness 工具定义无法执行（to_spec 丢端点、无生产
    注册桥）；build_pipeline 装配 extractor（端点推导）+ executor（分发）
    后声明式工具过门禁/沙箱/执行全环节。
    """
    from ink_engine.core.permissions import PermissionGate
    from ink_engine.core.sandbox import ProcessSandbox

    registry = HarnessRegistry(registries=_registry())
    registry.register(_harness())
    calls: list[str] = []

    async def process_executor(ctx, defn, args, approval):
        calls.append(defn.name)
        return "git status"

    registry.declarative.register(EndpointType.PROCESS_EXEC, process_executor)
    pipeline = registry.build_pipeline(
        "plotter",
        gate=PermissionGate(),
        sandboxes=(ProcessSandbox(allowlist=("git",)),),
    )

    class Ctx:
        async def emit(self, *args, **kwargs):
            pass

    spec = ToolSpec(
        name="plotter_tool",
        permissions=("process:exec:git",),
        parameters={"type": "object", "properties": {"command": {"type": "string"}}},
    )
    result = await pipeline.execute(Ctx(), spec, {"command": "git"})
    assert result.ok is True
    assert result.output == "git status"
    assert calls == ["plotter_tool"]
    # 目标推导失败（缺 command）→ fail-closed 拒绝（P0-4 语义贯通）
    denied = await pipeline.execute(Ctx(), spec, {})
    assert denied.ok is False
    assert "无法判定目标" in (denied.error or "")
