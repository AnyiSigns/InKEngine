/**
 * 加权上下文组装器：去重 + 预算分配 + 按块拼接（context.py 移植）。
 *
 * 块格式：有标题的源 = ``【标题】\n文本``，无标题 = 纯文本；
 * 块间 ``\n\n`` 分隔。预算硬上界 = total_chars（分隔符计入成本，
 * 末尾超界块跳过，兜底整串硬截断——保证输出永不超预算）。
 *
 * 装配顺序 = 分配优先级顺序（而非输入顺序）：分配结果已按优先级/
 * 分数定好谁 keep_full/truncate/drop，但 concatenate 若按输入序，预算
 * 紧张时前置低优截断源会先占预算、把后置高优 keep_full 源的内容二次
 * 截断挤出。重排只影响拼接顺序，不动分配结果（预算硬上界不变）。
 */

import {
  AssembledContext,
  ContextSource,
  DEFAULT_BUDGET_CHARS,
  DroppedSource,
  MODE_DROP,
  MODE_KEEP_FULL,
  MODE_TRUNCATE,
  SourceAllocation,
  SourceInclusion,
} from './context_types.js';
import { BudgetAllocator, WeightedBudgetAllocator } from './context_allocator.js';

/** 组装器构造选项。 */
export interface ContextAssemblerOptions {
  default_budget_chars?: number;
  /** 分配策略；非 null 时运行期校验 duck-type 满足 BudgetAllocator 协议。 */
  allocator?: BudgetAllocator | unknown | null;
}

/**
 * 加权组装：去重 + 预算分配 + 按块拼接（确定性层执行器）。
 */
export class ContextAssembler {
  readonly default_budget_chars: number;
  readonly allocator: BudgetAllocator;

  constructor(options: ContextAssemblerOptions = {}) {
    const d = options.default_budget_chars ?? DEFAULT_BUDGET_CHARS;
    if (d < 0) throw new RangeError(`默认预算不能为负: ${d}`);
    if (
      options.allocator !== undefined &&
      options.allocator !== null &&
      !is_budget_allocator(options.allocator)
    ) {
      // 协议运行期校验：注入的分配策略不满足协议（缺 allocate/签名漂移）
      // 在装配期暴露，而非执行期 AttributeError 炸链路
      const name =
        (options.allocator as { constructor?: { name?: string } }).constructor?.name ??
        'unknown';
      throw new TypeError(`allocator 须实现 BudgetAllocator 协议: ${name}`);
    }
    this.default_budget_chars = d;
    this.allocator = options.allocator ?? new WeightedBudgetAllocator();
  }

  /**
   * 确定性组装：源列表 → 预算内拼接文本 + 留痕。
   */
  assemble(sources: readonly ContextSource[], opts: { total_chars?: number | null } = {}): AssembledContext {
    const total = opts.total_chars ?? this.default_budget_chars;
    if (total < 0) throw new RangeError(`总预算不能为负: ${total}`);
    if (sources.length === 0) {
      return new AssembledContext('', [], [], total, 0, false);
    }

    const allocations = this.allocator.allocate(sources, total);
    // 装配顺序 = 分配优先级顺序：高优 keep_full 先拼（不再被前置低优挤占）。
    const order = indices_sorted_by_priority(allocations);
    const blocks: string[] = [];
    const included: SourceInclusion[] = [];
    const dropped: DroppedSource[] = [];
    let used = 0;
    for (const i of order) {
      const alloc = allocations[i]!;
      if (alloc.mode === MODE_DROP) {
        dropped.push(new DroppedSource(alloc.source.type, alloc.source.title, alloc.reason));
        continue;
      }
      let content = alloc.source.content.slice(0, alloc.char_limit);
      if (content.trim() === '') {
        dropped.push(new DroppedSource(alloc.source.type, alloc.source.title, '截断后为空'));
        continue;
      }
      const title = alloc.source.title;
      // 块成本 = 标题块【t】\n + 内容 + 块间分隔符 \n\n（首块无分隔符）
      // 【title】\n 实际为 len(title)+3（【/】/\n 各占 1），原 +2 少算 1
      const overhead = (title ? title.length + 3 : 0) + (blocks.length > 0 ? 2 : 0);
      if (used + overhead >= total) {
        // 标题/分隔符开销都放不下：整块无法呈现，丢弃（留痕可辨）
        dropped.push(new DroppedSource(alloc.source.type, alloc.source.title, '预算耗尽'));
        continue;
      }
      if (used + overhead + content.length > total) {
        // 内容超界：截断内容至剩余预算（标题保留）——分配层按内容长
        // 口径判全保留，块开销（标题/分隔符）会顶掉少量内容；
        // 截断保留而非整源丢弃，高优源必在场
        content = content.slice(0, total - used - overhead);
        if (content.trim() === '') {
          dropped.push(new DroppedSource(alloc.source.type, alloc.source.title, '预算耗尽'));
          continue;
        }
        dropped.push(
          new DroppedSource(
            alloc.source.type,
            alloc.source.title,
            `块开销截断 ${alloc.source.content.slice(0, alloc.char_limit).length - content.length} 字符`,
          ),
        );
      }
      const block = title ? `【${title}】\n${content}` : content;
      const cost = block.length + (blocks.length > 0 ? 2 : 0);
      blocks.push(block);
      used += cost;
      included.push(
        new SourceInclusion(alloc.source.type, alloc.source.title, alloc.mode, content.length),
      );
    }
    let text = blocks.join('\n\n');
    if (text.length > total) {
      // 兜底硬截断（分隔符累计误差防御）
      text = text.slice(0, total);
      used = text.length;
    }
    return new AssembledContext(text, included, dropped, total, used, false);
  }
}

/** 协议运行期校验（duck-typed）：allocator 有 allocate 方法即可。 */
function is_budget_allocator(value: unknown): value is BudgetAllocator {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { allocate?: unknown }).allocate === 'function'
  );
}

/** 按分配优先级排序的下标序列（drop 排末、priority 高在前、score 高在前、输入序稳定）。 */
function indices_sorted_by_priority(allocations: readonly SourceAllocation[]): number[] {
  const indices = allocations.map((_, i) => i);
  indices.sort((a, b) => {
    const aa = allocations[a]!;
    const bb = allocations[b]!;
    const dropA = aa.mode === MODE_DROP ? 1 : 0;
    const dropB = bb.mode === MODE_DROP ? 1 : 0;
    if (dropA !== dropB) return dropA - dropB;
    if (aa.source.priority !== bb.source.priority) {
      return bb.source.priority - aa.source.priority;
    }
    const scoreDiff = bb.source.score() - aa.source.score();
    if (scoreDiff !== 0) return scoreDiff;
    return a - b; // 同优先级的稳定序（输入序）
  });
  return indices;
}

/** MODE 常量重导出（公共 API 兼容 context.py `MODE_KEEP_FULL` 等命名）。 */
export { MODE_DROP, MODE_KEEP_FULL, MODE_TRUNCATE };