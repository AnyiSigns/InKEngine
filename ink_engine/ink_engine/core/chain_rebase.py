"""链级 rebase：checkpoint 版本链行数维度有界化（历史前缀归档压缩）。

问题背景：checkpoint 版本链每节点执行 +1 行、事件日志 append-only，
行数随执行量线性增长且与快照值大小无关——恢复回溯
（recovery.collect_resume_anchors）/巡检（storage.validate_chain）为
O(链长) 次逐跳查询，备份/迁移/并发写冲突扫描范围随链长增长。

方案：链级 rebase（非 TTL 删除，不丢弃会话历史语义）——链长超出窗口后，
把窗口外的历史前缀扁平化为「归档链头」：窗口外各行删除，每叶路径
窗口最旧行改写 parent_id=None 成为新链头。checkpoint 为全量快照，
归档链头状态 = 该路径窗口外最新快照，恢复锚点状态完整无信息丢失；
损失的是窗口外逐节点粒度（节点级回溯/旧子链锚点退化为从头执行）。

事件日志同步裁剪：<= 归档链头 event_seq 的事件对任何保留锚点都不可达
（恢复重放区间 = 锚点 seq 之后，恒 > 归档链头 seq），一并删除防日志无界。

不变量（压缩后仍满足写入期校验）：
- 每保留行的 parent 存在或为 None（改写先行、删除在后，任一步失败
  不产生悬挂父指针）；
- checkpoint_id 沿父链严格递减、event_seq 沿链单调不减（压缩不改值）；
- 链尾（max checkpoint_id = 叶行）恒保留（窗口按叶行回溯，叶必含）；
- 恢复语义：恢复锚点 = 最新链尾或其近祖（窗口内），锚点完整。

触发点：顶层 run/ainvoke 入口（编辑重放分叉除外——分叉锚点可能落在
窗口外）；spawn 实例回合收尾（实例独立子链同样压缩）。压缩失败
fail-open：跳过不阻断执行（宿主自定义存储未实现压缩原语时版本链
照常增长，功能不受损）。
"""
from __future__ import annotations

from dataclasses import dataclass

from .logging import get_logger
from .storage import ChainLink, Storage, validate_chain

logger = get_logger(__name__)


@dataclass(slots=True)
class CompactionPlan:
    """一次链压缩的执行计划（纯函数规划，由存储原语执行）。

    Attributes:
        delete_ids: 窗口外待删除行（按 checkpoint_id，不触发级联）。
        rewire_ids: 每叶路径窗口最旧行（改写 parent_id=None 成为新链头）。
        trim_before_seq: 事件日志裁剪边界（删除 seq <= 该值的事件；
            0 = 无需裁剪）。
    """

    delete_ids: tuple[int, ...] = ()
    rewire_ids: tuple[int, ...] = ()
    trim_before_seq: int = 0

    @property
    def is_empty(self) -> bool:
        return not self.delete_ids and not self.rewire_ids and self.trim_before_seq <= 0


@dataclass(slots=True)
class CompactionOutcome:
    """一次压缩的结果统计（审计留痕/测试断言用）。"""

    removed: int = 0
    rewired: int = 0
    trimmed: int = 0

    @property
    def compacted(self) -> bool:
        return self.removed > 0 or self.rewired > 0 or self.trimmed > 0


def plan_compaction(links: list[ChainLink], keep: int) -> CompactionPlan:
    """规划链压缩：每叶路径保留最近 ``keep`` 行，其余删除/改写/裁剪。

    叶行 = 未被任何行引用为 parent 的行（链尾；fork 分叉产生多叶）。
    对每叶路径：
    - 自叶向上保留 ``keep`` 行（含叶）；
    - 路径长于窗口时，窗口最旧行改写 parent_id=None 成为该路径归档链头
      （其父行随窗口外历史一并删除——多个叶共享祖先时改写去重）；
    - 路径短于窗口时整路径保留，链头保持原状（无改写）。

    Args:
        links: 整链行索引（:meth:`Storage.chain_index` 返回，id 降序）。
        keep: 每叶路径保留行数（>0；<=0 视为空计划）。

    Returns:
        CompactionPlan：删除/改写/事件裁剪清单。
    """
    if keep <= 0 or not links:
        return CompactionPlan()
    by_id = {link.checkpoint_id: link for link in links}
    parent_ids = {link.parent_id for link in links if link.parent_id is not None}
    leaves = [link for link in links if link.checkpoint_id not in parent_ids]

    survivors: set[int] = set()
    rewire: set[int] = set()
    for leaf in leaves:
        cur: ChainLink | None = leaf
        last_kept: ChainLink | None = None
        hops = 0
        while cur is not None and hops < keep:
            survivors.add(cur.checkpoint_id)
            last_kept = cur
            hops += 1
            cur = by_id.get(cur.parent_id)
        if last_kept is not None and last_kept.parent_id is not None:
            # 窗口最旧行仍有父（链长于窗口）→ 改写为归档链头
            rewire.add(last_kept.checkpoint_id)

    if not survivors:
        return CompactionPlan()
    delete_ids = [
        link.checkpoint_id for link in links if link.checkpoint_id not in survivors
    ]
    # 事件裁剪只随真实压缩（有行删除）触发：无删除的规划保持纯空操作，
    # 不意外裁剪日志（全量保留链的事件对巡检/审计仍可达）。
    trim_before = 0
    if delete_ids:
        trim_before = min(
            link.event_seq for link in links if link.checkpoint_id in survivors
        )
    return CompactionPlan(
        delete_ids=tuple(delete_ids),
        rewire_ids=tuple(sorted(rewire)),
        trim_before_seq=trim_before,
    )


async def maybe_compact_chain(
    storage: Storage, thread_id: str, *, keep: int
) -> CompactionOutcome:
    """链长超窗口时执行链级 rebase（幂等：压缩后链长 <= 窗口则空操作）。

    执行序：改写先行、删除在后（保留行永不悬挂）；事件裁剪最后（失败
    无害）。单次链索引查询即完成长度判定与规划——判定成本 O(1) 轮询，
    不随链长放大。

    原子性护栏（ENG5-10）：压缩的改写/删除是多个存储原语的序列，计划
    与执行之间链可能被并发推进（多引擎实例同 thread 续链/嵌套子图写
    checkpoint）——基于过期快照的删除会把新窗口内的行误裁。以计划期
    链尾 checkpoint_id 为版本戳：删除前重取索引比对，链尾已前进 =
    本计划作废，跳过删除（fail-open：压缩是尽力而为的维护操作，跳过后
    版本链照常增长，功能不受损；已执行的改写无害——重写行脱离父链成
    归档链头，下轮压缩会清理）。

    Args:
        storage: 存储服务。
        thread_id: 版本链归属线程。
        keep: 每叶路径保留行数（<=0 = 禁用压缩）。

    Returns:
        CompactionOutcome：删除/改写/裁剪统计（全 0 = 未触发）。
    """
    if keep <= 0:
        return CompactionOutcome()
    links = await storage.chain_index(thread_id)
    # 触发前先规划：plan 为空（多短叶链每叶路径 <= keep，无行需删除/改写）
    # 直接跳过后续操作，避免每回合空转（阈值与「每叶保留 keep 行」规划语义对齐）。
    plan = plan_compaction(links, keep)
    if plan.is_empty:
        return CompactionOutcome()
    tail_stamp = links[0].checkpoint_id if links else None
    # 改写先行（fail-safe）：set_checkpoint_parent 返回受影响行数，改写未
    # 生效（行不存在/已并发删除）的链头会让后续删除制造悬挂父指针，故提前
    # 中止删除（fail-open：压缩是维护操作，跳过不损坏数据）。
    rewired = 0
    for checkpoint_id in plan.rewire_ids:
        affected = await storage.set_checkpoint_parent(thread_id, checkpoint_id, None)
        if affected == 0:
            logger.error(
                f"压缩链头改写未生效（checkpoint #{checkpoint_id} 不存在），"
                f"中止删除避免悬挂父指针: thread={thread_id}"
            )
            return CompactionOutcome(rewired=rewired)
        rewired += 1
    fresh = await storage.chain_index(thread_id)
    if fresh and fresh[0].checkpoint_id != tail_stamp:
        # 链尾已前进：计划期快照过期，删除作废（改写已执行，无害）
        logger.warning(
            f"链压缩并发推进（链尾 {tail_stamp} -> {fresh[0].checkpoint_id}），"
            f"跳过删除，下轮入口重试: thread={thread_id}"
        )
        return CompactionOutcome(rewired=rewired)
    # 删除前重校验（并发编辑重放 fork 可能在计划后插入指向待删祖先的分支）：
    # 任何保留节点的父指针不得落在待删集内，否则删除后成悬挂。命中则跳过删除。
    delete_set = set(plan.delete_ids)
    dangling = [
        link.checkpoint_id
        for link in fresh
        if link.checkpoint_id not in delete_set
        and link.parent_id is not None
        and link.parent_id in delete_set
    ]
    if dangling:
        logger.warning(
            f"压缩删除前重校验命中悬挂风险（保留节点 {dangling} 的父指针落在待删集），"
            f"跳过删除避免悬挂父指针: thread={thread_id}"
        )
        return CompactionOutcome(rewired=rewired)
    removed = (
        await storage.delete_checkpoints(thread_id, list(plan.delete_ids))
        if plan.delete_ids
        else 0
    )
    trimmed = (
        await storage.trim_events(thread_id, plan.trim_before_seq)
        if plan.trim_before_seq > 0
        else 0
    )
    # 压缩后置自检：压缩产物须满足「每保留行 parent 存在或为 None」不变量。
    # 编辑重放分支的 event_seq 可能合法低于父锚点，故关闭 event_seq 单调性校验。
    violations = await validate_chain(storage, thread_id, check_event_seq=False)
    if violations:
        logger.error(
            f"压缩后置自检失败（链可能污染）: thread={thread_id} 违规={violations}"
        )
    return CompactionOutcome(removed=removed, rewired=rewired, trimmed=trimmed)


__all__ = [
    "CompactionOutcome",
    "CompactionPlan",
    "maybe_compact_chain",
    "plan_compaction",
]
