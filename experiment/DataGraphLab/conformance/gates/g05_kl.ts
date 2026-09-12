/**
 * G0.5 分布对齐（docs/gates.md G0.5）：train 与 heldout 的实际生成任务流按同一
 * STRATA（`(depth, has_cond)` 分层键）计数，得 P=train、Q=heldout，判
 * `KL(P‖Q) < 0.05 nats`（方向、对数底、平滑全部写死：自然对数；两分布各加
 * α=0.5 Lidstone 平滑后按 `p'=(n+α)/(N+αK)` 归一；K 取并集层数——双侧计数
 * 都为 0 的层不计入 K，单侧为 0 由平滑吸收；总计数 N==0 直接 fail-fast 抛错，
 * 绝不静默返回 0）。层归属按 composition_id → 骨架 → `_stratum` 唯一口径。
 * sanity 指标：goal 族 gold 骨架层分布的 train/heldout JS 散度（覆盖率证据，
 * 只入 metrics 不判）；分层计数表另存 csv 证据。
 */

import { writeFileSync } from 'node:fs';

import { SKELETONS, _skelId, _stratum, compareStratum, type StratumKey } from '../../gen/generator.js';
import type { Task } from '../../schema.js';
import { BATCH, buildResult, memoized, type GateContext, type GateResult } from './common.js';

const VERSION = 1;
const ALPHA = 0.5;

/** composition_id → 分层键（骨架层唯一真源派生；未知 id 即数据面破坏，抛错）。 */
function stratumOfTask(): (task: Task) => StratumKey {
  const byCid = new Map<string, StratumKey>(SKELETONS.map((sk) => [_skelId(sk), _stratum(sk)]));
  return (task: Task): StratumKey => {
    const key = byCid.get(task.composition_id);
    if (key === undefined) throw new Error(`g05: composition_id ${task.composition_id} 不在 SKELETONS（数据面破坏）`);
    return key;
  };
}

function counts(tasks: readonly Task[], stratumOf: (task: Task) => StratumKey): Map<StratumKey, number> {
  const m = new Map<StratumKey, number>();
  for (const t of tasks) m.set(stratumOf(t), (m.get(stratumOf(t)) ?? 0) + 1);
  return m;
}

function unionKeys(a: ReadonlyMap<StratumKey, number>, b: ReadonlyMap<StratumKey, number>): StratumKey[] {
  const keys = new Set<StratumKey>();
  for (const [k, n] of a) if (n > 0) keys.add(k);
  for (const [k, n] of b) if (n > 0) keys.add(k);
  return [...keys].sort(compareStratum);
}

function total(map: ReadonlyMap<StratumKey, number>): number {
  let s = 0;
  for (const n of map.values()) s += n;
  return s;
}

/** KL(P‖Q)：P 平滑分布的支撑上求和（含平滑后 P>0 恒真），nats。 */
function klDivergence(p: ReadonlyMap<StratumKey, number>, q: ReadonlyMap<StratumKey, number>): number {
  const np = total(p);
  const nq = total(q);
  if (np === 0 || nq === 0) throw new Error(`g05: 分布总计数 N==0（fail-fast，不静默返回 0）：train=${String(np)} heldout=${String(nq)}`);
  const keys = unionKeys(p, q);
  const k = keys.length;
  let sum = 0;
  for (const key of keys) {
    const pp = ((p.get(key) ?? 0) + ALPHA) / (np + ALPHA * k);
    const qq = ((q.get(key) ?? 0) + ALPHA) / (nq + ALPHA * k);
    sum += pp * Math.log(pp / qq);
  }
  return sum;
}

/** Jensen–Shannon 散度（无平滑，纯 sanity），对同一并集层支撑。 */
function jsDivergence(p: ReadonlyMap<StratumKey, number>, q: ReadonlyMap<StratumKey, number>): number {
  const np = total(p);
  const nq = total(q);
  if (np === 0 || nq === 0) return Number.NaN;
  const keys = unionKeys(p, q);
  const m = new Map<StratumKey, number>();
  for (const key of keys) m.set(key, ((p.get(key) ?? 0) / np + (q.get(key) ?? 0) / nq) / 2);
  const klFrom = (src: ReadonlyMap<StratumKey, number>): number => {
    const n = total(src);
    let s = 0;
    for (const key of keys) {
      const a = (src.get(key) ?? 0) / n;
      const b = m.get(key)!;
      if (a > 0 && b > 0) s += a * Math.log(a / b);
    }
    return s;
  };
  return (klFrom(p) + klFrom(q)) / 2;
}

function compute(ctx: GateContext): GateResult {
  const stratumOf = stratumOfTask();
  // 任务流用 g06 同批大样本（makeSplit 配额流，缓存复用不重复生成）：小批
  // （N=240）时 KL 的估计噪声（≈(K−1)/2N）已实测足以顶穿 0.05，池级 KL≈0.003
  // 证明构造对齐成立；判据对象不变（task 流计数分布），只是把抽样噪声压到判据
  // 以下——阈值 0.05 原样写死不放宽。
  const trainTasks = ctx.genTasks(BATCH.g06Train);
  const heldoutTasks = ctx.genTasks(BATCH.g06Heldout);
  const p = counts(trainTasks, stratumOf);
  const q = counts(heldoutTasks, stratumOf);
  const kl = klDivergence(p, q);

  const goalOnly = (tasks: readonly Task[]): Task[] => tasks.filter((t) => t.style === 'goal');
  const goalJs = jsDivergence(counts(goalOnly(trainTasks), stratumOf), counts(goalOnly(heldoutTasks), stratumOf));

  // per-stratum 覆盖率边距（A.2：仅报告不作阈值）：两侧并集层内 heldout 最小任务计数。
  const keys = unionKeys(p, q);
  const heldMin = Math.min(...keys.map((k) => q.get(k) ?? 0));
  const artifacts: string[] = [];
  if (ctx.outDir !== undefined) {
    // 长表按 §0.1 另存 csv；文件缺席（测试模式不落盘）不影响判定。
    const rows = ['stratum,train_count,heldout_count', ...keys.map((k) => `${k},${String(p.get(k) ?? 0)},${String(q.get(k) ?? 0)}`)];
    writeFileSync(`${ctx.outDir}/G0.5-strata.csv`, `${rows.join('\n')}\n`, 'utf8');
    artifacts.push(`${ctx.artifactPrefix}/G0.5-strata.csv`);
  }
  return buildResult({
    gate: 'G0.5',
    version: VERSION,
    ctx,
    seeds: [BATCH.g06Train.seed, BATCH.g06Heldout.seed],
    metrics: {
      kl_nats: kl,
      strata_count: keys.length,
      train_n: total(p),
      heldout_n: total(q),
      alpha: ALPHA,
      gold_skeleton_js_divergence: goalJs,
      heldout_margin_min: heldMin,
    },
    thresholds: {
      'kl_nats:max': 0.05,
      'strata_count:min': 1,
      'train_n:min': 1,
      'heldout_n:min': 1,
    },
    artifacts,
    notes:
      kl < 0.05
        ? `KL(P‖Q)=${kl.toFixed(6)} nats（α=0.5、nats、N=${String(total(p))}/${String(total(q))}，流=makeSplit(250/族) 大样本：小批 N=240 的估计噪声实测会顶穿 0.05，阈值原样写死不放宽）；per-stratum heldout 边距 min=${String(heldMin)}（A.2 报告项不判）；goal 族 gold 骨架 JS=${goalJs.toFixed(6)} 仅 sanity；分层计数表见 csv 证据`
        : `失败模式：KL=${kl.toFixed(6)} ≥0.05（α=0.5、nats、N=${String(total(p))}/${String(total(q))}），per-stratum 计数 ${keys.map((k) => `${k}:${String(p.get(k) ?? 0)}/${String(q.get(k) ?? 0)}`).join(' ')}`,
  });
}

/** 公开入口：同一上下文只算一次（结果不可变，见 common.memoized）。 */
export function run(ctx: GateContext): GateResult {
  return memoized('G0.5', ctx, () => compute(ctx));
}
