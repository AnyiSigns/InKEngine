/**
 * 块 → 物理输入（纯函数层）：被授权块清单 → 交既有调配管线的装配源条目。
 *
 * 分层衔接（§7.2）：白板只定义**可见性授权与块归属**，不定义**装载**。本模块把
 * 「被授权块集 + 作用域私有上下文」转成 ContextSource 装配源条目，交既有输入
 * 调配管线（ContextMixer/ContextAssembler/WeightedBudgetAllocator）统一预算
 * 分配、加权组装——不绕过也不复制这套机制。
 *
 * 预算域（预算分级中单列一域，产品侧三分先例 multi_agent_design §4.1/风险5）：
 * 总预算 = 0.8×cw（复用 resolve_compression_min_chars，缺失 200k 兜底）；调配
 * 切片 ≤25%（历史≤50%/调配≤25%/工具≤15%/余量10%）；切片内分两域：**协作域**
 * （task+N opinion+board）独立预算域（默认 60%），**主持人/用户面向域**
 * （conclusion/summary+私有上下文）占余量（40%）。域内按既有分配分比例预切
 * max_chars，域预算硬上界——意见块不能挤占结论，结论也不能挤占协作内容。
 *
 * 压缩/预算随作用域 model 走（§7.5）：同块集在不同 cw 下预算与裁切不同，属
 * 预期而非漂移；窗口参数一律走既有 resolve_compression_min_chars。
 *
 * 纯函数：调配切片不进 messages 通道（调用级临时拼接），不写会话状态。
 * 空块清单 = 与既有行为完全一致（零漂移）：默认字段 + 默认预算 4000。
 */

import {
  ContextSource,
  DEFAULT_BUDGET_CHARS,
  DEFAULT_RELEVANCE,
} from './context_types.js';
import { resolve_compression_min_chars } from './context_compression.js';

/** 被授权块类型（本地结构类型，与 core/whiteboard 的结构兼容；6A3 负责接真实类型）。 */
export type BlockKind = 'task' | 'opinion' | 'board' | 'conclusion' | 'summary';

/** 被授权块：白板按可见性授权后交给装载面的块（纯数据，不引用 core/whiteboard）。 */
export interface AuthorizedBlock {
  readonly kind: BlockKind;
  readonly owner: string;
  readonly content: string;
  readonly seq: number;
}

export type BudgetDomain = 'collab' | 'moderator';

/** 本轮输入总预算中调配切片的份额（产品侧三分先例：历史 ≤50%、调配 ≤25%、
 *  工具 ≤15%、余量 10%）。 */
export const ALLOCATION_SLICE_RATIO = 0.25;

/** 调配切片中协作域（task + N opinion + board）的份额：协作块是协作作用域
 *  调用的主干（多协作者场景 N 意见块是大头），故占调配切片过半；主持人域取
 *  余量（40%），是收口面（结论/摘要 + 私有上下文），量相对小。 */
export const COLLAB_DOMAIN_SHARE = 0.6;

/** 被授权块相关度：白板已按可见性授权，块内容即本次调用必相关（1.0）。
 *  据此 task/board/conclusion 的 score = weight×1.0 落入既有 keep_full（≥0.8）
 *  档，opinion/summary 落入截断档——复用既有三档分档，不另造第二套。 */
export const AUTHORIZED_BLOCK_RELEVANCE = 1.0;

/** 各块权重（命名常量 + 理由）：task 1.0 协作指令唯一源（keep_full）；opinion
 *  0.5 并行意见截断档水塘公平竞争；board 0.8 共享事实底座（keep_full）；
 *  conclusion 0.8 主持人裁决产物（keep_full）；summary 0.4 降级摘要（截断档）。
 *  权重可经 options.weights 覆盖（契约分化时域内优先序随权重移动）。 */
export const COLLAB_TASK_WEIGHT = 1.0;
export const COLLAB_OPINION_WEIGHT = 0.5;
export const COLLAB_BOARD_WEIGHT = 0.8;
export const MODERATOR_CONCLUSION_WEIGHT = 0.8;
export const MODERATOR_SUMMARY_WEIGHT = 0.4;

/** 私有上下文权重：与既有调配口径一致（weight=1.0，relevance 取默认 0.5）。 */
export const SCOPE_CONTEXT_WEIGHT = 1.0;

/** 块/上下文装配优先级（同域同分时排序键；跨域仍由 keep_full 先于截断填充）。 */
export const COLLAB_TASK_PRIORITY = 10;
export const COLLAB_BOARD_PRIORITY = 8;
export const COLLAB_OPINION_PRIORITY = 7;
export const MODERATOR_CONCLUSION_PRIORITY = 9;
export const MODERATOR_SUMMARY_PRIORITY = 6;
export const SCOPE_CONTEXT_PRIORITY = 5;

/** 装配源 type 标识（审计留痕「喂了什么」用；type 仅标签，无语义枚举）。 */
export const SOURCE_TYPE_TASK = 'block:task';
export const SOURCE_TYPE_OPINION = 'block:opinion';
export const SOURCE_TYPE_BOARD = 'block:board';
export const SOURCE_TYPE_CONCLUSION = 'block:conclusion';
export const SOURCE_TYPE_SUMMARY = 'block:summary';
export const SOURCE_TYPE_SCOPE_CONTEXT = 'scope.context';

const KINDS: readonly BlockKind[] = ['task', 'opinion', 'board', 'conclusion', 'summary'];

/** 构造选项（全部可选，覆盖命名常量默认值）。 */
export interface BlockSourceOptions {
  /** 调配切片占本轮输入总预算的比例（(0, 1]，默认 0.25）。 */
  allocation_slice_ratio?: number;
  /** 协作域占调配切片的比例（[0, 1]，默认 0.6）。 */
  collab_domain_share?: number;
  /** 各块类型权重覆盖（未列出的块用命名常量默认）。 */
  weights?: Partial<Record<BlockKind, number>>;
  /** 各块类型优先级覆盖。 */
  priorities?: Partial<Record<BlockKind, number>>;
}

/** 装配源条目 + 预算分解（交既有调配管线；budget_chars 为本次 mix 的 total_chars）。 */
export interface BlockSourceResult {
  /** 交既有调配管线的装配源条目（ContextSource[]）。 */
  readonly sources: readonly ContextSource[];
  /** 本次调配预算（交 ContextMixer/ContextAssembler 的 total_chars）。 */
  readonly budget_chars: number;
  /** 协作域预算（域内源 max_chars 之和 ≤ 该值，硬上界）。 */
  readonly collab_domain_budget: number;
  readonly moderator_domain_budget: number;
}

/** 块类型 → 装配元数据（标题/权重/优先级/type 标签/域归属）。 */
interface BlockMeta {
  readonly title: (seq: number) => string;
  readonly weight: number;
  readonly priority: number;
  readonly type: string;
  readonly domain: BudgetDomain;
}

const BLOCK_META: Record<BlockKind, BlockMeta> = {
  task: {
    title: () => '任务块',
    weight: COLLAB_TASK_WEIGHT,
    priority: COLLAB_TASK_PRIORITY,
    type: SOURCE_TYPE_TASK,
    domain: 'collab',
  },
  opinion: {
    title: (seq) => `意见块 #${seq}`,
    weight: COLLAB_OPINION_WEIGHT,
    priority: COLLAB_OPINION_PRIORITY,
    type: SOURCE_TYPE_OPINION,
    domain: 'collab',
  },
  board: {
    title: () => '白板块',
    weight: COLLAB_BOARD_WEIGHT,
    priority: COLLAB_BOARD_PRIORITY,
    type: SOURCE_TYPE_BOARD,
    domain: 'collab',
  },
  conclusion: {
    title: () => '结论块',
    weight: MODERATOR_CONCLUSION_WEIGHT,
    priority: MODERATOR_CONCLUSION_PRIORITY,
    type: SOURCE_TYPE_CONCLUSION,
    domain: 'moderator',
  },
  summary: {
    title: () => '摘要块',
    weight: MODERATOR_SUMMARY_WEIGHT,
    priority: MODERATOR_SUMMARY_PRIORITY,
    type: SOURCE_TYPE_SUMMARY,
    domain: 'moderator',
  },
};

/** 内部规划条目：域归属与权重已知但尚未定 max_chars（ContextSource 为冻结值，
 *  max_chars 须在构造前按域预算算好）。 */
interface PlannedSource {
  readonly type: string;
  readonly title: string | null;
  readonly content: string;
  readonly weight: number;
  readonly relevance: number;
  readonly priority: number;
  readonly domain: BudgetDomain;
  readonly seq: number;
  readonly owner: string;
  readonly kind: BlockKind | null;
  /** 域内按分配分比例预切的上限（cap_domain 填充；null = 未定/不限）。 */
  max_chars: number | null;
}

/**
 * 块 → 物理输入：被授权块清单 + 作用域私有上下文 + 模型 context_window →
 * 装配源条目 + 预算分解（纯函数，零状态）。空块清单 = 既有行为完全一致（单源
 * 私有上下文默认字段 + 默认预算 4000，无域切分）。校验失败一律 fail-closed——
 * 未知块类型可能是 6A3 接真实白板类型前的结构漂移，必须显式暴露。
 */
export function build_block_sources(
  blocks: readonly AuthorizedBlock[],
  scope_context: string,
  context_window: number | null | undefined,
  options: BlockSourceOptions = {},
): BlockSourceResult {
  if (!Array.isArray(blocks)) {
    throw new TypeError('blocks 必须是数组（被授权块清单）');
  }
  if (typeof scope_context !== 'string') {
    throw new TypeError('scope_context 必须是字符串');
  }
  validate_blocks(blocks);
  if (context_window !== null && context_window !== undefined) {
    if (!Number.isFinite(context_window) || context_window <= 0) {
      throw new RangeError(`模型 context_window 必须为正有限数: ${context_window}`);
    }
  }
  const slice_ratio = options.allocation_slice_ratio ?? ALLOCATION_SLICE_RATIO;
  const collab_share = options.collab_domain_share ?? COLLAB_DOMAIN_SHARE;
  if (!(slice_ratio > 0 && slice_ratio <= 1)) {
    throw new RangeError(`调配切片比例必须在 (0, 1] 内: ${slice_ratio}`);
  }
  if (!(collab_share >= 0 && collab_share <= 1)) {
    throw new RangeError(`协作域份额必须在 [0, 1] 内: ${collab_share}`);
  }
  validate_weight_overrides(options);

  if (blocks.length === 0) {
    return {
      sources: [
        new ContextSource(SOURCE_TYPE_SCOPE_CONTEXT, scope_context, {
          weight: SCOPE_CONTEXT_WEIGHT,
          priority: SCOPE_CONTEXT_PRIORITY,
        }),
      ],
      budget_chars: DEFAULT_BUDGET_CHARS,
      collab_domain_budget: 0,
      moderator_domain_budget: 0,
    };
  }

  // 预算链：本轮输入总预算 = 0.8×cw（既有压缩阈值实现，档案缺失 200k 兜底）
  // → 调配切片 ≤25% → 协作域 / 主持人域（余量回拨，缺源域预算不闲置）。
  const total_input_budget = resolve_compression_min_chars(context_window);
  const slice_budget = Math.trunc(total_input_budget * slice_ratio);
  const collab_budget = Math.trunc(slice_budget * collab_share);
  const moderator_budget = slice_budget - collab_budget;

  const planned: PlannedSource[] = [];
  for (const block of blocks) {
    const kind: BlockKind = block.kind;
    const meta = BLOCK_META[kind];
    planned.push({
      type: meta.type,
      title: meta.title(block.seq),
      content: block.content,
      weight: options.weights?.[kind] ?? meta.weight,
      relevance: AUTHORIZED_BLOCK_RELEVANCE,
      priority: options.priorities?.[kind] ?? meta.priority,
      domain: meta.domain,
      seq: block.seq,
      owner: block.owner,
      kind,
      max_chars: null,
    });
  }
  planned.push({
    type: SOURCE_TYPE_SCOPE_CONTEXT,
    title: null,
    content: scope_context,
    weight: SCOPE_CONTEXT_WEIGHT,
    relevance: DEFAULT_RELEVANCE,
    priority: SCOPE_CONTEXT_PRIORITY,
    domain: 'moderator',
    seq: -1,
    owner: '',
    kind: null,
    max_chars: null,
  });

  // 域内按既有分配分（weight × relevance）比例预切 max_chars：域预算硬上界由
  // 每源 max_chars 之和 ≤ 域预算保证（分配器 available_chars = min(len, max)）。
  cap_domain(planned, 'collab', collab_budget);
  cap_domain(planned, 'moderator', moderator_budget);

  const sources = planned.map(
    (p) =>
      new ContextSource(p.type, p.content, {
        title: p.title,
        weight: p.weight,
        relevance: p.relevance,
        priority: p.priority,
        max_chars: p.max_chars,
        meta: { domain: p.domain, kind: p.kind, owner: p.owner, seq: p.seq },
      }),
  );
  return {
    sources,
    budget_chars: slice_budget,
    collab_domain_budget: collab_budget,
    moderator_domain_budget: moderator_budget,
  };
}

/** 校验权重/优先级覆盖（fail-closed）：键必须是合法块类型，值必须为非负有限
 *  数——负权重会让 score 落入丢弃档并破坏域内预切分语义，显式拒绝。 */
function validate_weight_overrides(options: BlockSourceOptions): void {
  const overrides: Array<[string, Record<string, number> | undefined]> = [
    ['权重', options.weights],
    ['优先级', options.priorities],
  ];
  for (const [label, table] of overrides) {
    if (table === undefined) continue;
    for (const [kind, value] of Object.entries(table)) {
      if (!(KINDS as readonly string[]).includes(kind)) {
        throw new TypeError(`未知块类型（${label}覆盖）: ${kind}`);
      }
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new RangeError(`${label}覆盖必须为非负有限数: ${kind}=${String(value)}`);
      }
    }
  }
}

/** 校验被授权块结构（fail-closed）：kind 合法、owner 非空串、content 为串、
 *  seq 为非负整数。 */
function validate_blocks(blocks: readonly AuthorizedBlock[]): void {
  for (const block of blocks) {
    const raw = block as unknown as Record<string, unknown> | null;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TypeError('被授权块必须是对象');
    }
    const kind = raw['kind'];
    if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) {
      throw new TypeError(`未知块类型（fail-closed）: ${String(kind)}`);
    }
    const owner = raw['owner'];
    if (typeof owner !== 'string' || owner.trim() === '') {
      throw new TypeError('块作者 owner 必须为非空字符串');
    }
    const content = raw['content'];
    if (typeof content !== 'string') {
      throw new TypeError('块内容 content 必须为字符串');
    }
    const seq = raw['seq'];
    if (!Number.isInteger(seq) || (seq as number) < 0) {
      throw new RangeError(`块序号 seq 必须为非负整数: ${String(seq)}`);
    }
  }
}

/** 域内按分配分比例预切 max_chars（分到各规划的 max_chars 字段上）。 */
function cap_domain(planned: PlannedSource[], domain: BudgetDomain, budget: number): void {
  const entries = planned.filter((p) => p.domain === domain);
  if (entries.length === 0) return;
  const total_score = entries.reduce((acc, p) => acc + p.weight * p.relevance, 0);
  let assigned = 0;
  entries.forEach((p, idx) => {
    const share =
      total_score > 0
        ? Math.trunc((budget * (p.weight * p.relevance)) / total_score)
        : Math.trunc(budget / entries.length);
    // 末位补足截断余量，保证域预算被用尽且不超（域内分额总和 == budget）。
    const cap = idx === entries.length - 1 ? budget - assigned : share;
    p.max_chars = Math.max(0, cap);
    assigned += cap;
  });
}
