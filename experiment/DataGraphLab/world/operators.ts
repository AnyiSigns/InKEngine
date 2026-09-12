/**
 * 算子库契约表（v0，B.2 唯一真源）与结构节点。
 *
 * 契约先行：选边后、执行前查 `requires`/`provides`/`out_type`，不满足即零代价死路。
 * `kind` 决定节点能否进骨架采样池：只有 `op` 可被枚举；`terminal` 只由收尾按族追加；
 * `decoy` 只做干扰，永不入计划。`entry`/`exit` 是无契约结构节点。
 *
 * 类型推断见 `types.ts`；`"any"` 是字段通配符（存在即可，不限类型），**不是**类型格成员。
 */

import { t, type TypeName } from './types.js';

export const ENTRY = 'entry';
export const EXIT = 'exit';

/** 单节点在一次 rollout 中的访问上限；candidates 与骨架枚举共用此常量。 */
export const MAX_REPEAT = 2;

export type Kind = 'op' | 'terminal' | 'decoy';

export interface Contract {
  readonly id: string;
  readonly kind: Kind;
  /** {字段: 允许类型集合}；集合可含 `"any"` 通配。 */
  readonly requires: Readonly<Record<string, readonly string[]>>;
  /** 值约束；缺省必须按 {} 处理，禁止直接读 `.when`。 */
  readonly when?: Readonly<Record<string, readonly unknown[]>>;
  /** 成功写入的唯一产物字段；验收通道据此收口。 */
  readonly provides: string | null;
  /** 成功后 `provides` 字段的类型；`"any"` 表示动态类型。 */
  readonly out_type: string;
}

/** B.2 表顺序即基础顺序，`LEX_OPS_BASE`/`NODES_BASE` 槽位依赖它。 */
export const OPS: readonly Contract[] = [
  { id: 'add3', kind: 'op', requires: { x: ['Int'] }, provides: 'x', out_type: 'Int' },
  { id: 'mul2', kind: 'op', requires: { x: ['Int'] }, provides: 'x', out_type: 'Int' },
  { id: 'sub1', kind: 'op', requires: { x: ['Int'] }, provides: 'x', out_type: 'Int' },
  { id: 'neg', kind: 'op', requires: { x: ['Int'] }, provides: 'x', out_type: 'Int' },
  { id: 'mod7', kind: 'op', requires: { x: ['Int'] }, provides: 'x', out_type: 'Int' },
  { id: 'upper', kind: 'op', requires: { x: ['Str'] }, provides: 'x', out_type: 'Str' },
  { id: 'lower', kind: 'op', requires: { x: ['Str'] }, provides: 'x', out_type: 'Str' },
  { id: 'reverse', kind: 'op', requires: { x: ['Str'] }, provides: 'x', out_type: 'Str' },
  { id: 'append_bang', kind: 'op', requires: { x: ['Str'] }, provides: 'x', out_type: 'Str' },
  { id: 'str_len', kind: 'op', requires: { x: ['Str'] }, provides: 'x', out_type: 'Int' },
  { id: 'cond_even', kind: 'op', requires: { x: ['Int'] }, provides: 'x', out_type: 'Int' },
  { id: 'cond_long', kind: 'op', requires: { x: ['Str'] }, provides: 'x', out_type: 'Str' },
  { id: 'submit', kind: 'terminal', requires: { x: ['any'] }, provides: 'answer', out_type: 'any' },
  {
    id: 'check_parity',
    kind: 'terminal',
    requires: { x: ['Int'] },
    provides: 'verdict',
    out_type: 'Str',
  },
  {
    id: 'check_len',
    kind: 'terminal',
    requires: { x: ['Str'] },
    provides: 'verdict',
    out_type: 'Str',
  },
  { id: 'noop', kind: 'decoy', requires: { x: ['any'] }, provides: 'x', out_type: 'any' },
  { id: 'fake_add', kind: 'decoy', requires: { x: ['Int'] }, provides: 'x', out_type: 'Int' },
  { id: 'shuffle', kind: 'decoy', requires: { x: ['Str'] }, provides: 'x', out_type: 'Str' },
  { id: 'dead_end', kind: 'decoy', requires: { zzz: ['Int'] }, provides: 'x', out_type: 'any' },
  { id: 'echo', kind: 'decoy', requires: { x: ['any'] }, provides: 'answer', out_type: 'any' },
  { id: 'branch_decoy', kind: 'decoy', requires: { x: ['Int'] }, provides: 'x', out_type: 'Int' },
];

/** 基础节点全集（含结构节点），基础顺序冻结；`build_node_slots` 依赖此序。 */
export const NODES_BASE: readonly string[] = [ENTRY, ...OPS.map((o) => o.id), EXIT];

/** 候选参考序：去 entry 后排序，共 22 个（N_ACTIONS）。 */
export const ROUTING: readonly string[] = NODES_BASE.filter((n) => n !== ENTRY).sort();

/** 唯一词表：op + terminal 的 id，义项槽与 mention 特征按此序冻结。 */
export const LEX_OPS_BASE: readonly string[] = OPS.filter(
  (o) => o.kind === 'op' || o.kind === 'terminal',
).map((o) => o.id);

const BY_ID: ReadonlyMap<string, Contract> = new Map(OPS.map((o) => [o.id, o]));

export function contractOf(id: string): Contract | undefined {
  return BY_ID.get(id);
}

/** 派生 `requires_types`：并集去重、剔除 `"any"`（它不是类型格成员）。 */
export function requiresTypes(c: Contract): TypeName[] {
  const out: TypeName[] = [];
  for (const types of Object.values(c.requires)) {
    for (const ty of types) {
      if (ty === 'any') continue;
      if (!out.includes(ty as TypeName)) out.push(ty as TypeName);
    }
  }
  return out;
}

/** 非负取模：`neg` 会产生负数，JS/Python 的裸 `%` 语义不同，一律走此函数。 */
export function emod(a: number, m: number): number {
  return ((a % m) + m) % m;
}

/** 单节点访问计数（candidates / 骨架枚举 / 搜索共用）。 */
export function histCount(hist: readonly string[], nid: string): number {
  let n = 0;
  for (const h of hist) if (h === nid) n++;
  return n;
}

/** 契约匹配：字段存在 + 类型命中（`"any"` 跳过）+ `when` 值约束（缺省 {}）。 */
export function requiresOk(c: Contract, state: Readonly<Record<string, unknown>>): boolean {
  for (const [field, types] of Object.entries(c.requires)) {
    if (!Object.prototype.hasOwnProperty.call(state, field)) return false;
    if (!types.includes('any') && !types.includes(t(state[field]))) return false;
  }
  for (const [field, vals] of Object.entries(c.when ?? {})) {
    if (Object.prototype.hasOwnProperty.call(state, field) && !vals.includes(state[field])) {
      return false;
    }
  }
  return true;
}
