/**
 * G0.4 泄漏审计实现（`data/provenance.ts` 的门禁内核）。
 *
 * `audit`：四项检查——① obs 面白名单：`expected/spec/plan_hidden/plan_hash/seed`
 * 既不得作为记录顶层/state 键出现（state 只许 {answer, verdict}），其键名字符串亦
 * 不得夹带在 instruction/值文本里。只做键/文本级检出、不做值级扫描——submit 之后
 * answer 合法等于 expected，值比对必然假阳性；红线语义是「隐藏量不得以字段形态
 * 入数据面」。② train/heldout 的 composition_id 零重叠。③ 指令模板重叠：仅
 * follow——配方指令按构造唯一锚定骨架，同模板跨 composition = 一句话挂着两个
 * gold；goal 指令按多解设计本就跨骨架复用模板，不计泄漏（有意口径）。④ 标签 QA：
 * 记录标签逐条回放——动作 ∈ 候选、状态在 gold 前缀、与 oracle 下一步一致、EXIT 位
 * 处验收态；同 obs 不同 action 记 label-conflict（双方 quarantine 并卡门禁——混入
 * 即标签口径破坏），off-gold/不可回放进 quarantine（正常隔离，不卡门禁）。
 * 前四项全 0 才 passed（docs/gates.md G0.4）；外部边界 meta 缺坐标 fail-fast。
 */

import { hashObj } from '../world/hash.js';
import { makeRng } from '../world/rng.js';
import { EXIT, type State } from '../world/operators.js';
import { GRAPH, candidates } from '../runner/graph.js';
import { accept } from '../verify/acceptor.js';
import { isOnPath } from '../teacher/oracle.js';
import { taskHash, type Split, type Task } from '../schema.js';
import { stepDedupKey, type StoreRecord } from './store.js';

/** 特征白名单硬红线键（E.5/G0.4）。 */
const FORBIDDEN_KEYS: readonly string[] = ['expected', 'spec', 'plan_hidden', 'plan_hash', 'seed'];
/** state 面允许出现的唯一键（F.2 通道字段）。 */
const STATE_KEYS: readonly string[] = ['answer', 'verdict'];

export interface MetaCoords {
  readonly task_hash: string;
  readonly step_index: number;
  readonly split: Split;
  readonly composition_id: string;
}

/** 外部边界校验：记录必须携带可比对的审计坐标，缺即抛错不静默丢样本。 */
export function requireCoords(rec: StoreRecord, i: number): MetaCoords {
  const { task_hash: th, step_index: si, split, composition_id: ci } = rec.meta as Record<string, unknown>;
  if (
    typeof th !== 'string' ||
    typeof si !== 'number' ||
    typeof split !== 'string' ||
    typeof ci !== 'string'
  ) {
    throw new Error(`audit: 记录 #${String(i)} 的 meta 缺 task_hash/step_index/split/composition_id（fail-fast）`);
  }
  return { task_hash: th, step_index: si, split: split as Split, composition_id: ci };
}

/** 模板指纹：数字串归一为 #——同配方不同起点值视为同一模板（重叠统计唯一口径）。 */
export function templateFingerprint(instruction: string): string {
  return instruction.replace(/\d+/g, '#');
}

function obsLeaked(rec: StoreRecord): boolean {
  if (Object.keys(rec).some((k) => FORBIDDEN_KEYS.includes(k))) return true;
  if (Object.keys(rec.state as Record<string, unknown>).some((k) => !STATE_KEYS.includes(k))) return true;
  const surface = [rec.instruction, String(rec.x), String(rec.state.answer), String(rec.state.verdict)];
  return surface.some((s) => FORBIDDEN_KEYS.some((k) => s.includes(k)));
}

/** 同一 obs（task_hash + step_index + observation 规范序列化）的分桶键。 */
function obsBucketKey(coords: MetaCoords, rec: StoreRecord): string {
  return hashObj({
    ...coords,
    observation: hashObj({ x: rec.x, answer: rec.state.answer, verdict: rec.state.verdict, hist: [...rec.hist] }),
  });
}

export type QuarantineReason = 'label-conflict' | 'off-gold' | 'unreplayable';

export interface QuarantineEntry {
  readonly key: string;
  readonly task_hash: string;
  readonly step_index: number;
  readonly reason: QuarantineReason;
}

export interface AuditOptions {
  /** 与记录联动的任务（按 task_hash join）；缺省时抽样回放记 0，不假装通过。 */
  readonly tasks?: readonly Task[];
  readonly seed?: number;
  /** 标签 QA 的任务级抽样上限（缺省全量）。 */
  readonly sampleLimit?: number;
}

export interface AuditReport {
  readonly featureLeakCount: number;
  readonly skeletonOverlapCount: number;
  readonly templateOverlapCount: number;
  readonly labelConflictCount: number;
  readonly quarantinedCount: number;
  readonly passed: boolean;
  readonly quarantine: readonly QuarantineEntry[];
  readonly notes: {
    readonly checkedRecords: number;
    readonly tasksJoined: number;
    readonly replayedTasks: number;
    readonly replayOkTasks: number;
    readonly conflictGroups: number;
    readonly sampleLimit: number;
  };
}

/**
 * 标签回放：记录自带 state/hist 重建状态（spec 经 task join），核对候选内、
 * gold 前缀上、动作与 oracle 下一步一致、EXIT 位验收。返回最坏结论（null=干净）。
 */
function replayLabel(task: Task, rec: StoreRecord): QuarantineReason | null {
  const st: State = {
    x: rec.x,
    answer: rec.state.answer,
    verdict: rec.state.verdict,
    hist: [...rec.hist],
    spec: task.spec,
  };
  if (!candidates(GRAPH, st, st.hist).includes(rec.target)) return 'unreplayable';
  if (!isOnPath(st.hist, task.plan_hidden)) return 'off-gold';
  const pos = st.hist.length;
  const gold = pos < task.plan_hidden.length ? task.plan_hidden[pos] : EXIT;
  if (rec.target !== gold) return 'off-gold';
  if (rec.target === EXIT && !accept(task, st)) return 'unreplayable';
  return null;
}

const RANK: Record<QuarantineReason, number> = { unreplayable: 0, 'off-gold': 1, 'label-conflict': 2 };

/** G0.4 泄漏审计主入口：前四指标全 0 才 passed；quarantine 清单如实带出。 */
export function audit(records: readonly StoreRecord[], opts: AuditOptions = {}): AuditReport {
  const coords = records.map(requireCoords);
  let featureLeakCount = 0;
  for (const rec of records) if (obsLeaked(rec)) featureLeakCount++;

  const trainCids = new Set<string>();
  const heldCids = new Set<string>();
  for (const c of coords) {
    if (c.split === 'train') trainCids.add(c.composition_id);
    else if (c.split === 'heldout') heldCids.add(c.composition_id);
  }
  let skeletonOverlapCount = 0;
  for (const cid of [...trainCids].sort()) if (heldCids.has(cid)) skeletonOverlapCount++;

  const byTemplate = new Map<string, Set<string>>();
  records.forEach((rec, i) => {
    // goal 指令不含配方信息、天然跨骨架复用，模板重叠只对 follow 有意义。
    if (rec.style !== 'follow') return;
    const fp = templateFingerprint(rec.instruction);
    const set = byTemplate.get(fp) ?? new Set<string>();
    set.add(coords[i]!.composition_id);
    byTemplate.set(fp, set);
  });
  let templateOverlapCount = 0;
  for (const [, comps] of [...byTemplate].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (comps.size > 1) templateOverlapCount++;
  }

  const taskByKey = new Map<string, Task>((opts.tasks ?? []).map((t) => [taskHash(t), t]));
  let tasksJoined = 0;
  for (const th of new Set(coords.map((c) => c.task_hash))) if (taskByKey.has(th)) tasksJoined++;

  const buckets = new Map<string, number[]>();
  coords.forEach((c, i) => {
    const key = obsBucketKey(c, records[i]!);
    const arr = buckets.get(key) ?? [];
    arr.push(i);
    buckets.set(key, arr);
  });
  const reasonByRec = new Map<number, QuarantineReason>();
  const escalate = (i: number, r: QuarantineReason): void => {
    const cur = reasonByRec.get(i);
    if (cur === undefined || RANK[r] > RANK[cur]) reasonByRec.set(i, r);
  };
  let labelConflictCount = 0;
  let conflictGroups = 0;
  for (const [, idxs] of [...buckets].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const actions = new Set(idxs.map((i) => records[i]!.target));
    if (actions.size > 1) {
      labelConflictCount += actions.size - 1;
      conflictGroups++;
      for (const i of idxs) escalate(i, 'label-conflict');
    }
  }

  const byTask = new Map<string, number[]>();
  coords.forEach((c, i) => {
    const arr = byTask.get(c.task_hash) ?? [];
    arr.push(i);
    byTask.set(c.task_hash, arr);
  });
  const sampleLimit = opts.sampleLimit ?? Number.POSITIVE_INFINITY;
  let taskKeys = [...byTask.keys()].sort();
  if (Number.isFinite(sampleLimit) && taskKeys.length > sampleLimit) {
    taskKeys = makeRng(opts.seed ?? 0).shuffle(taskKeys).slice(0, sampleLimit).sort();
  }
  let replayedTasks = 0;
  let replayOkTasks = 0;
  for (const th of taskKeys) {
    const task = taskByKey.get(th);
    if (task === undefined) continue;
    replayedTasks++;
    let ok = true;
    for (const i of byTask.get(th)!) {
      const bad = replayLabel(task, records[i]!);
      if (bad !== null) {
        ok = false;
        escalate(i, bad);
      }
    }
    if (ok) replayOkTasks++;
  }

  const quarantine: QuarantineEntry[] = [...reasonByRec]
    .sort((a, b) => (a[0] === b[0] ? 0 : a[0] < b[0] ? -1 : 1))
    .map(([i, reason]) => ({
      key: stepDedupKey(records[i]!),
      task_hash: coords[i]!.task_hash,
      step_index: coords[i]!.step_index,
      reason,
    }));
  const passed =
    featureLeakCount === 0 &&
    skeletonOverlapCount === 0 &&
    templateOverlapCount === 0 &&
    labelConflictCount === 0;
  return {
    featureLeakCount,
    skeletonOverlapCount,
    templateOverlapCount,
    labelConflictCount,
    quarantinedCount: quarantine.length,
    passed,
    quarantine,
    notes: {
      checkedRecords: records.length,
      tasksJoined,
      replayedTasks,
      replayOkTasks,
      conflictGroups,
      sampleLimit: Number.isFinite(sampleLimit) ? sampleLimit : records.length + 1,
    },
  };
}
