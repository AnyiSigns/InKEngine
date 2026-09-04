/**
 * 上下文预算分配器接口与确定性默认实现（context.py 移植）。
 *
 * 分配器接口契约（实现替换策略 = 装配核心零改动）：
 * - 返回与输入等长的一一对应分配结果；
 * - 确定性：同一输入必得同一输出（业务可替换策略，换策略不改装配）；
 * - 总分配量不得超过 total_chars（预算硬上界）。
 *
 * WeightedBudgetAllocator 默认实现规则（score = weight × relevance 分档）：
 * 1. 剔除过期 / 空内容源；
 * 2. 跨源去重（同 dedup_key 保留优先级最高者）；
 * 3. score ≥ keep_full_threshold → 整源保留（受 max_chars 约束），
 *    按（优先级降序, score 降序）顺序填充预算，预算不足者降级为截断；
 * 4. 其余 score ≥ truncate_min_score → 按分配分占比分享剩余预算
 *    （水塘填充：超过可用长度的份额返还重新分配，跨轮份额累加、
 *    已整源保留者移出池锁定，防截断到比自己还短）；
 * 5. 份额低于 min_truncate_chars 或 score 低于门槛 → 丢弃。
 */

import {
  ContextSource,
  KEEP_FULL_THRESHOLD,
  MIN_TRUNCATE_CHARS,
  MODE_DROP,
  MODE_KEEP_FULL,
  MODE_TRUNCATE,
  SourceAllocation,
  TRUNCATE_MIN_SCORE,
} from './context_types.js';

/** 预算分配策略接口：源列表 + 总预算 → 逐源分配。 */
export interface BudgetAllocator {
  allocate(sources: readonly ContextSource[], total_chars: number): SourceAllocation[];
}

/** 跨源去重：同 dedup_key 只保留优先级最高者（插入序稳定）。 */
export function dedup_sources(sources: readonly ContextSource[]): ContextSource[] {
  const seen = new Map<string, ContextSource>();
  for (const src of sources) {
    if (src.dedup_key === null) continue;
    const prev = seen.get(src.dedup_key);
    if (
      prev === undefined ||
      src.priority > prev.priority ||
      (src.priority === prev.priority && src.score() > prev.score())
    ) {
      seen.set(src.dedup_key, src);
    }
  }
  const keys = new Set(seen.keys());
  return sources.filter(
    (s) => s.dedup_key === null || !keys.has(s.dedup_key) || seen.get(s.dedup_key) === s,
  );
}

/**
 * 确定性默认预算分配：高权重全保留、中权重截断、低权重丢弃。
 *
 * 时间基准：使用注入时钟 now（缺省 0，与 Python time.time 行为不同——
 * Python 默认走真实时间，本实现要求宿主显式注入以保纯函数可复现）。
 */
export class WeightedBudgetAllocator implements BudgetAllocator {
  readonly keep_full_threshold: number;
  readonly truncate_min_score: number;
  readonly min_truncate_chars: number;
  /** 时间源：created_at 缺省 / ttl 判定复用同一时钟。 */
  readonly now: () => number;

  constructor(
    options: {
      keep_full_threshold?: number;
      truncate_min_score?: number;
      min_truncate_chars?: number;
      now?: () => number;
    } = {},
  ) {
    const kft = options.keep_full_threshold ?? KEEP_FULL_THRESHOLD;
    const tms = options.truncate_min_score ?? TRUNCATE_MIN_SCORE;
    const mtc = options.min_truncate_chars ?? MIN_TRUNCATE_CHARS;
    if (!(kft >= 0 && kft <= 1)) {
      throw new RangeError(`全保留阈值必须在 [0, 1] 内: ${kft}`);
    }
    if (tms < 0 || tms > kft) {
      throw new RangeError(`截断门槛必须非负且不高于全保留阈值: ${tms}`);
    }
    if (mtc < 0) {
      throw new RangeError(`截断下限不能为负: ${mtc}`);
    }
    this.keep_full_threshold = kft;
    this.truncate_min_score = tms;
    this.min_truncate_chars = mtc;
    this.now = options.now ?? ((): number => 0);
  }

  /** 源的可用内容字符数（max_chars 兜底截断，保证单源也有上限）。 */
  private available_chars(source: ContextSource): number {
    const length = source.content.length;
    if (source.max_chars !== null) return Math.min(length, source.max_chars);
    return length;
  }

  allocate(sources: readonly ContextSource[], total_chars: number): SourceAllocation[] {
    if (total_chars < 0) {
      throw new RangeError(`总预算不能为负: ${total_chars}`);
    }
    const now = this.now();
    const alive = sources.filter((s) => s.content.trim() !== '' && !s.is_expired(now));
    const deduped = dedup_sources(alive);
    if (deduped.length === 0) return [];

    // 分档：全保留 / 截断 / 丢弃（score 升序为水塘填充顺序，插序稳定）
    const keep = deduped.filter((s) => s.score() >= this.keep_full_threshold);
    let trunc = deduped.filter(
      (s) => this.truncate_min_score <= s.score() && s.score() < this.keep_full_threshold,
    );
    const dropped = deduped.filter((s) => s.score() < this.truncate_min_score);
    const keepDesc = [...keep].sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return b.score() - a.score();
    });

    const allocations = new Map<ContextSource, SourceAllocation>();

    // 3. 全保留档顺序填充；预算不足者降级到截断池分享剩余
    let remaining = total_chars;
    const degraded: ContextSource[] = [];
    for (const src of keepDesc) {
      const avail = this.available_chars(src);
      if (remaining - avail >= 0) {
        allocations.set(
          src,
          new SourceAllocation(
            src,
            MODE_KEEP_FULL,
            avail,
            `高权重源全保留（score=${src.score().toFixed(2)}）`,
          ),
        );
        remaining -= avail;
      } else {
        degraded.push(src);
      }
    }
    if (degraded.length > 0) {
      trunc = [...trunc, ...degraded].sort((a, b) => b.score() - a.score());
    }

    // 4. 截断档水塘填充：每轮所有源按同一初始余额算份额，轮末统一扣减
    //    本轮实际分配额。跨轮累加：源在后续轮的份额是新增量而非覆写。
    //    已整源保留的源移出池锁定。
    let pool: ContextSource[] = trunc;
    while (pool.length > 0 && remaining > 0) {
      const total_score = pool.reduce((acc, s) => acc + s.score(), 0);
      if (total_score <= 0) {
        for (const src of pool) {
          if (!allocations.has(src)) {
            allocations.set(src, new SourceAllocation(src, MODE_DROP, 0, '分配分为零，无份额'));
          }
        }
        break;
      }
      const nextPool: ContextSource[] = [];
      let spent = 0;
      for (const src of pool) {
        const share = Math.trunc(remaining * src.score() / total_score);
        const avail = this.available_chars(src);
        const cur = allocations.get(src);
        const cur_limit = cur ? cur.char_limit : 0;
        if (cur_limit >= avail) {
          // 已整源保留：移出池锁定，不覆写不重复扣减
          continue;
        }
        if (share >= avail - cur_limit) {
          allocations.set(
            src,
            new SourceAllocation(
              src,
              MODE_TRUNCATE,
              avail,
              `预算份额 ${share} 超过可用长度，整源保留`,
            ),
          );
          spent += avail - cur_limit;
        } else if (cur_limit + share >= this.min_truncate_chars) {
          allocations.set(
            src,
            new SourceAllocation(
              src,
              MODE_TRUNCATE,
              cur_limit + share,
              `预算份额 ${share} 字符（累计 ${cur_limit + share}）`,
            ),
          );
          spent += share;
          nextPool.push(src);
        } else {
          // 份额低于下限：从未获得分配的源丢弃（其份额自然回流池
          // 重新分配）；已有累计分配的源保留现有结果并退出池
          if (cur === undefined) {
            allocations.set(
              src,
              new SourceAllocation(
                src,
                MODE_DROP,
                0,
                `预算份额 ${share} 低于下限 ${this.min_truncate_chars}，丢弃`,
              ),
            );
          }
        }
      }
      remaining -= spent;
      if (nextPool.length === 0 || nextPool.length >= pool.length) {
        // 全部封顶或份额无变化（精度收敛），退出防死循环
        pool = nextPool.length < pool.length ? nextPool : [];
      } else {
        pool = nextPool;
      }
    }

    for (const src of dropped) {
      allocations.set(
        src,
        new SourceAllocation(
          src,
          MODE_DROP,
          0,
          `分配分低于截断门槛（${src.score().toFixed(2)} < ${this.truncate_min_score}）`,
        ),
      );
    }
    // 兜底：预算耗尽前未进入分配池的源（如剩余预算为 0 的降级源）补丢弃标记
    for (const src of deduped) {
      if (!allocations.has(src)) {
        allocations.set(src, new SourceAllocation(src, MODE_DROP, 0, '预算耗尽'));
      }
    }
    const result = deduped.map((s) => allocations.get(s)!);
    // 预算硬上界契约：总分配量不得超过 total_chars。
    // 违反即分配器实现缺陷（编程错误），显式失败而非静默超预算。
    const total_allocated = result.reduce((acc, a) => acc + a.char_limit, 0);
    if (total_allocated > total_chars) {
      throw new Error(
        `预算分配超出硬上界: 分配 ${total_allocated} > 预算 ${total_chars}`,
      );
    }
    return result;
  }
}