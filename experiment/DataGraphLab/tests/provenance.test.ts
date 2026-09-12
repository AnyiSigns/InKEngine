/**
 * data/provenance 测试（§6 + D 表 + docs/gates.md G0.4）：manifest 稳定对象；
 * audit 对合法数据集 passed 且前四指标为 0，泄漏/骨架重叠/模板重叠样本必红，
 * 冲突标签进 quarantine；safeActionConflictRate 固定 seed 确定、先过滤
 * （目标族+join+on-path）后在子池上抽样 ≤200、shape 正确。数据集仅驻内存，
 * 测试不落仓库 runs/。
 */

import { describe, expect, it } from 'vitest';

import { audit, manifest, safeActionConflictRate } from '../data/provenance.js';
import { recordFromStep, type StoreRecord } from '../data/store.js';
import { oracleTrace } from '../teacher/oracle.js';
import { makeTask } from '../gen/generator.js';
import { GRAPH } from '../runner/graph.js';
import { worldVersion } from '../world/version.js';
import { PROBE_INT, PROBE_STR } from '../gen/skeletons.js';
import { canonicalJson, hashObj } from '../world/hash.js';
import { taskHash, type Family, type Split, type Style, type Task } from '../schema.js';

type Combo = [Style, Family, Split];
const COMBOS: readonly Combo[] = [
  ['follow', 'value', 'train'],
  ['follow', 'verify', 'train'],
  ['follow', 'value', 'val'],
  ['follow', 'verify', 'heldout'],
  ['goal', 'goal', 'train'],
  ['goal', 'goal_verify', 'train'],
  ['goal', 'goal', 'heldout'],
  ['goal', 'goal_verify', 'val'],
  ['follow', 'value', 'heldout'],
];

/** 逐 (style, family, split) 组合确定性取任务：同 seed 基 + 失败沿 attempt 推进，必得全组合。 */
function sampleTasks(): Task[] {
  const out: Task[] = [];
  for (const [style, family, split] of COMBOS) {
    let task: Task | null = null;
    for (let attempt = 0; attempt < 10 && task === null; attempt++) {
      task = makeTask(attempt * 13 + 1, style, family, split);
    }
    if (task === null) throw new Error(`provenance 测试数据集构造失败: ${style}/${family}/${split}`);
    out.push(task);
  }
  return out;
}

function recordsOf(tasks: readonly Task[]): StoreRecord[] {
  const out: StoreRecord[] = [];
  for (const t of tasks) {
    for (const step of oracleTrace(t, GRAPH)) out.push(recordFromStep(t, step));
  }
  return out;
}

function legitDataset(): { records: StoreRecord[]; tasks: Task[] } {
  const tasks = sampleTasks();
  return { records: recordsOf(tasks), tasks };
}

describe('data/provenance/manifest（§6 全员版本化）', () => {
  it('返回 Manifest 六字段且 world_version = world/version；两次调用逐字相同', () => {
    const m1 = manifest();
    const m2 = manifest();
    expect(Object.keys(m1).sort()).toEqual([
      'acceptor_version',
      'controller_code_hash',
      'generator_version',
      'probe_hash',
      'teacher_pin',
      'world_version',
    ]);
    expect(m1.world_version).toBe(worldVersion);
    expect(canonicalJson(m1)).toBe(canonicalJson(m2));
  });

  it('探针集/版本号/pin 任一变化即改 hash（数据集快照可追溯）', () => {
    const base = manifest();
    const altProbes = manifest({ probes: { int: [0], str: PROBE_STR } });
    expect(altProbes.probe_hash).not.toBe(base.probe_hash);
    expect(altProbes.probe_hash).toHaveLength(16);
    expect(manifest({ generatorVersion: 'gen@2' }).generator_version).toBe('gen@2');
    expect(manifest({ teacherPin: 'oracle@v2' }).teacher_pin).toBe('oracle@v2');
    expect(manifest({ acceptorVersion: 'accept@v1' }).acceptor_version).toBe('accept@v1');
    expect(PROBE_INT.length).toBe(101);
  });
});

describe('data/provenance/audit（G0.4 泄漏审计）', () => {
  it('合法数据集：passed=true，前四项为 0，quarantine 为空', () => {
    const { records, tasks } = legitDataset();
    expect(records.length).toBeGreaterThan(20);
    const report = audit(records, { tasks });
    expect(report.featureLeakCount).toBe(0);
    expect(report.skeletonOverlapCount).toBe(0);
    expect(report.templateOverlapCount).toBe(0);
    expect(report.labelConflictCount).toBe(0);
    expect(report.quarantinedCount).toBe(0);
    expect(report.passed).toBe(true);
    expect(report.quarantine).toEqual([]);
    expect(report.notes.replayOkTasks).toBe(tasks.length);
  });

  it('确定性：同一数据集两次 audit 结果逐字相同', () => {
    const { records, tasks } = legitDataset();
    expect(canonicalJson(audit(records, { tasks, seed: 3 }))).toBe(
      canonicalJson(audit(records, { tasks, seed: 3 })),
    );
  });

  it('泄漏样本：state 里塞 expected → featureLeakCount>0 且 passed=false', () => {
    const { records, tasks } = legitDataset();
    const r = records[0]!;
    const leaked: StoreRecord = {
      ...r,
      state: { ...r.state, expected: 999 } as unknown as StoreRecord['state'],
    };
    const report = audit([...records.slice(0, 1), leaked, ...records.slice(2)], { tasks });
    expect(report.featureLeakCount).toBeGreaterThan(0);
    expect(report.passed).toBe(false);
  });

  it('泄漏样本：顶层塞 spec / plan_hidden 键与指令夹带 JSON 关键名同样必检出', () => {
    const { records, tasks } = legitDataset();
    const r = records[0]!;
    const body = records.slice(1);
    const withSpec = { ...r, spec: { parity: 0 } } as unknown as StoreRecord;
    const withPlan = { ...r, plan_hidden: ['mul2', 'submit'] } as unknown as StoreRecord;
    const withKeyInText: StoreRecord = { ...r, instruction: r.instruction + '"plan_hidden":[]' };
    const report = audit([withSpec, withPlan, withKeyInText, ...body], { tasks });
    expect(report.featureLeakCount).toBe(3);
    expect(report.passed).toBe(false);
  });

  it('骨架重叠样本：train 记录挂上 heldout 的 composition_id → skeletonOverlapCount>0', () => {
    const { records, tasks } = legitDataset();
    const heldCid = tasks.find((t) => t.split === 'heldout')!.composition_id;
    const idx = records.findIndex((r) => r.meta.split === 'train' && r.meta.composition_id !== heldCid);
    const r = records[idx]!;
    const overlap: StoreRecord = { ...r, meta: { ...r.meta, composition_id: heldCid } };
    const report = audit([...records.slice(0, idx), overlap, ...records.slice(idx + 1)], { tasks });
    expect(report.skeletonOverlapCount).toBe(1);
    expect(report.passed).toBe(false);
  });

  it('模板重叠样本：同一条 follow 指令挂两个 composition → templateOverlapCount>0', () => {
    const { records, tasks } = legitDataset();
    const idx = records.findIndex((r) => r.style === 'follow' && r.meta.step_index === 0);
    const r = records[idx]!;
    const twin: StoreRecord = {
      ...r,
      meta: { ...r.meta, composition_id: 'skel-forged-twin', plan_hash: hashObj(['twin']) },
    };
    const report = audit([...records, twin], { tasks });
    expect(report.templateOverlapCount).toBe(1);
    expect(report.passed).toBe(false);
  });

  it('goal 族模板跨骨架复用属多解设计语义，不计模板重叠', () => {
    const { records, tasks } = legitDataset();
    const first = records.find((r) => r.style === 'goal' && r.meta.step_index === 0)!;
    const forged: StoreRecord = {
      ...first,
      meta: { ...first.meta, composition_id: 'skel-goal-fake-x', plan_hash: hashObj(['goal-twin']) },
    };
    const report = audit([...records, forged], { tasks });
    expect(report.templateOverlapCount).toBe(0);
  });

  it('冲突标签：同一 obs 两个不同 action → labelConflictCount=1，双方进 quarantine', () => {
    const { records, tasks } = legitDataset();
    const r = records.find((x) => x.meta.step_index === 0 && x.candidates.includes('fake_add'))!;
    expect(r.target).not.toBe('fake_add');
    const conflicting: StoreRecord = {
      ...r,
      target: 'fake_add',
      meta: { ...r.meta, plan_hash: hashObj(['fake_add']) },
    };
    const report = audit([...records, conflicting], { tasks });
    expect(report.labelConflictCount).toBe(1);
    expect(report.quarantinedCount).toBe(2);
    expect(report.quarantine.every((q) => q.reason === 'label-conflict')).toBe(true);
    const groupKeys = new Set(report.quarantine.map((q) => q.task_hash));
    expect(groupKeys.size).toBe(1);
    expect(report.passed).toBe(false);
  });

  it('完全相同的重复标签（同 obs 同 action）不构成冲突，audit 仍 passed', () => {
    const { records, tasks } = legitDataset();
    const r = records[0]!;
    const report = audit([...records, { ...r }], { tasks });
    expect(report.labelConflictCount).toBe(0);
    expect(report.quarantinedCount).toBe(0);
    expect(report.passed).toBe(true);
  });

  it('离路标签（action 不在 gold 前缀下一步）进 quarantine', () => {
    const { records, tasks } = legitDataset();
    // step-0 gold 记录必为真算子（decoy `noop` 永不入 plan），换成 noop 即确定的 off-gold
    const idx = records.findIndex((r) => r.meta.step_index === 0 && r.candidates.includes('noop') && r.target !== 'noop');
    expect(idx).toBeGreaterThanOrEqual(0);
    const r = records[idx]!;
    const offGold: StoreRecord = { ...r, target: 'noop' };
    const report = audit([...records.slice(0, idx), offGold, ...records.slice(idx + 1)], { tasks });
    expect(report.quarantinedCount).toBeGreaterThan(0);
    expect(report.quarantine.some((q) => q.reason === 'off-gold')).toBe(true);
  });

  it('无 tasks 时抽样 QA 记 skipped（不假装回放通过）', () => {
    const { records } = legitDataset();
    const report = audit(records);
    expect(report.passed).toBe(true);
    expect(report.notes.tasksJoined).toBe(0);
    expect(report.notes.replayOkTasks).toBe(0);
  });

  it('meta 缺关键字段的记录 fail-fast', () => {
    const { records, tasks } = legitDataset();
    const broken = { ...records[0]!, meta: {} } as StoreRecord;
    expect(() => audit([broken], { tasks })).toThrow(/meta/);
  });
});

describe('data/provenance/safeActionConflictRate（目标族诊断，C.8）', () => {
  const isGoalFam = (r: StoreRecord): boolean => r.family === 'goal' || r.family === 'goal_verify';

  it('返回 {rate, sampled, notes}；固定 seed 下逐字确定；notes 计数守恒', () => {
    const { records, tasks } = legitDataset();
    const r1 = safeActionConflictRate(records, { tasks, seed: 7, limit: 8, nodeBudget: 24 });
    const r2 = safeActionConflictRate(records, { tasks, seed: 7, limit: 8, nodeBudget: 24 });
    expect(typeof r1.rate).toBe('number');
    expect(r1.rate).toBeGreaterThanOrEqual(0);
    expect(r1.rate).toBeLessThanOrEqual(1);
    expect(r1.sampled).toBeGreaterThan(0);
    expect(r1.sampled).toBeLessThanOrEqual(8);
    expect(canonicalJson(r1)).toBe(canonicalJson(r2));
    expect(r1.notes.nodeBudget).toBe(24);
    expect(r1.notes.onPathPool).toBeGreaterThanOrEqual(r1.sampled);
    // 过滤全池扫描口径：poolSize = 族剔除 + 无 task + off-path + 子池。
    const n = r1.notes;
    expect(n.poolSize).toBe(n.excludedFollow + n.skippedNoTask + n.skippedOffPath + n.onPathPool);
  }, 120_000);

  it('池含 follow 记录时默认被排除：只统计 goal/goal_verify；includeFollow 才放回', () => {
    const { records, tasks } = legitDataset();
    const goalOnly = records.filter(isGoalFam);
    const followCount = records.length - goalOnly.length;
    expect(goalOnly.length).toBeGreaterThan(0);
    expect(followCount).toBeGreaterThan(0);
    const def = safeActionConflictRate(records, { tasks, seed: 3, nodeBudget: 24 });
    expect(def.notes.excludedFollow).toBe(followCount);
    expect(def.notes.onPathPool).toBe(goalOnly.length);
    const withFollow = safeActionConflictRate(records, { tasks, seed: 3, nodeBudget: 24, includeFollow: true });
    expect(withFollow.notes.excludedFollow).toBe(0);
    expect(withFollow.notes.onPathPool).toBe(records.length);
  }, 120_000);

  it('抽样上限 ≤200：子池 >200 时 sampled 恰 200；抽在过滤后子池上，limit 即有效样本量', () => {
    const tasks: Task[] = [];
    for (let seed = 1; seed <= 120; seed++) {
      const t = makeTask(seed, 'goal');
      if (t !== null) tasks.push(t);
    }
    const records = recordsOf(tasks);
    const full = safeActionConflictRate(records, { tasks, seed: 0, nodeBudget: 6 });
    expect(full.notes.onPathPool).toBeGreaterThan(200);
    expect(full.sampled).toBe(200);
    const tight = safeActionConflictRate(records, { tasks, seed: 0, limit: 5, nodeBudget: 6 });
    expect(tight.sampled).toBe(5);
    expect(full.rate).toBeGreaterThanOrEqual(0);
    expect(full.notes.poolSize).toBe(records.length);
  }, 120_000);

  it('多解状态（金标之外仍有合法且通向验收的动作）计入冲突：验收态末步 exit 标签必伴随 noop 类冲突', () => {
    let task: Task | null = null;
    for (let attempt = 0; attempt < 10 && task === null; attempt++) {
      task = makeTask(attempt + 1, 'follow', 'value', 'train');
    }
    const t = task ?? makeTask(2, 'goal', 'goal', 'train');
    expect(t).not.toBeNull();
    const trace = oracleTrace(t!, GRAPH);
    const records = trace.map((s) => recordFromStep(t!, s));
    const exitRec = records[records.length - 1]!;
    expect(exitRec.target).toBe('exit');
    const one = safeActionConflictRate([exitRec], { tasks: [t!], seed: 1, nodeBudget: 400, includeFollow: true });
    expect(one.sampled).toBe(1);
    // 验收态下 noop/echo 类动作仍通向验收 ⇒ 多解噪音必被计为冲突
    expect(one.rate).toBe(1);
    // 缺省目标族口径：同一条 follow 记录整条被族过滤，sampled 归 0。
    const excluded = safeActionConflictRate([exitRec], { tasks: [t!], seed: 1, nodeBudget: 400 });
    expect(excluded.notes.excludedFollow).toBe(isGoalFam(exitRec) ? 0 : 1);
    expect(excluded.sampled).toBe(isGoalFam(exitRec) ? 1 : 0);
  }, 120_000);

  it('未 join 到 task 的记录计入跳过注记（全池口径、恰 1），不炸', () => {
    const { records, tasks } = legitDataset();
    const src = records.find(isGoalFam)!;
    const orphan: StoreRecord = { ...src, meta: { ...src.meta, task_hash: 'no-such-task' } };
    const res = safeActionConflictRate([...records, orphan], { tasks, seed: 2, limit: 3, nodeBudget: 80 });
    expect(res.sampled).toBeLessThanOrEqual(3);
    expect(res.notes.poolSize).toBe(records.length + 1);
    expect(res.notes.skippedNoTask).toBe(1);
  }, 120_000);
});
