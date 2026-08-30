"""VTM 验证器门控 + 组装时间线事件测试（端到端落地验证）。

覆盖：
- 组装时间线事件顺序（turn_started → execution_started；assembly_* 在装配
  启用时成对发射）。
- VTM 门控三种形态：pass 放行 / fail 违规驱动重做 / 终败按节点失败收口。
- 门控关闭时节点声明 __verify__ 零行为变化（既有图兼容）。
- 终败 error 事件携带违规清单 + entity_id → 演化管线定向教训链路。
"""
from __future__ import annotations

import pytest
from conftest import make_engine

from ink_engine.core.events import CollectorTransport
from ink_engine.core.executor import Engine
from ink_engine.core.graph import Graph, TerminateReason
from ink_engine.core.knowledge_signals import SignalClassifier
from ink_engine.core.verifier import (
    VERIFY_FEEDBACK_KEY,
    VERIFY_KEY,
)


class FakeVerifier:
    """可编排的假验证器：按顺序消费判决，剩余用 pass 兜底。"""

    def __init__(self, results):
        self.results = list(results)
        self.calls: list[tuple[str, dict, dict]] = []

    async def verify(self, ctx, *, node, output, spec):
        result = self.results.pop(0) if self.results else {"pass": True, "violations": []}
        self.calls.append((node, dict(output), dict(spec)))
        return result


def _verify_graph() -> Graph:
    """验证图：produce（声明 __verify__）→ done。"""

    async def produce(ctx):
        repaired = bool(ctx.state.get(VERIFY_FEEDBACK_KEY))
        return {
            "produced": True,
            "repaired": repaired,
            VERIFY_KEY: {"task": "生成结果", "requirements": ["含 produced"], "entity_id": "e1"},
        }

    g = Graph(name="verify", entry="produce")
    g.add_node("produce", produce)
    g.add_node("done", lambda ctx: {"done": True})
    g.add_edge("produce", "done")
    g.add_exit("done")
    return g


async def _run(engine: Engine, state: dict | None = None):
    return await engine._execute(
        state=state or {},
        thread_id="t",
        round_id="r1",
        resume_from=None,
        trace_id="trace",
        queue=None,
    )


def _events(engine: Engine) -> list[dict]:
    out = []
    for t in engine.options.transports:
        if isinstance(t, CollectorTransport):
            out.extend({"type": e.type, "payload": e.payload or {}} for e in t.events)
    return out


# ── 组装时间线事件 ──

@pytest.mark.asyncio
async def test_timeline_events_order():
    engine = make_engine(_verify_graph(), emit_timeline_events=True)
    await _run(engine)
    evs = _events(engine)
    types = [e["type"] for e in evs if e["type"] in ("turn_started", "execution_started", "assembly_started", "assembly_done")]
    assert types[0] == "turn_started"
    assert types[-1] == "execution_started"
    ts = [e["payload"].get("ts") for e in evs if e["type"] in ("turn_started", "execution_started")]
    assert all(t for t in ts), "时间线事件应携带 ts（墙钟）"


@pytest.mark.asyncio
async def test_timeline_events_opt_in_default_off():
    # 默认关闭：既有事件协议零变化（不额外发射时间线事件）
    engine = make_engine(_verify_graph())
    await _run(engine)
    evs = _events(engine)
    assert not any(e["type"] in ("turn_started", "execution_started") for e in evs)


# ── VTM 门控：pass 放行 ──

@pytest.mark.asyncio
async def test_verifier_pass_flow():
    verifier = FakeVerifier([{"pass": True, "violations": []}])
    engine = make_engine(_verify_graph(), output_verifier=verifier)
    state, _result = await _run(engine)
    evs = _events(engine)
    verdicts = [e for e in evs if e["type"] == "output_verdict"]
    assert len(verdicts) == 1
    assert verdicts[0]["payload"]["pass"] is True
    assert verdicts[0]["payload"]["node"] == "produce"
    assert state.get("produced") is True
    assert VERIFY_KEY not in state, "评审规格保留键不得落状态"


# ── VTM 门控：fail → 违规驱动重做 ──

@pytest.mark.asyncio
async def test_verifier_fail_then_repair():
    verifier = FakeVerifier(
        [
            {"pass": False, "violations": ["缺 produced 标记"]},
            {"pass": True, "violations": []},
        ]
    )
    engine = make_engine(_verify_graph(), output_verifier=verifier, verify_retry_limit=2)
    state, _ = await _run(engine)
    assert len(verifier.calls) == 2, "首次 fail 后应按违规清单重做节点"
    assert verifier.calls[1][1].get("repaired") is True, "重做时节点应读到反馈并做定向修复"
    evs = _events(engine)
    verdicts = [e for e in evs if e["type"] == "output_verdict"]
    assert [v["payload"]["pass"] for v in verdicts] == [False, True]
    assert state.get("produced") is True


# ── VTM 门控：重做耗尽 → 按节点失败收口（error 事件带违规 + entity_id） ──

@pytest.mark.asyncio
async def test_verifier_exhausted_terminates():
    verifier = FakeVerifier(
        [
            {"pass": False, "violations": ["缺 A"]},
            {"pass": False, "violations": ["缺 B"]},
        ]
    )
    engine = make_engine(_verify_graph(), output_verifier=verifier, verify_retry_limit=1)
    _, result = await _run(engine, {"produced": False})
    evs = _events(engine)
    errors = [e for e in evs if e["type"] == "error"]
    assert len(errors) == 1
    assert "缺 B" in errors[0]["payload"]["message"], "终败消息应带违规清单（演化定向教训）"
    assert errors[0]["payload"]["context"]["entity_id"] == "e1", "终败应归因实体"
    assert result.reason == TerminateReason.ERROR


# ── 门控关闭：节点声明 __verify__ 零行为变化 ──

@pytest.mark.asyncio
async def test_verifier_disabled_noop():
    engine = make_engine(_verify_graph())  # 未挂 output_verifier
    state, _ = await _run(engine)
    evs = _events(engine)
    assert not any(e["type"] == "output_verdict" for e in evs)
    assert state.get("produced") is True, "未挂验证器时节点照常执行"


# ── 演化链路：error（带违规）→ SignalClassifier → pitfall 定向教训 ──

def test_verdict_error_maps_to_directed_pitfall():
    classifier = SignalClassifier()
    signal = classifier.classify(
        {
            "type": "error",
            "message": "节点产出未通过验证: produce（缺 A）",
            "source": "unit-test",
            "context": {"entity_id": "e1"},
        }
    )
    assert signal is not None
    assert signal.kind == "pitfall"
    assert "缺 A" in signal.message, "违规清单应进入教训消息（定向变异种子）"


# ── 宿主接线：配方开关 → LLM 验证器注入引擎 ──

@pytest.mark.asyncio
async def test_runtime_wires_output_verifier():
    from test_runtime import FakeHost, _ClosableLLM, _minimal_recipe

    from ink_engine.core.runtime import Runtime

    host = FakeHost()
    host.llm = _ClosableLLM()
    recipe = _minimal_recipe(verify_retry_limit=2, emit_timeline_events=True)
    runtime = await Runtime().boot(host, recipe)
    engine = runtime.engine
    assert engine.options.output_verifier is not None, "verify_retry_limit>0 应注入 LLM 验证器"
    assert engine.options.verify_retry_limit == 2
    assert engine.options.emit_timeline_events is True

    # 默认关闭 → 零注入（既有配方零行为变化）
    runtime2 = await Runtime().boot(FakeHost(), _minimal_recipe())
    assert runtime2.engine.options.output_verifier is None
    assert runtime2.engine.options.verify_retry_limit == 0
    assert runtime2.engine.options.emit_timeline_events is False


# ── 马尔可夫路径缓存回馈：多径执行结果回灌（观测不阻断） ──

@pytest.mark.asyncio
async def test_multipath_cache_feedback_reports():
    from test_multipath import make_behavior_registry, make_candidates, make_request

    from ink_engine.core.edge_evidence import EdgeEvidenceStore
    from ink_engine.core.multipath import MULTIPATH_KEY
    from ink_engine.core.path_assembler import (
        get_default_assembly_runtime,
        set_default_assembly_runtime,
    )
    from ink_engine.core.registry import GraphRegistries

    class RecordingRuntime:
        multipath_enabled = True
        evidence_store = None
        sink = None

        def __init__(self):
            self.reports: list[bool] = []

        async def report_cache_execution(self, request, *, ok):
            self.reports.append(ok)
            return True

    registry = make_behavior_registry()
    store = EdgeEvidenceStore(":memory:")
    candidates = await make_candidates(registry, store, top_k=2)
    request = make_request(top_k=2)
    rt = RecordingRuntime()
    previous = get_default_assembly_runtime()
    set_default_assembly_runtime(rt)
    try:
        async def orchestrator(ctx):
            return {
                MULTIPATH_KEY: {
                    "request": request,
                    "candidates": list(candidates),
                    "entry_state": {"input": "任务输入"},
                    "k": 2,
                }
            }

        g = Graph(name="mp-fb", entry="orch")
        g.add_node("orch", orchestrator)
        g.add_exit("orch")
        engine = make_engine(g, registries=GraphRegistries(nodes=registry))
        await engine.ainvoke({"input": "任务输入"})
        assert rt.reports == [True], "多径成功裁决后应回馈缓存 ok=True"
    finally:
        set_default_assembly_runtime(previous)
        await store.close()
