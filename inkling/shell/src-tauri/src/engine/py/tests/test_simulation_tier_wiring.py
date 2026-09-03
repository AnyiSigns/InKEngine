"""推演档位接通接线单测（设置 → 桥刷新 → 编排候选推演分支）。

覆盖：
- 档位策略注册/预算（configure_simulation_policy / simulation_tier_budget）；
- 档位 override 存取与非法值拒绝（set/simulation_tier_override）;
- 候选 → 决策点推演分支纯转换（candidate_simulation_branches：档位预算
  截断/状态透传/缺图报错/不推演回落）；
- 桥刷新（_refresh_max_tool_rounds 同时刷新 max_tool_rounds 与
  simulation_tier 覆盖：无记录/非法档回落策略缺省）。

pytest 兼容；无 pytest 依赖时可用 `py test_simulation_tier_wiring.py` 直跑。
"""
from __future__ import annotations

import asyncio
import importlib.util
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_BRIDGE_PATH = os.path.join(_HERE, "..", "bridge.py")
_ENGINE_PY = os.path.normpath(os.path.join(_HERE, ".."))
if _ENGINE_PY not in sys.path:
    sys.path.insert(0, _ENGINE_PY)
_REPO_ROOT = os.path.normpath(
    os.path.join(_HERE, "..", "..", "..", "..", "..", "..", "..")
)
_ENGINE_PKG = os.path.normpath(os.path.join(_REPO_ROOT, "ink_engine"))
if _ENGINE_PKG not in sys.path:
    sys.path.insert(0, _ENGINE_PKG)


def _load_bridge():
    spec = importlib.util.spec_from_file_location("bridge_under_test", _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _graph_recipe():
    from inkling_host import graph_recipe

    return graph_recipe


# ── 策略注册 / 预算 / override ────────────────────────────────────


def test_policy_defaults_and_budget_from_fallback():
    gr = _graph_recipe()
    try:
        gr.configure_simulation_policy(None)
        assert gr.simulation_default_tier() == "light"
        assert gr.effective_simulation_tier() == "light"
        assert gr.simulation_tier_budget("off") == 0
        assert gr.simulation_tier_budget("light") == 2
        assert gr.simulation_tier_budget("full") == 4
        assert gr.simulation_tier_budget("bogus") == 0
    finally:
        gr.set_simulation_tier_override(None)
        gr.configure_simulation_policy(None)


def test_policy_configure_from_seed_and_partial_rejected():
    gr = _graph_recipe()
    try:
        gr.configure_simulation_policy(
            {
                "default": "full",
                "tiers": {
                    "off": {"max_simulations": 0, "quota_per_round": 0},
                    "light": {"max_simulations": 1, "quota_per_round": 2},
                    "full": {"max_simulations": 6, "quota_per_round": 3},
                },
            }
        )
        assert gr.simulation_default_tier() == "full"
        assert gr.effective_simulation_tier() == "full"
        assert gr.simulation_tier_budget("light") == 1
        assert gr.simulation_tier_budget("full") == 6
        # 残缺段/缺字段/负数 = 配置错误显式抛错（与 Rust InvalidData 同口径，
        # 不静默保留旧策略——避免 Python 编排预算与 Rust 路由配额漂移）
        for bad in (
            {"tiers": {"light": {"max_simulations": 9}}},
            {"tiers": {t: {"max_simulations": 2, "quota_per_round": 1} for t in ("off", "light", "full") if t != "full"}},
            {"tiers": {t: {"quota_per_round": 1} for t in ("off", "light", "full")}},
            {"tiers": {t: {"max_simulations": -1, "quota_per_round": 1} for t in ("off", "light", "full")}},
            {"tiers": {t: {"max_simulations": "x", "quota_per_round": 1} for t in ("off", "light", "full")}},
        ):
            try:
                gr.configure_simulation_policy(bad)
            except ValueError:
                pass
            else:
                raise AssertionError("残缺/非法档策略应显式抛错")
        assert gr.simulation_tier_budget("light") == 1, "非法配置不得改写既有策略"
    finally:
        gr.set_simulation_tier_override(None)
        gr.configure_simulation_policy(None)


def test_tier_override_set_clear_and_invalid_rejected():
    gr = _graph_recipe()
    try:
        gr.configure_simulation_policy(None)
        assert gr.simulation_tier_override() is None
        gr.set_simulation_tier_override("full")
        assert gr.simulation_tier_override() == "full"
        assert gr.effective_simulation_tier() == "full"
        try:
            gr.set_simulation_tier_override("bogus")
        except ValueError:
            pass
        else:
            raise AssertionError("非法档位应拒绝")
        gr.set_simulation_tier_override(None)
        assert gr.effective_simulation_tier() == "light"
    finally:
        gr.set_simulation_tier_override(None)
        gr.configure_simulation_policy(None)


# ── 候选 → 决策点推演分支纯转换 ──────────────────────────────────


def _candidate(cid: str, chain: tuple[str, ...], graph: dict):
    return {"id": cid, "chain": list(chain), "graph": graph}


def test_candidate_simulation_branches_gated_by_count_and_budget():
    gr = _graph_recipe()
    c1 = _candidate("c1", ("fetch_doc",), {"name": "g1", "entry": "fetch_doc"})
    c2 = _candidate("c2", ("answer_direct",), {"name": "g2", "entry": "answer_direct"})
    assert gr.candidate_simulation_branches([c1], step_args=None, max_branches=2) is None
    assert gr.candidate_simulation_branches([c1, c2], step_args=None, max_branches=0) is None
    assert gr.candidate_simulation_branches([c1, c2], step_args=None, max_branches=-1) is None
    assert gr.candidate_simulation_branches([], step_args=None, max_branches=2) is None


def test_candidate_simulation_branches_shapes_and_budget_slice():
    gr = _graph_recipe()
    c1 = _candidate("c1", ("fetch_doc",), {"name": "g1", "entry": "fetch_doc"})
    c2 = _candidate("c2", ("answer_direct",), {"name": "g2", "entry": "answer_direct"})
    c3 = _candidate("c3", ("shell",), {"name": "g3", "entry": "shell"})
    envelope = gr.candidate_simulation_branches(
        [c1, c2, c3], step_args={"fetch_doc": {"url": "u"}}, max_branches=2
    )
    assert envelope is not None
    branches = envelope["branches"]
    assert len(branches) == 2
    assert branches[0]["subgraph"] == c1["graph"]
    assert branches[0]["index"] == 100
    assert branches[0]["state"] == {"step_args": {"fetch_doc": {"url": "u"}}}
    assert "组装候选 1" in branches[0]["description"]
    assert branches[1]["index"] == 200
    assert "组装候选 2" in branches[1]["description"]


def test_candidate_simulation_branches_missing_graph_rejected():
    gr = _graph_recipe()
    c1 = _candidate("c1", ("fetch_doc",), {"name": "g1", "entry": "fetch_doc"})
    bad = {"id": "bad", "chain": ["ghost"]}
    try:
        gr.candidate_simulation_branches([c1, bad], step_args=None, max_branches=2)
    except TypeError:
        pass
    else:
        raise AssertionError("候选缺 candidate.graph 应显式报错")


# ── 桥刷新（能力记录 → 模块 override） ────────────────────────────


class _RecordStorage:
    def __init__(self, record: dict | None):
        self._record = record

    async def get_record(self, collection: str, key: str) -> dict | None:
        return self._record


class _FakeRuntime:
    def __init__(self, record: dict | None):
        self.storage = _RecordStorage(record)


def test_bridge_refresh_applies_tier_and_max_rounds():
    gr = _graph_recipe()
    bridge = _load_bridge()
    try:
        gr.configure_simulation_policy(None)
        runtime = _FakeRuntime(
            {"max_tool_rounds": 12, "simulation_tier": "full"}
        )
        asyncio.run(bridge._refresh_max_tool_rounds(runtime))
        assert gr.simulation_tier_override() == "full"
        assert gr.max_tool_rounds_override() == 12
    finally:
        gr.set_simulation_tier_override(None)
        gr.configure_simulation_policy(None)


def test_bridge_refresh_invalid_or_missing_tier_falls_back():
    gr = _graph_recipe()
    bridge = _load_bridge()
    try:
        gr.configure_simulation_policy(None)
        gr.set_simulation_tier_override("off")
        runtime = _FakeRuntime({"simulation_tier": "bogus"})
        asyncio.run(bridge._refresh_max_tool_rounds(runtime))
        assert gr.simulation_tier_override() is None
        assert gr.effective_simulation_tier() == "light"
        asyncio.run(bridge._refresh_max_tool_rounds(_FakeRuntime(None)))
        assert gr.simulation_tier_override() is None
        assert gr.effective_simulation_tier() == "light"
    finally:
        gr.set_simulation_tier_override(None)
        gr.configure_simulation_policy(None)


if __name__ == "__main__":
    test_policy_defaults_and_budget_from_fallback()
    test_policy_configure_from_seed_and_partial_rejected()
    test_tier_override_set_clear_and_invalid_rejected()
    test_candidate_simulation_branches_gated_by_count_and_budget()
    test_candidate_simulation_branches_shapes_and_budget_slice()
    test_candidate_simulation_branches_missing_graph_rejected()
    test_bridge_refresh_applies_tier_and_max_rounds()
    test_bridge_refresh_invalid_or_missing_tier_falls_back()
    print("test_simulation_tier_wiring: all passed")
