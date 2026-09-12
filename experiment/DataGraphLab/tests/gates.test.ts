/**
 * 门禁判定脚本断言（docs/gates.md §0.1）：把每个 G0.x 的 run() 包成 vitest 用例，
 * 断言 `passed` 且 `passed === evaluateThresholds(metrics, thresholds)`（判据由
 * metrics/thresholds 机器复核，不手写期望数字）。上下文由 `createGateContext()`
 * 构造——与 `npm run gate` 走同一代码路径、同一批确定性数据（上下文内按
 * (split, perFamily, seed) 缓存生成批次），因此本文件断言与 CI 独立入口结果一致。
 * 门禁内部零网络零 LLM；批次参数钉死后单次全量约数十秒，属预期。唯一例外是
 * G0.3 规模哨兵用例：它不复核判据，而是字面钉死套件规模（越小越危险的东西）。
 */

import { describe, expect, it } from 'vitest';

import { createGateContext, runAll, type GateContext, type GateResult } from '../conformance/gates/harness.js';
import { run as runG01 } from '../conformance/gates/g01_determinism.js';
import { run as runG02 } from '../conformance/gates/g02_solvable.js';
import { run as runG03 } from '../conformance/gates/g03_adversarial.js';
import { run as runG04 } from '../conformance/gates/g04_leakage.js';
import { run as runG05 } from '../conformance/gates/g05_kl.js';
import { run as runG06 } from '../conformance/gates/g06_goal_separability.js';
import { evaluateThresholds, gateShapeKeys } from '../conformance/gates/common.js';
import { SKELETONS } from '../gen/generator.js';

let shared: GateContext | undefined;
function ctx(): GateContext {
  if (shared === undefined) shared = createGateContext();
  return shared;
}

function expectGate(res: GateResult, gate: string): void {
  expect(res.gate).toBe(gate);
  for (const key of gateShapeKeys()) expect(res).toHaveProperty(key);
  expect(res.inputs_hash).toBe(ctx().inputsHash);
  expect(res.world_version).toBe(ctx().worldVersion);
  expect(res.passed, `${gate} notes: ${res.notes ?? ''} metrics: ${JSON.stringify(res.metrics)}`).toBe(true);
  expect(evaluateThresholds(res.metrics, res.thresholds)).toBe(res.passed);
}

describe('门禁 G0.1–G0.6（与 npm run gate 同源断言）', () => {
  it('G0.1 生成确定性：跨进程逐字节一致 + fixture 复算全命中', () => {
    expectGate(runG01(ctx()), 'G0.1');
  }, 240_000);

  it('G0.2 生成可解：plan_hidden 回放穿验收 100%', () => {
    expectGate(runG02(ctx()), 'G0.2');
  }, 240_000);

  it('G0.3 验收抗投喂：错误全拒 + 正确通道可被喂饱', () => {
    expectGate(runG03(ctx()), 'G0.3');
  }, 120_000);

  it('G0.3 对抗套件规模哨兵：case_count=58、SKELETONS=4199（字面钉值，防条目被删则门不红）', () => {
    // 规模哨兵：判据 reject_ratio==1/accept_correct_ratio==1 与 case_count:eq 阈值都
    // 由静态清单长度派生，若有人删 WRONG_ARTIFACTS/FUZZ 条目，比率仍 100%、case_count
    // 阈值也随之下移——门不红。此处用字面常量钉死当前规模（58 =
    // WRONG_ARTIFACTS(34) + FUZZ_COUNT(24)），一旦套件缩水本用例即红，逼回归审。
    // SKELETONS.length 同理守生成器骨架池规模（去冗余后、恒等丢弃后当前 4199）。
    expect(runG03(ctx()).metrics.case_count).toBe(58);
    expect(SKELETONS.length).toBe(4199);
  }, 120_000);

  it('G0.4 泄漏审计：前四指标全 0', () => {
    expectGate(runG04(ctx()), 'G0.4');
  }, 240_000);

  it('G0.5 分布对齐：train/heldout 层分布 KL < 0.05 nats', () => {
    expectGate(runG05(ctx()), 'G0.5');
  }, 240_000);

  it('G0.6 目标可分性：公开指令特征线性分类 top1 ≥ 0.90', () => {
    expectGate(runG06(ctx()), 'G0.6');
  }, 300_000);

  it('runAll 依序 G0.1→G0.6、全绿、与单个 run() 结果一致', () => {
    const results = runAll(ctx());
    expect(results.map((r) => r.gate)).toEqual(['G0.1', 'G0.2', 'G0.3', 'G0.4', 'G0.5', 'G0.6']);
    for (const r of results) expect(r.passed, `${r.gate} ${r.notes ?? ''}`).toBe(true);
    const perGate = [runG01(ctx()), runG02(ctx()), runG03(ctx()), runG04(ctx()), runG05(ctx()), runG06(ctx())];
    for (let i = 0; i < perGate.length; i++) {
      expect(results[i]!.metrics).toEqual(perGate[i]!.metrics);
    }
  }, 300_000);
});
