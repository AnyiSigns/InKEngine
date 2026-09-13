/**
 * F1–F4 防漂移门禁断言（判据/阈值照 F.3 表）：逐门禁跑 conformance/f_gates.ts
 * 的 run 函数，断言判据数字并复核 passed 与 evaluateThresholds 一致（不手写
 * 布尔值）。上下文用最小 GateContext（本测试只消费 worldVersion/inputsHash，
 * 不依赖 harness 的数据批次——F 门禁的输入是冻结 fixture，不是生成流）。
 *
 * 两条跨语言断言 F1/F2 经 spawnSync 起 `.venv` 的 python 跑 py_forward.py：
 * 解释器缺失或脚本非零退出会由门禁模块抛出带路径/退出码的错误——测试直接
 * fail 并展示该消息，绝不静默跳过（F.3 零容忍同纪律：缺失即红，不是没测）。
 * F3 额外注入一份含 LEXICON 的伪 py 文件验证审计确实会咬人。
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runF1, runF2, runF3, runF4 } from '../conformance/f_gates.js';
import { evaluateThresholds, gateShapeKeys, type GateContext } from '../conformance/gates/common.js';
import { hashObj } from '../world/hash.js';
import { worldVersion } from '../world/version.js';

let shared: GateContext | undefined;
function ctx(): GateContext {
  if (shared === undefined) {
    shared = {
      worldVersion,
      inputsHash: hashObj({ world_version: worldVersion, scope: 'f_gates_test' }),
      manifestHash: 'test',
      fixturesHash: 'test',
      fixtures: { rng: [], crc32: [], canonical: [] },
      genTasks: () => {
        throw new Error('F 门禁不消费生成批次');
      },
      outDir: undefined,
      artifactPrefix: '',
    };
  }
  return shared;
}

/** 形状与判据复核（复用 common 的唯一口径）；额外断言本门禁特有数字。 */
function expectGate(res: ReturnType<typeof runF1>, id: string): void {
  expect(res.gate).toBe(id);
  for (const key of gateShapeKeys()) expect(res).toHaveProperty(key);
  expect(res.inputs_hash).toBe(ctx().inputsHash);
  expect(res.world_version).toBe(ctx().worldVersion);
  expect(res.passed, `${id} notes=${res.notes ?? ''} metrics=${JSON.stringify(res.metrics)}`).toBe(true);
  expect(evaluateThresholds(res.metrics, res.thresholds)).toBe(res.passed);
}

describe('防漂移门禁 F1–F4（conformance/ffixtures 冻结输入）', () => {
  it('F1 前向一致：TS f64 重算与 Python f64 softmax 逐元素 max|Δ| < 1e-6', () => {
    const res = runF1(ctx());
    expectGate(res, 'F1');
    expect(res.metrics.max_abs_diff).toBeLessThan(1e-6);
    expect(res.metrics.n_groups).toBeGreaterThanOrEqual(1);
    expect(res.metrics.tol).toBe(1e-6);
  }, 60_000);

  it('F2 往返一致：TS Policy.actFromObs 与 Python greedy action 100% 一致', () => {
    const res = runF2(ctx());
    expectGate(res, 'F2');
    expect(res.metrics.agree_rate).toBe(1);
    expect(res.metrics.total).toBeGreaterThanOrEqual(1);
    expect(res.metrics.tie_count).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('F3 特征单源：训练器与 conformance 入口源码 banned 标识符零命中', () => {
    const res = runF3(ctx());
    expectGate(res, 'F3');
    expect(res.metrics.banned_hits).toBe(0);
    expect(res.metrics.files_scanned).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it('F3 审计有效性：注入含 LEXICON 的伪 py 文件必命中（证明扫描不是摆设）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dgl-f3-'));
    const fakePath = join(dir, 'fake_feature.py');
    writeFileSync(fakePath, '# 伪特征文件：只用于验证 F3 审计能咬到 LEXICON\nLEXICON = {"add3": ["加三"]}\n', 'utf8');
    const res = runF3(ctx(), [{ path: 'conformance/ffixtures/_fake_feature.py', content: readFileSync(fakePath, 'utf8') }]);
    expect(res.gate).toBe('F3');
    expect(res.metrics.banned_hits).toBeGreaterThan(0);
    expect(res.passed).toBe(false);
  }, 60_000);

  it('F4 规范序列化自检：canonicalJson/hashObj 与 f4_expected.json 逐字一致', () => {
    const res = runF4(ctx());
    expectGate(res, 'F4');
    expect(res.metrics.all_stable).toBe(1);
    expect(res.metrics.cases_checked).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
