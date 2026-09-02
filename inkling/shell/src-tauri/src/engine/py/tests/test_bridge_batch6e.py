"""壳侧批 6e 桥层审查修复回归测试（P4/P5/P6/P9/P10/E-P5 + llm_usage 帧收集）。

覆盖：
- P4：web_search 执行体对桥回传坏 JSON（JSONDecodeError）结构化降级；
- P5：搜索 payload 只传 provider，不传 key 明文（防密钥落桥日志/审计链）；
- P6：scoring 死簇清理后导入链干净（recipe_loader 不再引用打分器）；
- P9：未注册 op 返回结构化 ``{"ok": false, "error": "unregistered_op", "op"}``；
- P10：register_builtin_ops 按域拆分后各域 op 均仍在注册表；
- llm_usage 帧收集：回合入口传输包裹收集引擎 llm_usage 事件帧 →
  metrics.snapshot 无参聚合（批 3a 遗留闭环）；
- E-P5：execute_round_to_reply 回合收尾调 tune_after_round（失败信号）。

pytest 兼容；无 pytest 依赖时可用 `py test_bridge_batch6e.py` 直跑。
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
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


# ── P4/P5：web_search_domain 结构化降级 + provider-only payload ──


class _BrokenCallbackHost:
    """模拟 Rust 回调桥回传坏 JSON（json.loads 抛 JSONDecodeError）。"""

    def invoke(self, name: str, payload_json: str) -> str:
        return "{broken json"


class _FakeBridgeModule:
    def callback_host(self) -> _BrokenCallbackHost:
        return _BrokenCallbackHost()


def test_web_search_bad_json_degrades_structurally():
    """P4：桥回传坏 JSON 走 shell_unavailable 结构化降级（不抛异常）。"""
    from inkling_host import web_search_domain as wsd

    sys.modules["inkling_bridge"] = _FakeBridgeModule()
    try:
        execute = wsd.make_web_search_executor()
        raw = asyncio.run(execute(None, None, {"query": "墨引擎"}, None))
    finally:
        del sys.modules["inkling_bridge"]
    result = json.loads(raw)
    assert result["ok"] is False
    assert result["status"] == "shell_unavailable"
    assert "坏" in result["error"] or "不可用" in result["error"]


def test_web_search_payload_carries_provider_not_key():
    """P5：payload 只带 provider 名，不带 key 明文。"""
    from inkling_host import web_search_domain as wsd

    captured: dict = {}

    def spy_callback(name: str, payload: dict):
        captured["payload"] = payload
        return json.dumps({"ok": True, "results": []})

    os.environ["INK_SEARCH_KEY"] = "sk-test-secret"
    os.environ["INK_SEARCH_PROVIDER"] = "exa"
    try:
        execute = wsd.make_web_search_executor(callback=spy_callback)
        asyncio.run(execute(None, None, {"query": "q"}, None))
    finally:
        del os.environ["INK_SEARCH_KEY"]
        del os.environ["INK_SEARCH_PROVIDER"]
    payload = captured["payload"]
    assert "keys" not in payload, "key 明文不得跨桥（P5）"
    assert payload.get("provider") == "exa"
    assert "sk-test-secret" not in json.dumps(payload, ensure_ascii=False)


def test_web_search_no_key_env_payload_has_no_provider():
    """P5：未配置厂商 key = 本地聚合源（payload 不带 provider 字段）。"""
    from inkling_host import web_search_domain as wsd

    captured: dict = {}

    def spy_callback(name: str, payload: dict):
        captured["payload"] = payload
        return json.dumps({"ok": True, "results": []})

    os.environ.pop("INK_SEARCH_KEY", None)
    os.environ.pop("INK_SEARCH_PROVIDER", None)
    execute = wsd.make_web_search_executor(callback=spy_callback)
    asyncio.run(execute(None, None, {"query": "q"}, None))
    assert "provider" not in captured["payload"]
    assert "keys" not in captured["payload"]


# ── P6：scoring 死簇清理后导入链干净 ──


def test_dead_scoring_cluster_removed():
    """P6：recipe_loader 无 map_review_scorer；scoring 仅剩配置映射。"""
    from inkling_host import recipe_loader, scoring

    assert not hasattr(recipe_loader, "map_review_scorer")
    assert "map_review_scorer" not in recipe_loader.__all__
    assert not hasattr(scoring, "build_review_scorer")
    assert not hasattr(scoring, "dimension_scorer_with_facts")
    assert "build_review_scorer" not in scoring.__all__
    assert "dimension_scorer_with_facts" not in scoring.__all__
    assert hasattr(scoring, "build_review_scoring_config")


# ── P9：未注册 op 结构化错误 ──


def test_unregistered_op_returns_structured_error():
    """P9：未注册 op 双通道均返回结构化错误（不再抛 KeyError 原文）。"""
    bridge = _load_bridge()
    sync_raw = bridge.invoke("ghost.op.nonexistent", "{}")
    assert json.loads(sync_raw) == {
        "ok": False,
        "error": "unregistered_op",
        "op": "ghost.op.nonexistent",
    }
    async_raw = asyncio.run(bridge.invoke_async("ghost.op.nonexistent", "{}"))
    assert json.loads(async_raw) == {
        "ok": False,
        "error": "unregistered_op",
        "op": "ghost.op.nonexistent",
    }


# ── P10：按域拆分后注册表完整 ──


def test_domain_ops_registered_after_split():
    """P10：register_builtin_ops 按域拆分后，各域代表 op 均仍在注册表。"""
    bridge = _load_bridge()
    registered = set(bridge._OPS_SYNC) | set(bridge._OPS_ASYNC)
    for name in (
        "engine.rebuild",  # 引擎核心组
        "patch.apply",  # 补丁链组
        "engine.knowledge_add",  # 知识组
        "approval.gate_card_request",  # 流水线/审批组
        "graph.register_node_types",  # 图配方组
        "mcp.connect",  # MCP 组
        "engine.thread_branch",  # 会话/版本链组
        "engine.memory_query",  # 记忆/检索组
        "engine.canary_stub_round",  # 活跃态/试跑组
    ):
        assert name in registered, f"按域拆分后 op 缺失: {name}"


# ── llm_usage 帧收集（批 3a 遗留闭环）──


class _NoopTransport:
    async def send(self, event) -> None:
        pass


class _UsageEvent:
    def __init__(self, etype: str, payload: dict):
        self.type = etype
        self.payload = payload
        self.node = None


def test_llm_usage_frame_collection_feeds_snapshot():
    """llm_usage 事件帧经传输包裹收集 → metrics.snapshot 无参聚合。"""
    bridge = _load_bridge()
    transport = bridge._usage_collecting_transport(_NoopTransport())

    async def run():
        await transport.send(
            _UsageEvent("llm_usage", {"prompt_tokens": 120, "completion_tokens": 30})
        )
        await transport.send(_UsageEvent("llm_usage", {"prompt_tokens": 5}))
        await transport.send(_UsageEvent("user", {"content": "不计数"}))
        await transport.send(_UsageEvent("llm_usage", {"prompt_tokens": "bad"}))
        return await bridge._metrics_snapshot({})

    out = asyncio.run(run())
    assert out["ok"] is True
    assert out["llm"]["prompt_tokens_total"] == 125
    assert out["llm"]["completion_tokens_total"] == 30
    assert out["llm"]["tokens_total"] == 155
    assert out["llm"]["last_prompt_tokens"] == 5


def test_llm_usage_snapshot_explicit_frames_still_win():
    """metrics.snapshot 显式传入 llm_usage 帧时优先（桥侧累计为缺省）。"""
    bridge = _load_bridge()
    out = asyncio.run(
        bridge._metrics_snapshot(
            {"llm_usage": [{"prompt_tokens": 7, "completion_tokens": 3}]}
        )
    )
    assert out["llm"]["prompt_tokens_total"] == 7
    assert out["llm"]["tokens_total"] == 10


# ── E-P5：主回合入口收尾调参 ──


class _FakeResult:
    def __init__(self, reason: str, error: str | None = None):
        self.reason = reason
        self.state: dict = {}
        self.error = error


class _FakeEngine:
    def __init__(self, result: _FakeResult):
        self._result = result
        self.calls: list[dict] = []

    async def ainvoke(self, state, **kwargs):
        self.calls.append(kwargs)
        return self._result

    async def get_latest_interrupt(self, thread_id: str):
        return None


class _FakeRuntime:
    def __init__(self, engine: _FakeEngine):
        self.engine = engine
        self.tune_calls: list[tuple[bool, str]] = []

    def tune_after_round(self, *, failed: bool = False, error: str = "") -> None:
        self.tune_calls.append((failed, error))

    async def resume_run(self, thread_id, decision, **kwargs):
        return _FakeResult("reply")


class _FakeHost:
    def build_transport(self):
        return _NoopTransport()


def test_round_entry_continues_chain_for_cross_round_context():
    """回合入口续链：跨回合消息连续性 = continue_chain=True（引擎链级续接）。

    引擎侧 continue_chain 语义（chain_rebase/recovery）：读链尾 checkpoint
    为基底、输入覆盖、版本链续接链尾——不带此参数则每回合全新 state，
    模型拿不到上一回合的逐字消息，长会话上下文丢失。
    """
    bridge = _load_bridge()
    engine = _FakeEngine(_FakeResult("reply"))
    runtime = _FakeRuntime(engine)
    host = _FakeHost()
    asyncio.run(
        bridge.execute_round_to_reply(
            runtime, host, input_text="第二轮", thread_id="t1", round_id="r2"
        )
    )
    assert engine.calls, "回合入口必须驱动引擎一次"
    assert engine.calls[0].get("continue_chain") is True
    assert engine.calls[0].get("thread_id") == "t1"


def test_round_entry_carries_attachments_into_state():
    """：回合附件（引擎 Attachment 契约数组）随入口 state 注入。

    前端 round_send attachments → RoundRequest → execute_round_to_reply →
    state["attachments"] → llm 多模态用户消息面；空/缺省 = 纯文本回合。
    """
    bridge = _load_bridge()

    captured: dict = {}

    class _CaptureEngine(_FakeEngine):
        async def ainvoke(self, state, **kwargs):
            captured["state"] = state
            captured["kwargs"] = kwargs
            return self._result

    runtime = _FakeRuntime(_CaptureEngine(_FakeResult("reply")))
    host = _FakeHost()
    asyncio.run(
        bridge.execute_round_to_reply(
            runtime,
            host,
            input_text="描述这张图",
            thread_id="t1",
            round_id="r1",
            attachments=[
                {
                    "kind": "image",
                    "url": "~/inkling/attachments/a.png",
                    "name": "a.png",
                    "mime": "image/png",
                }
            ],
        )
    )
    assert captured["state"]["attachments"] == [
        {
            "kind": "image",
            "url": "~/inkling/attachments/a.png",
            "name": "a.png",
            "mime": "image/png",
        }
    ]
    assert captured["state"]["input"] == "描述这张图"
    assert captured["state"]["step_args"] == {}


def test_round_entry_attachments_default_empty():
    """：未传附件 → state.attachments = []（纯文本回合契约）。"""
    bridge = _load_bridge()

    captured: dict = {}

    class _CaptureEngine(_FakeEngine):
        async def ainvoke(self, state, **kwargs):
            captured["state"] = state
            return self._result

    runtime = _FakeRuntime(_CaptureEngine(_FakeResult("reply")))
    host = _FakeHost()
    asyncio.run(
        bridge.execute_round_to_reply(
            runtime, host, input_text="hi", thread_id="t1", round_id="r1"
        )
    )
    assert captured["state"]["attachments"] == []


def test_round_entry_tunes_after_round_success():
    """E-P5：主回合入口正常收尾 → tune_after_round(failed=False)。"""
    bridge = _load_bridge()
    runtime = _FakeRuntime(_FakeEngine(_FakeResult("reply")))
    host = _FakeHost()
    out = asyncio.run(
        bridge.execute_round_to_reply(
            runtime, host, input_text="hi", thread_id="t1", round_id="r1"
        )
    )
    assert out["reason"] == "reply"
    assert runtime.tune_calls == [(False, "")]


def test_round_entry_tunes_after_round_failure_signal():
    """E-P5：回合结果携带 error → tune_after_round(failed=True, error)。"""
    bridge = _load_bridge()
    runtime = _FakeRuntime(_FakeEngine(_FakeResult("reply", error="模型超时")))
    host = _FakeHost()
    asyncio.run(
        bridge.execute_round_to_reply(
            runtime, host, input_text="hi", thread_id="t1", round_id="r1"
        )
    )
    assert runtime.tune_calls == [(True, "模型超时")]


def test_round_entry_tunes_after_round_on_exception():
    """E-P5：回合执行抛异常 → 失败信号调参（不吞异常）。"""
    bridge = _load_bridge()

    class _BoomEngine(_FakeEngine):
        async def ainvoke(self, state, **kwargs):
            raise RuntimeError("回合引擎不可用")

    runtime = _FakeRuntime(_BoomEngine(_FakeResult("reply")))
    host = _FakeHost()
    raised = False
    try:
        asyncio.run(
            bridge.execute_round_to_reply(
                runtime, host, input_text="hi", thread_id="t1", round_id="r1"
            )
        )
    except RuntimeError:
        raised = True
    assert raised
    assert runtime.tune_calls == [(True, "回合执行异常（无结果）")]


def test_round_model_override_swaps_holder_llm_and_restores():
    """回合级选模型：holder llm 换入（llm_decider 数据面）→ 回合后恢复。"""
    from ink_engine.core.registry import GraphRegistries

    from inkling_host.graph_recipe import _specs_holder

    registries = GraphRegistries()
    holder = _specs_holder(registries)
    holder["llm"] = "default-llm"

    class _Engine:
        def __init__(self):
            self.seen_llm = None

        async def ainvoke(self, state, **kwargs):
            self.seen_llm = holder.get("llm")
            return _FakeResult("reply")

        async def get_latest_interrupt(self, thread_id):
            return None

    engine = _Engine()

    class _Runtime:
        def __init__(self):
            self.engine = engine
            self.graph_registries = registries

        def tune_after_round(self, *, failed: bool = False, error: str = "") -> None:
            pass

        async def resume_run(self, thread_id, decision, **kwargs):
            return _FakeResult("reply")

    class _Host(_FakeHost):
        def resolve_model_llm(self, provider, model_id):
            return f"model-llm:{model_id}"

    bridge = _load_bridge()
    asyncio.run(
        bridge.execute_round_to_reply(
            _Runtime(),
            _Host(),
            input_text="hi",
            thread_id="t1",
            round_id="r1",
            model={"provider": "openai_compat", "model_id": "kimi"},
        )
    )
    # 回合内 llm_decider 读到选定的模型；回合后恢复会话默认
    assert engine.seen_llm == "model-llm:kimi"
    assert holder.get("llm") == "default-llm"


def test_round_model_override_fail_open_without_resolver():
    """选模型解析缺失（host 无 resolve_model_llm）= 回落默认，不报错。"""
    bridge = _load_bridge()
    engine = _FakeEngine(_FakeResult("reply"))
    runtime = _FakeRuntime(engine)
    asyncio.run(
        bridge.execute_round_to_reply(
            runtime,
            _FakeHost(),
            input_text="hi",
            thread_id="t1",
            round_id="r1",
            model={"provider": "openai_compat", "model_id": "kimi"},
        )
    )
    assert len(engine.calls) == 1  # 正常执行（fail-open）


if __name__ == "__main__":
    test_web_search_bad_json_degrades_structurally()
    test_web_search_payload_carries_provider_not_key()
    test_web_search_no_key_env_payload_has_no_provider()
    test_dead_scoring_cluster_removed()
    test_unregistered_op_returns_structured_error()
    test_domain_ops_registered_after_split()
    test_llm_usage_frame_collection_feeds_snapshot()
    test_llm_usage_snapshot_explicit_frames_still_win()
    test_round_entry_tunes_after_round_success()
    test_round_entry_tunes_after_round_failure_signal()
    test_round_entry_tunes_after_round_on_exception()
    test_round_model_override_swaps_holder_llm_and_restores()
    test_round_model_override_fail_open_without_resolver()
    test_round_entry_continues_chain_for_cross_round_context()
    print("batch 6e bridge fixes all assertions passed")
