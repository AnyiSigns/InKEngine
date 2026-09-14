/**
 * 世界版本 = 算子契约表 + 变换语义 + 访问上限 + 词表面的规范 hash（G0.1 与 GateResult 的共同口径）。
 *
 * 四组输入覆盖生成/回放的全部行为面：契约表（id/kind/requires/when/provides/out_type）
 * 任一字段变化即改版本；变换语义键记录 B.2 变换列的规范化表述，实现与语义错位即改版本；
 * `MAX_REPEAT` 虽定义在 world/operators.ts，但改变它会改变可枚举骨架空间与候选动作集，
 * 故一并纳入哈希；词表面（LEXICON 义项→opId 映射与 GOAL_LEX/GOAL_TEMPLATES/
 * GOAL_CONNECTORS/RECIPE_PREFIXES/RECIPE_CONNECTORS）决定 render/parseRecipe/
 * occurrencePlan/weakLexicalPlan 语义与特征槽，改词表却不 bump 版本会让旧数据与
 * 旧权重蒙混过关（P1-A），故作为第 4 键 `lexicon` 纳入。任一变化都会让旧数据的
 * `task_hash` 失效——这是数据集可追溯、可回滚的前提。`entry`/`exit` 是结构节点、
 * 无契约，不入契约表；语义键仅为覆盖 B.2 全表而保留占位。
 */

import { hashObj } from './hash.js';
import { MAX_REPEAT, OPS } from './operators.js';
import {
  GOAL_CONNECTORS,
  GOAL_LEX,
  GOAL_TEMPLATES,
  LEXICON,
  RECIPE_CONNECTORS,
  RECIPE_PREFIXES,
} from './lexicon.js';

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
  check_parity: 'pass iff emod(x,2)==spec.parity → verdict="pass:"+hash8(x)，否则 "fail"',
  check_len: 'pass iff len(x)==spec.length → verdict="pass:"+hash8(x)，否则 "fail"',
  noop: '原样返回',
  fake_add: 'x+2',
  shuffle: '循环右移 crc32(x) % max(1,len(x)) 位',
  dead_end: '原样（requires zzz，恒零代价死路）',
  echo: 'answer="echo:"+str(x)',
  branch_decoy: 'x*x',
  entry: '起点，不可被选',
  exit: '验收终点，可被选',
};

/**
 * 词表面的规范投影（P1-A 纳入 worldVersion 哈希）。键名冻结为稳定 camelCase：
 * hashObj 按键排序规范化，词表任何一处内容（义项集合/目标词/模板/池）变化都改版本。
 */
export function lexiconFace(): Record<string, unknown> {
  return {
    lexicon: LEXICON,
    goalLex: GOAL_LEX,
    goalTemplates: GOAL_TEMPLATES,
    goalConnectors: GOAL_CONNECTORS,
    recipePrefixes: RECIPE_PREFIXES,
    recipeConnectors: RECIPE_CONNECTORS,
  };
}

/** 稳定版本串（sha1 前 16 位，随契约/语义/访问上限/词表内容变化）。 */
export function hashWorldVersion(
  semantics: Readonly<Record<string, string>>,
  maxRepeat: number,
  lexicon: unknown = lexiconFace(),
): string {
  return hashObj({ contracts: CONTRACT_TABLE, semantics, maxRepeat, lexicon });
}

export const worldVersion: string = hashWorldVersion(TRANSFORM_SEMANTICS, MAX_REPEAT);
