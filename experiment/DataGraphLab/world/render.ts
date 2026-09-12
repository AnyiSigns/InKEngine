/**
 * 配方族线性渲染、目标族渲染与配方往返解析（follow 族可复现性的核心）。
 *
 * `render_recipe` 把算子序列按义项线性渲染；`parse_recipe` 必须能从 `tokens` +
 * LEXICON 还原出同一序列——否则 follow 族指令不可复现，`S_follow ≥ 0.80` 无意义。
 * 往返正确性依赖两条硬约束：同一算子的一次出现用不同义项（支持 MAX_REPEAT=2 的
 * 重复算子），以及共享义项（`取反`）由“当前值类型”判定归属。
 *
 * `render_goal` 只描述目标属性，绝不出现任何算子义项，否则目标式族会退化成配方族。
 */

import type { Rng } from './rng.js';
import type { Goal } from './goal.js';
import { contractOf, LEX_OPS_BASE } from './operators.js';
import { GOAL_CONNECTORS, GOAL_TEMPLATES, LEXICON, RECIPE_CONNECTORS, RECIPE_PREFIXES } from './lexicon.js';
import { findSequence, senseTokens, tokens } from './tokenize.js';
import type { TypeName } from './types.js';

function formatValue(x: unknown): string {
  return typeof x === 'string' ? `「${x}」` : String(x);
}

function pickSense(rng: Rng, id: string, used: Set<string>): string {
  const senses = LEXICON[id];
  if (!senses || senses.length === 0) throw new Error(`render_recipe: no lexicon for ${id}`);
  // 整条指令内义项字符串全局唯一：解析器按“首次出现”还原，若同一 sense 复用两次
  // 就无法区分两次出现。义项耗尽说明计划违反 MAX_REPEAT/义项数约束，fail-fast。
  const free = senses.filter((s) => !used.has(s));
  if (free.length === 0) {
    throw new Error(`render_recipe: ${id} occurrences exceed its ${senses.length} distinct senses`);
  }
  const pick = rng.choice(free);
  used.add(pick);
  return pick;
}

/** 按计划顺序线性渲染配方族指令；同 seed 逐字相同。 */
export function renderRecipe(rng: Rng, plan: readonly string[], x: unknown): string {
  const used = new Set<string>();
  const segments: string[] = [];
  plan.forEach((id, i) => {
    const sense = pickSense(rng, id, used);
    segments.push(i === 0 ? sense : `${rng.choice(RECIPE_CONNECTORS)}${sense}`);
  });
  const head = rng.choice(RECIPE_PREFIXES);
  return `起点值${formatValue(x)}。${head}${segments.join('，')}`;
}

function acceptsType(opId: string, currentType: TypeName): boolean {
  const c = contractOf(opId);
  if (!c) return false;
  return Object.values(c.requires).some(
    (types) => types.includes('any') || types.includes(currentType),
  );
}

interface Mention {
  opId: string;
  sense: string;
}

/**
 * 从指令还原算子序列；`rootType` 为初始 x 的类型，用于消解类型可判定的共享义项。
 * 同一 token 位置只产出一次决策：共享义项（`取反`）会同时命中多个算子，按当前类型
 * 取唯一合法者；不同位置的不同义项（支持 MAX_REPEAT=2 的重复算子）各算一次。
 */
export function parseRecipe(instr: string, rootType: TypeName): string[] {
  const toks = tokens(instr);
  const byFirst = new Map<number, Mention[]>();
  for (const opId of LEX_OPS_BASE) {
    for (const sense of LEXICON[opId]!) {
      const first = findSequence(toks, senseTokens(sense));
      if (first < 0) continue;
      const group = byFirst.get(first) ?? [];
      group.push({ opId, sense });
      byFirst.set(first, group);
    }
  }

  const out: string[] = [];
  let currentType: TypeName = rootType;
  for (const first of [...byFirst.keys()].sort((a, b) => a - b)) {
    const candidates: string[] = [];
    for (const m of byFirst.get(first)!) {
      for (const id of LEX_OPS_BASE) {
        if (LEXICON[id]!.includes(m.sense) && !candidates.includes(id)) candidates.push(id);
      }
    }
    // LEX_OPS_BASE 顺序即确定性 tie-break。
    candidates.sort((a, b) => LEX_OPS_BASE.indexOf(a) - LEX_OPS_BASE.indexOf(b));
    const chosen = candidates.find((id) => acceptsType(id, currentType));
    if (!chosen) continue;
    out.push(chosen);
    const c = contractOf(chosen);
    if (c && c.out_type !== 'any') currentType = c.out_type as TypeName;
  }
  return out;
}

/** 目标族渲染：只描述目标属性，阈值/区间端点显式出现。 */
export function renderGoal(rng: Rng, goal: Goal): string {
  if (goal.kind === 'all') {
    if (goal.of.length === 0) throw new Error('renderGoal: empty conjunction');
    // 全部合取子目标都要渲染：goalOk 按 every 校验，少渲一个会产出不可解指令。
    const parts = goal.of.map((g) => renderGoal(rng, g));
    return parts.join(rng.choice(GOAL_CONNECTORS));
  }
  const tmpl = rng.choice(GOAL_TEMPLATES[goal.kind]!);
  if (goal.kind === 'parity') {
    return tmpl.replace('{parity_word}', goal.target === 0 ? '偶' : '奇');
  }
  if (goal.kind === 'gt') return tmpl.replace('{target}', String(goal.target));
  return tmpl.replace('{min}', String(goal.min)).replace('{max}', String(goal.max));
}
