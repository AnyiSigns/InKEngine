/**
 * REINFORCE 对照臂（G2.3）的 TS 侧断言：优势基线口径、采样行的确定性与结构合法性、
 * `reinforce.bin` 字节往返、臂的 greedy 评测，以及 Python 梯度数学的数值梯度自检
 * （`.venv` 缺席即红，不静默跳过——假通过比红着更有毒）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterAll, describe, expect, it } from 'vitest';

import {
  BASELINE_WINDOW,
  ReinforceArm,
  collectReinforceRows,
  slidingBaseline,
  writeReinforceFile,
} from '../eval/reinforce.js';
import { readReinforceBin } from '../data/reinforce_bin.js';
import { Policy } from '../controller/policy.js';
import { currentArch, readWeightsJson } from '../controller/checkpoint.js';
import { GRAPH } from '../runner/graph.js';
import { makeSplit } from '../gen/generator.js';
import { PKG_ROOT, defaultTrainerPath } from '../eval/scale.js';

const tmpRoots: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dgl-reinforce-'));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => {
  while (tmpRoots.length > 0) rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

describe('eval/reinforce：优势基线', () => {
  it('滑动窗口取最近 window 条均值；调用方在推入当前奖励前取值即自然排除自身', () => {
    expect(slidingBaseline([])).toBe(0);
    expect(slidingBaseline([1])).toBe(1);
    expect(slidingBaseline([1, 0, 1], 2)).toBeCloseTo(0.5, 15);
    const many = Array.from({ length: BASELINE_WINDOW + 10 }, (_, i) => (i < 10 ? 1 : 0));
    expect(slidingBaseline(many)).toBeCloseTo(0, 15); // 窗口滑过早期奖励后基线归零
  });
});

describe('eval/reinforce：采样数据与 bin 往返', () => {
  const tasks = makeSplit('train', 3, 5);

  it('同 seed 两次收集逐行相同；行结构合法（掩码/下标/优势有限）', () => {
    const policy = Policy.random(11, 'lang', 'none');
    const a = collectReinforceRows(policy, tasks, { seed: 3 });
    const b = collectReinforceRows(policy, tasks, { seed: 3 });
    expect(a).toEqual(b);
    expect(a.rollouts).toBe(tasks.length);
    expect(a.steps).toBe(a.rows.length);
    expect(a.solved).toBeGreaterThanOrEqual(0);
    for (const row of a.rows) {
      expect(row.candMask >>> 0).toBe(row.candMask);
      expect(row.actionIdx).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(row.advantage)).toBe(true);
      expect(row.reward === 0 || row.reward === 1).toBe(true);
      expect(row.idx.length).toBe(row.val.length);
    }
  });

  it('reinforce.bin 写读往返逐行一致（magic/版本/动作表随 header）', () => {
    const policy = Policy.random(7, 'lang', 'none');
    const collected = collectReinforceRows(policy, tasks, { seed: 1 });
    const path = join(tmpRoot(), 'reinforce.bin');
    writeReinforceFile(path, collected.rows, 'lang');
    const back = readReinforceBin(path);
    expect(back.obsDim).toBe(732);
    expect(back.actDim).toBe(83);
    expect(back.actFeats.length).toBe(22);
    expect(back.rows.length).toBe(collected.rows.length);
    for (let i = 0; i < back.rows.length; i++) {
      const r = back.rows[i]!;
      const o = collected.rows[i]!;
      expect(r.taskHash).toBe(o.taskHash);
      expect(r.stepIndex).toBe(o.stepIndex);
      expect(r.actionIdx).toBe(o.actionIdx);
      expect(r.candMask).toBe(o.candMask);
      expect(r.advantage).toBeCloseTo(o.advantage, 5);
      expect(r.reward).toBeCloseTo(o.reward, 5);
    }
  });

  it('ReinforceArm 同 greedy rollout 口径，passAt1 报告结构完整', () => {
    const arm = new ReinforceArm(Policy.random(0, 'lang', 'none'));
    const rep = ReinforceArm.evaluate(arm, tasks, GRAPH);
    expect(rep.total).toBe(tasks.length);
    expect(rep.solved).toBeLessThanOrEqual(rep.total);
    expect(rep.ci95[0]).toBeLessThanOrEqual(rep.passRate);
    expect(rep.passRate).toBeLessThanOrEqual(rep.ci95[1]);
  });
});

describe('REINFORCE 跨语言闭环：TS 采集 → Python 批量梯度 → weights.json', () => {
  it('bin → train_reinforce.py → arch v1:lang:732:83:128:none 且可被 Policy.load', () => {
    const dir = tmpRoot();
    const tasks = makeSplit('train', 3, 5);
    const collected = collectReinforceRows(Policy.random(7, 'lang', 'none'), tasks, { seed: 1 });
    const bin = join(dir, 'reinforce.bin');
    writeReinforceFile(bin, collected.rows, 'lang');
    const out = join(dir, 'weights.json');
    const res = spawnSync(
      defaultTrainerPath(),
      [join(PKG_ROOT, 'controller', 'train.py'), '--loss', 'reinforce',
        '--train', bin, '--out', out, '--seed', '0'],
      { cwd: PKG_ROOT, encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
    );
    expect(res.error, `Python 启动失败：${res.error?.message ?? ''}`).toBeUndefined();
    expect(res.status, `train_reinforce 退出码非 0：${res.stderr}`).toBe(0);
    const file = readWeightsJson(out, { featureSet: 'lang', head: 'none' });
    expect(file.arch).toBe(currentArch('lang', 'none'));
    const policy = Policy.load(out, { featureSet: 'lang', head: 'none' });
    expect(policy).toBeTruthy();
  }, 300000);
});

describe('controller/reinforce_nn.py：策略梯度数值自检', () => {  it('中心差分相对范数差 < 1e-5（.venv 缺席即红）', () => {
    const script = join(PKG_ROOT, 'controller', 'reinforce_nn.py');
    const res = spawnSync(defaultTrainerPath(), [script], {
      cwd: PKG_ROOT,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    expect(res.error, `Python 启动失败：${res.error?.message ?? ''}`).toBeUndefined();
    expect(res.status, `reinforce_nn 退出码非 0：${res.stderr}`).toBe(0);
    expect(res.stdout).toMatch(/1\.\d+e-\d{2}/);
  }, 300000);
});
