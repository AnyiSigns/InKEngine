"""第二批组装域壳侧接线单测（ENG9a-1/2 + E-P9 治理 sink + D1 种子语料）。

覆盖：
- 工具契约登记闭环（register_tool_node_types）：组装池不再恒零候选——
  声明式工具带契约进注册表后 assemble 解出目标字段（ENG9a-1）；
- 图定义候选直接作 spawn subgraph 消费 + 类型名→工具名映射两端断言
  （assembly_candidate_specs，ENG9a-2）；
- 池治理 sink 接线（_governed_proposal_sink_factory）：结点提案经四规则
  判定随审计落库（E-P9）；
- path_seeds.json 种子语料 → 边证据冷启动基线（D1 联动）。

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


# ── D1 联动：path_seeds.json 种子语料 → 边证据冷启动基线 ─────────

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
    test_governed_proposal_sink_factory()
    test_seed_edges_from_path_seeds()
    print("assembly wiring all assertions passed")
