/**
 * 链级 rebase：checkpoint 版本链行数维度有界化（历史前缀归档压缩）。
 *
 * 问题背景：checkpoint 版本链每节点执行 +1 行、事件日志 append-only，
 * 行数随执行量线性增长且与快照值大小无关——恢复回溯/巡检为 O(链长) 次
 * 逐跳查询，备份/迁移/并发写冲突扫描范围随链长增长。
 *
 * 方案：链级 rebase（非 TTL 删除，不丢弃会话历史语义）——链长超出窗口后，
 * 把窗口外的历史前缀扁平化为「归档链头」：窗口外各行删除，每叶路径
 * 窗口最旧行改写 parent_id=None 成为新链头。checkpoint 为全量快照，
 * 归档链头状态 = 该路径窗口外最新快照，恢复锚点状态完整无信息丢失；
 * 损失的是窗口外逐节点粒度（节点级回溯/旧子链锚点退化为从头执行）。
 *
 * 事件日志同步裁剪：<= 归档链头 event_seq 的事件对任何保留锚点都不可达
 * （恢复重放区间 = 锚点 seq 之后，恒 > 归档链头 seq），一并删除防日志无界。
 *
 * 本模块只承担「纯函数规划」（plan_compaction）+「存储原语编排」
 * （maybe_compact_chain，宿主经 Storage seam 注入，不改写存储数据形态）。
 * 日志/审计留痕属观察面副作用，此处省略；后置一致性自检
 * （validate_chain）是 storage 模块语义，随其移植后再接线。
 */

/** 版本链轻量行索引（回溯/巡检/压缩用，不含 state 快照负载）。 */
export interface ChainLink {
  checkpoint_id: number;
  parent_id: number | null;
  event_seq: number;
  graph_path?: readonly string[];
  reason?: string | null;
}

/**
 * 压缩依赖的存储 seam：仅含链级 rebase 调用的四个原语
 * （storage.Storage 协议的子集，其余方法与本模块无关）。
 * 压缩原语缺省的后端由调用方 fail-open 兜底（版本链照常增长）。
 */
export interface Storage {
  chain_index(thread_id: string): Promise<ChainLink[]>;
  delete_checkpoints(thread_id: string, ids: number[]): Promise<number>;
  set_checkpoint_parent(
    thread_id: string,
    checkpoint_id: number,
    parent_id: number | null,
  ): Promise<number>;
  trim_events(thread_id: string, before_seq: number): Promise<number>;
}

/** 一次链压缩的执行计划（纯函数规划，由存储原语执行）。 */
export class CompactionPlan {
  delete_ids: number[];
  rewire_ids: number[];
  trim_before_seq: number;

  constructor(init: Partial<CompactionPlan> = {}) {
    this.delete_ids = init.delete_ids ?? [];
    this.rewire_ids = init.rewire_ids ?? [];
    this.trim_before_seq = init.trim_before_seq ?? 0;
  }

  get is_empty(): boolean {
    return (
      this.delete_ids.length === 0 &&
      this.rewire_ids.length === 0 &&
      this.trim_before_seq <= 0
    );
  }
}

/** 一次压缩的结果统计（审计留痕/测试断言用）。 */
export class CompactionOutcome {
  removed: number;
  rewired: number;
  trimmed: number;

  constructor(init: Partial<CompactionOutcome> = {}) {
    this.removed = init.removed ?? 0;
    this.rewired = init.rewired ?? 0;
    this.trimmed = init.trimmed ?? 0;
  }

  get compacted(): boolean {
    return this.removed > 0 || this.rewired > 0 || this.trimmed > 0;
  }
}

/**
 * 规划链压缩：每叶路径保留最近 keep 行，其余删除/改写/裁剪。
 *
 * 叶行 = 未被任何行引用为 parent 的行（链尾；fork 分叉产生多叶）。
 * 对每叶路径：自叶向上保留 keep 行（含叶）；路径长于窗口时窗口最旧行
 * 改写 parent_id=None 成为该路径归档链头（其父行随窗口外历史一并删除，
 * 多叶共享祖先时改写去重）；路径短于窗口时整路径保留，链头保持原状。
 *
 * keep <= 0 或空链返回空计划；无存活行（理论成环）同样返回空计划，
 * 不产生删除/裁剪副作用。
 */
export function plan_compaction(links: readonly ChainLink[], keep: number): CompactionPlan {
  if (keep <= 0 || links.length === 0) return new CompactionPlan();
  const byId = new Map<number, ChainLink>();
  for (const link of links) byId.set(link.checkpoint_id, link);
  const parentIds = new Set<number>();
  for (const link of links) {
    if (link.parent_id !== null) parentIds.add(link.parent_id);
  }
  const leaves = links.filter((link) => !parentIds.has(link.checkpoint_id));

  const survivors = new Set<number>();
  const rewire = new Set<number>();
  for (const leaf of leaves) {
    let cur: ChainLink | undefined = leaf;
    let lastKept: ChainLink | undefined;
    let hops = 0;
    while (cur !== undefined && hops < keep) {
      survivors.add(cur.checkpoint_id);
      lastKept = cur;
      hops += 1;
      cur = cur.parent_id !== null ? byId.get(cur.parent_id) : undefined;
    }
    if (lastKept !== undefined && lastKept.parent_id !== null) {
      // 窗口最旧行仍有父（链长于窗口）→ 改写为归档链头
      rewire.add(lastKept.checkpoint_id);
    }
  }

  if (survivors.size === 0) return new CompactionPlan();
  const deleteIds = links
    .filter((link) => !survivors.has(link.checkpoint_id))
    .map((link) => link.checkpoint_id);
  // 事件裁剪只随真实压缩（有行删除）触发：无删除的规划保持纯空操作，
  // 不意外裁剪日志（全量保留链的事件对巡检/审计仍可达）。
  let trimBefore = 0;
  if (deleteIds.length > 0) {
    trimBefore = Math.min(
      ...links.filter((link) => survivors.has(link.checkpoint_id)).map((link) => link.event_seq),
    );
  }
  return new CompactionPlan({
    delete_ids: deleteIds,
    rewire_ids: [...rewire].sort((a, b) => a - b),
    trim_before_seq: trimBefore,
  });
}

/**
 * 链长超窗口时执行链级 rebase（幂等：压缩后链长 <= 窗口则空操作）。
 *
 * 执行序：改写先行、删除在后（保留行永不悬挂）；事件裁剪最后（失败
 * 无害）。单次链索引查询即完成长度判定与规划——判定成本 O(1) 轮询，
 * 不随链长放大。
 *
 * 原子性护栏：压缩的改写/删除是多个存储原语的序列，计划与执行之间链
 * 可能被并发推进（多引擎实例同 thread 续链/嵌套子图写 checkpoint）——
 * 基于过期快照的删除会把新窗口内的行误裁。以计划期链尾 checkpoint_id
 * 为版本戳：删除前重取索引比对，链尾已前进 = 本计划作废，跳过删除
 * （fail-open：压缩是尽力而为的维护操作，跳过不损坏数据）。
 *
 * keep <= 0 = 禁用压缩；plan 为空直接跳过，避免每回合空转。
 */
export async function maybe_compact_chain(
  storage: Storage,
  thread_id: string,
  keep: number,
): Promise<CompactionOutcome> {
  if (keep <= 0) return new CompactionOutcome();
  const links = await storage.chain_index(thread_id);
  const plan = plan_compaction(links, keep);
  if (plan.is_empty) return new CompactionOutcome();
  const tailStamp = links.length > 0 ? (links[0] as ChainLink).checkpoint_id : null;

  // 改写先行（fail-safe）：改写未生效（行不存在/已并发删除）的链头会让
  // 后续删除制造悬挂父指针，故提前中止删除（跳过不损坏数据）。
  let rewired = 0;
  for (const checkpointId of plan.rewire_ids) {
    const affected = await storage.set_checkpoint_parent(thread_id, checkpointId, null);
    if (affected === 0) {
      return new CompactionOutcome({ rewired });
    }
    rewired += 1;
  }

  const fresh = await storage.chain_index(thread_id);
  if (fresh.length > 0 && tailStamp !== null && (fresh[0] as ChainLink).checkpoint_id !== tailStamp) {
    // 链尾已前进：计划期快照过期，删除作废（改写已执行，无害）
    return new CompactionOutcome({ rewired });
  }
  // 删除前重校验（并发编辑重放 fork 可能在计划后插入指向待删祖先的分支）：
  // 任何保留节点的父指针不得落在待删集内，否则删除后成悬挂。命中则跳过删除。
  const deleteSet = new Set(plan.delete_ids);
  const dangling = fresh
    .filter(
      (link) =>
        !deleteSet.has(link.checkpoint_id) &&
        link.parent_id !== null &&
        deleteSet.has(link.parent_id),
    )
    .map((link) => link.checkpoint_id);
  if (dangling.length > 0) {
    return new CompactionOutcome({ rewired });
  }
  const removed =
    plan.delete_ids.length > 0
      ? await storage.delete_checkpoints(thread_id, [...plan.delete_ids])
      : 0;
  const trimmed =
    plan.trim_before_seq > 0 ? await storage.trim_events(thread_id, plan.trim_before_seq) : 0;
  return new CompactionOutcome({ removed, rewired, trimmed });
}
