/**
 * eval/scale 测试：checkpoint 选点（手工权重 + 构造目标题的确定性判据）、
 * fake 训练器 e2e（results 契约行集 / 选点 / 落盘 / 幂律 note）、k=100 覆盖轴。
 *
 * fake 训练器与手工权重都在 tests/fixtures_scale_trainer.ts 生成（桩由测试写入
 * 临时目录、随临时目录删除，仓库不落任何产物）。选点单测的判据在夹具头注：
 * 全零权重在一切任务上 pass@1=0（answer 恒 null），偏好权重只解构造题 →
 * 「第 2 个快照 val_pass1 更高 → 选第 2 个 epoch」可精确断言。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCoverageAxis, runScale, selectCheckpoint, writeScaleResults } from '../eval/scale.js';
import { BETA_ENT } from '../eval/reinforce.js';
import { hashObj } from '../world/hash.js';
import { rollout } from '../runner/rollout.js';
import { GRAPH } from '../runner/graph.js';
import type { WeightsFile } from '../controller/checkpoint.js';
import type { Task } from '../schema.js';
import { pSolveParams, pZeroParams, writeFakeTrainer } from './fixtures_scale_trainer.js';

const tmpRoots: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dgl-scale-'));
  tmpRoots.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpRoots.length > 0) rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

function fileWith(snapshots: unknown[], finalParams = pZeroParams(), bestEpoch: number | null = 0): WeightsFile {
  return {
    arch: 'v1:lang:732:83:128:progress',
    dims: { featureSet: 'lang', obsDim: 732, actDim: 83, h: 128, head: 'progress' },
    params: finalParams,
    train_meta: { epochs_run: 2, final_val_ce: 0.5, best_epoch: bestEpoch, epoch_snapshots: snapshots },
  };
}

const t0: Task = {
  style: 'goal', family: 'goal', instruction: '提交长度处于一到二的字符串', x: 'AB',
  spec: { goal: { kind: 'len', min: 1, max: 2 } }, expected: 'AB', plan_hidden: ['submit'],
  root: 'Str', plan_hash: hashObj(['submit']), composition_id: 'fixture-0', split: 'val',
};
const t1: Task = {
  ...t0, instruction: '提交长度处于五到六的字符串',
  spec: { goal: { kind: 'len', min: 5, max: 6 } },
};

describe('selectCheckpoint（C.8 终点选点：末 K 快照 + 最终 params）', () => {
  it('第 2 个快照 val_pass1 更高 → 选第 2 个 epoch', () => {
    const file = fileWith([
      { epoch: 0, val_ce: 0.9, params: pZeroParams() },
      { epoch: 1, val_ce: 0.8, params: pSolveParams() },
    ]);
    const sel = selectCheckpoint(file, [t0, t1], 2);
    expect(sel.selectedSnapshotEpoch).toBe(1);
    expect(sel.bestValPass1).toBeCloseTo(0.5, 10);
    const back = rollout(sel.policy, GRAPH, t0, true);
    expect(back.accepted).toBe(true);
    expect(back.trace.map((s) => s.action)).toEqual(['submit', 'submit', 'exit']);
  });

  it('并列取更靠后候选；全零重复快照与最终 params 去重后不重复评估', () => {
    const file = fileWith([
      { epoch: 0, val_ce: 0.9, params: pZeroParams() },
      { epoch: 1, val_ce: 0.8, params: pSolveParams() },
    ]);
    // t1 谁都解不开 → 两候选并列 0 → 靠后者（更晚 epoch）当选。
    expect(selectCheckpoint(file, [t1], 2).selectedSnapshotEpoch).toBe(1);
    const dup = fileWith([{ epoch: 0, val_ce: 0.9, params: pZeroParams() }]);
    const snap0 = (dup.train_meta.epoch_snapshots as { params: unknown }[])[0]!;
    expect(dup.params).deep.equal(snap0.params);
    // 全零重复 + 最终 params 同为全零 → 候选去重成 1 个，epoch 记 0。
    expect(selectCheckpoint(dup, [t0, t1], 2).selectedSnapshotEpoch).toBe(0);
  });

  it('val 为空不崩；无快照时回落最终 params（best_epoch null → 记 0）', () => {
    const file = fileWith([], pSolveParams(), null);
    expect(selectCheckpoint(file, [], 5).bestValPass1).toBe(0);
    expect(selectCheckpoint(file, [t0], 5).selectedSnapshotEpoch).toBe(0);
  });
});

describe('runScale（fake 训练器 e2e，C.8 契约）', () => {
  it('行集 / 选点 / results.{json,csv} 落盘', { timeout: 120000 }, () => {
    const dir = tmpRoot();
    const stub = writeFakeTrainer(dir);
    const report = runScale({
      grid: [100],
      seeds: [0],
      outRoot: dir,
      runId: 'fake',
      trainer: stub,
      saveLastK: 2,
      heldoutPerFamily: 3,
      pythonTimeoutMs: 60000,
      includeKCoverage: false,
      coverageN: 100,
    });
    expect(report.meta.protocol).toBe('c8-v1');
    expect(report.meta.grid).toEqual([100]);
    expect(report.meta.seeds).toEqual([0]);
    expect(report.meta.trainer).toBe('controller/train.py');
    expect(report.meta.heldout_cap).toBe(300);
    expect(report.meta.world_version).toHaveLength(16);
    // 行集 = 钉死的口径：pass1×(follow 四臂 / goal 四臂) + trained 诊断列。
    const keys = new Set(report.rows.map((r) => `${r.style}/${r.arm}/${r.metric}`));
    expect(keys).toEqual(new Set([
      'follow/heuristic/pass1', 'follow/random/pass1', 'follow/contract_route/pass1',
      'follow/trained/pass1', 'follow/trained/path_excess', 'follow/trained/routing_acc',
      'goal/random/pass1', 'goal/planner/pass1', 'goal/contract_route/pass1',
      'goal/trained/pass1', 'goal/trained/steps_over_shortest',
      'goal/trained/steps_over_shortest_overbudget', 'goal/trained/safe_action_conflict_rate',
      'goal/trained/routing_acc',
    ]));
    expect(report.checkpoints).toHaveLength(1);
    const ck = report.checkpoints[0]!;
    expect(ck.N).toBe(100);
    expect(ck.seed).toBe(0);
    // 全零下界恒 0、偏好权重 ≥0 → 无论并列还是晋级，确定性落在 epoch1。
    expect(ck.selected_snapshot_epoch).toBe(1);
    expect(ck.final_val_ce).toBe(0.7);
    expect(ck.best_val_pass1).toBeGreaterThanOrEqual(0);
    for (const r of report.rows.filter((e) => e.metric === 'pass1')) {
      expect(r.n).toBeGreaterThan(0);
      expect(r.value).toBeGreaterThanOrEqual(0);
      expect(r.value).toBeLessThanOrEqual(1);
      expect(typeof r.ciLo).toBe('number');
      expect(typeof r.ciHi).toBe('number');
    }
    // 幂律：1 个 N 点不足拟合，如实记 null + note。
    for (const style of ['follow', 'goal'] as const) {
      const fit = report.powerLaw[style];
      expect(fit.S_inf).toBeNull();
      expect(fit.note.length).toBeGreaterThan(0);
      expect(fit.fitted_on).toEqual([100]);
    }
    expect(report.kCoverage).toEqual([]);
    expect(report.coverageSet.taskCount).toBeGreaterThan(0);
    // 落盘契约。
    const json = JSON.parse(readFileSync(join(report.runDir, 'results.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(['checkpoints', 'k_coverage', 'meta', 'power_law', 'rows']);
    const jsonRows = json.rows as Record<string, unknown>[];
    expect(Object.keys(jsonRows[0]!).sort()).toEqual(['N', 'arm', 'ci_hi', 'ci_lo', 'metric', 'n', 'seed', 'style', 'value']);
    const csv = readFileSync(join(report.runDir, 'results.csv'), 'utf8').split('\n').filter((l) => l.length > 0);
    expect(csv[0]).toBe('N,seed,style,arm,metric,value,ci_lo,ci_hi,n');
    expect(csv.length - 1).toBe(report.rows.length);
    // 再显式写一遍（demo 通路的幂等入口）。
    writeScaleResults(join(dir, 'extra.json'), join(dir, 'extra.csv'), report);
    expect(existsSync(join(dir, 'extra.json'))).toBe(true);
  });

  it('同参数两次运行 rows 逐字一致（确定性，除时间戳外无随机量）', { timeout: 180000 }, () => {
    const dir = tmpRoot();
    const stub = writeFakeTrainer(dir);
    const a = runScale({
      grid: [40], seeds: [0], outRoot: dir, runId: 'r1', trainer: stub, saveLastK: 2,
      heldoutPerFamily: 2, pythonTimeoutMs: 60000, includeKCoverage: false,
    });
    const b = runScale({
      grid: [40], seeds: [0], outRoot: dir, runId: 'r2', trainer: stub, saveLastK: 2,
      heldoutPerFamily: 2, pythonTimeoutMs: 60000, includeKCoverage: false,
    });
    expect(JSON.stringify(a.rows)).toBe(JSON.stringify(b.rows));
    expect(JSON.stringify(a.checkpoints)).toBe(JSON.stringify(b.checkpoints));
  });

  it('k=100 覆盖轴：剩余池按构造为空，行仍按两 style 如实报 n=0', { timeout: 90000 }, () => {
    const dir = tmpRoot();
    const stub = writeFakeTrainer(dir);
    const res = runCoverageAxis({
      coverageKs: [100],
      coverageN: 20,
      styleRatio: 0.5,
      runDir: dir,
      trainer: stub,
      valBin: join(dir, 'unused.bin'),
      saveLastK: 2,
      timeoutMs: 60000,
    });
    expect(res.skippedByK[100]).toBe(0);
    expect(res.rows.map((r) => `${r.k}/${r.style}/${r.n}`)).toEqual(['100/follow/0', '100/goal/0']);
    expect(res.rows.every((r) => r.pass1 === 0)).toBe(true);
  });
});

// A.2 钉死对照臂超参：与 controller 两处 .py 字面同源，防 eval 侧静默漂移。
describe('A.2 REINFORCE 熵正则系数钉死（eval 侧）', () => {
  it('BETA_ENT === 0.01（A.2 终稿值）', () => {
    expect(BETA_ENT).toBe(0.01);
  });
});
