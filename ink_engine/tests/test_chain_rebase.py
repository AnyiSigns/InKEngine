"""链级 rebase 单测：压缩规划/后端原语/引擎接线/恢复锚点边界。

覆盖：plan_compaction 纯函数（线性/分叉/短链/keep=1）；三后端压缩
原语（chain_index/delete/set_parent/trim，memory+sqlite 参数化）；
maybe_compact_chain 幂等与阈值；引擎多轮会话链长有界 + 恢复可用 +
事件裁剪；编辑重放跳过压缩；spawn 实例链压缩；压缩后锚点回溯
（窗口内子链锚点保留、窗口外退化从头执行）。
"""
from __future__ import annotations

import pytest
from conftest import make_engine

from ink_engine.core.chain_rebase import (
    CompactionPlan,
    maybe_compact_chain,
    plan_compaction,
)
from ink_engine.core.executor import Engine, RunOptions
from ink_engine.core.graph import Graph, TerminateReason
from ink_engine.core.recovery import collect_resume_anchors
from ink_engine.core.spawn import SPAWN_KEY
from ink_engine.core.storage import (
    ChainLink,
    CheckpointRecord,
    create_storage,
    validate_chain,
)


def _link(cid: int, parent: int | None, seq: int | None = None, path: tuple = (), reason=None) -> ChainLink:
    return ChainLink(
        checkpoint_id=cid,
        parent_id=parent,
        event_seq=cid * 2 if seq is None else seq,
        graph_path=path,
        reason=reason,
    )


def _cp(thread_id="t1", **kw) -> CheckpointRecord:
    return CheckpointRecord(
        checkpoint_id=0,
        thread_id=thread_id,
        node=kw.pop("node", "n"),
        **kw,
    )


# ── plan_compaction 纯函数 ──


def test_plan_linear_chain_window():
    """线性链 keep=3：保留尾 3 行，窗口最旧行改链头，其余删除，事件裁剪到窗口最旧 seq。"""
    links = [_link(i, i - 1 if i > 1 else None, seq=i * 2) for i in range(1, 11)]
    plan = plan_compaction(links, keep=3)
    assert plan == CompactionPlan(
        delete_ids=(1, 2, 3, 4, 5, 6, 7),
        rewire_ids=(8,),
        trim_before_seq=16,
    )


def test_plan_short_chain_noop():
    """链长 <= 窗口：整链保留，无改写无删除无裁剪。"""
    links = [_link(i, i - 1 if i > 1 else None) for i in range(1, 4)]
    assert plan_compaction(links, keep=3).is_empty
    assert plan_compaction(links, keep=10).is_empty


def test_plan_keep_one_keeps_leaf_only():
    links = [_link(i, i - 1 if i > 1 else None) for i in range(1, 6)]
    plan = plan_compaction(links, keep=1)
    assert plan.delete_ids == (1, 2, 3, 4)
    assert plan.rewire_ids == (5,)


def test_plan_fork_multi_leaf_windows():
    """分叉链（编辑重放侧支）：每叶各自保留窗口，共享祖先改写去重。"""
    # 主链 1←2←...←10；分支在 5 处分叉：5←b6←b7
    links = [_link(i, i - 1 if i > 1 else None) for i in range(1, 11)]
    links += [
        _link(100, 5),
        _link(101, 100),
    ]
    plan = plan_compaction(links, keep=3)
    # 主叶 10：窗口 8,9,10 → 改写 8；分枝叶 101：窗口 100,101,5 → 改写 5
    assert set(plan.delete_ids) == {1, 2, 3, 4, 6, 7}
    assert set(plan.rewire_ids) == {5, 8}
    # 执行后无悬挂：改写先行（窗口最旧行 parent → None），再删除
    kept = {link.checkpoint_id for link in links} - set(plan.delete_ids)
    by_id = {link.checkpoint_id: link for link in links}
    for cid in kept:
        parent = None if cid in plan.rewire_ids else by_id[cid].parent_id
        assert parent is None or parent in kept


def test_plan_empty_inputs():
    assert plan_compaction([], keep=3).is_empty
    assert plan_compaction([_link(1, None)], keep=0).is_empty


# ── 后端压缩原语（memory + sqlite 参数化）──


@pytest.fixture(params=["memory://", "sqlite:///:memory:"])
async def storage(request):
    store = create_storage(request.param)
    yield store
    await store.close()


async def _build_chain(storage, n: int = 10, thread_id: str = "t1"):
    prev = None
    for i in range(1, n + 1):
        rec = await storage.put_checkpoint(
            _cp(thread_id=thread_id, node=f"n{i}", state={"v": i}, parent_id=prev, event_seq=i * 2)
        )
        prev = rec.checkpoint_id
    return prev


async def test_chain_index_lightweight(storage):
    tail = await _build_chain(storage, n=3)
    links = await storage.chain_index("t1")
    assert [link.checkpoint_id for link in links] == [tail, tail - 1, tail - 2]  # 降序
    assert all(link.event_seq > 0 for link in links)
    # 轻量行：无 state 字段（压缩/回溯不需快照负载）
    assert not hasattr(links[0], "state")


async def test_compaction_roundtrip_memory_sqlite(storage):
    await _build_chain(storage, n=10)
    for i in range(1, 21):
        await storage.append_event("t1", _event(i))
    outcome = await maybe_compact_chain(storage, "t1", keep=3)
    assert outcome.removed == 7
    assert outcome.rewired == 1
    # 窗口最旧行 event_seq=16（第 8 行）→ 裁剪 seq <= 16 共 16 条
    assert outcome.trimmed == 16
    assert await storage.latest_event_seq("t1") == 20
    # 链一致 + 链尾保留 + 长度有界
    assert await validate_chain(storage, "t1") == []
    latest = await storage.get_latest_checkpoint("t1")
    assert latest is not None and latest.state == {"v": 10}
    links = await storage.chain_index("t1")
    assert len(links) == 3
    # 幂等：二次压缩空操作
    assert not (await maybe_compact_chain(storage, "t1", keep=3)).compacted


def _event(i: int):
    from ink_engine.core.events import EngineEvent

    return EngineEvent(seq=0, thread_id="t1", type="log", payload={"i": i})


async def test_compaction_threshold_noop(storage):
    await _build_chain(storage, n=3)
    outcome = await maybe_compact_chain(storage, "t1", keep=3)
    assert not outcome.compacted
    assert await validate_chain(storage, "t1") == []


async def test_compaction_keep_disabled(storage):
    await _build_chain(storage, n=10)
    assert not (await maybe_compact_chain(storage, "t1", keep=0)).compacted
    assert len(await storage.chain_index("t1")) == 10


async def test_delete_checkpoints_guards_latest(storage):
    """删除链尾兜底：误删叶行后链尾指针重算为剩余最大 id。"""
    await _build_chain(storage, n=3)
    links = await storage.chain_index("t1")
    tail_id = links[0].checkpoint_id
    await storage.delete_checkpoints("t1", [tail_id])
    latest = await storage.get_latest_checkpoint("t1")
    assert latest is not None and latest.checkpoint_id == links[1].checkpoint_id


# ── 压缩后恢复锚点回溯 ──


async def test_collect_anchors_after_compaction(storage):
    """窗口内子链锚点保留、顶层锚点正确、窗口外锚点消失（退化从头）。"""
    # 链：顶层 t1→t2 → 子链 s1→s2（reason=None）→ 顶层 t3（interrupted）
    rows = [
        (1, None, 0, (), None),
        (2, 1, 1, (), None),
        (3, 2, 2, ("sub",), None),  # 子链未完成锚点（窗口内）
        (4, 3, 3, ("sub",), "interrupted"),
        (5, 4, 4, (), "interrupted"),  # 顶层中断锚点
    ]
    tail_id = await _put_rows(storage, rows)
    tail = await storage.get_checkpoint(tail_id)
    top_anchor, resume_map = await collect_resume_anchors(storage, tail, {})
    assert top_anchor == 5
    assert resume_map == {("sub",): 4}

    # 压缩 keep=3：叶 5 窗口 = 5,4,3 → 改写 3；1,2 删除 → 子链锚点只剩 4
    await maybe_compact_chain(storage, "t1", keep=3)
    tail = await storage.get_checkpoint(tail_id)
    top_anchor, resume_map = await collect_resume_anchors(storage, tail, {})
    assert top_anchor == 5
    assert resume_map == {("sub",): 4}
    assert await validate_chain(storage, "t1") == []

    # 压缩 keep=1：窗口 = 5 → 子链锚点全部消失（退化从头执行），顶层锚点保留
    await maybe_compact_chain(storage, "t1", keep=1)
    tail = await storage.get_checkpoint(tail_id)
    top_anchor, resume_map = await collect_resume_anchors(storage, tail, {})
    assert top_anchor == 5
    assert resume_map == {}
    assert await validate_chain(storage, "t1") == []


async def _put_rows(storage, rows):
    prev_id = None
    for cid, parent, seq, path, reason in rows:
        rec = await storage.put_checkpoint(
            CheckpointRecord(
                checkpoint_id=0,
                thread_id="t1",
                node=f"n{cid}",
                state={"v": cid},
                parent_id=parent,
                event_seq=seq,
                graph_path=path,
                reason=reason,
            )
        )
        prev_id = rec.checkpoint_id
    return prev_id


# ── 引擎接线：多轮会话链长有界 ──


def _round_graph() -> Graph:
    """回合图：round 节点发事件并终止回合（reply），next 走回 round——
    每轮都真实执行（continue_chain 新回合从图入口重新执行；next 保留为
    环形边合法性验证，续链路径不经过它）。"""

    async def round_node(ctx):
        await ctx.emit("log", {"n": ctx.state.get("count", 0)})
        ctx.terminate("reply")
        return {"count": ctx.state.get("count", 0) + 1}

    async def next_node(ctx):
        return {"touched": True}

    g = Graph(name="rounds", entry="round")
    g.add_node("round", round_node)
    g.add_node("next", next_node)
    g.add_edge("round", "next")
    g.add_edge("next", "round")
    return g


async def test_engine_rounds_keep_chain_bounded(memory_storage):
    """continue_chain 多轮会话：链长有界（<= keep + 单轮行数），恢复与校验可用。"""
    engine = make_engine(
        _round_graph(), storage=memory_storage, checkpoint_keep=3
    )
    last = None
    for _ in range(8):
        result = await engine.ainvoke(
            state={} if last is None else {"count": last.get("count", 0)},
            thread_id="t1",
            continue_chain=last is not None,
        )
        last = result.state
    # 单轮 1 行（每轮从入口重新执行，round 终止即终态 checkpoint），
    # 轮次入口压缩 → 上界 = keep + 1
    links = await memory_storage.chain_index("t1")
    assert len(links) <= 5
    assert await validate_chain(memory_storage, "t1") == []
    # 续链继续可用：每轮 count 单调 +1
    assert last["count"] == 8
    result = await engine.ainvoke(
        state={"count": last["count"]},
        thread_id="t1",
        continue_chain=True,
    )
    assert result.reason == TerminateReason.REPLY
    assert result.state["count"] == 9


async def test_engine_edit_replay_skips_compaction(memory_storage):
    """编辑重放（parent_checkpoint 分叉）：跳过压缩，历史锚点保留。"""
    engine = make_engine(_round_graph(), storage=memory_storage, checkpoint_keep=0)
    for i in range(5):
        await engine.ainvoke(state={"count": i}, thread_id="t1", continue_chain=True)
    links = await memory_storage.chain_index("t1")
    # 禁用压缩时链完整：新回合从入口重新执行，每轮 1 行（round 终态）
    assert len(links) == 5
    # 开启压缩的分叉重放：入口跳过压缩，最老锚点仍可用
    old = links[-1]
    engine_fork = make_engine(_round_graph(), storage=memory_storage, checkpoint_keep=1)
    result = await engine_fork.ainvoke(
        state={},
        thread_id="t1",
        parent_checkpoint=old.checkpoint_id,
    )
    assert result.reason == TerminateReason.REPLY
    # 分叉后的普通轮次恢复压缩：链重新有界——分叉尾保留为第二叶根
    # （keep=1 每叶 1 行：旧链尾 + 分叉尾 = 2 根），新轮 1 行 → 共 3
    await engine_fork.ainvoke(
        state={}, thread_id="t1", continue_chain=True
    )
    links = await memory_storage.chain_index("t1")
    assert len(links) <= 4
    # 最新路径（恢复遍历路径）严格有界：叶 + 新轮 2 行
    assert await validate_chain(memory_storage, "t1") == []


async def test_engine_events_trimmed_after_compaction(memory_storage):
    """压缩连带事件裁剪：窗口外事件删除，恢复重放不受影响。"""
    engine = make_engine(_round_graph(), storage=memory_storage, checkpoint_keep=2)
    for i in range(6):
        await engine.ainvoke(state={"count": i}, thread_id="t1", continue_chain=True)
    latest = await memory_storage.latest_event_seq("t1")
    links = await memory_storage.chain_index("t1")
    assert len(links) <= 5  # keep=2 + 单轮 3 行
    tail = await memory_storage.get_latest_checkpoint("t1")
    assert tail is not None
    assert tail.event_seq <= latest  # 锚点不晚于日志
    # 恢复：重放区间 = 锚点之后（窗口外事件已被裁剪，无重复投递）
    engine2 = make_engine(_round_graph(), storage=memory_storage, checkpoint_keep=2)
    result = await engine2.ainvoke(
        state={"count": tail.state["count"]},
        thread_id="t1",
        continue_chain=True,
    )
    assert result.reason == TerminateReason.REPLY
    assert await memory_storage.latest_event_seq("t1") > latest  # seq 单调不回退


# ── spawn 实例链压缩 ──


def _sub_graph() -> Graph:
    async def sub_node(ctx):
        return {"sub_result": ctx.state.get("seed", 0) + 1}

    g = Graph(name="sub", entry="s1")
    g.add_node("s1", sub_node)
    g.add_exit("s1")
    return g


def _spawn_parent() -> Graph:
    async def route(ctx):
        return {SPAWN_KEY: [{"subgraph": _sub_graph(), "state": {"seed": 1}, "index": 0}]}

    g = Graph(name="parent", entry="route")
    g.add_node("route", route)
    g.add_exit("route")
    return g


async def test_spawn_instance_chain_bounded(memory_storage):
    """spawn 实例独立子链同样压缩：同父线程多轮后实例链长有界。"""
    engine = make_engine(_spawn_parent(), storage=memory_storage, checkpoint_keep=2)
    for _i in range(6):
        result = await engine.ainvoke(state={}, thread_id="t1")
        assert result.reason == TerminateReason.REPLY
    # 实例线程跨轮续接（链严格线性）→ 每轮 2 行（节点+终态），回合收尾压缩
    links = await memory_storage.chain_index("t1:spawn:0")
    assert len(links) <= 3
    assert await validate_chain(memory_storage, "t1:spawn:0") == []
    # 实例可继续恢复执行（链尾锚点完整）
    tail = await memory_storage.get_latest_checkpoint("t1:spawn:0")
    assert tail is not None and tail.state


# ── fail-open：宿主自定义存储缺原语不阻断 ──


class _NoCompactionStorage:
    """仅缺失压缩原语的宿主存储（其余委托内存后端）：压缩 fail-open 跳过。"""

    def __init__(self, inner) -> None:
        self._inner = inner

    def __getattr__(self, name):
        return getattr(self._inner, name)

    async def chain_index(self, thread_id):
        raise NotImplementedError("宿主存储未实现链索引")

    async def delete_checkpoints(self, thread_id, ids):
        raise NotImplementedError

    async def set_checkpoint_parent(self, thread_id, cid, parent):
        raise NotImplementedError

    async def trim_events(self, thread_id, before_seq):
        raise NotImplementedError


async def test_compaction_fail_open_partial_storage(memory_storage):
    """缺失压缩原语的后端：引擎入口不因压缩失败而中断执行。"""
    engine = Engine(
        _round_graph(),
        options=RunOptions(
            storage=_NoCompactionStorage(memory_storage),
            checkpoint_keep=3,
        ),
    )
    result = await engine.ainvoke(state={}, thread_id="t1")
    assert result.reason == TerminateReason.REPLY


# ── ENG5-10：压缩原子性（链尾版本戳）──


class _AdvancingTailStorage:
    """模拟压缩期并发推进：第二次 chain_index 返回链尾已前进的索引。

    压缩计划基于首次索引（tail=T），rewire 后重取索引发现链尾 != T
    （他引擎同 thread 续链）→ 本计划作废，跳过删除（fail-open）。
    """

    def __init__(self, inner) -> None:
        self._inner = inner
        self.index_calls = 0
        self.delete_called = False

    async def chain_index(self, thread_id):
        self.index_calls += 1
        links = await self._inner.chain_index(thread_id)
        if self.index_calls == 2:
            # 模拟并发推进：新链尾 = 旧链尾之后（parent 指向旧链尾）
            advanced = ChainLink(
                checkpoint_id=links[0].checkpoint_id + 100,
                parent_id=links[0].checkpoint_id,
                event_seq=links[0].event_seq + 1,
                graph_path=(),
                reason=None,
            )
            return [advanced, *links]
        return links

    async def set_checkpoint_parent(self, thread_id, cid, parent):
        await self._inner.set_checkpoint_parent(thread_id, cid, parent)

    async def delete_checkpoints(self, thread_id, ids):
        self.delete_called = True
        return await self._inner.delete_checkpoints(thread_id, ids)

    async def trim_events(self, thread_id, before_seq):
        return 0


async def test_compaction_skips_delete_on_concurrent_tail_advance(memory_storage):
    """ENG5-10 回归：rewire 与删除之间链尾被并发推进 → 计划作废，跳过删除。

    基于过期快照的删除会把新窗口内的行误裁；以计划期链尾为版本戳，
    删除前重取索引比对，链尾已前进 = 本计划作废（fail-open：压缩是
    尽力而为的维护操作，跳过不损坏数据）。
    """
    await _build_chain(memory_storage, n=10)
    for i in range(1, 21):
        await memory_storage.append_event("t1", _event(i))

    adv = _AdvancingTailStorage(memory_storage)
    outcome = await maybe_compact_chain(adv, "t1", keep=3)
    # rewire 已执行（无害），删除被跳过（版本戳不匹配）
    assert outcome.removed == 0
    assert outcome.rewired == 1
    assert not adv.delete_called
    assert len(await memory_storage.chain_index("t1")) == 10  # 行数未裁剪
    # 链仍一致（rewire 无害：归档链头脱离父链，校验器只走链尾路径）
    assert await validate_chain(memory_storage, "t1") == []


async def test_compaction_normal_path_still_compacts(memory_storage):
    """ENG5-10 反向确认：无并发推进时压缩照常执行（版本戳匹配）。"""
    await _build_chain(memory_storage, n=10)
    outcome = await maybe_compact_chain(memory_storage, "t1", keep=3)
    assert outcome.removed == 7
    assert outcome.rewired == 1
    assert len(await memory_storage.chain_index("t1")) == 3
    assert await validate_chain(memory_storage, "t1") == []
