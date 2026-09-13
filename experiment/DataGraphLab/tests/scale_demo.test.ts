/**
 * demos/scale_demo 测试：协议主体是 runScale（真实 trainer），CLI 面另测参数
 * 解析与非法输入。规模轴走 `--grid 100 --seeds 0`（真实 BC、短 epoch），预算
 * 120s；k 副轴与 large heldout 不进单测（离线大实验口径），heldout 用小配额。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { runScale } from '../eval/scale.js';
import { parseArgs } from '../demos/scale_demo.js';
import { defaultTrainerPath } from '../eval/scale.js';

const tmpRoots: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dgl-sdemo-'));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => {
  while (tmpRoots.length > 0) rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

describe('scale_demo CLI 解析', () => {
  it('--grid/--seeds 逗号串解析与非法值拒绝', () => {
    const opts = parseArgs(['--grid', '1000,10000', '--seeds', '0,1,2', '--out', 'x']);
    expect(opts.grid).toEqual([1000, 10000]);
    expect(opts.seeds).toEqual([0, 1, 2]);
    expect(() => parseArgs(['--grid', ''])).toThrow();
    expect(() => parseArgs(['--grid', '0'])).toThrow();
    expect(() => parseArgs(['--grid', 'abc'])).toThrow();
  });
});

describe('runScale（真实 trainer，小网格冒烟）', () => {
  it('--grid 100 --seeds 0 全链跑通且 results.csv 非空', { timeout: 120000 }, () => {
    expect(existsSync(defaultTrainerPath()), `训练器解释器缺失：${defaultTrainerPath()}`).toBe(true);
    const dir = tmpRoot();
    const report = runScale({
      grid: [100],
      seeds: [0],
      outRoot: dir,
      runId: 'real',
      heldoutPerFamily: 3,
      valPerFamily: 24,
      saveLastK: 5,
      includeKCoverage: false,
      trainPyArgs: ['--epochs', '14'],
      pythonTimeoutMs: 110000,
    });
    const csvPath = join(report.runDir, 'results.csv');
    expect(existsSync(csvPath)).toBe(true);
    const lines = readFileSync(csvPath, 'utf8').split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.length - 1).toBe(report.rows.length);
    expect(report.checkpoints[0]!.selected_snapshot_epoch).not.toBeNull();
    expect(report.meta.protocol).toBe('c8-v1');
    const trained = report.rows.filter((r) => r.arm === 'trained' && r.metric === 'pass1');
    expect(trained.length).toBe(2);
  });
});
