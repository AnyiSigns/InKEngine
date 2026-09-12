/**
 * 世界版本 = 算子契约表 + 变换语义 + 访问上限的规范 hash（G0.1 与 GateResult 的共同口径）。
 *
 * 三组输入覆盖生成/回放的全部行为面：契约表（id/kind/requires/when/provides/out_type）
 * 任一字段变化即改版本；变换语义键记录 B.2 变换列的规范化表述，实现与语义错位即改版本；
 * `MAX_REPEAT` 虽定义在 world/operators.ts，但改变它会改变可枚举骨架空间与候选动作集，
 * 故一并纳入哈希。任一变化都会让旧数据的 `task_hash` 失效——这是数据集可追溯、
 * 可回滚的前提。`entry`/`exit` 是结构节点、无契约，不入契约表；语义键仅为覆盖 B.2
 * 全表而保留占位。
 */

import { hashObj } from './hash.js';
import { MAX_REPEAT, OPS } from './operators.js';

const CONTRACT_TABLE = OPS.map((o) => ({
  id: o.id,
  kind: o.kind,
  requires: o.requires,
  when: o.when ?? {},
  provides: o.provides,
  out_type: o.out_type,
}));

/** B.2 变换列语义键（Record<opId, 规范语义字符串>）；`entry`/`exit` 为占位覆盖。 */
export const TRANSFORM_SEMANTICS: Readonly<Record<string, string>> = {
  add3: 'x+3',
  mul2: 'x*2',
  sub1: 'x-1',
  neg: '-x',
  mod7: 'emod(x,7)',
  upper: 'x.upper()（仅 ASCII）',
  lower: 'x.lower()（仅 ASCII）',
  reverse: 'x[::-1]',
  append_bang: 'x+"!"',
  str_len: 'len(x)',
  cond_even: 'emod(x,2)==0?x+1:x*2',
  cond_long: 'len(x)>=4?x.upper():x+"?"',
  submit: 'answer=x',
  check_parity: 'pass iff emod(x,2)==spec.parity',
  check_len: 'pass iff len(x)==spec.length',
  noop: '原样返回',
  fake_add: 'x+2',
  shuffle: '循环右移 crc32(x) % max(1,len(x)) 位',
  dead_end: '原样（requires zzz，恒零代价死路）',
  echo: 'answer="echo:"+str(x)',
  branch_decoy: 'x*x',
  entry: '起点，不可被选',
  exit: '验收终点，可被选',
};

/** 稳定版本串（sha1 前 16 位，随契约/语义/访问上限内容变化）。 */
export function hashWorldVersion(
  semantics: Readonly<Record<string, string>>,
  maxRepeat: number,
): string {
  return hashObj({ contracts: CONTRACT_TABLE, semantics, maxRepeat });
}

export const worldVersion: string = hashWorldVersion(TRANSFORM_SEMANTICS, MAX_REPEAT);
