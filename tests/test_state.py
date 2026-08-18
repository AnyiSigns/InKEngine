"""状态通道 + reducer 注册表单测：累积型/内容型/合并型/覆盖型 + schema 合并。"""
from __future__ import annotations

from ink_engine.core.patch_chain import Patch, PatchChain, PatchOp
from ink_engine.core.state import (
    Channel,
    StateSchema,
    add_messages,
    get_reducer,
    last_value,
    merge_dicts,
    merge_metrics,
    patch_chain_reducer,
)


def test_add_messages_append():
    base = [{"id": "m1", "content": "hi"}]
    out = add_messages(base, [{"id": "m2", "content": "world"}])
    assert [m["id"] for m in out] == ["m1", "m2"]


def test_add_messages_replace_by_id():
    base = [{"id": "m1", "content": "old"}]
    out = add_messages(base, [{"id": "m1", "content": "new"}])
    assert len(out) == 1
    assert out[0]["content"] == "new"


def test_add_messages_remove():
    base = [{"id": "m1", "content": "a"}, {"id": "m2", "content": "b"}]
    out = add_messages(base, [{"id": "m1", "type": "RemoveMessage"}])
    assert [m["id"] for m in out] == ["m2"]


def test_add_messages_no_id_appends():
    base = [{"content": "a"}]
    out = add_messages(base, [{"content": "b"}])
    assert len(out) == 2


def test_merge_dicts_overlay_wins():
    assert merge_dicts({"a": 1, "b": 2}, {"b": 3}) == {"a": 1, "b": 3}


def test_merge_metrics_adds_numbers_and_merges_nested():
    out = merge_metrics(
        {"calls": 2, "nested": {"x": 1}, "only_base": "b"},
        {"calls": 3, "nested": {"y": 2}, "only_overlay": "o"},
    )
    assert out["calls"] == 5
    assert out["nested"] == {"x": 1, "y": 2}
    assert out["only_base"] == "b"
    assert out["only_overlay"] == "o"


def test_patch_chain_reducer_accumulates():
    chain = patch_chain_reducer(None, Patch(op=PatchOp.APPEND, path=("items",), value="a"))
    chain = patch_chain_reducer(chain, Patch(op=PatchOp.APPEND, path=("items",), value="b"))
    assert isinstance(chain, PatchChain)
    assert chain.assemble() == {"items": ["a", "b"]}


def test_patch_chain_reducer_same_object_no_duplicate():
    """overlay 与 base 同一对象（节点读链→就地追加→整链返回）→ 短路不重复。"""
    chain = PatchChain(base={"text": ""})
    chain.apply(Patch(op=PatchOp.APPEND, path=("text",), value="A"))
    result = patch_chain_reducer(chain, chain)
    assert result is chain
    assert chain.length == 1
    assert chain.assemble() == {"text": "A"}


def test_patch_chain_reducer_batch_and_chain():
    batch = [Patch(op=PatchOp.REPLACE, path=("x",), value=1)]
    chain = patch_chain_reducer(None, batch)
    chain = patch_chain_reducer(chain, PatchChain(base={}, patches=[Patch(op=PatchOp.REPLACE, path=("y",), value=2)]))
    assert chain.assemble() == {"x": 1, "y": 2}


def test_reducer_registry():
    assert get_reducer("add_messages") is add_messages
    assert get_reducer("merge_dicts") is merge_dicts
    assert get_reducer("merge_metrics") is merge_metrics
    assert get_reducer("patch_chain") is patch_chain_reducer
    assert get_reducer("last_value") is last_value
    assert get_reducer(None) is None


def test_schema_apply_with_reducer():
    schema = StateSchema(
        channels={"messages": Channel("add_messages"), "count": Channel()}
    )
    state = {"messages": [{"id": "m1"}], "count": 1}
    state = schema.apply(state, {"messages": [{"id": "m2"}], "count": 2})
    assert len(state["messages"]) == 2
    assert state["count"] == 2  # 裸通道覆盖


def test_schema_apply_unknown_channel_tolerant():
    schema = StateSchema()
    state = schema.apply({"a": 1}, {"unknown": 2})
    assert state == {"a": 1, "unknown": 2}


def test_schema_apply_none_overlay_noop():
    schema = StateSchema(channels={"a": Channel()})
    assert schema.apply({"a": 1}, {}) == {"a": 1}


def test_schema_add_api():
    schema = StateSchema()
    schema.add("messages", "add_messages")
    schema.add("plain")
    assert schema.channels["messages"].reducer == "add_messages"
    assert schema.channels["plain"].reducer is None
