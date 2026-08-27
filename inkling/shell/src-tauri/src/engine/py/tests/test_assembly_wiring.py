"""组装域壳侧接线单测。

覆盖：
- 工具契约登记闭环（register_tool_node_types）：组装池不再恒零候选——
  声明式工具带契约进注册表后 assemble 解出目标字段；
- 图定义候选直接作 spawn subgraph 消费 + 类型名→工具名映射两端断言
  （assembly_candidate_specs）；
- 池治理 sink 接线（_governed_proposal_sink_factory）：结点提案经四规则
  判定随审计落库；
- path_seeds.json 种子语料 → 边证据冷启动基线。

pytest 兼容；无 pytest 依赖时可用 `py test_assembly_wiring.py` 直跑。
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ENGINE_PY = os.path.normpath(os.path.join(_HERE, ".."))
if _ENGINE_PY not in sys.path:
    sys.path.insert(0, _ENGINE_PY)
# 仓库根（tests → py → engine → src → src-tauri → shell → inkling → 根）
_REPO_ROOT = os.path.normpath(
    os.path.join(_HERE, "..", "..", "..", "..", "..", "..", "..")
)
# 显式优先解析工作区引擎（本测试断言的是工作区代码）：直接插包根路径，
# 使 ``import ink_engine`` 命中带 __init__.py 的常规包（引擎测试经
# ink_engine/pyproject.toml 的 pythonpath=["."] 已达成，此处手动等价；
# 不插包根的话顶层 ink_engine 走命名空间、子模块落回 editable 主仓库）
_ENGINE_PKG = os.path.normpath(os.path.join(_REPO_ROOT, "ink_engine"))
if _ENGINE_PKG not in sys.path:
    sys.path.insert(0, _ENGINE_PKG)


def _load_host():
    from inkling_host import host

    return host


def _load_graph_recipe():
    from inkling_host import graph_recipe

    return graph_recipe


def _specs():
    from ink_engine.core.declarative_tools import DeclarativeToolSpec, EndpointType

    return [
        DeclarativeToolSpec(
            name="fetch_doc",
            description="抓取文档",
            parameters={
                "type": "object",
                "properties": {"url": {"type": "string"}},
                "required": [],
            },
            permissions=("mcp:call:inkling_exec",),
            endpoint=EndpointType.MCP,
            endpoint_config={"server_id": "inkling_exec"},
            meta={"approval": "allow"},
        ),
        DeclarativeToolSpec(
            name="answer_direct",
            description="直答",
            parameters={
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": [],
            },
            permissions=("filesystem:read:/work",),
            endpoint=EndpointType.FILE_OPS,
            endpoint_config={"root": "/work"},
            meta={"approval": "allow"},
        ),
    ]


# ── ENG9a-1：工具契约登记 → 组装闭环 ─────────────────────────────

@pytest.mark.asyncio
async def test_tool_contract_registration_enables_assembly():
    """声明式工具带契约入注册表：assemble 不再恒零候选（目标字段与工具
    产出匹配，放行档按真实审批档剪枝——allow 档工具进 tier-0 路径）。"""
    from ink_engine.core.contracts import NodeContract, PathAssemblyConfig
    from ink_engine.core.path_assembler import AssemblyRequest, PathAssembler
    from ink_engine.core.registry import NodeTypeRegistry
    from ink_engine.core.schema_validator import FIELD_STRING, SchemaField, SchemaSpec

    specs = _specs()
    registry = NodeTypeRegistry()
    recipe = _load_graph_recipe()
    registered = recipe.register_tool_node_types(registry, specs)
    assert registered == 2
    assert registry.has("fetch_doc")
    assert isinstance(registry.contract_for("fetch_doc"), NodeContract)
    # 登记端断言：契约输入/输出与工具声明同源（tool_node_mapping 同源）
    from ink_engine.core.declarative_tools import validate_tool_node_consistency

    assert validate_tool_node_consistency(
        {name: registry.contract_for(name) for name in registry.types()}, specs
    ) == []
    # 组装闭环：goal = result（file_ops 端点产出）→ 候选解出（不再恒零）
    assembler = PathAssembler(
        registry=registry,
        config=PathAssemblyConfig(enabled=True),
    )
    request = AssemblyRequest(
        goal_schema=SchemaSpec(
            name="goal",
            fields=(SchemaField(name="result", required=True, kind=FIELD_STRING),),
        ),
        entry_fields=(),
        domain="default",
        max_safety_tier=0,
    )
    result = await assembler.assemble(request)
    assert not result.is_empty, f"契约登记后组装仍零候选（{result.fallback_reason}）"
    assert any("answer_direct" in c.chain for c in result.candidates)


# ── ENG9a-2：图定义候选直接作 spawn subgraph 消费 ─────────────────

@pytest.mark.asyncio
async def test_assembly_candidate_specs_consumes_graph_data():
    """候选图定义数据直接作 spawn subgraph（不再降级为工具名列表）；
    消费端断言「类型名→工具名」映射（未登记类型显式报错）。"""
    from ink_engine.core.contracts import PathAssemblyConfig
    from ink_engine.core.path_assembler import AssemblyRequest, PathAssembler
    from ink_engine.core.registry import GraphRegistries, NodeTypeRegistry
    from ink_engine.core.schema_validator import FIELD_STRING, SchemaField, SchemaSpec

    specs = _specs()
    registry = NodeTypeRegistry()
    recipe = _load_graph_recipe()
    recipe.register_tool_node_types(registry, specs)
    # 消费端断言源：注册表状态（register_node_types 挂载；测试直挂）
    recipe._REGISTRIES_STATE["registries"] = GraphRegistries(nodes=registry)
    assembler = PathAssembler(
        registry=registry,
        config=PathAssemblyConfig(enabled=True),
    )
    request = AssemblyRequest(
        goal_schema=SchemaSpec(
            name="goal",
            fields=(SchemaField(name="result", required=True, kind=FIELD_STRING),),
        ),
        entry_fields=(),
        domain="default",
        max_safety_tier=0,
    )
    result = await assembler.assemble(request)
    assert not result.is_empty
    candidate = result.candidates[0]
    specs_out = recipe.assembly_candidate_specs(
        [candidate.to_dict()], step_args={"answer_direct": {"text": "x"}}
    )
    assert len(specs_out) == 1
    assert specs_out[0]["subgraph"] == candidate.to_dict()["graph"]
    assert specs_out[0]["state"]["step_args"] == {"answer_direct": {"text": "x"}}
    # 未登记类型 → 消费端显式报错（不做静默降级）
    try:
        recipe.assembly_candidate_specs(
            [{"graph": {"nodes": {}}, "chain": ["ghost_type"]}]
        )
        raised = False
    except ValueError:
        raised = True
    assert raised


# ── E-P9：池治理 sink 接线（四规则随结点提案审计落库）─────────────

def test_governed_proposal_sink_factory():
    """结点提案经池治理判定：判定结果随提案记录经原审计通道落库。"""
    from ink_engine.core.pool_governance import PoolGovernance

    host = _load_host()
    gov = PoolGovernance()
    emitted: list[dict] = []
    registry_ref: list = [None]

    def registry_getter():
        return registry_ref[0]

    sink = host._governed_proposal_sink_factory(
        gov,
        registry_getter=registry_getter,
        fallback_sink=emitted.append,
    )
    sink(
        {
            "node_type": "proposed_node",
            "output_schema": {
                "name": "proposed_node.output",
                "fields": [{"name": "result", "required": True}],
            },
            "domain": "default",
        }
    )
    assert len(emitted) == 1
    assert emitted[0]["node_type"] == "proposed_node"
    assert "governance" in emitted[0]
    assert emitted[0]["governance"]["verdict"] in ("allow", "merge", "reject")
    assert len(gov.log) == 1  # 判定登记
    # 治理判定异常不阻断提案审计（fail-open 于观测侧）
    def boom():
        raise ValueError("注册表不可用")

    sink2 = host._governed_proposal_sink_factory(
        gov, registry_getter=boom, fallback_sink=emitted.append
    )
    sink2({"node_type": "x", "output_schema": {"fields": []}})
    assert emitted[-1]["node_type"] == "x"
    assert "governance" not in emitted[-1]


# ── MCP server 离线独立标记（离线仅该 server 挂载工具降级）────

def _mcp_spec(name, server_id):
    from ink_engine.core.declarative_tools import DeclarativeToolSpec, EndpointType

    return DeclarativeToolSpec(
        name=name,
        description="mcp 工具",
        parameters={"type": "object", "properties": {}, "required": []},
        permissions=(f"mcp:call:{server_id}",),
        endpoint=EndpointType.MCP,
        endpoint_config={"server_id": server_id},
        meta={},
    )


def _file_spec(name="answer_direct"):
    from ink_engine.core.declarative_tools import DeclarativeToolSpec, EndpointType

    return DeclarativeToolSpec(
        name=name,
        description="直答",
        parameters={
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": [],
        },
        permissions=("filesystem:read:/work",),
        endpoint=EndpointType.FILE_OPS,
        endpoint_config={"root": "/work"},
        meta={},
    )


class _FakeCtx:
    def __init__(self) -> None:
        self.state: dict = {}
        self.events: list = []

    async def emit(self, name, payload, **kwargs):
        self.events.append((name, payload, kwargs))


@pytest.fixture(autouse=True)
def _isolate_mcp_state():
    """模块级标记/探测通道隔离（用例间不互相污染）。"""
    recipe = _load_graph_recipe()
    yield
    recipe._SERVER_AVAILABILITY.clear()
    recipe._SERVER_CHECKED_AT.clear()
    recipe.install_mcp_server_probe(None)


def test_server_availability_independent_marks():
    """离线 server 独立标记：标记只落在该 server，其余不受影响。"""
    recipe = _load_graph_recipe()
    recipe.mark_mcp_server_available("server_a", False)
    recipe.mark_mcp_server_available("server_b", True)
    assert recipe.mcp_server_available("server_a") is False
    assert recipe.mcp_server_available("server_b") is True
    # 未探测/未知 server = 可用（不因缺探测误降级）
    assert recipe.mcp_server_available("server_c") is True
    snapshot = recipe.server_availability_snapshot()
    assert snapshot["server_a"] is False
    assert snapshot["server_b"] is True
    assert "server_c" not in snapshot


@pytest.mark.asyncio
async def test_refresh_mcp_availability_independent_failure():
    """逐 server 独立探测：一个 server 探测异常不影响其余 server 探测。"""
    recipe = _load_graph_recipe()
    probe_calls: list[str] = []

    async def fake_probe(server_id):
        probe_calls.append(server_id)
        if server_id == "server_a":
            raise RuntimeError("连接被拒")
        return server_id != "server_b"

    recipe.install_mcp_server_probe(fake_probe)
    specs = [
        _mcp_spec("tool_a", "server_a"),
        _mcp_spec("tool_b", "server_b"),
        _mcp_spec("tool_c", "server_c"),
    ]
    snapshot = await recipe.refresh_mcp_availability(specs, force=True)
    assert snapshot["server_a"] is False  # 探测异常 → 该 server 独立标记离线
    assert snapshot["server_b"] is False  # 探测返回 False → 离线
    assert snapshot["server_c"] is True  # 其余 server 不受影响
    assert set(probe_calls) == {"server_a", "server_b", "server_c"}
    # 未注入探测通道 = 不探测不降级（装配形态与启用前一致）
    recipe.install_mcp_server_probe(None)
    recipe._SERVER_AVAILABILITY.clear()
    recipe._SERVER_CHECKED_AT.clear()
    snapshot2 = await recipe.refresh_mcp_availability(specs)
    assert all(snapshot2[s] for s in ("server_a", "server_b", "server_c"))


def test_default_plan_drops_offline_server_steps():
    """默认研究链：离线 server 挂载工具的步骤剔除，其余步骤保留。"""
    recipe = _load_graph_recipe()
    recipe.mark_mcp_server_available("server_a", False)
    recipe.mark_mcp_server_available("server_b", True)
    specs = [
        _mcp_spec("collect_a", "server_a"),
        _mcp_spec("parse_b", "server_b"),
        _file_spec("answer_direct"),
    ]
    online, dropped = recipe._default_plan_steps(
        specs, ("collect_a", "parse_b", "answer_direct")
    )
    assert online == ("parse_b", "answer_direct")
    assert dropped == ("collect_a",)
    # 无工具表 = 原样（不因缺探测误降级）
    assert recipe._default_plan_steps((), ("collect_a",)) == (
        ("collect_a",),
        (),
    )


def test_candidates_online_drops_offline_server_candidates():
    """组装候选：链含离线 server 工具的候选剔除，其余候选不受影响。"""
    recipe = _load_graph_recipe()
    recipe.mark_mcp_server_available("server_a", False)
    specs = [_mcp_spec("collect_a", "server_a"), _file_spec("answer_direct")]
    candidates = [
        {"id": "c1", "chain": ["collect_a"]},
        {"id": "c2", "chain": ["answer_direct"]},
        {"id": "c3", "chain": ["answer_direct", "collect_a"]},
    ]
    online, dropped = recipe._candidates_online(specs, candidates)
    assert [c["id"] for c in online] == ["c2"]
    assert dropped == ("c1", "c3")
    # 无工具表 = 原样
    assert recipe._candidates_online((), candidates)[0] == candidates


@pytest.mark.asyncio
async def test_run_tool_degrades_offline_server_only():
    """工具执行：离线 server 挂载工具降级（不发起调用），其余照常。"""
    from types import SimpleNamespace

    recipe = _load_graph_recipe()
    from ink_engine.core.registry import GraphRegistries, NodeTypeRegistry

    registries = GraphRegistries(nodes=NodeTypeRegistry())
    holder = recipe._specs_holder(registries)
    holder["specs"] = [
        _mcp_spec("collect_a", "server_a"),
        _mcp_spec("parse_b", "server_b"),
    ]
    recipe.mark_mcp_server_available("server_a", False)
    recipe.mark_mcp_server_available("server_b", True)
    calls: list[str] = []

    class FakePipeline:
        async def execute(self, ctx, spec, args):
            calls.append(spec.name)
            return SimpleNamespace(ok=True, output="ok")

    holder["pipeline"] = FakePipeline()
    factory = recipe.make_tool_pipeline_factory(holder)

    node_a = factory({"tool": "collect_a"})
    ctx_a = _FakeCtx()
    await node_a(ctx_a)
    tool_end_a = next(e for e in ctx_a.events if e[0] == "tool_end")
    assert tool_end_a[1]["success"] is False
    assert "离线" in tool_end_a[1]["message"]
    assert calls == []  # 离线 server 工具未发起真实调用

    node_b = factory({"tool": "parse_b"})
    ctx_b = _FakeCtx()
    await node_b(ctx_b)
    assert calls == ["parse_b"]  # 在线 server 工具照常执行


@pytest.mark.asyncio
async def test_orchestrator_default_plan_filters_offline_steps():
    """研究编排节点：默认规划剔除离线 server 步骤（其余步骤保留）。"""
    from ink_engine.core.plan import PLAN_KEY
    from ink_engine.core.workflow import WorkflowNodeSpec, WorkflowSpec

    recipe = _load_graph_recipe()
    workflow = WorkflowSpec(
        name="wf",
        nodes=(
            WorkflowNodeSpec(id="collect_a", type="tool_pipeline", config={}),
            WorkflowNodeSpec(id="answer_direct", type="tool_pipeline", config={}),
        ),
        edges=(),
        entry=None,
    )
    holder = {
        "specs": [_mcp_spec("collect_a", "server_a"), _file_spec("answer_direct")]
    }
    recipe.mark_mcp_server_available("server_a", False)
    factory = recipe.make_orchestrator_factory(workflow, holder)
    node = factory({"default_plan": True})
    ctx = _FakeCtx()
    delta = await node(ctx)
    plan = delta[PLAN_KEY]
    assert plan == [{"nodes": ["answer_direct"]}]


# ── path_seeds.json 种子语料 → 边证据冷启动基线 ─────────

def test_seed_edges_from_path_seeds():
    """出厂路径链 → 边证据种子（相邻结点对展开，缺省回落 edge_defaults）。"""
    host = _load_host()
    from inkling_host.recipe_loader import SeedDataBundle

    root = Path(tempfile.mkdtemp(prefix="ink-path-seeds-"))
    (root / "seed_data").mkdir(parents=True, exist_ok=True)
    (root / "seed_data" / "path_seeds.json").write_text(
        json.dumps(
            {
                "seed_paths": [
                    {
                        "id": "seed.path.test",
                        "domain": "default",
                        "chain": ["intent_parse", "retrieval_search", "answer_generate"],
                        "edge_stats": {"success_count": 5, "fail_count": 1},
                    }
                ],
                "edge_defaults": {
                    "success_count": 3,
                    "fail_count": 1,
                    "avg_cost": 0.5,
                    "src_contract_version": "1",
                    "dst_contract_version": "1",
                },
            }
        ),
        encoding="utf-8",
    )
    bundle = SeedDataBundle(root=root)
    edges = host._seed_edges_from_path_seeds(bundle)
    assert len(edges) == 2  # 3 结点链 → 2 条边
    assert edges[0] == {
        "src_type": "intent_parse",
        "dst_type": "retrieval_search",
        "success_count": 5,
        "fail_count": 1,
        "avg_cost": 0.5,
        "context_domain": "default",
        "src_contract_version": "1",
        "dst_contract_version": "1",
    }
    assert edges[1]["src_type"] == "retrieval_search"
    assert edges[1]["dst_type"] == "answer_generate"
    # 缺文件 = 空清单（冷启动无先验，不阻断装配）
    missing_root = Path(tempfile.mkdtemp(prefix="ink-path-missing-"))
    assert host._seed_edges_from_path_seeds(SeedDataBundle(root=missing_root)) == []


if __name__ == "__main__":
    asyncio.run(test_tool_contract_registration_enables_assembly())
    asyncio.run(test_assembly_candidate_specs_consumes_graph_data())
    asyncio.run(test_refresh_mcp_availability_independent_failure())
    asyncio.run(test_run_tool_degrades_offline_server_only())
    asyncio.run(test_orchestrator_default_plan_filters_offline_steps())
    test_governed_proposal_sink_factory()
    test_seed_edges_from_path_seeds()
    print("assembly wiring all assertions passed")
