/**
 * 生成器核心（C.1 全文）：分层实例化 → public spec + hidden gold。
 *
 * 骨架枚举/签名去冗余/恒等丢弃在 gen/skeletons.ts（SKELETONS/isIdentity），分层与
 * 切分在 gen/splits.ts（STRATA/_splitMaps/splitOf/poolFor），判定层在
 * gen/producibility.ts（goalEligible/hasShortcut/hasOneStepSolution/
 * UNPRODUCIBLE_HELDOUT），覆盖构造在 gen/coverage.ts（makeCoverageSplitInfo/
 * makeCoverageSplit，本文件再导出保持 D 表端口），本文件负责
 * 采样与收尾：按 (深度 × 是否含 cond) 分层等概率采样（层间/层内各一次 choice），
 * 按族给骨架补 submit(+check_*)，follow 族指令 = 计划线性渲染（含终算子义项）+
 * 极小性守卫换 witness，goal 族指令只描述目标谓词（gold = 传入骨架本身，多解可
 * 接受）；goal 域族的一切采样走适格池（R2-P0-2）。
 *
 * 确定性纪律：随机一律 makeRng(seed)、哈希一律 hashObj/crc32（G0.1 同 seed
 * 跨进程逐字相同）；所有 `expected` 由回放求出，不由人手写；任何任务生成后
 * 必须回放穿验收 accept 才返回（G0.2）。收尾终算子只由 _commit 追加一次，
 * 绝不在骨架枚举采样池里。排序一律码点比较（codepointCompare），禁
 * localeCompare（locale 相关，破坏跨环境一致）。
 */

import { _skelId, PROBE_INT, PROBE_STR, SKELETONS, type Skel } from './skeletons.js';
import {
  _stratum,
  codepointCompare,
  compareStratum,
  poolFor,
  splitOf,
  type StratumKey,
} from './splits.js';
import {
  _commit,
  followUnproducible,
  goalEligible,
  goalProbeHit,
  hasOneStepSolution,
  hasShortcut,
  isGoalDomain,
} from './producibility.js';
import { initState, runPlan, sampleValue } from '../world/operators.js';
import { goalOk, type Goal } from '../world/goal.js';
import { renderGoal, renderRecipe } from '../world/render.js';
import { hashObj } from '../world/hash.js';
import { makeRng, type Rng } from '../world/rng.js';
import { GRAPH } from '../runner/graph.js';
import { accept } from '../verify/acceptor.js';
import type { Family, Root, Split, Style, Task } from '../schema.js';

/** 重导出骨架层公开符号：appendix D 将 SKELETONS/signature/枚举/去冗余/恒等判定挂在 gen/generator。 */
export {
  MAX_DEPTH,
  PROBE_INT,
  PROBE_STR,
  SKELETONS,
  enumerateSkeletons,
  signature,
  dedupeBySignature,
  isIdentity,
  compareSkel,
} from './skeletons.js';
export type { Skel, Sig } from './skeletons.js';

/** 重导出切分符号：appendix D 将 STRATA/split_of/两注册表也挂在 gen/generator。 */
export {
  STRATA,
  _stratum,
  _splitMaps,
  HELDOUT_SKELETONS,
  VAL_SKELETONS,
  splitOf,
  compareStratum,
} from './splits.js';
export type { StratumKey } from './splits.js';

/** 重导出判定层符号：注册表、捷径守卫与适格性判定的公开端口（实现见 gen/producibility.ts）。 */
export {
  coverageKey,
  goalEligible,
  goalProbeHit,
  GOAL_PROBE_GOALS,
  hasOneStepSolution,
  hasShortcut,
  UNPRODUCIBLE_HELDOUT,
} from './producibility.js';

/** C.1 `_skel_id` 与 STRATA 的分层键 / 层级数据（保持真源在持有方，本处 re-export）。 */
export { _skelId };

/** Int 目标词采样器池（C.1）：parity 奇偶 + gt 严格大于 0/5/20。 */
export const INT_GOALS: readonly ((rng: Rng) => Goal)[] = [
  (r) => ({ kind: 'parity', target: r.randint(0, 1) === 0 ? 0 : 1 }),
  (r) => ({ kind: 'gt', target: r.choice([0, 5, 20]) }),
];

/** Str 目标采样器池：len 区间端点 1..2 / 3..5。max≤5 保证 echo 产物长度 ≥6 恒不达标。 */
export const STR_GOALS: readonly ((rng: Rng) => Goal)[] = [
  (r) => ({ kind: 'len', min: r.randint(1, 2), max: r.randint(3, 5) }),
];

/** C.1 `sample_goal`：40% 概率做合取（强制多步规划）；Str 池只有一项，永不合取。 */
export function sampleGoal(rng: Rng, root: Root): Goal {
  const pool = root === 'Int' ? INT_GOALS : STR_GOALS;
  let g = rng.choice(pool)(rng);
  if (rng.uniform(0, 1) < 0.4 && pool.length > 1) {
    g = { kind: 'all', of: [g, rng.choice(pool)(rng)] };
  }
  return g;
}

// 注：goalProbeHit / _commit / goalEligible / hasOneStepSolution / hasShortcut 均在
// gen/producibility.ts 实现，本文件按 import/re-export 取用（唯一口径，别处不复制）。

/** 配方族实例化（C.1）：指令 = 计划线性渲染；follow 族极小性守卫（has_shortcut，
 *  R2-P0-3 删任意步版）命中即换 witness；结构性非最小骨架（followUnproducible，
 *  采样域无 ≥2 条无捷径 witness）直接短路 null，防空烧采样预算；回放穿 accept
 *  才返回。 */
export function instanceFollow(rng: Rng, root: Root, skeleton: readonly string[], family: Family): Task | null {
  if (followUnproducible({ root, plan: skeleton })) return null;
  for (let i = 0; i < 200; i++) {
    const x = sampleValue(rng, root);
    const st = runPlan(skeleton, initState(x));
    if (st === null) continue;
    const cs = _commit(family, skeleton, st.x as number | string);
    if (cs === null) continue;
    const { plan, spec } = cs;
    const task: Task = {
      style: 'follow',
      family,
      instruction: renderRecipe(rng, plan, x),
      x,
      spec,
      expected: st.x as number | string,
      plan_hidden: plan,
      root,
      plan_hash: hashObj(plan),
      composition_id: _skelId({ root, plan: skeleton }),
      split: splitOf({ root, plan: skeleton }),
    };
    if (hasShortcut(task, GRAPH)) continue;
    const st2 = runPlan(plan, initState(x, spec));
    if (st2 !== null && accept(task, st2)) return task;
  }
  return null;
}

/** 目标族实例化（C.1）：80 目标 × 200 witness 拒绝采样；gold = 传入骨架本身。 */
export function instanceGoal(rng: Rng, root: Root, skeleton: readonly string[], family: Family): Task | null {
  for (let g = 0; g < 80; g++) {
    const goal = sampleGoal(rng, root);
    if (root === 'Int' && !goalProbeHit(root, skeleton, goal)) continue;
    for (let w = 0; w < 200; w++) {
      const x = sampleValue(rng, root);
      if (goalOk(x, { goal })) continue;
      const st = runPlan(skeleton, initState(x));
      if (st === null || !goalOk(st.x, { goal })) continue;
      const cs = _commit(family, skeleton, st.x as number | string);
      if (cs === null) continue;
      const { plan, spec } = cs;
      const fullSpec = { ...spec, goal };
      const task: Task = {
        style: 'goal',
        family,
        instruction: renderGoal(rng, goal),
        x,
        spec: fullSpec,
        expected: st.x as number | string,
        plan_hidden: plan,
        root,
        plan_hash: hashObj(plan),
        composition_id: _skelId({ root, plan: skeleton }),
        split: splitOf({ root, plan: skeleton }),
      };
      if (hasOneStepSolution(task, GRAPH)) continue;
      const st2 = runPlan(plan, initState(x, fullSpec));
      if (st2 !== null && accept(task, st2)) return task;
    }
  }
  return null;
}

/** 每种 style 允许的 family（C.1）。 */
export const STYLES: Readonly<Record<Style, readonly Family[]>> = {
  follow: ['value', 'verify'],
  goal: ['goal', 'goal_verify'],
};

/** 按 style 分发到 follow/goal 实例化（C.1 `instance_task`）。 */
export function instanceTask(
  rng: Rng,
  root: Root,
  skeleton: readonly string[],
  family: Family,
  style: Style,
): Task | null {
  return style === 'goal'
    ? instanceGoal(rng, root, skeleton, family)
    : instanceFollow(rng, root, skeleton, family);
}

/** 层间等概率 + 层内等概率：修掉“骨架均匀抽样 = 几乎全是深度 5”。 */
function _stratifiedChoice(rng: Rng, pool: readonly Skel[]): Skel {
  const by = new Map<StratumKey, Skel[]>();
  for (const sk of pool) {
    const k = _stratum(sk);
    const arr = by.get(k);
    if (arr === undefined) by.set(k, [sk]);
    else arr.push(sk);
  }
  const keys = [...by.keys()].sort(compareStratum);
  return rng.choice(by.get(rng.choice(keys))!);
}

/** C.1 `make_task`：同 seed 完全确定；可钉 skeleton/family/split。goal 域族只走适格池（R2-P0-2）。 */
export function makeTask(
  seed: number,
  style: Style = 'follow',
  family?: Family,
  split?: Split,
  skeleton?: Skel,
): Task | null {
  const rng = makeRng(seed);
  const pool = skeleton !== undefined ? [skeleton] : split !== undefined ? poolFor(split) : SKELETONS;
  for (let i = 0; i < 200; i++) {
    const sk = skeleton ?? _stratifiedChoice(rng, pool);
    const fam = family ?? rng.choice(STYLES[style]);
    if (isGoalDomain(fam) && !goalEligible(sk.root, sk.plan)) continue;
    const task = instanceTask(rng, sk.root, sk.plan, fam, style);
    if (task !== null && (split === undefined || task.split === split)) return task;
  }
  return null;
}

/**
 * C.1 `make_split`：确定性配额——每 (style, family) 生成 per_family 条，轮转顺序
 * 固定；骨架不够则同骨架多实例化（上限 maxPerSkeleton），仍不够报错不静默降级。
 * 只用于统计集/val，「每骨架都被考核」由 makeCoverageSplit 保证，二者不可混用。
 * goal 域族（goal/goal_verify）只走适格池（R2-P0-2）：长度不变类等不适格骨架
 * 产不出 goal 任务；follow 域族结构性非最小骨架（R2-P0-3 删任意步版：采样域无
 * ≥2 条无捷径 witness）由 instanceFollow 短路 null，不空烧采样预算。
 */
export function makeSplit(split: Split, perFamily: number, seed = 0, maxPerSkeleton = 4): Task[] {
  const rng = makeRng(seed);
  const pool = [...poolFor(split)].sort((a, b) => codepointCompare(_skelId(a), _skelId(b)));
  const out: Task[] = [];
  for (const style of ['follow', 'goal'] as const) {
    for (const fam of STYLES[style]) {
      let n = 0;
      const epool = isGoalDomain(fam)
        ? pool.filter((sk) => goalEligible(sk.root, sk.plan))
        : pool;
      if (epool.length === 0) {
        throw new Error(`${split}/${style}/${fam}: eligible pool empty`);
      }
      for (let rep = 0; rep < maxPerSkeleton; rep++) {
        for (const sk of epool) {
          if (n >= perFamily) break;
          const task = instanceTask(rng, sk.root, sk.plan, fam, style);
          if (task !== null && task.split === split) {
            out.push(task);
            n++;
          }
        }
        if (n >= perFamily) break;
      }
      if (n < perFamily) {
        throw new Error(`split ${split}/${style}/${fam}: quota ${perFamily} unmet (${n})`);
      }
    }
  }
  return out;
}

/** 覆盖构造端口（实现见 gen/coverage.ts，为满足单文件 ≤350 行纪律拆出；D 表仍挂 generator）。 */
export { makeCoverageSplit, makeCoverageSplitInfo } from './coverage.js';
export type { CoverageSplitInfo } from './coverage.js';
