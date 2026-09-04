/**
 * 输入调配管线执行体 InputAssembler（assembly.py 移植）：多源统一预算
 * 分配 → 组装 → 激活留痕。「能全量则全量，放不下才裁剪」。预算分配复用
 * WeightedBudgetAllocator、组装复用 ContextAssembler——注入的分配器同时
 * 驱动组装与留痕（换策略即换产物，留痕与实际一致）。模块级辅助函数落
 * _helpers.ts，本文件只承载类本体。
 */

import { ContextAssembler } from '../context/context_assembler.js';
import { ContextSource, MODE_DROP } from '../context/context_types.js';
import { WeightedBudgetAllocator } from '../context/context_allocator.js';
import { GraphDefinitionError } from '../errors.js';
import {
  SOURCE_TOOL,
  _SOURCE_TYPES,
  AssemblyConfig,
  MODE_COMPRESSED,
  ratio_for,
} from './assembly_config.js';
import {
  ActivationRecord,
  AssemblyResult,
  InputAssemblyResult,
  SourceActivation,
} from './assembly_types.js';
import type { EntryCompressor } from './assembly_types.js';
import type { ActivationAggregator } from './activation_aggregator.js';
import {
  activation_for,
  entry_ref_of,
  group_sources,
  limit_tools,
  rollback_priority,
  source_with_content,
  tool_cap_note,
} from './_helpers.js';

/** InputAssembler 构造选项（Python kw-only 参数映射）。 */
export interface InputAssemblerOptions {
  allocator?: WeightedBudgetAllocator | null;
  compressor?: EntryCompressor | null;
  aggregator?: ActivationAggregator | null;
}

/** assemble 调用选项（调用点预算/版本快照）。 */
export interface AssembleOptions {
  total_budget?: number | null;
  version_snapshot?: Record<string, unknown> | null;
}

/** 输入调配管线执行体：多源统一预算分配 → 组装 → 激活留痕。 */
export class InputAssembler {
  readonly config: AssemblyConfig;
  private readonly _allocator: WeightedBudgetAllocator;
  private readonly _assembler: ContextAssembler;
  private readonly _compressor: EntryCompressor | null;
  private readonly _aggregator: ActivationAggregator | null;
  /** 全量路径分配器：门槛归零 = 预算足够时全部保留（零低分丢弃）。 */
  private readonly _keep_all: WeightedBudgetAllocator;

  constructor(config: AssemblyConfig | null = null, options: InputAssemblerOptions = {}) {
    this.config = config ?? new AssemblyConfig();
    this._allocator = options.allocator ?? new WeightedBudgetAllocator();
    // 组装器与留痕共用同一分配器：注入策略真实作用于产物（一次分配语义
    // ——分配决定 = 组装决定，留痕即事实）
    this._assembler = new ContextAssembler({ allocator: this._allocator });
    this._compressor = options.compressor ?? null;
    // 激活聚合器：每次调配留痕同步喂聚合器（空 = 不聚合）
    this._aggregator = options.aggregator ?? null;
    this._keep_all = new WeightedBudgetAllocator({
      keep_full_threshold: 0.0,
      truncate_min_score: 0.0,
      min_truncate_chars: 0,
    });
  }

  /** 留痕同步喂聚合器（聚合器为空 = 零影响）。 */
  private _feed_aggregator(record: ActivationRecord): ActivationRecord {
    if (this._aggregator !== null) {
      this._aggregator.record(record);
    }
    return record;
  }

  /**
   * 统一调配入口：多源 → 预算分配 → 组装 → 激活留痕。total_budget=None
   * 用配置默认；version_snapshot 按副本留存（外部改写不污染留痕）。
   */
  assemble(
    sources: readonly ContextSource[],
    options: AssembleOptions = {},
  ): AssemblyResult {
    if (!this.config.enabled) {
      throw new GraphDefinitionError('输入调配已禁用（enabled=False，调用点应走旧路径）');
    }
    const budget = options.total_budget ?? this.config.total_budget;
    if (budget <= 0) {
      throw new GraphDefinitionError(`装配总预算必须为正: ${budget}`);
    }
    const snapshot = options.version_snapshot ? { ...options.version_snapshot } : null;
    const grouped = group_sources(sources);
    const all_sources: ContextSource[] = [];
    for (const kind of _SOURCE_TYPES) all_sources.push(...(grouped[kind] ?? []));

    // 能全量则全量：总内容不超过预算 → 整包激活（集小无稀疏必要）。
    const total_chars = all_sources.reduce((acc, s) => acc + s.content.length, 0);
    if (total_chars <= budget) {
      return this._assemble_full(grouped, budget, snapshot);
    }
    // 放不下才裁剪：分级池预算两遍分配 + 逐池组装 + 源块边界回退。
    return this._assemble_truncated(grouped, all_sources, budget, snapshot);
  }

  /** 全量路径：工具激活数上限是独立护栏（每轮 3-14 个），被裁剪工具同留痕。 */
  private _assemble_full(
    grouped: Record<string, ContextSource[]>,
    budget: number,
    snapshot: Record<string, unknown> | null,
  ): AssemblyResult {
    const activated: ContextSource[] = [];
    const dropped_tools: ContextSource[] = [];
    for (const kind of _SOURCE_TYPES) {
      let group = grouped[kind] ?? [];
      if (kind === SOURCE_TOOL && group.length > this.config.max_tools) {
        const kept_tools = limit_tools(group, this.config.max_tools);
        const kept_ids = new Set<ContextSource>(kept_tools);
        for (const s of group) {
          if (!kept_ids.has(s)) dropped_tools.push(s);
        }
        group = kept_tools;
      }
      activated.push(...group);
    }
    const full_assembler = new ContextAssembler({ allocator: this._keep_all });
    const assembled = full_assembler.assemble(activated, { total_chars: budget });
    const allocations = this._keep_all.allocate(activated, budget);
    const activations: SourceActivation[] = allocations.map((a) =>
      activation_for(a.source, { char_limit: a.char_limit, mode: a.mode }),
    );
    activations.push(
      ...dropped_tools.map((s) =>
        activation_for(s, {
          char_limit: 0,
          mode: MODE_DROP,
          note: tool_cap_note(this.config.max_tools),
        }),
      ),
    );
    return new InputAssemblyResult(
      assembled.text,
      this._feed_aggregator(
        new ActivationRecord({
          total_budget: budget,
          assembled_chars: assembled.text.length,
          sources: activations,
          version_snapshot: snapshot,
        }),
      ),
    );
  }

  /**
   * 裁剪路径：分级池预算两遍分配——先按占比分池，再把无源池与取整余量
   * 二次回拨给有源池（缺源池预算不闲置：仅 context 源可用预算 ≈ 总预算）。
   */
  private _assemble_truncated(
    grouped: Record<string, ContextSource[]>,
    all_sources: ContextSource[],
    budget: number,
    snapshot: Record<string, unknown> | null,
  ): AssemblyResult {
    const present_kinds = _SOURCE_TYPES.filter(
      (kind) => (grouped[kind] ?? []).length > 0,
    );
    const pool_budgets: Record<string, number> = {};
    for (const kind of present_kinds) {
      pool_budgets[kind] = Math.trunc(budget * ratio_for(this.config, kind));
    }
    let pool_sum = 0;
    for (const kind of present_kinds) pool_sum += pool_budgets[kind] ?? 0;
    const remainder = Math.max(0, budget - pool_sum);
    let ratio_sum = 0;
    for (const kind of present_kinds) ratio_sum += ratio_for(this.config, kind);
    if (remainder > 0 && ratio_sum > 0) {
      for (const kind of present_kinds) {
        const extra = Math.trunc((remainder * ratio_for(this.config, kind)) / ratio_sum);
        pool_budgets[kind] = (pool_budgets[kind] ?? 0) + extra;
      }
    }
    const activations: SourceActivation[] = [];
    // 源块清单：逐池组装文本 + 该池激活留痕成对保存——全局预算回退按块整
    // 体丢弃（不切半句），被丢块的留痕同步改写
    const blocks: Array<[string, SourceActivation[]]> = [];
    for (const kind of present_kinds) {
      let pool_sources = grouped[kind] ?? [];
      const pool_budget = pool_budgets[kind] ?? 0;
      const group_activations: SourceActivation[] = [];
      if (kind === SOURCE_TOOL && pool_sources.length > this.config.max_tools) {
        const kept_tools = limit_tools(pool_sources, this.config.max_tools);
        const kept_ids = new Set<ContextSource>(kept_tools);
        for (const s of pool_sources) {
          if (!kept_ids.has(s)) {
            group_activations.push(
              activation_for(s, {
                char_limit: 0,
                mode: MODE_DROP,
                note: tool_cap_note(this.config.max_tools),
              }),
            );
          }
        }
        pool_sources = kept_tools;
      }
      if (pool_sources.length === 0) continue;
      const allocations = this._allocator.allocate(pool_sources, pool_budget);
      // 组装期条目内压缩：被截断源若挂了压缩钩子，用非破坏性摘要视图替代
      // 截断内容（原文不动）；压缩失败（空串）走默认截断。
      const kept: ContextSource[] = [];
      const compressed_ids = new Set<ContextSource>();
      for (const a of allocations) {
        if (a.char_limit <= 0) continue;
        if (this._compressor !== null && a.source.content.length > a.char_limit) {
          const compressed = this._compressor(a.source, a.char_limit) || '';
          if (compressed) {
            kept.push(source_with_content(a.source, compressed));
            compressed_ids.add(a.source);
            continue;
          }
        }
        kept.push(a.source);
      }
      if (kept.length === 0) {
        group_activations.push(
          ...allocations.map((a) =>
            activation_for(a.source, {
              char_limit: 0,
              mode: a.mode,
              note: a.reason,
            }),
          ),
        );
        activations.push(...group_activations);
        continue;
      }
      const assembled = this._assembler.assemble(kept, {
        total_chars: pool_budget,
      });
      for (const a of allocations) {
        group_activations.push(
          activation_for(a.source, {
            char_limit: a.char_limit,
            mode: compressed_ids.has(a.source) ? MODE_COMPRESSED : a.mode,
            note: a.char_limit <= 0 ? a.reason : '',
          }),
        );
      }
      if (assembled.text) blocks.push([assembled.text, group_activations]);
      activations.push(...group_activations);
    }
    let text = blocks.map((block) => block[0]).join('\n\n');
    // 粘合开销兜底：各分级池分别填满后拼接会超出总预算（每处边界两个分
    // 隔符）——按源块边界回退丢整块：按回退优先级排序，从尾部逐块回退直
    // 至不超预算，context 等高优池最后才被牺牲。被丢块留痕改写为 drop +
    // 归因 note，截断量随留痕记录。
    blocks.sort((x, y) => rollback_priority(y) - rollback_priority(x));
    let truncated_chars = 0;
    // 运行长度跟踪：迭代回退用累计字符数递减代替每轮重新 join 全文（块数
    // 上百时 O(n²) 不可忽视）；被丢块 = 块文本 + 尾部分隔符（2 字符）
    let joined_total = text.length;
    while (blocks.length > 0 && joined_total > budget) {
      const removed = blocks.pop() as [string, SourceActivation[]];
      const removed_chars = removed[0].length + (blocks.length > 0 ? 2 : 0);
      joined_total -= removed_chars;
      truncated_chars += removed_chars;
      for (const act of removed[1]) {
        if (act.char_limit <= 0) continue;
        for (let index = 0; index < activations.length; index++) {
          if (activations[index] === act) {
            activations[index] = new SourceActivation({
              source_type: act.source_type,
              title: act.title,
              weight: act.weight,
              relevance: act.relevance,
              char_limit: 0,
              mode: MODE_DROP,
              entry_ref: act.entry_ref,
              note: '全局预算回退：按源块边界丢整块（粘合开销超预算）',
            });
            break;
          }
        }
      }
    }
    text = blocks.map((block) => block[0]).join('\n\n');
    // 兜底防线：单块仍超预算（组装器异常，理论不可达）时最后硬截断
    if (text.length > budget) {
      truncated_chars += text.length - budget;
      text = text.slice(0, budget);
    }
    // 空装配保底：预算过小导致全部分配被丢弃时，保留最高优先源的可读片段
    // （宁可截断也不空手喂模型）。保底源追加到留痕，保留原有 drop 记录不
    // 整体替换——审计可见「哪些源被丢弃 + 哪个源保底」。
    if (text === '' && all_sources.length > 0) {
      let top = all_sources[0] as ContextSource;
      for (const s of all_sources) {
        if (
          s.score() > top.score() ||
          (s.score() === top.score() && s.priority > top.priority)
        ) {
          top = s;
        }
      }
      text = top.content.slice(0, budget);
      activations.push(
        activation_for(top, {
          char_limit: text.length,
          mode: 'fallback_keep',
          note: '空装配保底：仅保留最高优先源的可读片段',
        }),
      );
    }
    return new InputAssemblyResult(
      text,
      this._feed_aggregator(
        new ActivationRecord({
          total_budget: budget,
          assembled_chars: text.length,
          sources: activations,
          version_snapshot: snapshot,
          truncated_chars,
        }),
      ),
    );
  }
}
