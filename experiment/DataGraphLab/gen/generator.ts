/**
 * 生成器核心（C.1 全文）：分层实例化 → public spec + hidden gold。
 *
 * 骨架枚举/签名去冗余在 gen/skeletons.ts（SKELETONS），分层与切分在
 * gen/splits.ts（STRATA/_splitMaps/splitOf），本文件负责采样与收尾：
 * 按 (深度 × 是否含 cond) 分层等概率采样（层间/层内各一次 choice），按族给
 * 骨架补 submit(+check_*)，follow 族指令 = 计划线性渲染（含终算子义项），
 * goal 族指令只描述目标谓词（gold = 传入骨架本身，多解可接受）。
 *
 * 确定性纪律：随机一律 makeRng(seed)、哈希一律 hashObj/crc32（G0.1 同 seed
 * 跨进程逐字相同）；所有 `expected` 由回放求出，不由人手写；任何任务生成后
 * 必须回放穿验收 accept 才返回（G0.2）。收尾终算子只由 _commit 追加一次，
 * 绝不在骨架枚举采样池里。
 */

import {
  _skelId,
  compareSkel,
  dedupeBySignature,
  enumerateSkeletons,
  MAX_DEPTH,
  PROBE_INT,
  PROBE_STR,
  SKELETONS,
  signature,
  type Sig,
  type Skel,
} from './skeletons.js';
import {
  _splitMaps,
  _stratum,
  compareStratum,
  HELDOUT_SKELETONS,
  splitOf,
  STRATA,
  VAL_SKELETONS,
  type StratumKey,
} from './splits.js';
import { applyOp, emod, EXIT, initState, runPlan, sampleValue, type Graph, type State } from '../world/operators.js';
import { t } from '../world/types.js';
import { goalOk, type Goal } from '../world/goal.js';
import { renderGoal, renderRecipe } from '../world/render.js';
import { crc32, hashObj } from '../world/hash.js';
import { makeRng, type Rng } from '../world/rng.js';
import { GRAPH, candidates } from '../runner/graph.js';
import { accept } from '../verify/acceptor.js';
import type { Family, Root, Split, Style, Task } from '../schema.js';

/** 重导出骨架层公开符号：appendix D 将 SKELETONS/signature/枚举/去冗余挂在 gen/generator。 */
export {
  MAX_DEPTH,
  PROBE_INT,
  PROBE_STR,
  SKELETONS,
  enumerateSkeletons,
  signature,
  dedupeBySignature,
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

/** C.1 `goal_probe_hit`：可达性探针。Int 用全域探针 ⇒ 判定精确；Str 只是提示不剪枝。 */
export function goalProbeHit(root: Root, plan: readonly string[], goal: Goal): boolean {
  const probes: readonly (number | string)[] = root === 'Int' ? PROBE_INT : PROBE_STR;
  for (const probe of probes) {
    const st = runPlan(plan, initState(probe));
    if (st !== null && goalOk(st.x, { goal })) return true;
  }
  return false;
}

/**
 * C.1 `has_one_step_solution`：depth-1 捷径守卫——任一单步（含 echo/submit）
 * 直接过验收即拒采。只需 O(|candidates|) 次 apply+accept，不必整图 BFS，
 * 也避免 gen → teacher 反向依赖。
 */
export function hasOneStepSolution(task: Task, graph: Graph): boolean {
  const st = initState(task.x, task.spec);
  for (const a of candidates(graph, st, st.hist)) {
    if (a === EXIT) continue;
    const st2 = applyOp(graph, a, st);
    if (st2 !== null && accept(task, st2)) return true;
  }
  return false;
}

/** 终算子收尾唯一入口（C.1）：verify/goal_verify 依终值类型选 check_* 并写入 spec。 */
function _commit(
  family: Family,
  skeleton: readonly string[],
  expected: number | string,
): { plan: string[]; spec: Record<string, unknown> } | null {
  const plan = [...skeleton, 'submit'];
  let spec: Record<string, unknown> = {};
  if (family === 'verify' || family === 'goal_verify') {
    if (t(expected) === 'Int') {
      spec = { parity: emod(expected as number, 2) };
      plan.push('check_parity');
    } else if (t(expected) === 'Str') {
      spec = { length: (expected as string).length };
      plan.push('check_len');
    } else {
      return null;
    }
  }
  return { plan, spec };
}

/** 配方族实例化（C.1）：指令 = 计划线性渲染；回放穿 accept 才返回。 */
export function instanceFollow(rng: Rng, root: Root, skeleton: readonly string[], family: Family): Task | null {
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

/** 该切分下的骨架池。 */
function _pool(split: Split): Skel[] {
  return SKELETONS.filter((sk) => splitOf(sk) === split);
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

/** C.1 `make_task`：同 seed 完全确定；可钉 skeleton/family/split。 */
export function makeTask(
  seed: number,
  style: Style = 'follow',
  family?: Family,
  split?: Split,
  skeleton?: Skel,
): Task | null {
  const rng = makeRng(seed);
  const pool = skeleton !== undefined ? [skeleton] : split !== undefined ? _pool(split) : SKELETONS;
  for (let i = 0; i < 200; i++) {
    const sk = skeleton ?? _stratifiedChoice(rng, pool);
    const fam = family ?? rng.choice(STYLES[style]);
    const task = instanceTask(rng, sk.root, sk.plan, fam, style);
    if (task !== null && (split === undefined || task.split === split)) return task;
  }
  return null;
}

/**
 * C.1 `make_split`：确定性配额——每 (style, family) 生成 per_family 条，轮转顺序
 * 固定；骨架不够则同骨架多实例化（上限 maxPerSkeleton），仍不够报错不静默降级。
 * 只用于统计集/val，「每骨架都被考核」由 makeCoverageSplit 保证，二者不可混用。
 */
export function makeSplit(split: Split, perFamily: number, seed = 0, maxPerSkeleton = 4): Task[] {
  const rng = makeRng(seed);
  const pool = [..._pool(split)].sort((a, b) => _skelId(a).localeCompare(_skelId(b)));
  const out: Task[] = [];
  for (const style of ['follow', 'goal'] as const) {
    for (const fam of STYLES[style]) {
      let n = 0;
      for (let rep = 0; rep < maxPerSkeleton; rep++) {
        for (const sk of pool) {
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

/** C.1 `make_coverage_split`：每个 (heldout 骨架 × style × family) 恰 1 条；只允许
 * 同骨架重试（50 次），禁止跨骨架顶替；任一产不出即报错（覆盖声明可判定）。 */
export function makeCoverageSplit(split: Split, seed = 0): Task[] {
  const rng = makeRng(seed);
  const pool = [..._pool(split)].sort((a, b) => _skelId(a).localeCompare(_skelId(b)));
  const out: Task[] = [];
  for (const style of ['follow', 'goal'] as const) {
    for (const fam of STYLES[style]) {
      for (const sk of pool) {
        let task: Task | null = null;
        for (let attempt = 0; attempt < 50; attempt++) {
          const t = instanceTask(rng, sk.root, sk.plan, fam, style);
          if (t !== null && t.split === split) {
            task = t;
            break;
          }
        }
        if (task === null) {
          throw new Error(`coverage ${split}/${style}/${fam}/${_skelId(sk)}: skeleton yields no task`);
        }
        out.push(task);
      }
    }
  }
  return out;
}
