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
import { crc32, hash8 } from './hash.js';
import type { Rng } from './rng.js';

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

/**
 * check_* 通过时的 verdict 唯一写法：`"pass:"+hash8(被检值)`。verdict 指纹绑定被检值，
 * 使 `accept` 能把独立检查器结论钉在当次交付产物上——check 之后 x 再变，旧指纹与
 * 新 answer 不匹配即拒（堵 `goal_verify` 族"先 check 后改值再 submit"的旧 verdict 复用）。
 * 口径来自 B.2/B.4，world 与 verify 两侧共用此函数，禁止别处拼接 "pass:" 字面量。
 */
export function verdictPass(v: unknown): string {
  return 'pass:' + hash8(v);
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

/** 运行时状态（B.1 保留字段）：`spec` 运行期只读；`expected` 属于验收侧，永不入 state。 */
export interface State {
  [key: string]: unknown;
  x: unknown;
  answer: unknown;
  verdict: unknown;
  hist: string[];
  spec: Readonly<Record<string, unknown>>;
}

/** 图节点 = 契约 + 运行期标记；`requires_types` 由 `requiresTypes` 派生，非契约真源。 */
export interface GraphNode extends Contract {
  readonly alive: boolean;
  readonly requires_types: readonly TypeName[];
}

/** 算子图：`nodes` 按 id 索引；`candidates` 迭代 `sorted(graph.nodes)`（B.3）。 */
export interface Graph {
  readonly nodes: Readonly<Record<string, GraphNode>>;
}

/** 基础图：OPS 全部 alive。`run_plan` 在此回放；`runner/graph.ts` 的 GRAPH 由它扩展。 */
export const GRAPH_BASE: Graph = (() => {
  const nodes: Record<string, GraphNode> = {};
  for (const o of OPS) nodes[o.id] = { ...o, alive: true, requires_types: requiresTypes(o) };
  return { nodes };
})();

/** 形状语义（C.1，跨语言一致）：Int 全域 -50..50；Str 长度 1..8、字母表 a-h。 */
export const ASCII_ALPHABET = 'abcdefgh';

export function sampleValue(rng: Rng, root: 'Int' | 'Str'): number | string {
  if (root === 'Int') return rng.randint(-50, 50);
  const alphabet = Array.from(ASCII_ALPHABET);
  let s = '';
  for (let i = 0, n = rng.randint(1, 8); i < n; i++) s += rng.choice(alphabet);
  return s;
}

/** 初始状态：`spec` 缺省为空对象，避免 `when` 直读与 undefined 比较。 */
export function initState(x: unknown, spec?: Readonly<Record<string, unknown>>): State {
  return { x, answer: null, verdict: null, hist: [], spec: spec ?? {} };
}

/** 仅 ASCII 的 upper/lower：世界字符串由 a-h/!/? 构成，不做区域语言的大小写展开。 */
function asciiUpper(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out += c >= 0x61 && c <= 0x7a ? String.fromCharCode(c - 0x20) : ch;
  }
  return out;
}

function asciiLower(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 0x20) : ch;
  }
  return out;
}

/**
 * 执行单步（B.2 唯一真源）：契约闸 `requiresOk` 通过后按表变换，成功把 `nid`
 * 追加进 `hist`，失败返回 null = 死路。`check_*` 读公开 `spec` 写 `verdict`：
 * 通过写 `verdictPass(x)`（"pass:"+hash8 指纹绑定被检值），不通过写 "fail"——
 * B.2 只规定通过侧的指纹，失败侧沿用非 pass 前缀的固定标记即可：验收器只认
 * `pass:`+当前 answer 指纹，任何失败/伪造串都判拒，无需在失败值里再携带信息。
 */
export function applyOp(graph: Graph, nid: string, st: State): State | null {
  const node = graph.nodes[nid];
  if (!node) throw new Error(`applyOp: 图中不存在节点 ${nid}`);
  if (!requiresOk(node, st)) return null;
  const x = st.x;
  const spec = st.spec;
  let next: Partial<State>;
  switch (nid) {
    case 'add3':
      next = { x: (x as number) + 3 };
      break;
    case 'mul2':
      next = { x: (x as number) * 2 };
      break;
    case 'sub1':
      next = { x: (x as number) - 1 };
      break;
    case 'neg':
      next = { x: -(x as number) };
      break;
    case 'mod7':
      next = { x: emod(x as number, 7) };
      break;
    case 'upper':
      next = { x: asciiUpper(x as string) };
      break;
    case 'lower':
      next = { x: asciiLower(x as string) };
      break;
    case 'reverse':
      next = { x: (x as string).split('').reverse().join('') };
      break;
    case 'append_bang':
      next = { x: (x as string) + '!' };
      break;
    case 'str_len':
      next = { x: (x as string).length };
      break;
    case 'cond_even':
      next = { x: emod(x as number, 2) === 0 ? (x as number) + 1 : (x as number) * 2 };
      break;
    case 'cond_long':
      next = {
        x: (x as string).length >= 4 ? asciiUpper(x as string) : (x as string) + '?',
      };
      break;
    case 'submit':
      next = { answer: x };
      break;
    case 'check_parity':
      next = {
        verdict:
          emod(x as number, 2) === (spec.parity as number) ? verdictPass(x) : 'fail',
      };
      break;
    case 'check_len':
      next = {
        verdict:
          (x as string).length === (spec.length as number) ? verdictPass(x) : 'fail',
      };
      break;
    case 'noop':
      next = { x };
      break;
    case 'fake_add':
      next = { x: (x as number) + 2 };
      break;
    case 'shuffle': {
      const s = x as string;
      const k = emod(crc32(s), Math.max(1, s.length));
      next = { x: k === 0 ? s : s.slice(-k) + s.slice(0, s.length - k) };
      break;
    }
    case 'dead_end':
      // `zzz` 恒不在 state，requiresOk 已拒绝；此处仅为变换表完备（B.2 原样）。
      next = {};
      break;
    case 'echo':
      next = { answer: 'echo:' + String(x) };
      break;
    case 'branch_decoy':
      next = { x: (x as number) * (x as number) };
      break;
    default:
      throw new Error(`applyOp: 无 ${nid} 的变换实现`);
  }
  return { ...st, ...next, hist: [...st.hist, nid] };
}

/** 顺序回放计划（C.1 回放求 expected 的唯一途径）；任一死路即整体 null。 */
export function runPlan(plan: readonly string[], st: State): State | null {
  let cur: State | null = st;
  for (const nid of plan) {
    cur = applyOp(GRAPH_BASE, nid, cur);
    if (cur === null) return null;
  }
  return cur;
}

/** 观察投影：只保留 x/answer/verdict/hist（B.1/E.5 白名单），spec/expected 永不外泄。 */
export function obsSnapshot(st: State): Readonly<{
  x: unknown;
  answer: unknown;
  verdict: unknown;
  hist: readonly string[];
}> {
  return { x: st.x, answer: st.answer, verdict: st.verdict, hist: [...st.hist] };
}
