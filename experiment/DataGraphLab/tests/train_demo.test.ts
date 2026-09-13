/**
 * demos/train_demo 测试（真实 python）：--n 64 --seed 0 跑通「采样 → oracle →
 * bin → train.py → weights.json + metrics.json」全链，落盘物与 arch 合法性断言。
 *
 * 仓库 `.venv` 是既定环境事实：python 缺失即按测试失败处理并给明确消息，
 * 不做静默 skip（假通过比红着更有毒）。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { main } from '../demos/train_demo.js';
import { currentArch, readWeightsJson } from '../controller/checkpoint.js';
import { PKG_ROOT, defaultTrainerPath } from '../eval/scale.js';

const tmpRoots: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dgl-tdemo-'));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => {
  while (tmpRoots.length > 0) rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

describe('demos/train_demo（真实 trainer）', () => {
  it('python 与 train.py 必须在场（缺席 = 环境破坏，红给用户看而不是跳过）', () => {
    expect(existsSync(defaultTrainerPath()), `训练器解释器缺失：${defaultTrainerPath()}`).toBe(true);
    expect(existsSync(join(PKG_ROOT, 'controller', 'train.py'))).toBe(true);
  });

  it('--n 64 --seed 0 → weights.json + metrics.json 落盘、arch 合法', { timeout: 120000 }, () => {
    const dir = tmpRoot();
    const code = main(['--n', '64', '--seed', '0', '--out', dir]);
    expect(code, `train_demo 退出码非 0（见上方 stderr）`).toBe(0);
    const weightsPath = join(dir, 'weights.json');
    const metricsPath = join(dir, 'metrics.json');
    expect(existsSync(weightsPath)).toBe(true);
    expect(existsSync(metricsPath)).toBe(true);
    const file = readWeightsJson(weightsPath, { featureSet: 'lang' });
    expect(file.arch).toBe(currentArch('lang', 'progress'));
    const metrics = JSON.parse(readFileSync(metricsPath, 'utf8')) as Record<string, unknown>;
    expect(metrics.arch).toBe(file.arch);
    expect(typeof metrics.final_val_ce).toBe('number');
    expect(typeof metrics.epochs_run).toBe('number');
    expect(metrics.train_meta).toBeTypeOf('object');
    expect(existsSync(join(dir, 'train.bin'))).toBe(true);
    expect(existsSync(join(dir, 'val.bin'))).toBe(true);
  });
});
