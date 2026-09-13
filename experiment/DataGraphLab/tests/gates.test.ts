/**
 * 门禁判定脚本断言（docs/gates.md §0.1）：把每个 G0.x/G1.x 的 run() 包成 vitest 用例，
 * 断言 `passed` 且 `passed === evaluateThresholds(metrics, thresholds)`（判据由
 * metrics/thresholds 机器复核，不手写期望数字）。上下文由 `createGateContext()`
 * 构造——与 `npm run gate` 走同一代码路径、同一批确定性数据（上下文内按
 * (split, perFamily, seed) 缓存生成批次），因此本文件断言与 CI 独立入口结果一致。
 * 门禁内部零网络零 LLM；批次参数钉死后单次全量约数十秒，属预期。唯一例外是
 * G0.3 规模哨兵用例：它不复核判据，而是字面钉死套件规模（越小越危险的东西）。
 * G1.2/G1.3 消费 C.8 `results.json`（读取唯一口径 results_view.ts）：本文件用
 * tmpdir 合成 fixture 注入 `ctx.resultsPath` 做达标/不达标双断言，不依赖真实
 * scale 产物；真实证据缺席时两门禁必须如实 FAIL（notes 引导先跑 scale）。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { createGateContext, runAll, type GateContext, type GateResult } from '../conformance/gates/harness.js';
import { run as runG01 } from '../conformance/gates/g01_determinism.js';
import { run as runG02 } from '../conformance/gates/g02_solvable.js';
import { run as runG03 } from '../conformance/gates/g03_adversarial.js';
import { run as runG04 } from '../conformance/gates/g04_leakage.js';
import { run as runG05 } from '../conformance/gates/g05_kl.js';
import { run as runG06 } from '../conformance/gates/g06_goal_separability.js';
import { run as runG11 } from '../conformance/gates/g11_no_free_lunch.js';
import { run as runG12 } from '../conformance/gates/g12_main_target.js';
import { run as runG13 } from '../conformance/gates/g13_three_arms.js';
import { runF1, runF2, runF3, runF4 } from '../conformance/f_gates.js';
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

  it('runAll 依序 G0.1→G1.3 + F1→F4、G0.*+G1.1+F* 全绿、G1.2/G1.3 与单个 run() 结果一致', () => {
    const results = runAll(ctx());
    expect(results.map((r) => r.gate)).toEqual([
      'G0.1', 'G0.2', 'G0.3', 'G0.4', 'G0.5', 'G0.6', 'G1.1', 'G1.2', 'G1.3',
      'F1', 'F2', 'F3', 'F4',
    ]);
    // G0.*+G1.1（7 项）与 F1–F4（4 项）须全绿；G1.2/G1.3 缺真实 scale 证据时如实 FAIL。
    for (const r of [...results.slice(0, 7), ...results.slice(9, 13)]) {
      expect(r.passed, `${r.gate} ${r.notes ?? ''}`).toBe(true);
    }
    const perGate = [
      runG01(ctx()), runG02(ctx()), runG03(ctx()), runG04(ctx()), runG05(ctx()), runG06(ctx()),
      runG11(ctx()), runG12(ctx()), runG13(ctx()),
      runF1(ctx()), runF2(ctx()), runF3(ctx()), runF4(ctx()),
    ];
    for (let i = 0; i < perGate.length; i++) {
      expect(results[i]!.metrics).toEqual(perGate[i]!.metrics);
      expect(results[i]!.passed).toBe(perGate[i]!.passed);
    }
  }, 600_000);

  it('G1.2/G1.3 无真实 scale 证据时：ctx 未注入且（干净 clone）扫不到即如实 FAIL 并引导先跑', () => {
    // 显式注入不存在的 resultsPath，把「证据缺席」分支与并行 scale 产物隔离；
    // 缺证据必须红、notes 引导跑 C.8 scale——「没跑」不是「齐全」。
    if (ctx().resultsPath !== undefined) return; // 本机已有真实 scale 时不重复裁决
    const res = runG12(ctx());
    expect(res.passed, res.notes ?? '').toBe(false);
    expect(res.notes).toContain('results.json not found: run C.8 scale first');
    const arms = runG13(ctx());
    expect(arms.passed, arms.notes ?? '').toBe(false);
    expect(arms.notes).toContain('results.json not found: run C.8 scale first');
  }, 240_000);
});

// —— G1.1–G1.3（Phase 1 门禁）：G1.1 用真实 held-out 统计集，G1.2/G1.3 用
// 合成 results.json 注入 ctx.resultsPath，达标/不达标双断言。 ——

interface SynRow {
  N: number;
  seed: number;
  style: string;
  arm: string;
  metric: string;
  value: number;
  ci_lo: number;
  ci_hi: number;
  n: number;
}

function r1(N: number, seed: number, style: string, arm: string, value: number): SynRow {
  return { N, seed, style, arm, metric: 'pass1', value, ci_lo: Math.max(0, value - 0.05), ci_hi: Math.min(1, value + 0.05), n: 600 };
}

/** 达标版网格：1k+10k 点、无 30k（单调性应 skipped）、三臂+可选列齐全。 */
const BASE_ROWS: SynRow[] = [
  r1(1_000, 0, 'goal', 'trained', 0.42), r1(1_000, 1, 'goal', 'trained', 0.46),
  r1(10_000, 0, 'goal', 'trained', 0.56), r1(10_000, 1, 'goal', 'trained', 0.6),
  r1(10_000, 0, 'follow', 'trained', 0.83), r1(10_000, 1, 'follow', 'trained', 0.85),
  r1(10_000, 0, 'follow', 'heuristic', 0.6), r1(10_000, 1, 'follow', 'heuristic', 0.6),
  r1(10_000, 0, 'follow', 'random', 0), r1(10_000, 1, 'follow', 'random', 0),
  r1(10_000, 0, 'goal', 'random', 0.02), r1(10_000, 1, 'goal', 'random', 0.03),
  r1(10_000, 0, 'goal', 'planner', 1), r1(10_000, 1, 'goal', 'planner', 1),
  r1(10_000, 0, 'goal', 'contract_route', 0.35),
];

const TMP_DIRS: string[] = [];
afterAll(() => {
  for (const d of TMP_DIRS) rmSync(d, { recursive: true, force: true });
});

function makeResultsCtx(rows: readonly SynRow[]): { ctx: GateContext; badPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dg-g1x-'));
  TMP_DIRS.push(dir);
  const path = join(dir, 'results.json');
  writeFileSync(path, JSON.stringify({ meta: { grid: [1_000, 10_000], seeds: [0, 1] }, rows }), 'utf8');
  return { ctx: createGateContext({ resultsPath: path }), badPath: join(dir, 'absent.json') };
}

function expectShape(res: GateResult, gate: string): void {
  expect(res.gate).toBe(gate);
  for (const key of gateShapeKeys()) expect(res).toHaveProperty(key);
  expect(evaluateThresholds(res.metrics, res.thresholds), `${gate} 判据与阈值不可对账`).toBe(res.passed);
}

describe('Phase 1 门禁 G1.1–G1.3', () => {
  it('G1.1 非免费午餐：真实 held-out 上 random 臂两 style pass@1 ≤0.05（不读 results 也能跑）', () => {
    // 用 G0 同源的共享 ctx（未注入任何 results 证据）——G1.1 判据只依赖生成器与
    // 随机臂；实测若越线，上方 expect 会带 notes 如实爆红（E.7），不许调阈值。
    const res = runG11(ctx());
    expectShape(res, 'G1.1');
    expect(res.passed, res.notes ?? '').toBe(true);
    expect(res.metrics.pass1_follow).toBeLessThanOrEqual(0.05);
    expect(res.metrics.pass1_goal).toBeLessThanOrEqual(0.05);
    expect(res.metrics.seed).toBe(123);
  }, 240_000);

  it('G1.2 主目标：达标版 PASS（缺 30k → 单调性 skipped 并标注）', () => {
    const { ctx: passCtx } = makeResultsCtx(BASE_ROWS);
    const res = runG12(passCtx);
    expectShape(res, 'G1.2');
    expect(res.passed, res.notes ?? '').toBe(true);
    expect(res.metrics.S_goal_10k).toBeCloseTo(0.58, 10);
    expect(res.metrics.S_follow_10k).toBeCloseTo(0.84, 10);
    expect(res.metrics.follow_minus_heur).toBeCloseTo(0.24, 10);
    expect(res.metrics.monotonicity_checked).toBe(0);
    expect(res.notes).toContain('monotonicity: skipped(no 30k)');
    expect(res.seeds).toEqual([0, 1]);
  });

  it('G1.2 主目标：不达标版 FAIL 且 notes 点名违反判据（不许改阈值/删基线）', () => {
    const bad = BASE_ROWS.map((row) =>
      row.N === 10_000 && row.style === 'goal' && row.arm === 'trained' ? { ...row, value: 0.3 } : row,
    );
    const { ctx: badCtx } = makeResultsCtx(bad);
    const res = runG12(badCtx);
    expectShape(res, 'G1.2');
    expect(res.passed).toBe(false);
    expect(res.metrics.S_goal_10k).toBeCloseTo(0.3, 10);
    expect(res.notes).toContain('S_goal(10k)=0.3000');
    expect(res.notes).toContain('不许改阈值/删基线');
  });

  it('G1.2 单调性：含 30k 点且 S_goal(30k)<S_goal(1k) → FAIL；非降 → PASS 且 checked=1', () => {
    const violated = [...BASE_ROWS, r1(30_000, 0, 'goal', 'trained', 0.38), r1(30_000, 1, 'goal', 'trained', 0.4)];
    const v = runG12(makeResultsCtx(violated).ctx);
    expectShape(v, 'G1.2');
    expect(v.passed).toBe(false);
    expect(v.metrics.monotonicity_checked).toBe(1);
    expect(v.metrics.monotonicity_ok).toBe(0);
    expect(v.metrics.grid_has_30k).toBe(1);
    expect(v.notes).toContain('单调性破坏');
    const rising = [...BASE_ROWS, r1(30_000, 0, 'goal', 'trained', 0.63), r1(30_000, 1, 'goal', 'trained', 0.65)];
    const p = runG12(makeResultsCtx(rising).ctx);
    expect(p.passed, p.notes ?? '').toBe(true);
    expect(p.metrics.monotonicity_checked).toBe(1);
  });

  it('G1.2 缺数据形态：grid 缺 10000 → notes 报 grid missing；文件缺 → notes 引导先跑 scale', () => {
    const no10k = BASE_ROWS.filter((row) => row.N !== 10_000);
    const miss = runG12(makeResultsCtx(no10k).ctx);
    expectShape(miss, 'G1.2');
    expect(miss.passed).toBe(false);
    expect(miss.metrics.grid_has_10k).toBe(0);
    expect(miss.notes).toContain('grid missing N=10000');
    const { badPath } = makeResultsCtx(BASE_ROWS);
    const absent = runG12(createGateContext({ resultsPath: badPath }));
    expect(absent.passed).toBe(false);
    expect(absent.notes).toContain('results.json not found: run C.8 scale first');
  });

  it('G1.3 三臂齐全：达标版 PASS（contract_route 可选缺席不红）；缺 planner → FAIL 列缺臂', () => {
    const pass = runG13(makeResultsCtx(BASE_ROWS).ctx);
    expectShape(pass, 'G1.3');
    expect(pass.passed, pass.notes ?? '').toBe(true);
    expect(pass.metrics.complete).toBe(1);
    expect(pass.notes).toContain('contract_route');
    const noPlanner = BASE_ROWS.filter((row) => row.arm !== 'planner');
    const fail = runG13(makeResultsCtx(noPlanner).ctx);
    expectShape(fail, 'G1.3');
    expect(fail.passed).toBe(false);
    expect(fail.metrics.complete).toBe(0);
    expect(fail.notes).toContain('goal=[planner]');
    const noHeur = BASE_ROWS.filter((row) => row.arm !== 'heuristic');
    const fail2 = runG13(makeResultsCtx(noHeur).ctx);
    expect(fail2.passed).toBe(false);
    expect(fail2.notes).toContain('follow=[heuristic]');
    const { badPath } = makeResultsCtx(BASE_ROWS);
    const absent = runG13(createGateContext({ resultsPath: badPath }));
    expect(absent.passed).toBe(false);
    expect(absent.notes).toContain('results.json not found: run C.8 scale first');
  });
});
