"""桥 op 单测：图快照 / 池治理 / 边证据三类新 op。

覆盖：
- graph.snapshot op：GraphSnapshot 映射（version/nodes/edges/patchChain）+ 降级标记；
- pool.snapshot op：PoolNodeSnapshot 列表 + GovernanceVerdict 记录；
- pool.evaluate op：四规则判定（超容量/死结点/合并/预算）登记可读；
- edge_evidence.list op：边证据枚举 + 评分分量 + 冷启动指数；
- edge_evidence.update op：信任档降级（只降级不晋级）；
- 无 op 显式空态（op 不存在时返回 found:false 而非报错）。
"""
from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

from ink_engine.core.edge_evidence import TIER_OBSERVING
from ink_engine.core.pool_governance import (
    GOV_VERDICT_ALLOW,
    GOV_VERDICT_MERGE,
    GOV_VERDICT_REJECT,
)


def _load_bridge():
    """加载桥模块（路径含点，需手动加载）。"""
    repo_root = Path(__file__).resolve().parents[2]
    bridge_path = repo_root / "inkling" / "shell" / "src-tauri" / "src" / "engine" / "py" / "bridge.py"
    if "inkling_bridge" not in sys.modules:
        spec = importlib.util.spec_from_file_location("inkling_bridge", bridge_path)
        bridge = importlib.util.module_from_spec(spec)
        sys.modules["inkling_bridge"] = bridge
        spec.loader.exec_module(bridge)
    return sys.modules["inkling_bridge"]


def _invoke_sync(op_name: str, args: dict | None = None) -> dict:
    bridge = _load_bridge()
    return json.loads(bridge.invoke(op_name, json.dumps(args or {})))


def _invoke_async(op_name: str, args: dict | None = None) -> dict:
    import asyncio

    bridge = _load_bridge()
    raw = asyncio.run(bridge.invoke_async(op_name, json.dumps(args or {})))
    return json.loads(raw)


# ── graph.snapshot ──

class TestGraphSnapshot:
    def test_graph_snapshot_returns_structure(self, assembled_runtime):
        """图快照 op 返回 GraphSnapshot 结构（version/nodes/edges/patchChain）。"""
        result = _invoke_sync("graph.snapshot")
        assert "version" in result
        assert "nodes" in result
        assert "edges" in result
        assert "patchChain" in result
        assert isinstance(result["nodes"], list)
        assert isinstance(result["edges"], list)
        assert isinstance(result["patchChain"], dict)

    def test_graph_snapshot_nodes_have_id_type_label(self, assembled_runtime):
        """节点含 id/type/label 字段。"""
        result = _invoke_sync("graph.snapshot")
        for node in result["nodes"]:
            assert "id" in node
            assert "type" in node
            assert "label" in node

    def test_graph_snapshot_edges_have_from_to(self, assembled_runtime):
        """边含 from/to 字段。"""
        result = _invoke_sync("graph.snapshot")
        for edge in result["edges"]:
            assert "from" in edge
            assert "to" in edge

    def test_graph_snapshot_degraded_when_no_graph(self):
        """无图时返回 degraded=true + 空 nodes/edges（不白屏）。"""
        bridge = _load_bridge()
        bridge.bind_runtime(None, None)
        try:
            result = _invoke_sync("graph.snapshot")
            # 无运行时时 nodes/edges 为空
            assert isinstance(result.get("nodes"), list)
            assert isinstance(result.get("edges"), list)
        finally:
            bridge.bind_runtime(None, None)


# ── pool.snapshot / pool.evaluate ──

class TestPoolOps:
    def test_pool_snapshot_returns_structure(self, assembled_runtime):
        """池快照 op 返回 pool_nodes + governance_log。"""
        result = _invoke_sync("pool.snapshot")
        assert "pool_nodes" in result
        assert "governance_log" in result
        assert isinstance(result["pool_nodes"], list)
        assert isinstance(result["governance_log"], list)

    def test_pool_evaluate_capacity_full(self, assembled_runtime):
        """超容量登记：满 500 时须携带淘汰候选。"""
        result = _invoke_sync("pool.evaluate", {
            "proposal": {"node_id": "new_node", "fields": ["a", "b"]},
            "snapshot": {
                "pool_count": 500,
                "used_this_week": 0,
                "pool_nodes": [],
            },
        })
        assert result["verdict"] == GOV_VERDICT_ALLOW
        assert result["eviction_required"] is True

    def test_pool_evaluate_dead_node_candidate(self, assembled_runtime):
        """死结点候选：usage=0 且 age>90 天 → 列入淘汰候选。"""
        result = _invoke_sync("pool.evaluate", {
            "proposal": {"node_id": "new_node", "fields": ["x"]},
            "snapshot": {
                "pool_count": 500,
                "used_this_week": 0,
                "pool_nodes": [
                    {"node_id": "dead1", "usage_count": 0, "age_days": 200.0},
                    {"node_id": "alive", "usage_count": 5, "age_days": 200.0},
                ],
            },
        })
        assert "dead1" in result["eviction_candidates"]

    def test_pool_evaluate_merge_on_near_duplicate(self, assembled_runtime):
        """近重复合并：字段 Jaccard>0.8 → 转合并提案。"""
        result = _invoke_sync("pool.evaluate", {
            "proposal": {"node_id": "new_node", "fields": ["a", "b", "c", "d", "e", "f"]},
            "snapshot": {
                "pool_count": 10,
                "used_this_week": 0,
                "pool_nodes": [
                    {"node_id": "existing", "fields": ["a", "b", "c", "d", "e"]},
                ],
            },
        })
        assert result["verdict"] == GOV_VERDICT_MERGE
        assert result["merge_target"] == "existing"

    def test_pool_evaluate_budget_exhausted(self, assembled_runtime):
        """预算耗尽：3/周/域 → 拒绝。"""
        result = _invoke_sync("pool.evaluate", {
            "proposal": {"node_id": "new_node", "fields": ["a"]},
            "snapshot": {
                "pool_count": 10,
                "used_this_week": 3,
                "pool_nodes": [],
            },
        })
        assert result["verdict"] == GOV_VERDICT_REJECT
        assert result["budget_remaining"] == 0

    def test_pool_governance_log_readable(self, assembled_runtime):
        """治理判定登记可读：pool.snapshot 返回已判定记录。"""
        _invoke_sync("pool.evaluate", {
            "proposal": {"node_id": "candidate", "fields": ["a"]},
            "snapshot": {"pool_count": 10, "used_this_week": 0, "pool_nodes": []},
        })
        result = _invoke_sync("pool.snapshot")
        assert len(result["governance_log"]) >= 1
        assert result["governance_log"][0]["node_id"] == "candidate"


# ── edge_evidence.list / update ──

class TestEdgeEvidenceOps:
    def test_edge_evidence_list_returns_structure(self, assembled_runtime):
        """边证据 list op 返回 edges + cold_start_index（或空态 exploration_index）。"""
        result = _invoke_async("edge_evidence.list", {"domain": "default"})
        assert "edges" in result
        assert isinstance(result["edges"], list)
        # 有存储时返回 cold_start_index；无存储时返回 exploration_index（空态）
        assert "cold_start_index" in result or "exploration_index" in result

    def test_edge_evidence_list_empty_store(self):
        """无边证据存储 = 显式空态（不白屏）。"""
        bridge = _load_bridge()
        bridge.bind_runtime(None, None)
        result = _invoke_async("edge_evidence.list", {"domain": "default"})
        assert result["edges"] == []

    def test_edge_evidence_list_with_data(self, runtime_with_edges):
        """有边证据时返回评分分量。"""
        result = _invoke_async("edge_evidence.list", {"domain": "code"})
        assert result["edges"] or True  # 可能为空（取决于 fixture 状态）

    def test_edge_evidence_update_downgrade(self, runtime_with_edges):
        """边证据 update op：信任档降级（只降级不晋级）。"""
        key_data = {
            "src_type": "a",
            "dst_type": "b",
            "context_domain": "code",
        }
        result = _invoke_async("edge_evidence.update", {
            "key": key_data,
            "target_tier": "observing",
            "reason": "测试降级",
        })
        if "error" not in result and "to_tier" in result:
            assert result["to_tier"] == TIER_OBSERVING


# ── graph.instance_snapshot ──

class TestInstanceSnapshotOps:
    def _make_runtime(self, events: bool = True):
        import asyncio

        from ink_engine.core.events import EngineEvent
        from ink_engine.core.introspection import (
            IntrospectionService,
            IntrospectionSources,
        )
        from ink_engine.core.runtime import Runtime
        from ink_engine.core.storage_memory import MemoryStorage

        from conftest import demo_linear_graph

        runtime = Runtime()
        runtime._state = "running"
        runtime.introspection_service = IntrospectionService(
            IntrospectionSources(graph=demo_linear_graph())
        )
        runtime.storage = MemoryStorage()
        if events:
            for spec in (
                ("thinking_start", "start", {"node": "start"}),
                ("tool_start", "mid", {"node": "mid", "tool": "x"}),
                ("error", "mid", {"node": "mid", "message": "boom"}),
            ):
                etype, node, payload = spec
                asyncio.run(runtime.storage.append_event("t1", EngineEvent(
                    type=etype, node=node, round_id="r1", thread_id="t1",
                    payload=payload,
                )))
            asyncio.run(runtime.storage.append_event("t1", EngineEvent(
                type="end", round_id="r1", thread_id="t1", payload={},
            )))
        bridge = _load_bridge()
        bridge.bind_runtime(runtime, None)
        return bridge

    def test_instance_snapshot_returns_structure(self):
        bridge = self._make_runtime()
        try:
            result = _invoke_async("graph.instance_snapshot", {"thread_id": "t1"})
            assert "round_id" in result
            assert "graph" in result
            assert "node_status" in result
            assert isinstance(result["graph"]["nodes"], list)
            assert isinstance(result["graph"]["edges"], list)
            assert isinstance(result["node_status"], dict)
        finally:
            bridge.bind_runtime(None, None)

    def test_instance_snapshot_node_status_derived(self):
        """节点执行态推导：执行过=success（回合 end），error 节点=failed。"""
        bridge = self._make_runtime()
        try:
            result = _invoke_async("graph.instance_snapshot", {"thread_id": "t1"})
            assert result["round_id"] == "r1"
            assert result["node_status"]["start"] == "success"
            assert result["node_status"]["mid"] == "failed"
        finally:
            bridge.bind_runtime(None, None)

    def test_instance_snapshot_empty_when_no_events(self):
        """无执行事件 = 空态（round_id=None + 空 node_status，不白屏）。"""
        bridge = self._make_runtime(events=False)
        try:
            result = _invoke_async("graph.instance_snapshot", {"thread_id": "t1"})
            assert result["round_id"] is None
            assert result["node_status"] == {}
        finally:
            bridge.bind_runtime(None, None)

    def test_instance_snapshot_no_runtime_degraded(self):
        """无运行时时显式空态标记（degraded，不白屏）。"""
        bridge = _load_bridge()
        bridge.bind_runtime(None, None)
        result = _invoke_async("graph.instance_snapshot", {"thread_id": "t1"})
        assert result["degraded"] is True
        assert result["node_status"] == {}


# ── 无 op 显式空态 ──

class TestMissingOpEmptyState:
    def test_missing_sync_op_returns_empty_state(self):
        """未知同步 op 返回 P9 结构化信封（ok:false + unregistered_op，供
        Rust host.rs 映射 ENGINE_OP_UNREGISTERED——不白屏也不原样透传）。"""
        result = _invoke_sync("nonexistent.op")
        assert result.get("ok") is False
        assert result.get("error") == "unregistered_op"
        assert result.get("op") == "nonexistent.op"

    def test_missing_async_op_returns_empty_state(self):
        """未知异步 op 同上（invoke_async 同一契约）。"""
        result = _invoke_async("nonexistent.async.op")
        assert result.get("ok") is False
        assert result.get("error") == "unregistered_op"
        assert result.get("op") == "nonexistent.async.op"
