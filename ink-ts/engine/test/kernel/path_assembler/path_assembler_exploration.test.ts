/**
 * P4.1 组装反路径锁定 / 探索预算单测（候选层三件套之②无证据候选试用通道 +
 * ③连续顶选反垄断）。
 *
 * 测试点：
 * - ② 无样本候选试用：开启候选层试用预算后，cold-start/低样本存在时按
 *   epsilon 概率把「能覆盖目标但无样本/样本极低」的候选置顶试用；关闭或
 *   未命中概率 = 纯证据序零漂移（既有排序断言不受影响）。
 * - ③ 连续顶选反垄断：最近 N 轮窗口同一指纹连续顶选且存在可覆盖目标但分
 *   较低的次优候选 → 强制次优置顶试用一次；窗口未满/含异指纹 = 不强制。
 * - 运行期 PathAssemblyRuntime 跨轮窗口收尾追加 + 有界（按请求缓存键分域）。
 * 预算默认全关：默认构造（不传 exploration_budget）时上述机制零参与。
 */
import { describe, expect, it } from 'vitest';

import { PathAssemblyConfig } from '../../../src/core/contracts/contracts.js';
import { EdgeEvidenceStore } from '../../../src/core/edge_evidence/index.js';
import type { EdgeKey } from '../../../src/core/edge_evidence/index.js';
import { request_fingerprint } from '../../../src/core/fingerprint/fingerprint.js';
import {
  CANDIDATE_TRIAL_MIN_SAMPLES,
  DEFAULT_ANTI_MONOPOLY_WINDOW,
  PathAssemblyRuntime,
  STATS_ANTI_MONOPOLY_FORCES,
  STATS_TRIAL_PROMOTIONS,
} from '../../../src/kernel/path_assembler/index.js';
import { PathAssembler } from '../../../src/kernel/path_assembler/index.js';
import { DUMMY_NOW, make_registry, make_request } from './helpers.js';

function edge_key(src_type: string, dst_type: string): EdgeKey {
  return {
    src_type,
    dst_type,
    src_contract_version: '1',
    dst_contract_version: '1',
    context_domain: 'code',
    variant_hash: '',
  };
}

/** 双答案小池：parse → answerA（可被证据强化）/ answerB（无样本候选）。 */
function dual_answer_registry() {
  return make_registry([
    ['parse', ['user_query'], ['q']],
    ['answerA', ['q'], ['answer']],
    ['answerB', ['q'], ['answer']],
  ]);
}

/** 顶选 A 链的组装（预算关；用于取反垄断窗口的“顶选指纹”）。 */
async function top_fingerprint_a(): Promise<{ fp: string; key: string }> {
  const assembler = new PathAssembler({
    registry: dual_answer_registry(),
    now: DUMMY_NOW,
  });
  const request = make_request(['answer'], { top_k: 1 });
  const result = await assembler.assemble(request);
  expect(result.candidates[0]!.chain).toEqual(['parse', 'answerA']);
  const key = request_fingerprint({
    goal_fields: request.goal_fields(),
    entry_fields: request.entry_fields,
    domain: request.domain,
    max_safety_tier: request.max_safety_tier,
    model_id: '',
  });
  return { fp: result.fingerprint, key };
}

describe('P4.1 ②无证据候选试用通道（候选层）', () => {
  it('试用预算开启 + epsilon 命中：无样本候选置顶进入 top-k（试用后落正常证据）', async () => {
    const registry = dual_answer_registry();
    const store = new EdgeEvidenceStore();
    const aEdge = edge_key('parse', 'answerA');
    for (let i = 0; i < 30; i += 1) {
      await store.record_success(aEdge, { now: DUMMY_NOW });
    }
    const request = make_request(['answer'], { top_k: 1 });
    const build = (budget: Record<string, unknown>) =>
      new PathAssembler({
        registry,
        evidence_store: store,
        now: DUMMY_NOW,
        exploration_budget: budget as never,
        rng: () => 0.0,
      });
    // 预算开启且 epsilon=1.0 恒触发：answerB（无样本）置顶试用
    const trial = await build({
      candidate_trial_enabled: true,
      candidate_trial_epsilon: 1.0,
    }).assemble(request);
    expect(trial.candidates[0]!.chain).toEqual(['parse', 'answerB']);
    expect(trial.stats[STATS_TRIAL_PROMOTIONS]).toBe(1);
    // 预算关闭：纯证据序（有样本 A 链置顶，试用不参与 = 零漂移）
    const plain = await build({}).assemble(request);
    expect(plain.candidates[0]!.chain).toEqual(['parse', 'answerA']);
    expect(plain.stats[STATS_TRIAL_PROMOTIONS]).toBeUndefined();
    await store.close();
  });

  it('试用预算开启但 epsilon 未命中（rng ≥ ε）：仍走纯证据序', async () => {
    const registry = dual_answer_registry();
    const store = new EdgeEvidenceStore();
    for (let i = 0; i < 30; i += 1) {
      await store.record_success(edge_key('parse', 'answerA'), { now: DUMMY_NOW });
    }
    const request = make_request(['answer'], { top_k: 1 });
    const assembler = new PathAssembler({
      registry,
      evidence_store: store,
      now: DUMMY_NOW,
      exploration_budget: {
        candidate_trial_enabled: true,
        candidate_trial_epsilon: 0.5,
      },
      rng: () => 0.9, // 0.9 !< 0.5 → 未命中
    });
    const result = await assembler.assemble(request);
    expect(result.candidates[0]!.chain).toEqual(['parse', 'answerA']);
    expect(result.stats[STATS_TRIAL_PROMOTIONS]).toBeUndefined();
    await store.close();
  });

  it('候选存在低样本（< CANDIDATE_TRIAL_MIN_SAMPLES）即激活探索窗口 → 无样本次优获试用', async () => {
    const registry = dual_answer_registry();
    const store = new EdgeEvidenceStore();
    // answerA 仅 1 次成功样本 = 样本极低（仍 < min_samples）
    await store.record_success(edge_key('parse', 'answerA'), { now: DUMMY_NOW });
    expect(CANDIDATE_TRIAL_MIN_SAMPLES).toBeGreaterThan(1);
    const request = make_request(['answer'], { top_k: 1 });
    const assembler = new PathAssembler({
      registry,
      evidence_store: store,
      now: DUMMY_NOW,
      exploration_budget: {
        candidate_trial_enabled: true,
        candidate_trial_epsilon: 1.0,
      },
      rng: () => 0.0,
    });
    const result = await assembler.assemble(request);
    expect(result.stats[STATS_TRIAL_PROMOTIONS]).toBe(1);
    await store.close();
  });
});

describe('P4.1 ③连续顶选反垄断（候选层）', () => {
  it('窗口满且最近 N 轮同一指纹连续顶选 → 强试次优（分较低候选）置顶', async () => {
    const { fp, key } = await top_fingerprint_a();
    const recent_tops = new Map<string, string[]>([
      [key, Array(DEFAULT_ANTI_MONOPOLY_WINDOW).fill(fp)],
    ]);
    const registry = dual_answer_registry();
    const store = new EdgeEvidenceStore();
    // A 链 30 次成功（顶选强证据），B 链 3 次成功（次优但已覆盖目标）
    for (let i = 0; i < 30; i += 1) {
      await store.record_success(edge_key('parse', 'answerA'), { now: DUMMY_NOW });
    }
    for (let i = 0; i < 3; i += 1) {
      await store.record_success(edge_key('parse', 'answerB'), { now: DUMMY_NOW });
    }
    const request = make_request(['answer'], { top_k: 2 });
    const assembler = new PathAssembler({
      registry,
      evidence_store: store,
      now: DUMMY_NOW,
      exploration_budget: { anti_monopoly_enabled: true, recent_tops },
    });
    const result = await assembler.assemble(request);
    expect(result.candidates[0]!.chain).toEqual(['parse', 'answerB']);
    expect(result.candidates[1]!.chain).toEqual(['parse', 'answerA']);
    expect(result.stats[STATS_ANTI_MONOPOLY_FORCES]).toBe(1);
    await store.close();
  });

  it('窗口未满 → 不强制（次优不入顶）；预算关闭 → 零参与', async () => {
    const { fp, key } = await top_fingerprint_a();
    const registry = dual_answer_registry();
    const store = new EdgeEvidenceStore();
    for (let i = 0; i < 30; i += 1) {
      await store.record_success(edge_key('parse', 'answerA'), { now: DUMMY_NOW });
    }
    const request = make_request(['answer'], { top_k: 2 });
    // 窗口仅 N-1 轮同指纹：未满 → 顶选不动
    const short_window = new Map<string, string[]>([
      [key, Array(DEFAULT_ANTI_MONOPOLY_WINDOW - 1).fill(fp)],
    ]);
    const notYet = await new PathAssembler({
      registry,
      evidence_store: store,
      now: DUMMY_NOW,
      exploration_budget: {
        anti_monopoly_enabled: true,
        recent_tops: short_window,
      },
    }).assemble(request);
    expect(notYet.candidates[0]!.chain).toEqual(['parse', 'answerA']);
    expect(notYet.stats[STATS_ANTI_MONOPOLY_FORCES]).toBeUndefined();
    // 预算关闭（默认）：即使窗口满也不参与
    const full_window = new Map<string, string[]>([
      [key, Array(DEFAULT_ANTI_MONOPOLY_WINDOW).fill(fp)],
    ]);
    const off = await new PathAssembler({
      registry,
      evidence_store: store,
      now: DUMMY_NOW,
      exploration_budget: { recent_tops: full_window },
    }).assemble(request);
    expect(off.candidates[0]!.chain).toEqual(['parse', 'answerA']);
    expect(off.stats[STATS_ANTI_MONOPOLY_FORCES]).toBeUndefined();
    await store.close();
  });
});

describe('P4.1 反垄断跨轮窗口（PathAssemblyRuntime 会话统计面）', () => {
  it('组装收尾后按请求键追加顶选指纹；有界保留最近 N 条', async () => {
    const registry = dual_answer_registry();
    const store = new EdgeEvidenceStore();
    for (let i = 0; i < 30; i += 1) {
      await store.record_success(edge_key('parse', 'answerA'), { now: DUMMY_NOW });
    }
    const runtime = new PathAssemblyRuntime({
      registry,
      evidence_store: store,
      config: new PathAssemblyConfig({ enabled: true }),
      now: DUMMY_NOW,
      exploration_budget: { anti_monopoly_enabled: true },
    });
    const request = make_request(['answer'], { top_k: 1 });
    const resultA = await runtime.assemble_plan(request);
    expect(resultA.candidates[0]!.chain).toEqual(['parse', 'answerA']);
    expect(runtime.recent_tops.size).toBe(1);
    // 第二次组装顶选仍是 A 链 → 窗口记录两条同指纹
    await runtime.assemble_plan(request);
    const key = request_fingerprint({
      goal_fields: request.goal_fields(),
      entry_fields: request.entry_fields,
      domain: request.domain,
      max_safety_tier: request.max_safety_tier,
      model_id: '',
    });
    const window = runtime.recent_tops.get(key) ?? [];
    expect(window.length).toBe(2);
    expect(window.every((fp) => fp === resultA.fingerprint)).toBe(true);
    expect(window.length).toBeLessThanOrEqual(DEFAULT_ANTI_MONOPOLY_WINDOW);
    await store.close();
  });
});
