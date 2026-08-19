"""自指层观察原语单测：内省服务快照正确性 + 元工具注册与流水线门禁。

覆盖：工具描述注册形态（权限声明）、图/规则/知识/界面/工具表五路
快照（恒定信封、函数直挂节点降级视图、默认严重度补全、深拷贝）、
流水线执行（只读判定直过、敏感键剥离）、权限缺失拒绝（fail-closed）、
未知工具名拒绝、limit 钳制、五路快照 JSON 可序列化。
"""
from __future__ import annotations

import json

import pytest

from ink_engine.core.graph import Graph
from ink_engine.core.harness import HarnessDefinition, HarnessRegistry
from ink_engine.core.introspection import (
    INTROSPECTION_PERMISSION,
    IntrospectionService,
    IntrospectionSources,
    build_introspection_pipeline,
    introspection_tool_specs,
)
from ink_engine.core.knowledge_set import (
    KIND_RULE,
    LEVEL_USER,
    KnowledgeEntry,
    KnowledgeSet,
)
from ink_engine.core.llm.tools import ToolSpec, to_openai_tools
from ink_engine.core.rules import Rule
from ink_engine.core.tool_pipeline import DENY

INTROSPECTION_TOOL_NAMES = (
    "inspect_graph",
    "inspect_rules",
    "inspect_knowledge",
    "inspect_ui",
    "inspect_tools",
)


def _data_graph() -> Graph:
    """类型化图（节点注册类型名，可序列化为图定义数据）。"""
    g = Graph(name="intro", entry="start")
    g.add_node_type("start", "start", {"prompt": "你好"})
    g.add_node_type("mid", "mid", {})
    g.add_edge("start", "mid")
    g.add_exit("mid")
    return g


def _function_graph() -> Graph:
    """函数直挂节点图（不可序列化，观察时须回退降级视图）。"""

    async def start(ctx):
        return {}

    g = Graph(name="fn", entry="start")
    g.add_node("start", start)
    g.add_exit("start")
    return g


def _knowledge_set(storage) -> KnowledgeSet:
    """真实规则形态夹具：经 Rule.to_dict 产出的声明数据（默认级省略
    severity 键是引擎序列化语义，快照须补全而非呈现 null）。"""
    ks = KnowledgeSet("u1", storage=storage)
    default_rule = Rule(
        id="rule-1",
        predicate="motive_consistent",
        config={"motive_path": "motive"},
        description="主角行为须与既定动机一致",
    )
    warning_rule = Rule(
        id="rule-2",
        predicate="foreshadow_paired",
        config={"chain_path": "foreshadows"},
        severity="warning",
        description="伏笔须有回收",
    )
    ks.add(
        KnowledgeEntry(
            id="rule-1",
            level=LEVEL_USER,
            kind=KIND_RULE,
            title="主角动机一致",
            data={"rule": default_rule.to_dict()},
            source="model",
        )
    )
    ks.add(
        KnowledgeEntry(
            id="rule-2",
            level=LEVEL_USER,
            kind=KIND_RULE,
            title="伏笔回收",
            data={"rule": warning_rule.to_dict()},
            source="model",
        )
    )
    ks.add(
        KnowledgeEntry(
            id="entry-1",
            level=LEVEL_USER,
            kind="template",
            title="章节模板",
            data={"steps": []},
            source="dialog",
        )
    )
    return ks


def _service(storage=None, graph=None, registry=None) -> IntrospectionService:
    tools = introspection_tool_specs()
    return IntrospectionService(
        IntrospectionSources(
            graph=graph,
            knowledge_set=_knowledge_set(storage) if storage is not None else None,
            harness_registry=registry,
            tools=tools,
            ui_spec={"layout": "panel"},
        )
    )


def test_tool_specs_registration_shape() -> None:
    specs = introspection_tool_specs()
    assert len(specs) == 5
    assert tuple(spec.name for spec in specs) == INTROSPECTION_TOOL_NAMES
    for spec in specs:
        assert spec.permissions == (INTROSPECTION_PERMISSION,)
        assert isinstance(spec.parameters, dict)
        assert isinstance(spec.description, str) and spec.description


def test_snapshot_graph_data_form(memory_storage) -> None:
    service = _service(memory_storage, graph=_data_graph())
    snapshot = service.snapshot_graph()
    assert set(snapshot) == {"graph", "digest"}
    graph = snapshot["graph"]
    assert graph["name"] == "intro"
    assert graph["entry"] == "start"
    assert "start" in graph["nodes"]
    assert graph["edges"]["start"][0]["target"] == "mid"
    assert "mid" in graph["exits"]
    assert isinstance(snapshot["digest"], str) and snapshot["digest"]


def test_snapshot_graph_empty_envelope(memory_storage) -> None:
    service = _service(memory_storage, graph=None)
    assert service.snapshot_graph() == {"graph": None, "digest": None}


def test_snapshot_graph_function_node_degraded(memory_storage) -> None:
    # 函数直挂节点不可序列化——内省回退为降级视图并显式标记，而非抛错
    service = _service(memory_storage, graph=_function_graph())
    snapshot = service.snapshot_graph()
    graph = snapshot["graph"]
    assert graph["name"] == "fn"
    assert graph["nodes"]["start"] == {"type": "function"}
    assert graph["degraded"] is True
    assert graph["degraded_reason"]
    assert snapshot["digest"]


def test_snapshot_graph_subgraph_recursive_degraded(memory_storage) -> None:
    # 降级视图递归呈现子图内部结构（子图节点不混入 nodes）
    parent = Graph(name="parent", entry="root")

    async def root(ctx):
        return {}

    parent.add_node("root", root)
    parent.add_exit("root")
    child = _data_graph()
    parent.add_subgraph("child", child)
    service = _service(memory_storage, graph=parent)
    snapshot = service.snapshot_graph()
    graph = snapshot["graph"]
    assert graph["degraded"] is True
    assert graph["nodes"]["root"] == {"type": "function"}
    assert "child" not in graph["nodes"]
    sub = graph["subgraphs"]["child"]
    assert sub["name"] == "intro"
    assert "start" in sub["nodes"]


def test_snapshot_rules(memory_storage) -> None:
    service = _service(memory_storage, graph=_data_graph())
    snapshot = service.snapshot_rules()
    assert snapshot["count"] == 2
    by_id = {rule["id"]: rule for rule in snapshot["rules"]}
    # 默认级省略 severity 键的声明数据补全为 error，而非 null
    assert by_id["rule-1"]["severity"] == "error"
    assert by_id["rule-2"]["severity"] == "warning"
    assert by_id["rule-1"]["description"] == "主角行为须与既定动机一致"


def test_snapshot_knowledge_counts_and_limit(memory_storage) -> None:
    service = _service(memory_storage, graph=_data_graph())
    snapshot = service.snapshot_knowledge()
    assert snapshot["count"] == 3
    assert snapshot["by_kind"] == {"rule": 2, "template": 1}
    assert snapshot["by_level"] == {LEVEL_USER: 3}
    titles = {item["title"] for item in snapshot["entries"]}
    assert titles == {"主角动机一致", "伏笔回收", "章节模板"}
    limited = service.snapshot_knowledge(limit=1)
    assert len(limited["entries"]) == 1


def test_snapshot_knowledge_limit_clamped(memory_storage) -> None:
    # 负值/越界 limit 不静默失真：钳制到 [1, 100]，越界取声明上限
    service = _service(memory_storage, graph=_data_graph())
    negative = service.snapshot_knowledge(limit=-3)
    assert len(negative["entries"]) == 1
    huge = service.snapshot_knowledge(limit=10_000)
    assert len(huge["entries"]) == 3


def test_snapshot_ui(memory_storage) -> None:
    service = _service(memory_storage, graph=_data_graph())
    snapshot = service.snapshot_ui()
    assert snapshot["ui_spec"] == {"layout": "panel"}
    # 快照是观察数据：改写返回结果不得反写引擎源数据
    snapshot["ui_spec"]["layout"] = "mutated"
    assert service.snapshot_ui()["ui_spec"]["layout"] == "panel"


def test_snapshot_tools_includes_harness(memory_storage) -> None:
    registry = HarnessRegistry()
    registry.register(
        HarnessDefinition(name="novel", description="小说领域", keywords=("小说",))
    )
    service = _service(memory_storage, graph=_data_graph(), registry=registry)
    snapshot = service.snapshot_tools()
    assert snapshot["count"] == 5
    assert "inspect_graph" in {tool["name"] for tool in snapshot["tools"]}
    assert snapshot["harnesses"] == ["novel"]
    assert snapshot["tools"][0]["permissions"] == [INTROSPECTION_PERMISSION]


def test_snapshot_dispatch_unknown_rejected(memory_storage) -> None:
    service = _service(memory_storage, graph=_data_graph())
    with pytest.raises(ValueError, match="未知内省工具"):
        service.snapshot("inspect_nothing", {})


async def test_pipeline_execute_returns_json_snapshot(memory_storage) -> None:
    service = _service(memory_storage, graph=_data_graph())
    pipeline = build_introspection_pipeline(service)
    spec = introspection_tool_specs()[0]
    result = await pipeline.execute(None, spec, {})
    assert result.ok is True
    assert result.decision == "allow"
    data = json.loads(result.output)
    assert data["graph"]["name"] == "intro"


async def test_pipeline_strips_sensitive_keys(memory_storage) -> None:
    # 快照出口统一剥离：节点 config 携带的凭据绝不进入模型上下文
    graph = _data_graph()
    graph.add_node_type(
        "llm", "llm", {"api_key": "sk-LIVE-SECRET", "model_id": "m1"}
    )
    service = _service(memory_storage, graph=graph)
    pipeline = build_introspection_pipeline(service)
    result = await pipeline.execute(None, introspection_tool_specs()[0], {})
    assert result.ok is True
    output = json.loads(result.output)
    config = output["graph"]["nodes"]["llm"]["config"]
    assert config["api_key"] == ""
    assert "sk-LIVE-SECRET" not in result.output


def test_all_snapshots_json_serializable(memory_storage) -> None:
    # 五路快照均为确定性 JSON 数据（工具流水线输出契约）
    service = _service(memory_storage, graph=_function_graph())
    for name in INTROSPECTION_TOOL_NAMES:
        snapshot = service.snapshot(name, {})
        json.dumps(snapshot, ensure_ascii=False)


def test_to_openai_tools_conversion() -> None:
    # 工具表注册契约：内省工具描述可转换为 OpenAI 工具 schema
    converted = to_openai_tools(list(introspection_tool_specs()))
    assert len(converted) == 5
    assert {tool["function"]["name"] for tool in converted} == set(
        INTROSPECTION_TOOL_NAMES
    )


async def test_pipeline_denies_without_permission(memory_storage) -> None:
    # 未声明内省权限的工具经同一流水线被拒绝（fail-closed）
    service = _service(memory_storage, graph=_data_graph())
    pipeline = build_introspection_pipeline(service)
    bare = ToolSpec(name="inspect_graph", description="无权限声明", parameters={})
    result = await pipeline.execute(None, bare, {})
    assert result.ok is False
    assert result.decision == DENY


async def test_pipeline_audits_execution(memory_storage) -> None:
    # 审计留痕：成功调用与拒绝调用都应经 audit 通道记录
    service = _service(memory_storage, graph=_data_graph())
    records: list[dict] = []
    pipeline = build_introspection_pipeline(service)
    pipeline.audit = lambda _ctx, record: records.append(record)
    ok_spec = introspection_tool_specs()[0]
    await pipeline.execute(None, ok_spec, {})
    deny_spec = ToolSpec(name="inspect_graph", description="无权限声明", parameters={})
    await pipeline.execute(None, deny_spec, {})
    assert [r["decision"] for r in records] == ["ok", "deny"]


async def test_pipeline_unknown_tool_rejected(memory_storage) -> None:
    service = _service(memory_storage, graph=_data_graph())
    pipeline = build_introspection_pipeline(service)
    spec = ToolSpec(
        name="inspect_nothing",
        description="未知工具",
        parameters={},
        permissions=(INTROSPECTION_PERMISSION,),
    )
    result = await pipeline.execute(None, spec, {})
    assert result.ok is False
    assert "未知内省工具" in (result.error or "")
