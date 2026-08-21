"""族 19：数据契约（test_19_data_contracts.py）｜全模块「一切皆数据」形态契约。

覆盖全部模块的数据形态 round-trip 契约（to_dict/from_dict 或等价序列化 →
指纹一致）：Graph / Plan / WorkflowSpec / HarnessDefinition / RuleSet /
FixtureSet / KnowledgeEntry / SchemaSpec / UISpec / EventTypeSpec /
DeclarativeToolSpec / ToolManifest / ContextSource / AssemblyRecipe / EngineEvent
/ CheckpointRecord / PatchChain / ToolTrace / MemoryEntry / ApprovalDecision /
InterruptState / Message / ToolCall / LLMConfig / McpServerConfig / VettingResult
/ EnvironmentSpec / BuildSpec / Rule。

契约要点：
- 指纹稳定（同数据两次序列化指纹一致）；版本字段（事件协议 / checkpoint 记录）随
  序列化保留；
- 敏感键剥离贯穿三出口（导出 / 落库 / 事件）且同规格（core/security 的
  is_sensitive_key / strip_sensitive 纯函数）；知识集 / 补丁链导出导入契约无损；
- core/security 用例映射：is_sensitive_key 覆盖全部敏感键与后缀，strip_sensitive
  对 dict/list/tuple/PatchChain/嵌套递归剥离。

标记约定：`real` 标记 = 真实 LLM 调用（族门禁②，计入费用熔断）；其余为确定性
机制用例（零费用）。
"""
from __future__ import annotations

import dataclasses
import hashlib
import json

import pytest

pytestmark = pytest.mark.live

from ink_engine.core.approval import ApprovalDecision  # noqa: E402
from ink_engine.core.builder import BuildKind, BuildSpec  # noqa: E402
from ink_engine.core.context import ContextSource  # noqa: E402
from ink_engine.core.declarative_tools import DeclarativeToolSpec, EndpointType  # noqa: E402
from ink_engine.core.environments import EnvironmentSpec, RuntimeKind  # noqa: E402
from ink_engine.core.event_types import EventTypeSpec  # noqa: E402
from ink_engine.core.events import PROTOCOL_VERSION, EngineEvent  # noqa: E402
from ink_engine.core.graph import Graph, TerminateReason  # noqa: E402
from ink_engine.core.harness import HarnessDefinition  # noqa: E402
from ink_engine.core.interrupt import InterruptState  # noqa: E402
from ink_engine.core.knowledge_set import (  # noqa: E402
    KIND_RULE,
    LEVEL_WORK,
    SOURCE_MODEL,
    KnowledgeEntry,
    KnowledgeSet,
)
from ink_engine.core.llm.base import LLMConfig  # noqa: E402
from ink_engine.core.llm.messages import Message, ToolCall  # noqa: E402
from ink_engine.core.mcp_client import McpServerConfig, McpTransport  # noqa: E402
from ink_engine.core.memory import MemoryEntry  # noqa: E402
from ink_engine.core.patch_chain import Patch, PatchChain, PatchOp  # noqa: E402
from ink_engine.core.plan import KIND_NODES, KIND_PARALLEL, Plan, PlanStep  # noqa: E402
from ink_engine.core.registry import GraphRegistries  # noqa: E402
from ink_engine.core.rules import (  # noqa: E402
    RULE_CONSTRAINT,
    SEVERITY_WARNING,
    FixtureCase,
    FixtureSet,
    Rule,
    RuleSet,
)
from ink_engine.core.runtime import AssemblyRecipe  # noqa: E402
from ink_engine.core.schema_validator import FIELD_STRING, SchemaField, SchemaSpec  # noqa: E402
from ink_engine.core.security import SENSITIVE_KEYS, is_sensitive_key, strip_sensitive  # noqa: E402
from ink_engine.core.storage import CheckpointRecord  # noqa: E402
from ink_engine.core.tool_orchestrator import ToolTrace  # noqa: E402
from ink_engine.core.tool_vetting import (  # noqa: E402
    ShadowRunResult,
    ShadowWrite,
    ToolManifest,
    ToolSource,
    VettingCheck,
    VettingResult,
    VettingVerdict,
)
from ink_engine.core.ui_schema import (  # noqa: E402
    NODE_KIND_COMPONENT,
    NODE_KIND_CONTAINER,
    UIBind,
    UINode,
    UISpec,
)
from ink_engine.core.workflow import WorkflowEdgeSpec, WorkflowNodeSpec, WorkflowSpec  # noqa: E402


def _fp(data: dict) -> str:
    return hashlib.sha256(
        json.dumps(data, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
    ).hexdigest()


async def _noop_node(ctx):  # pragma: no cover - 图序列化测试不执行节点
    return {}


def _roundtrip_todict(obj) -> None:
    d = obj.to_dict()
    obj2 = type(obj).from_dict(d)
    assert obj2.to_dict() == d, f"{type(obj).__name__} 序列化不等价"
    assert _fp(obj2.to_dict()) == _fp(d), f"{type(obj).__name__} 指纹不稳定"


def _roundtrip_asdict(obj) -> None:
    d = dataclasses.asdict(obj)
    obj2 = type(obj)(**d)
    assert dataclasses.asdict(obj2) == d, f"{type(obj).__name__} 序列化不等价"
    assert _fp(dataclasses.asdict(obj2)) == _fp(d), f"{type(obj).__name__} 指纹不稳定"


def _vetting_from_dict(d: dict) -> VettingResult:
    return VettingResult(
        ok=d["ok"],
        verdict=VettingVerdict(d["verdict"]),
        checks=tuple(
            VettingCheck(name=c["name"], ok=c["ok"], detail=c["detail"])
            for c in d["checks"]
        ),
        shadow=None
        if d["shadow"] is None
        else ShadowRunResult(
            ok=d["shadow"]["ok"],
                writes=tuple(
                    ShadowWrite(path=w["path"], operation=w["operation"], size=w["size"])
                    for w in d["shadow"]["writes"]
                ),
                output=d["shadow"].get("output"),
                untrusted=d["shadow"]["untrusted"],
        ),
        reason=d["reason"],
    )


# ----------------------------------------------------------------------
# 全量数据形态 round-trip 契约
# ----------------------------------------------------------------------


def test_graph_roundtrip_and_digest():
    regs = GraphRegistries()
    regs.nodes.register("noop", lambda config: _noop_node)
    regs.edges.register("always", lambda ctx: True)
    g = Graph(name="demo", entry="a")
    g.add_node_type("a", "noop", {"k": 1})
    g.add_node_type("b", "noop", {})
    g.add_conditional_edge_by_name("a", "b", "always")
    g.add_exit("b")
    restored = Graph.from_dict(
        g.to_dict(), registry=regs.nodes, edge_registry=regs.edges
    )
    assert restored.to_dict() == g.to_dict(), "Graph 序列化不等价"
    assert restored.digest() == g.digest(), "Graph 内容指纹不稳定"


def test_plan_roundtrip():
    _roundtrip_todict(
        Plan(
            steps=(
                PlanStep(kind=KIND_NODES, nodes=("a", "b")),
                PlanStep(kind=KIND_PARALLEL, nodes=("c",)),
            ),
            index=1,
        )
    )


def test_workflow_spec_roundtrip():
    wf = WorkflowSpec(
        name="wf",
        nodes=(
            WorkflowNodeSpec(id="n1", type="noop", config={"x": 1}),
            WorkflowNodeSpec(id="n2", type="noop"),
        ),
        edges=(WorkflowEdgeSpec(source="n1", target="n2"),),
        entry="n1",
    )
    _roundtrip_asdict(wf)


def test_harness_definition_roundtrip():
    _roundtrip_todict(
        HarnessDefinition(
            name="h",
            description="d",
            keywords=("k1", "k2"),
            graph={
                "name": "g",
                "entry": "a",
                "nodes": {},
                "edges": {},
                "exits": [],
                "subgraphs": {},
                "schema": None,
            },
            tools=(
                {
                    "name": "t",
                    "description": "",
                    "parameters": {},
                    "permissions": ["filesystem:write:/x"],
                    "endpoint": "http_fetch",
                    "endpoint_config": {},
                    "meta": {},
                },
            ),
            schema=None,
            default_plan=None,
            meta={"src": "x"},
        )
    )


def test_ruleset_roundtrip():
    _roundtrip_todict(
        RuleSet(
            name="rs",
            rules=(
                Rule(
                    id="r1",
                    predicate="present",
                    config={"path": "x"},
                    kind="rule",
                    description="d",
                ),
            ),
            description="d",
        )
    )


def test_fixtureset_roundtrip():
    _roundtrip_todict(
        FixtureSet(
            name="fs",
            cases=(
                FixtureCase(
                    id="c1",
                    data={"x": 1},
                    expected_pass=True,
                    expected_kinds=("k1",),
                    description="d",
                ),
            ),
        )
    )


def test_knowledge_entry_roundtrip():
    _roundtrip_todict(
        KnowledgeEntry(
            id="k1",
            level=LEVEL_WORK,
            kind=KIND_RULE,
            data={"rule": {"message": "m"}},
            source=SOURCE_MODEL,
            credibility=0.7,
            title="t",
            tags=("a",),
            usage_count=2,
            fail_count=1,
            failure_logs=("e1",),
            archived=False,
            created_at=1.0,
            updated_at=2.0,
        )
    )


def test_schema_spec_roundtrip():
    _roundtrip_todict(
        SchemaSpec(
            name="sch",
            fields=(
                SchemaField(
                    name="f1",
                    required=True,
                    kind=FIELD_STRING,
                    enum=("a", "b"),
                    min=0.0,
                    max=10.0,
                    pattern="^a.*$",
                ),
            ),
        )
    )


def test_ui_spec_roundtrip():
    _roundtrip_todict(
        UISpec(
            name="ui",
            root=UINode(
                kind=NODE_KIND_CONTAINER,
                type="container",
                props={"p": 1},
                children=(
                    UINode(
                        kind=NODE_KIND_COMPONENT,
                        type="btn",
                        bind=UIBind(channel="state", path="x"),
                    ),
                ),
            ),
            theme={"color": "red"},
            version=2,
        )
    )


def test_event_type_spec_roundtrip():
    _roundtrip_todict(
        EventTypeSpec(
            name="et",
            schema=SchemaSpec(name="s", fields=()),
            renderer="r",
            system=False,
            meta={"m": 1},
        )
    )


def test_declarative_tool_spec_roundtrip():
    _roundtrip_todict(
        DeclarativeToolSpec(
            name="t",
            description="d",
            parameters={"type": "object"},
            permissions=("filesystem:write:/x",),
            endpoint=EndpointType.HTTP_FETCH,
            endpoint_config={"method": "GET"},
            meta={"m": 1},
        )
    )


def test_tool_manifest_roundtrip():
    _roundtrip_todict(
        ToolManifest(
            name="t",
            source=ToolSource.MARKET,
            signature="sig",
            hashes={"a.py": "x" * 64},
            permissions=("p:q",),
            dependencies=("dep",),
            meta={"m": 1},
        )
    )


def test_context_source_roundtrip():
    _roundtrip_asdict(
        ContextSource(
            type="knowledge",
            content="c",
            title="t",
            weight=0.9,
            relevance=0.5,
            priority=3,
            ttl=10,
            max_chars=100,
            dedup_key="dk",
            meta={"m": 1},
        )
    )


def test_assembly_recipe_data_shape():
    rec = AssemblyRecipe(
        set_id="u1",
        ui_allowed_components=("c1",),
        ui_allowed_theme_tokens=("tok",),
        harness_definitions=[HarnessDefinition(name="h")],
    )
    assert rec.set_id == "u1"
    assert rec.ui_allowed_components == ("c1",)
    assert rec.ui_allowed_theme_tokens == ("tok",)
    assert len(rec.harness_definitions) == 1


def test_engine_event_roundtrip_and_version():
    ev = EngineEvent(
        type="t",
        payload={"k": "v"},
        step_id="s1",
        parent_step_id="p1",
        round_id="r1",
        node="n1",
        graph_path=("g",),
        seq=1,
        trace_id="tr",
        thread_id="th",
        version=PROTOCOL_VERSION,
    )
    _roundtrip_todict(ev)
    assert EngineEvent.from_dict(ev.to_dict()).version == PROTOCOL_VERSION


def test_checkpoint_record_roundtrip_and_version():
    cp = CheckpointRecord(
        checkpoint_id=5,
        thread_id="th",
        node="n",
        graph_path=("g",),
        state={"a": 1},
        parent_id=3,
        reason=TerminateReason.REPLY,
        version=2,
        event_seq=4,
        error=None,
        interrupt=None,
        graph_version="gv",
        plan={"steps": [], "index": 0},
    )
    _roundtrip_todict(cp)
    assert CheckpointRecord.from_dict(cp.to_dict()).version == 2


def test_patch_chain_roundtrip():
    _roundtrip_todict(
        PatchChain(
            base={"x": 1},
            patches=[
                Patch(op=PatchOp.REPLACE, path=("x",), value=2),
                Patch(op=PatchOp.APPEND, path=("items",), value="y"),
            ],
        )
    )


def test_tool_trace_roundtrip():
    _roundtrip_todict(
        ToolTrace(
            tool="t",
            ok=False,
            decision="deny",
            args={"a": 1},
            error="e",
            duration_ms=5.0,
            thread_id="th",
            created_at=1.0,
            id="id1",
        )
    )


def test_memory_entry_roundtrip():
    _roundtrip_asdict(
        MemoryEntry(
            namespace="user:1",
            kind="k",
            content="c",
            id="id1",
            title="t",
            source="decision",
            priority=7,
            weight=0.8,
            meta={"m": 1},
            created_at=1.0,
            expires_at=10.0,
        )
    )


def test_approval_decision_roundtrip():
    _roundtrip_asdict(
        ApprovalDecision(
            decision="edit",
            action={"tool": "t", "args": {}},
            edited_content="x",
            reason="r",
            source="inject",
        )
    )


def test_interrupt_state_roundtrip():
    _roundtrip_todict(
        InterruptState(key="k", payload={"a": 1}, node="n", graph_path=("g",))
    )


def test_message_roundtrip():
    _roundtrip_todict(
        Message(
            role="assistant",
            content="hi",
            tool_calls=[ToolCall(id="c1", name="f", arguments='{"a":1}')],
            reasoning="think",
            id="id1",
        )
    )


def test_tool_call_roundtrip():
    tc = ToolCall(id="c1", name="f", arguments='{"a":1}')
    d = {"id": tc.id, "name": tc.name, "arguments": tc.arguments}
    assert dataclasses.asdict(ToolCall(**d)) == d


def test_llm_config_roundtrip():
    cfg = LLMConfig(
        adapter="openai_compat",
        model_id="m",
        base_url="http://x",
        api_key="sk-xyz",
        temperature=0.5,
        max_tokens=100,
        request_timeout=30.0,
        extra={"org": "o"},
    )
    _roundtrip_asdict(cfg)


def test_mcp_server_config_roundtrip():
    _roundtrip_todict(
        McpServerConfig(
            id="s1",
            transport=McpTransport.STDIO,
            headers={"Auth": "Bearer x"},
            command="node",
            args=("a.js",),
            env={"PATH": "x"},
            source=ToolSource.GITHUB,
            signature="sig",
        )
    )


def test_vetting_result_roundtrip():
    vr = VettingResult(
        ok=True,
        verdict=VettingVerdict.VERIFIED,
        checks=(VettingCheck(name="m", ok=True, detail="d"),),
        shadow=ShadowRunResult(
            ok=True,
            writes=(ShadowWrite(path="p", operation="write", size=3),),
            output="o",
            untrusted=True,
        ),
        reason="r",
    )
    restored = _vetting_from_dict(vr.to_dict())
    assert restored.to_dict() == vr.to_dict(), "VettingResult 序列化不等价"
    assert _fp(restored.to_dict()) == _fp(vr.to_dict()), "VettingResult 指纹不稳定"


def test_environment_spec_roundtrip():
    _roundtrip_todict(
        EnvironmentSpec(
            name="e",
            runtime=RuntimeKind.CONTAINER,
            tools=("node",),
            install_cmds=("npm i",),
            version="1.0",
            meta={"m": 1},
        )
    )


def test_build_spec_roundtrip():
    _roundtrip_todict(
        BuildSpec(
            kind=BuildKind.JS_BUNDLE,
            command="npm",
            args=("run", "build"),
            workdir="src",
            env={"NODE_ENV": "production"},
            timeout=60.0,
            output_paths=("dist/bundle.js",),
            meta={"m": 1},
        )
    )


def test_rule_roundtrip():
    _roundtrip_todict(
        Rule(
            id="r1",
            predicate="present",
            config={"path": "x"},
            type=RULE_CONSTRAINT,
            target_path="y",
            iterate_items=True,
            severity=SEVERITY_WARNING,
            kind="k",
            entity_type="et",
            description="d",
        )
    )


def test_knowledge_set_export_import_roundtrip():
    ks = KnowledgeSet("u1")
    ks.add(
        KnowledgeEntry(
            id="k1",
            level=LEVEL_WORK,
            kind=KIND_RULE,
            data={"rule": {"message": "m"}, "api_key": "sk-x"},
            source=SOURCE_MODEL,
            credibility=0.5,
        )
    )
    exported = ks.export()
    ks2 = KnowledgeSet.from_export("u1", exported)
    e2 = ks2.get("k1")
    assert e2 is not None and e2.data == {"rule": {"message": "m"}, "api_key": "sk-x"}


# ----------------------------------------------------------------------
# core/security：is_sensitive_key / strip_sensitive 纯函数三出口同规格
# ----------------------------------------------------------------------


def test_is_sensitive_key_covers_keys_and_suffixes():
    for key in SENSITIVE_KEYS:
        assert is_sensitive_key(key)
        assert is_sensitive_key(key.upper())
    for suf in ("_key", "_token", "_secret", "_password"):
        assert is_sensitive_key(f"custom{suf}")
    assert not is_sensitive_key("username")
    assert not is_sensitive_key("content")


def test_strip_sensitive_pure_function():
    data = {
        "api_key": "sk",
        "nested": {"token": "t"},
        "list": [{"secret": "s"}],
        "ok": "keep",
    }
    out = strip_sensitive(data)
    assert out["api_key"] == ""
    assert out["nested"]["token"] == ""
    assert out["list"][0]["secret"] == ""
    assert out["ok"] == "keep"
    pc = PatchChain(
        base={"password": "p"},
        patches=[Patch(op=PatchOp.REPLACE, path=("token",), value="x")],
    )
    pc2 = strip_sensitive(pc)
    assert pc2.base["password"] == "" and pc2.patches[0].value == "x"
    msg = Message(role="user", content="api_key=sk-123")
    assert "sk-123" in strip_sensitive(msg.to_dict())["content"]


async def test_security_three_outlets_strip_consistent(memory_storage):
    cred = "sk-abcdef1234567890"
    state = {"user": "u", "api_key": cred, "sub": {"token": cred}}
    ev = EngineEvent(type="reply", payload={"content": "ok", "api_key": cred})
    assert strip_sensitive(ev.to_dict())["payload"]["api_key"] == ""
    cp = CheckpointRecord(
        checkpoint_id=0,
        thread_id="t",
        node="n",
        version=1,
        state=state,
        reason=TerminateReason.REPLY,
    )
    cp_state = cp.to_dict()["state"]
    assert cp_state["api_key"] == "" and cp_state["sub"]["token"] == ""
    await memory_storage.put_record("coll", "d", {"user": "u", "secret": cred})
    rec = await memory_storage.get_record("coll", "d")
    assert rec["secret"] == "" and rec["user"] == "u"


# ----------------------------------------------------------------------
# real：真实 LLM 回合驱动三出口敏感键剥离
# ----------------------------------------------------------------------


@pytest.mark.real
async def test_real_roundtrip_sensitive_strip_three_outlets(live_llm, sqlite_storage):
    from ink_engine.core.llm.messages import user

    result = await live_llm.ainvoke([user("用一句话说明什么是数据契约。")])
    reply = result.content
    assert isinstance(reply, str) and reply.strip()
    cred = "sk-abcdef1234567890"
    # 1) 事件出口：真实回复与假凭据一并进入事件负载，凭据键被剥离
    event = EngineEvent(
        type="reply",
        payload={"content": reply, "api_key": cred, "nested": {"token": cred}},
    )
    ev_out = strip_sensitive(event.to_dict())
    assert ev_out["payload"]["api_key"] == ""
    assert ev_out["payload"]["nested"]["token"] == ""
    assert ev_out["payload"]["content"] == reply
    # 2) 落库出口：checkpoint 序列化剥离 state 内敏感键
    cp = CheckpointRecord(
        checkpoint_id=0,
        thread_id="t",
        node="n",
        version=1,
        state={"reply": reply, "secret": cred},
        reason=TerminateReason.REPLY,
    )
    cp_out = cp.to_dict()
    assert cp_out["state"]["secret"] == "" and cp_out["state"]["reply"] == reply
    # 3) 导出/落库出口：records 通道落库即剥离敏感键
    await sqlite_storage.put_record("coll", "doc", {"reply": reply, "authorization": cred})
    raw = await sqlite_storage.get_record("coll", "doc")
    assert raw["authorization"] == "" and raw["reply"] == reply
