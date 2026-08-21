"""族 2：状态与补丁链（test_02_state_patch.py）｜state/patch_chain/state_machine。

- 内置 reducer 全量各一例真实增量合并（add_messages/merge_dicts/
  merge_metrics/last_value/patch_chain）；自定义 reducer 注册
- PatchChain 全操作：append/assemble(full/base_only/partial)/rebase/
  truncate/branch
- 内容型补丁链落库 → 跨实例恢复组装；补丁链 + 状态通道组合
- StateMachine：状态转换=补丁 append/rollback 推导/非法转换拒绝（领域
  状态名自定义）

确定性机制用例（零模型调用）+ 1 条真实 LLM 用例（族门禁②）。
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.live

from ink_engine.core.llm.messages import Message  # noqa: E402
from ink_engine.core.patch_chain import (  # noqa: E402
    AssembleMode,
    Patch,
    PatchChain,
    PatchOp,
)
from ink_engine.core.state import StateSchema, register_reducer  # noqa: E402
from ink_engine.core.state_machine import StateMachine  # noqa: E402

register_reducer("collect_tags", lambda current, delta: "|".join(filter(None, (current, delta))))


# ----------------------------------------------------------------------
# 内置 reducer 真实增量合并
# ----------------------------------------------------------------------

def test_reducers_add_messages():
    schema = StateSchema({"messages": "add_messages"})
    state = schema.apply({}, {"messages": [Message(role="user", content="你好")]})
    state = schema.apply(state, {"messages": [Message(role="assistant", content="嗨")]})
    assert [m.content for m in state["messages"]] == ["你好", "嗨"]
    # 同 id 替换（编辑覆盖）
    edited = Message(role="user", content="你好（改）", id=state["messages"][0].id)
    state = schema.apply(state, {"messages": [edited]})
    assert len(state["messages"]) == 2
    assert state["messages"][0].content == "你好（改）"


def test_reducers_merge_dicts():
    schema = StateSchema({"meta": "merge_dicts"})
    state = schema.apply({}, {"meta": {"a": 1}})
    state = schema.apply(state, {"meta": {"b": 2}})
    assert state["meta"] == {"a": 1, "b": 2}  # 增量合并不覆盖


def test_reducers_merge_metrics():
    schema = StateSchema({"metrics": "merge_metrics"})
    state = schema.apply({}, {"metrics": {"calls": 3}})
    state = schema.apply(state, {"metrics": {"calls": 2, "errors": 1}})
    assert state["metrics"] == {"calls": 5, "errors": 1}  # 加和


def test_reducers_last_value_default():
    schema = StateSchema({"answer": "last_value"})
    state = schema.apply({}, {"answer": "第一版"})
    state = schema.apply(state, {"answer": "第二版"})
    assert state["answer"] == "第二版"  # 末值覆盖


def test_reducers_patch_chain_channel():
    schema = StateSchema({"doc": "patch_chain"})
    state = schema.apply({}, {"doc": PatchChain(base={"title": "T"})})
    state = schema.apply(
        state, {"doc": Patch(op=PatchOp.REPLACE, path=("title",), value="T2")}
    )
    doc = state["doc"]
    assert isinstance(doc, PatchChain)
    assert doc.assemble()["title"] == "T2"


def test_custom_reducer_registration():
    schema = StateSchema({"tags": "collect_tags"})
    state = schema.apply({}, {"tags": "a"})
    state = schema.apply(state, {"tags": "b"})
    assert state["tags"] == "a|b"  # 注册表默认含自定义实现


# ----------------------------------------------------------------------
# PatchChain 全操作
# ----------------------------------------------------------------------

def test_patch_chain_operations():
    chain = PatchChain(base={"items": [], "name": "n1"})
    chain.apply(Patch(op=PatchOp.APPEND, path=("items",), value="x"))
    chain.apply(Patch(op=PatchOp.APPEND, path=("items",), value="y"))
    chain.apply(Patch(op=PatchOp.REPLACE, path=("name",), value="n2"))
    assert chain.assemble() == {"items": ["x", "y"], "name": "n2"}
    # base_only：只回基础形态（不含补丁）
    assert chain.assemble(mode=AssembleMode.BASE_ONLY) == {"items": [], "name": "n1"}
    # partial：应用到第 N 条补丁为止
    assert chain.assemble(mode=AssembleMode.PARTIAL, end=1) == {"items": ["x"], "name": "n1"}
    # rebase：压扁为单 base（重放不变）
    rebased = chain.rebase()
    assert rebased.assemble() == chain.assemble()
    assert rebased.length == 0
    # truncate：仅保留前 N 条补丁（编辑重放 = 截断 + 新分支）
    branch = chain.branch()
    assert branch.assemble() == chain.assemble()
    chain.truncate(1)
    assert chain.assemble()["items"] == ["x"]
    assert chain.assemble()["name"] == "n1"
    # delete 操作
    chain.apply(Patch(op=PatchOp.DELETE, path=("name",)))
    assert "name" not in chain.assemble()


def test_patch_chain_roundtrip():
    chain = PatchChain(base={"v": 1})
    chain.apply(Patch(op=PatchOp.REPLACE, path=("v",), value=2))
    restored = PatchChain.from_dict(chain.to_dict())
    assert restored.assemble() == {"v": 2}
    assert restored.to_dict() == chain.to_dict()


# ----------------------------------------------------------------------
# 内容型补丁链落库 → 跨实例恢复
# ----------------------------------------------------------------------

async def test_patch_chain_persist_restore(sqlite_storage):
    chain = PatchChain(base={"title": "初版"})
    chain.apply(Patch(op=PatchOp.REPLACE, path=("title",), value="修订一"))
    chain.apply(Patch(op=PatchOp.REPLACE, path=("title",), value="修订二"))
    await sqlite_storage.put_record("documents", "doc:1", chain.to_dict())
    record = await sqlite_storage.get_record("documents", "doc:1")
    restored = PatchChain.from_dict(record)
    assert restored.assemble()["title"] == "修订二"
    # 补丁链 + 状态通道组合：补丁通道经 schema 增量合并
    schema = StateSchema({"doc": "patch_chain"})
    state = schema.apply({}, {"doc": restored})
    state = schema.apply(state, {"doc": Patch(op=PatchOp.REPLACE, path=("title",), value="修订三")})
    assert state["doc"].assemble()["title"] == "修订三"


# ----------------------------------------------------------------------
# StateMachine：转换日志 = 补丁链推导 / 非法拒绝
# ----------------------------------------------------------------------

def test_state_machine_transitions_and_rollback():
    machine = StateMachine(
        states={"draft", "review", "approved", "rejected", "archived"},
        terminal_states={"archived"},
        allowed={
            "draft": {"review", "rejected"},
            "review": {"approved", "rejected", "draft"},
            "approved": {"archived"},
            "rejected": {"draft"},
        },
        name="doc_flow",
    )
    log = machine.log(initial_state="draft")

    def guarded_append(to_state: str):
        """写时预检模式：非法转换拒绝（is_illegal_transition 为权威闸门）。"""
        if machine.is_illegal_transition(log.current_state, to_state):
            return None
        return log.append(to_state)

    assert guarded_append("review").to_state == "review"  # type: ignore[union-attr]
    assert guarded_append("approved").to_state == "approved"  # type: ignore[union-attr]
    assert guarded_append("archived").to_state == "archived"  # type: ignore[union-attr]
    assert log.current_state == "archived"
    # 终态单向：已归档不得转出（非法转换拒绝）
    assert machine.is_illegal_transition("archived", "draft") is True
    assert guarded_append("draft") is None  # 预检拒绝，日志不写
    # 白名单外转换拒绝
    assert machine.is_illegal_transition("draft", "archived") is True
    # rollback 推导：截断日志，当前状态重推
    assert log.rollback(1) == "approved"
    assert log.current_state == "approved"
    assert log.rollback(10) == "draft"  # 超长回滚 → 初始状态


def test_state_machine_custom_domain_states():
    machine = StateMachine(
        states={"pending", "running", "done"},
        terminal_states={"done"},
        name="pipeline",
    )
    assert machine.is_valid_state("running")
    assert machine.is_valid_state("bogus") is False
    assert machine.is_illegal_transition("done", "running") is True


# ----------------------------------------------------------------------
# 真实 LLM 回合：add_messages 增量合并 + checkpoint 落库（族门禁②）
# ----------------------------------------------------------------------

@pytest.mark.real
async def test_real_round_reducer_merge_and_checkpoint(live_llm, memory_storage):
    """真实 LLM 回合：add_messages 通道增量合并 + 补丁链/checkpoint 落库。"""
    from ink_engine.core.events import CollectorTransport
    from ink_engine.core.executor import Engine, RunOptions
    from ink_engine.core.graph import Graph, TerminateReason

    async def llm_node(ctx):
        result = await live_llm.ainvoke([Message(role="user", content="用一句话自我介绍")])
        await ctx.emit("reply", {"content": result.content})
        return {"messages": [Message(role="assistant", content=result.content)]}

    g = Graph(name="real_state", entry="start")
    g.add_node("start", lambda ctx: {"messages": [Message(role="user", content="你好")]})
    g.add_node("llm_node", llm_node)
    g.add_edge("start", "llm_node")
    g.add_exit("llm_node")

    schema = StateSchema({"messages": "add_messages"})
    engine = Engine(
        g,
        options=RunOptions(storage=memory_storage, schema=schema, transports=[CollectorTransport()]),
    )
    result = await engine.ainvoke({}, thread_id="real-state")
    assert result.reason == TerminateReason.REPLY
    contents = [m.content for m in result.state["messages"]]
    assert contents[0] == "你好"
    assert contents[-1].strip()  # 真实回复经 add_messages 增量合并入链
    cp = await memory_storage.get_latest_checkpoint("real-state")
    assert cp is not None and len(cp.state["messages"]) == 2
