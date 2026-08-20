"""补丁链单测：追加/替换/删除/组装（full/base_only/partial）/压扁/截断/分支。"""
from __future__ import annotations

import pytest

from ink_engine.core.patch_chain import AssembleMode, Patch, PatchChain, PatchOp


def test_append_to_list():
    chain = PatchChain(base={"items": ["a"]})
    chain.apply(Patch(op=PatchOp.APPEND, path=("items",), value="b"))
    assert chain.assemble() == {"items": ["a", "b"]}


def test_append_to_string():
    chain = PatchChain(base={"content": "你好"})
    chain.apply(Patch(op=PatchOp.APPEND, path=("content",), value="世界"))
    assert chain.assemble()["content"] == "你好世界"


def test_append_auto_create_list():
    chain = PatchChain(base={})
    chain.apply(Patch(op=PatchOp.APPEND, path=("drafts",), value="d1"))
    assert chain.assemble() == {"drafts": ["d1"]}


def test_replace_nested():
    chain = PatchChain(base={"a": {"b": 1}})
    chain.apply(Patch(op=PatchOp.REPLACE, path=("a", "b"), value=2))
    chain.apply(Patch(op=PatchOp.REPLACE, path=("c", "d"), value=3))  # 路径自动创建
    assert chain.assemble() == {"a": {"b": 2}, "c": {"d": 3}}


def test_replace_list_index():
    chain = PatchChain(base={"list": [1, 2, 3]})
    chain.apply(Patch(op=PatchOp.REPLACE, path=("list", 1), value=99))
    assert chain.assemble()["list"] == [1, 99, 3]


def test_replace_list_auto_extend():
    chain = PatchChain(base={"list": [1]})
    chain.apply(Patch(op=PatchOp.REPLACE, path=("list", 3), value="x"))
    assert chain.assemble()["list"] == [1, None, None, "x"]


def test_delete():
    chain = PatchChain(base={"keep": 1, "drop": 2})
    chain.apply(Patch(op=PatchOp.DELETE, path=("drop",)))
    assert chain.assemble() == {"keep": 1}


def test_delete_missing_is_idempotent():
    chain = PatchChain(base={"keep": 1})
    chain.apply(Patch(op=PatchOp.DELETE, path=("missing",)))
    assert chain.assemble() == {"keep": 1}


def test_append_to_non_container_raises():
    chain = PatchChain(base={"n": 42})
    chain.apply(Patch(op=PatchOp.APPEND, path=("n",), value=1))  # apply 只追加补丁
    with pytest.raises(TypeError):  # 组装时才暴露目标类型不合法
        chain.assemble()


def test_assemble_base_only():
    chain = PatchChain(base={"x": 1})
    chain.apply(Patch(op=PatchOp.REPLACE, path=("x",), value=2))
    assert chain.assemble(AssembleMode.BASE_ONLY) == {"x": 1}


def test_assemble_partial_range():
    chain = PatchChain(base={"log": ""})
    chain.apply(Patch(op=PatchOp.APPEND, path=("log",), value="a"))
    chain.apply(Patch(op=PatchOp.APPEND, path=("log",), value="b"))
    chain.apply(Patch(op=PatchOp.APPEND, path=("log",), value="c"))
    assert chain.assemble(AssembleMode.PARTIAL, start=0, end=2)["log"] == "ab"


def test_assemble_is_pure():
    base = {"x": 1}
    chain = PatchChain(base=base)
    chain.apply(Patch(op=PatchOp.REPLACE, path=("x",), value=2))
    out = chain.assemble()
    assert out == {"x": 2}
    # 原 base 与链不受组装影响（纯函数）
    assert base == {"x": 1}
    assert chain.assemble(AssembleMode.BASE_ONLY) == {"x": 1}


def test_rebase_flattens():
    chain = PatchChain(base={"n": 0})
    for i in range(1, 4):
        chain.apply(Patch(op=PatchOp.REPLACE, path=("n",), value=i))
    flat = chain.rebase()
    assert flat.base == {"n": 3}
    assert flat.length == 0
    # 原链保留（非破坏性）
    assert chain.length == 3


def test_truncate_keeps_prefix():
    chain = PatchChain(base={"log": ""})
    for ch in "abcde":
        chain.apply(Patch(op=PatchOp.APPEND, path=("log",), value=ch))
    chain.truncate(2)
    assert chain.assemble()["log"] == "ab"


def test_truncate_negative_raises():
    chain = PatchChain()
    with pytest.raises(ValueError):
        chain.truncate(-1)


def test_branch_shares_prefix():
    chain = PatchChain(base={"log": ""})
    chain.apply(Patch(op=PatchOp.APPEND, path=("log",), value="a"))
    chain.apply(Patch(op=PatchOp.APPEND, path=("log",), value="b"))
    branch = chain.branch(at=1)
    assert branch.assemble()["log"] == "a"
    # 分支追加不影响原链
    branch.apply(Patch(op=PatchOp.APPEND, path=("log",), value="x"))
    assert chain.assemble()["log"] == "ab"


def test_to_from_dict_roundtrip():
    chain = PatchChain(base={"items": []})
    chain.apply(Patch(op=PatchOp.APPEND, path=("items",), value="a"))
    chain.apply(Patch(op=PatchOp.REPLACE, path=("title",), value="t"))
    restored = PatchChain.from_dict(chain.to_dict())
    assert restored.assemble() == chain.assemble()
    assert restored.patches == chain.patches


def test_from_dict_tolerates_extra_fields():
    data = {"base": {"a": 1}, "patches": [{"op": "replace", "path": ["a"], "value": 2}]}
    chain = PatchChain.from_dict(data)
    assert chain.assemble() == {"a": 2}


def test_length():
    chain = PatchChain()
    assert chain.length == 0
    chain.apply(Patch(op=PatchOp.REPLACE, path=("a",), value=1))
    assert chain.length == 1


def test_assemble_result_isolated_from_chain():
    """P1 回归：组装产物修改不污染链（补丁 value 深拷贝入文档，
    修复前：产物与链共享 value 引用，二次组装结果被污染）。"""
    chain = PatchChain(base={})
    chain.apply(Patch(op=PatchOp.REPLACE, path=("doc",), value={"k": [1]}))
    doc = chain.assemble()
    doc["doc"]["k"].append(2)
    assert chain.assemble()["doc"] == {"k": [1]}


def test_assemble_append_value_isolated_from_chain():
    """P1 回归：append 补丁的 value 同样深拷贝入产物。"""
    chain = PatchChain(base={})
    chain.apply(Patch(op=PatchOp.APPEND, path=("items",), value={"k": [1]}))
    doc = chain.assemble()
    doc["items"][0]["k"].append(2)
    assert chain.assemble()["items"] == [{"k": [1]}]


def test_branch_deep_copies_patch_values():
    """P1 回归：branch 分支补丁深拷贝——修改分支不污染原链
    （修复前：浅拷贝共享 Patch.value，What-if 平行宇宙互相污染）。"""
    chain = PatchChain(base={})
    chain.apply(Patch(op=PatchOp.REPLACE, path=("doc",), value={"k": [1]}))
    branch = chain.branch()
    branch.patches[0].value["k"].append(9)
    assert chain.assemble()["doc"] == {"k": [1]}
