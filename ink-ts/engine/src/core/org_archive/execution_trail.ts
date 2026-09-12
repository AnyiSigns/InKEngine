/**
 * 轨迹记录数据面（ExecutionTrail：一次执行的 scope×channel 轨迹单元）。
 *
 * 执行模型的择优对象是**组织决策**（该不该委托/并行几路/派给哪些作用域/归并
 * 契约/通道条件），组织档案 = 轨迹（scope×channel 序列）+ 结果随事件流落库后
 * 的统计。本模块承载轨迹记录的**数据面形态与归档规则**——执行树（run_id /
 * parent_run_id 组织、§七.6 标识面）里，一次执行（会话或子执行）产出的一条
 * 记录即本单元；组织档案（org_archive）按它聚合。
 *
 * 轨迹 = 执行经过的 scope×channel 序列，**非图快照**（术语表 §九）：
 *
 * - run_id / parent_run_id：执行树定位（子执行带父 id；根执行 parent = null）；
 * - entry_scope：本次执行的入口作用域（子执行 = 父转场的目标作用域）；
 * - hops：本执行经过的转场序列（scope A → 通道 → scope B，连续：后一跳起点 =
 *   前一跳目标）；作用域引用 = 目录作用域 id/role 词汇（scope_spec），通道维度
 *   复用通道数据面的形态/提交契约词表（channel_spec），**不另立第二套枚举**；
 * - outcome：终态（成功/失败/降级）；
 * - cost：成本度量（steps/cost/tokens/ms，可缺省——只承载后续可从引擎事件喂入
 *   的字段，不臆造 IO）；ended_at_ms 供使用近度统计。
 *
 * 纯数据面（JSON 进 JSON 出）：只做类型 + 解析/校验 + 序列化，不含任何执行
 * 语义与存储；后续 GuardedStorage 集合（存档波）与事件流接线（运行时波）都以
 * 本字典形态为持久化/传输契约。未知键忽略（前向兼容），字段类型非法 = 显式
 * 抛错（fail-closed，与作用域/通道数据面同口径）。
 */

import {
  CHANNEL_COMMITS,
  CHANNEL_COMMIT_FULL,
  CHANNEL_SHAPES,
  type ChannelCommit,
  type ChannelShape,
} from '../../model/channels/channel_spec.js';
import { ENTITY_ID_MAX_LENGTH } from '../entities/entities.js';
import { GraphDefinitionError } from '../../model/errors.js';
import { isRecord } from '../../model/json.js';

/** 轨迹记录 schema 版本（存档波对未知键版本容忍，类型非法仍显式拒绝）。 */
export const TRAIL_SCHEMA_VERSION = 1;

/** run_id 命名上限（执行标识，可与实体/通道 id 同档以上的宽松上限）。 */
export const RUN_ID_MAX_LENGTH = 96;

/** 轨迹终态词表（success = 达成目标；failure = 失败；degraded = 降级交付）。 */
export const TRAIL_OUTCOMES = ['success', 'failure', 'degraded'] as const;

/** 轨迹终态（三值）。 */
export type TrailOutcome = (typeof TRAIL_OUTCOMES)[number];

/** 成本度量（全部可缺省；steps 计步/护栏口径，其余由运行时定价后喂入）。 */
export interface TrailCost {
  steps?: number;
  cost?: number;
  tokens?: number;
  ms?: number;
}

/** 一次转场（scope A →通道→ scope B）。 */
export interface TrailHop {
  /** 起点作用域 id（目录作用域词汇；host 自定义 id 同实体 id 约束）。 */
  from: string;
  /** 目标作用域 id（≠ from，禁止自环转场）。 */
  to: string;
  /** 通道形态（channel_spec 词表四值，非自造词）。 */
  shape: ChannelShape;
  /** 提交契约（channel_spec 词表；缺省 = 全量回传，序列化不落缺省）。 */
  commit?: ChannelCommit;
  /** 并行路数（fan_out/fan_in 转场可携带；组织档案据此统计并行档）。 */
  count?: number;
}

/** 一次执行的轨迹记录（组织档案聚合的单元）。 */
export interface ExecutionTrail {
  run_id: string;
  /** 父执行 id（子执行带；根执行 null）。 */
  parent_run_id: string | null;
  /** 入口作用域 id。 */
  entry_scope: string;
  /** 有序转场序列（可空 = 单作用域直答/直收，未发生跨作用域转场）。 */
  hops: readonly TrailHop[];
  outcome: TrailOutcome;
  cost?: TrailCost | null;
  /** 执行结束时刻（使用近度统计输入；可缺省 = ingest 时注入 now）。 */
  ended_at_ms?: number;
}

/** 校验辅助：报错统一入口（带字段名 + 期望形态）。 */
function _bad(where: string, expected: string): never {
  const location = where === '' ? '轨迹记录非法' : `轨迹记录 ${where} 非法`;
  throw new GraphDefinitionError(`${location}: 期望 ${expected}`);
}

/** 校验 id 形态（非空/无空白控制字符/长度上限；run_id 与 scope id 共用语义）。 */
function _check_id(value: unknown, where: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    _bad(where, '非空字符串');
  }
  if (value.length > maxLength) {
    _bad(where, `长度 ≤${maxLength} 的字符串`);
  }
  for (const ch of value) {
    if (ch.charCodeAt(0) < 32 || /\s/.test(ch)) {
      _bad(where, '不含空白或控制字符的字符串');
    }
  }
  return value;
}

/** 校验作用域 id 引用（与实体 id 同约束：作用域资产即实体记录）。 */
export function validate_scope_ref(scope_id: string, where = 'scope'): void {
  _check_id(scope_id, where, ENTITY_ID_MAX_LENGTH);
}

/** 校验 run_id 引用（长度上限见 RUN_ID_MAX_LENGTH）。 */
export function validate_run_id(run_id: string, where = 'run_id'): void {
  _check_id(run_id, where, RUN_ID_MAX_LENGTH);
}

/** 解析转场 hop（字段类型 + 通道词表校验；非法抛错）。 */
function _parse_hop(raw: unknown, where: string): TrailHop {
  if (!isRecord(raw)) _bad(where, 'dict');
  const from = _check_id(raw['from'], `${where}.from`, ENTITY_ID_MAX_LENGTH);
  const to = _check_id(raw['to'], `${where}.to`, ENTITY_ID_MAX_LENGTH);
  if (from === to) _bad(where, `目标作用域 ≠ 起点（${from} 自环）`);
  const shape = raw['shape'];
  if (typeof shape !== 'string' || !(CHANNEL_SHAPES as readonly string[]).includes(shape)) {
    _bad(`${where}.shape`, `通道形态 ${CHANNEL_SHAPES.join('/')} 之一`);
  }
  const hop: TrailHop = { from, to, shape: shape as ChannelShape };
  const commit = raw['commit'];
  if (commit === undefined) {
    hop.commit = CHANNEL_COMMIT_FULL;
  } else if (typeof commit === 'string' && (CHANNEL_COMMITS as readonly string[]).includes(commit)) {
    if (commit !== CHANNEL_COMMIT_FULL) hop.commit = commit as ChannelCommit;
  } else {
    _bad(`${where}.commit`, `提交契约 ${CHANNEL_COMMITS.join('/')} 之一`);
  }
  const count = raw['count'];
  if (count !== undefined) {
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
      _bad(`${where}.count`, '正整数');
    }
    hop.count = count;
  }
  return hop;
}

/** 解析成本度量（字段可选；出现则须为非负有限数，steps/tokens 还须整数）。 */
function _parse_cost(raw: unknown, where: string): TrailCost | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) _bad(where, 'dict');
  const cost: TrailCost = {};
  for (const key of ['steps', 'cost', 'tokens', 'ms'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      _bad(`${where}.${key}`, '非负有限数');
    }
    if ((key === 'steps' || key === 'tokens') && !Number.isInteger(value)) {
      _bad(`${where}.${key}`, '非负整数');
    }
    cost[key] = value;
  }
  return cost;
}

/** 轨迹结构校验（转场连续 + 首跳起点 = 入口作用域；非法抛错）。 */
export function validate_execution_trail(trail: ExecutionTrail): void {
  const hops = trail.hops;
  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i]!;
    validate_scope_ref(hop.from, `hops[${i}].from`);
    validate_scope_ref(hop.to, `hops[${i}].to`);
    if (hop.from === hop.to) {
      throw new GraphDefinitionError(`轨迹 ${trail.run_id} 第 ${i} 跳自环（${hop.from}）`);
    }
    if (i === 0 && hop.from !== trail.entry_scope) {
      throw new GraphDefinitionError(
        `轨迹 ${trail.run_id} 首跳起点须为入口作用域 ${trail.entry_scope}`,
      );
    }
    if (i > 0 && hop.from !== hops[i - 1]!.to) {
      throw new GraphDefinitionError(
        `轨迹 ${trail.run_id} 转场断链：第 ${i} 跳起点 ${hop.from} ≠ 第 ${i - 1} 跳目标 ${hops[i - 1]!.to}`,
      );
    }
  }
}

/**
 * 从 JSON 解析轨迹记录（执行树事件流的落库/传输面）。
 * 未知键忽略（前向兼容）；类型/词表/结构非法 = 显式抛错。commit 缺省归一为
 * 全量回传（与通道缺省契约同口径）；结构校验见 validate_execution_trail。
 */
export function parse_execution_trail(data: unknown): ExecutionTrail {
  if (!isRecord(data)) _bad('', 'dict');
  const run_id = _check_id(data['run_id'], 'run_id', RUN_ID_MAX_LENGTH);
  const rawParent = data['parent_run_id'];
  const parent_run_id =
    rawParent === null || rawParent === undefined
      ? null
      : _check_id(rawParent, 'parent_run_id', RUN_ID_MAX_LENGTH);
  const entry_scope = _check_id(data['entry_scope'], 'entry_scope', ENTITY_ID_MAX_LENGTH);
  const rawHops = data['hops'];
  if (rawHops !== undefined && !Array.isArray(rawHops)) _bad('hops', 'list');
  const hops = (rawHops ?? []).map((rawHop, i) => _parse_hop(rawHop, `hops[${i}]`));
  const outcome = data['outcome'];
  if (typeof outcome !== 'string' || !(TRAIL_OUTCOMES as readonly string[]).includes(outcome)) {
    _bad('outcome', `终态 ${TRAIL_OUTCOMES.join('/')} 之一`);
  }
  const cost = _parse_cost(data['cost'], 'cost');
  let ended_at_ms: number | undefined;
  const rawEnded = data['ended_at_ms'];
  if (rawEnded !== undefined) {
    if (typeof rawEnded !== 'number' || !Number.isFinite(rawEnded) || rawEnded < 0) {
      _bad('ended_at_ms', '非负有限数');
    }
    ended_at_ms = rawEnded;
  }
  const trail: ExecutionTrail = {
    run_id,
    parent_run_id,
    entry_scope,
    hops,
    outcome: outcome as TrailOutcome,
  };
  if (cost !== null && Object.keys(cost).length > 0) trail.cost = cost;
  if (ended_at_ms !== undefined) trail.ended_at_ms = ended_at_ms;
  validate_execution_trail(trail);
  return trail;
}

/** 序列化轨迹记录（最小形态：缺省/空维度不落键；防调用方就地改写）。 */
export function trail_to_dict(trail: ExecutionTrail): Record<string, unknown> {
  const data: Record<string, unknown> = { run_id: trail.run_id };
  if (trail.parent_run_id !== null) data['parent_run_id'] = trail.parent_run_id;
  data['entry_scope'] = trail.entry_scope;
  data['hops'] = trail.hops.map((hop) => {
    const item: Record<string, unknown> = {
      from: hop.from,
      to: hop.to,
      shape: hop.shape,
    };
    if (hop.commit !== undefined && hop.commit !== CHANNEL_COMMIT_FULL) {
      item['commit'] = hop.commit;
    }
    if (hop.count !== undefined) item['count'] = hop.count;
    return item;
  });
  data['outcome'] = trail.outcome;
  const cost = trail.cost;
  if (cost !== undefined && cost !== null) {
    const costDict: Record<string, unknown> = {};
    if (cost.steps !== undefined) costDict['steps'] = cost.steps;
    if (cost.cost !== undefined) costDict['cost'] = cost.cost;
    if (cost.tokens !== undefined) costDict['tokens'] = cost.tokens;
    if (cost.ms !== undefined) costDict['ms'] = cost.ms;
    if (Object.keys(costDict).length > 0) data['cost'] = costDict;
  }
  if (trail.ended_at_ms !== undefined) data['ended_at_ms'] = trail.ended_at_ms;
  return data;
}
