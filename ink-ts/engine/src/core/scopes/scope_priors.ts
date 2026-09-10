/**
 * 默认组织先验素材（出厂预置的组织先验：起点，非写死拓扑）。
 *
 * 执行模型的「自治调度 = 生成即路由」：主持人按产物声明下一步去哪个作用域/
 * 过哪条通道/收。本素材把实验验证过的几类起点路线以**数据**形式沉淀下来
 * （编码任务 / 简单直答 / 需多方意见 / 专门子任务委托），供执行层在入场决策
 * 时参考；先验可被后续择优覆盖/降权/下架（组织档案择优语义），不是静态执行
 * 拓扑——执行不依赖本素材之外的任何固定图结构。
 *
 * 路线表达：hop = 一次作用域→作用域转场（from/to + 通道形态 + 可选提交契约
 * 覆写/并行数）；SINK = 直接结束回合给出最终答复（非通道、非作用域）。
 * to 引用目录作用域 id（默认素材引用出厂目录行：main/planner/coder/critic/
 * collaborator/subagent；约定见 scope_directory.ts）。
 */

import { GraphDefinitionError } from '../errors.js';
import { isRecord } from '../json.js';
import {
  CHANNEL_COMMITS,
  CHANNEL_COMMIT_FULL,
  CHANNEL_SHAPES,
  type ChannelCommit,
  type ChannelShape,
} from '../channels/channel_spec.js';

/** 收（SINK）：直接结束回合给出最终答复（非工具/作用域/通道）。 */
export const SCOPE_PRIOR_SINK = 'sink';

/** 先验 hop 形态：通道形态四值 + sink。 */
export type ScopePriorShape = ChannelShape | typeof SCOPE_PRIOR_SINK;

/** 单次转场 hop（sink 终态无 to；fan_out/fan_in 可带并行数）。 */
export interface ScopePriorHop {
  /** 起点作用域 id（目录作用域）。 */
  from: string;
  /** 目标作用域 id（sink 缺省）。 */
  to?: string;
  shape: ScopePriorShape;
  /** 并行路数（fan_out/fan_in 可选声明）。 */
  count?: number;
  /** 提交契约覆写（缺省 = 全量回传）。 */
  commit?: ChannelCommit | null;
}

/** 先验模式（一条组织的 scope×channel 起点路线）。 */
export interface ScopePriorPattern {
  id: string;
  label: string;
  /** 入口作用域（默认素材 = main 主持人）。 */
  entry_scope: string;
  /** 适用触发/任务分类标签（宿主/执行层按会话目标匹配）。 */
  trigger_kinds: readonly string[];
  /** 有序转场序列（末跳须为 sink）。 */
  hops: readonly ScopePriorHop[];
}

const VALID_HOP_SHAPES: readonly string[] = [...CHANNEL_SHAPES, SCOPE_PRIOR_SINK];

/** hop 形态取值校验（非法 = 抛错，防脏先验入素材面）。 */
function _valid_hop_shape(shape: string): asserts shape is ScopePriorShape {
  if (!VALID_HOP_SHAPES.includes(shape)) {
    throw new GraphDefinitionError(`先验 hop 形态非法: ${shape}`);
  }
}

/** 先验模式结构校验：形态词表/首跳入口/末跳 sink（须回到入口收口）/转场连续。 */
export function validate_scope_prior(pattern: ScopePriorPattern): void {
  if (pattern.id.trim() === '') throw new GraphDefinitionError('先验模式缺 id');
  if (pattern.hops.length === 0) {
    throw new GraphDefinitionError(`先验模式 ${pattern.id} 缺转场序列`);
  }
  for (let i = 0; i < pattern.hops.length; i++) {
    const hop = pattern.hops[i]!;
    _valid_hop_shape(hop.shape);
    const isLast = i === pattern.hops.length - 1;
    if (hop.shape === SCOPE_PRIOR_SINK) {
      if (!isLast) {
        throw new GraphDefinitionError(`先验模式 ${pattern.id} 的 sink 必须为末跳`);
      }
      if (hop.to !== undefined) {
        throw new GraphDefinitionError(`先验模式 ${pattern.id} 的 sink 跳不得带目标作用域`);
      }
      continue;
    }
    if (typeof hop.to !== 'string' || hop.to.trim() === '') {
      throw new GraphDefinitionError(`先验模式 ${pattern.id} 第 ${i} 跳缺目标作用域`);
    }
    if (hop.to === hop.from) {
      throw new GraphDefinitionError(`先验模式 ${pattern.id} 第 ${i} 跳自环（${hop.from}）`);
    }
    const count = hop.count;
    if (count !== undefined && (!Number.isInteger(count) || count < 1)) {
      throw new GraphDefinitionError(`先验模式 ${pattern.id} 第 ${i} 跳 count 须为正整数`);
    }
    if (hop.commit !== undefined && hop.commit !== null) {
      if (!(CHANNEL_COMMITS as readonly string[]).includes(hop.commit)) {
        throw new GraphDefinitionError(
          `先验模式 ${pattern.id} 第 ${i} 跳提交契约非法: ${String(hop.commit)}`,
        );
      }
    }
  }
  const first = pattern.hops[0]!;
  if (first.from !== pattern.entry_scope) {
    throw new GraphDefinitionError(
      `先验模式 ${pattern.id} 首跳起点须为入口作用域 ${pattern.entry_scope}`,
    );
  }
  // 末跳必须收口（sink）；缺席即路线悬空（无「直接结束回合」终态）
  const last = pattern.hops[pattern.hops.length - 1]!;
  if (last.shape !== SCOPE_PRIOR_SINK) {
    throw new GraphDefinitionError(`先验模式 ${pattern.id} 末跳须为 sink（收口）`);
  }
  // 收口回到入口作用域（汇聚点唯一面向用户的收敛；子执行经 return 归并，
  // 不各自对用户收口）
  if (last.from !== pattern.entry_scope) {
    throw new GraphDefinitionError(
      `先验模式 ${pattern.id} 末跳 sink 起点须回到入口作用域 ${pattern.entry_scope}`,
    );
  }
  // 转场连续：前一跳的目标作用域 = 后一跳起点（sink 恒在末跳，故前一跳必有 to）
  for (let i = 1; i < pattern.hops.length; i++) {
    const prev = pattern.hops[i - 1]!;
    const hop = pattern.hops[i]!;
    if (hop.from !== prev.to) {
      throw new GraphDefinitionError(
        `先验模式 ${pattern.id} 转场断链：第 ${i} 跳起点 ${hop.from} ≠ 第 ${i - 1} 跳目标 ${prev.to}`,
      );
    }
  }
}

/**
 * 出厂默认组织先验（每次返回新鲜数据）。
 *
 * 四条起点路线（实验验证过的起点，非写死拓扑）：
 * - coding：编码任务 main→planner→coder×N→critic→main→收；
 * - casual：简单/寒暄 main 直答（短路）；
 * - multi_opinion：需多方意见 main→collaborator×N→fan-in→main 裁决；
 * - delegation：专门子任务 main→subagent→回传。
 * 提交契约：coding 的分片归并端走 full（并行 coder 的补丁全量并入 critic
 * 审查，各片互补而非竞争择优，故不走 best）；多方意见归并走 full（意见全收，
 * 主持人裁决）；委托/回传走 full（全量归还）。仅声明素材：执行层按会话目标
 * 匹配 trigger，产物 `__next` 声明仍由主持人自治决定。
 */
export function default_scope_priors(): ScopePriorPattern[] {
  const hop = (
    from: string,
    shape: ScopePriorShape,
    to?: string,
    extra: { count?: number; commit?: ChannelCommit } = {},
  ): ScopePriorHop => {
    const out: ScopePriorHop = { from, shape };
    if (to !== undefined) out.to = to;
    if (extra.count !== undefined) out.count = extra.count;
    if (extra.commit !== undefined) out.commit = extra.commit;
    return out;
  };
  return [
    {
      id: 'coding',
      label: '编码任务链',
      entry_scope: 'main',
      trigger_kinds: ['coding', 'patch'],
      hops: [
        hop('main', 'delegate', 'planner'),
        hop('planner', 'fan_out', 'coder', { count: 3, commit: CHANNEL_COMMIT_FULL }),
        hop('coder', 'fan_in', 'critic', { commit: CHANNEL_COMMIT_FULL }),
        hop('critic', 'return', 'main'),
        hop('main', SCOPE_PRIOR_SINK),
      ],
    },
    {
      id: 'casual',
      label: '简单/寒暄直答',
      entry_scope: 'main',
      trigger_kinds: ['casual', 'greeting'],
      hops: [hop('main', SCOPE_PRIOR_SINK)],
    },
    {
      id: 'multi_opinion',
      label: '多方意见召集',
      entry_scope: 'main',
      trigger_kinds: ['multi_opinion', 'consensus'],
      hops: [
        hop('main', 'fan_out', 'collaborator', { count: 3, commit: CHANNEL_COMMIT_FULL }),
        hop('collaborator', 'fan_in', 'main', { commit: CHANNEL_COMMIT_FULL }),
        hop('main', SCOPE_PRIOR_SINK),
      ],
    },
    {
      id: 'delegation',
      label: '专门子任务委托',
      entry_scope: 'main',
      trigger_kinds: ['delegation', 'subtask'],
      hops: [
        hop('main', 'delegate', 'subagent'),
        hop('subagent', 'return', 'main'),
        hop('main', SCOPE_PRIOR_SINK),
      ],
    },
  ];
}

/** 先验模式序列化（from_dict 的逆映射；round-trip 保持全字段，空 label
 *  省略——与 from_dict 缺省回落一致；覆写持久化/审计读面用）。 */
export function scope_prior_to_dict(pattern: ScopePriorPattern): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: pattern.id,
    entry_scope: pattern.entry_scope,
    hops: pattern.hops.map((hop) => {
      const item: Record<string, unknown> = { from: hop.from, shape: hop.shape };
      if (hop.to !== undefined) item['to'] = hop.to;
      if (hop.count !== undefined) item['count'] = hop.count;
      if (hop.commit !== undefined && hop.commit !== null) item['commit'] = hop.commit;
      return item;
    }),
  };
  if (pattern.label) out['label'] = pattern.label;
  if (pattern.trigger_kinds.length > 0) out['trigger_kinds'] = [...pattern.trigger_kinds];
  return out;
}

/** 先验素材解析/校验入口（从 JSON dict 反序列化 + 结构校验；非法抛错）。 */
export function scope_prior_from_dict(data: unknown): ScopePriorPattern {
  if (!isRecord(data)) throw new GraphDefinitionError('先验模式声明须为 dict');
  const id = data['id'];
  const entryScope = data['entry_scope'];
  const hops = data['hops'];
  if (typeof id !== 'string' || id.trim() === '') {
    throw new GraphDefinitionError('先验模式缺 id');
  }
  if (typeof entryScope !== 'string' || entryScope.trim() === '') {
    throw new GraphDefinitionError(`先验模式 ${id} 缺 entry_scope`);
  }
  if (!Array.isArray(hops) || hops.length === 0) {
    throw new GraphDefinitionError(`先验模式 ${id} 缺转场序列 hops`);
  }
  const triggerKinds = data['trigger_kinds'];
  if (
    triggerKinds !== undefined
    && (!Array.isArray(triggerKinds) || triggerKinds.some((k) => typeof k !== 'string'))
  ) {
    throw new GraphDefinitionError(`先验模式 ${id} 的 trigger_kinds 须为字符串清单`);
  }
  const parsedHops: ScopePriorHop[] = hops.map((rawHop) => {
    if (!isRecord(rawHop)) throw new GraphDefinitionError(`先验模式 ${id} 的 hop 须为 dict`);
    const from = rawHop['from'];
    const to = rawHop['to'];
    const shape = rawHop['shape'];
    if (typeof from !== 'string' || from.trim() === '') {
      throw new GraphDefinitionError(`先验模式 ${id} 的 hop 缺起点 from`);
    }
    if (typeof shape !== 'string') {
      throw new GraphDefinitionError(`先验模式 ${id} 的 hop 缺 shape`);
    }
    _valid_hop_shape(shape);
    const out: ScopePriorHop = { from, shape };
    if (to !== undefined) {
      if (typeof to !== 'string') throw new GraphDefinitionError(`先验模式 ${id} 的 hop.to 须为字符串`);
      out.to = to;
    }
    const count = rawHop['count'];
    if (count !== undefined) out.count = Number(count);
    const commit = rawHop['commit'];
    if (commit !== undefined && commit !== null) {
      if (typeof commit !== 'string' || !(CHANNEL_COMMITS as readonly string[]).includes(commit)) {
        throw new GraphDefinitionError(`先验模式 ${id} 的 hop.commit 非法: ${String(commit)}`);
      }
      out.commit = commit as ChannelCommit;
    }
    return out;
  });
  const pattern: ScopePriorPattern = {
    id,
    entry_scope: entryScope,
    trigger_kinds: Array.isArray(triggerKinds)
      ? (triggerKinds as string[])
      : [],
    label: typeof data['label'] === 'string' ? data['label'] : '',
    hops: parsedHops,
  };
  validate_scope_prior(pattern);
  return pattern;
}
