/**
 * teacher/oracle 测试（C.3 + D 表断言）：oracleTrace 逐步标签必须末项 EXIT、
 * 回放穿验收、obs 面绝不携带 spec/expected/plan_hidden、候选断言路径可触发；
 * isOnPath 支撑「状态恰在 gold 前缀才打标」的标签纪律。
 */

import { describe, expect, it } from 'vitest';

import { isOnPath, oracleTrace } from '../teacher/oracle.js';
import { makeTask } from '../gen/generator.js';
import { GRAPH, candidates } from '../runner/graph.js';
import { EXIT, applyOp, initState } from '../world/operators.js';
import { accept } from '../verify/acceptor.js';
import { canonicalJson, hashObj } from '../world/hash.js';
import type { Family, Split, Style, Task } from '../schema.js';

function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    style: 'follow',
    family: 'value',
    instruction: '起点值4。按顺序做：翻倍，随后提交',
    x: 4,
    spec: {},
    expected: 8,
    plan_hidden: ['mul2', 'submit'],
    root: 'Int',
    plan_hash: hashObj(['mul2', 'submit']),
    composition_id: 'skel-oracle-0',
    split: 'train',
    ...overrides,
  };
}

const CASES: ReadonlyArray<[Style, Family]> = [
  ['follow', 'value'],
  ['follow', 'verify'],
  ['goal', 'goal'],
  ['goal', 'goal_verify'],
];

const SPLITS: readonly (Split | undefined)[] = [undefined, 'train', 'val', 'heldout'];

/** 四 (style, family) 组合 × 多种子 × split 轮转，收集成功生成的真实任务。 */
function realTasks(): Task[] {
  const out: Task[] = [];
  for (const [style, family] of CASES) {
    for (const seed of [1, 2, 5, 13, 31, 77]) {
      const split = SPLITS[seed % SPLITS.length];
      const t = makeTask(seed, style, family, split);
      if (t !== null && t.style === style && t.family === family) out.push(t);
    }
  }
  return out;
}

describe('teacher/oracleTrace（C.3 逐步标签）', () => {
  const tasks = realTasks();

  it('真实任务覆盖四族（否则本套断言空转）', () => {
    const fams = new Set(tasks.map((t) => `${t.style}:${t.family}`));
    expect(fams.size).toBe(4);
    expect(tasks.length).toBeGreaterThanOrEqual(12);
  });

  it('轨迹长度 = 计划长 + EXIT；末步 action=EXIT 且候选含 exit', () => {
    for (const t of tasks) {
      const trace = oracleTrace(t, GRAPH);
      expect(trace).toHaveLength(t.plan_hidden.length + 1);
      expect(trace[trace.length - 1]!.action).toBe(EXIT);
      expect(trace[trace.length - 1]!.candidates).toContain(EXIT);
      expect(trace[trace.length - 1]!.step).toBe(trace.length - 1);
    }
  });

  it('每步 action ∈ 该步 candidates；applyOp 逐步非 null；回放穿 accept', () => {
    for (const t of tasks) {
      const trace = oracleTrace(t, GRAPH);
      let st = initState(t.x, t.spec);
      for (let k = 0; k < t.plan_hidden.length; k++) {
        const step = trace[k]!;
        expect(step.candidates).toContain(step.action);
        expect(step.step).toBe(k);
        const next = applyOp(GRAPH, step.action, st);
        expect(next).not.toBeNull();
        st = next!;
        expect([...st.hist]).toEqual(t.plan_hidden.slice(0, k + 1));
      }
      expect(accept(t, st)).toBe(true);
      const last = trace[trace.length - 1]!;
      expect(last.obs.answer).toBe(st.answer);
      expect(canonicalJson(last.obs)).toBe(
        canonicalJson({ x: st.x, answer: st.answer, verdict: st.verdict, hist: [...st.hist] }),
      );
    }
  });

  it('obs 面只有 {x, answer, verdict, hist}：spec/expected/plan_hidden 永不入 obs', () => {
    for (const t of tasks) {
      for (const step of oracleTrace(t, GRAPH)) {
        expect(Object.keys(step.obs).sort()).toEqual(['answer', 'hist', 'verdict', 'x']);
        const flat = canonicalJson({ obs: step.obs, candidates: step.candidates });
        for (const forbidden of ['"expected"', '"spec"', '"plan_hidden"', '"plan_hash"']) {
          expect(flat).not.toContain(forbidden);
        }
      }
    }
  });

  it('每步 candidates 与该状态重算结果完全一致（唯一口径无断层）', () => {
    for (const t of tasks) {
      for (const step of oracleTrace(t, GRAPH)) {
        const st = {
          ...initState(step.obs.x, t.spec),
          answer: step.obs.answer,
          verdict: step.obs.verdict,
          hist: [...step.obs.hist],
        };
        expect(step.candidates).toEqual(candidates(GRAPH, st, st.hist));
      }
    }
  });

  it('候选断言：超出 MAX_REPEAT 的 gold op 触发 throw（访问上限自检）', () => {
    const bad = mkTask({
      x: 1,
      expected: 7,
      plan_hidden: ['add3', 'add3', 'add3', 'submit'],
    });
    expect(() => oracleTrace(bad, GRAPH)).toThrow(/候选/);
  });

  it('候选断言：requires 恒不满足的 gold op（dead_end）触发 throw', () => {
    const bad = mkTask({ plan_hidden: ['dead_end', 'submit'], expected: 8 });
    expect(() => oracleTrace(bad, GRAPH)).toThrow(/候选/);
  });

  it('最终验收不过的 plan 触发 throw（G0.2 前提不可绕过）', () => {
    const bad = mkTask({ expected: 7, plan_hidden: ['mul2', 'submit'] });
    expect(() => oracleTrace(bad, GRAPH)).toThrow(/验收/);
  });

  it('同 task 两次 oracleTrace 逐字节相同（确定性）', () => {
    for (const t of tasks.slice(0, 4)) {
      expect(canonicalJson(oracleTrace(t, GRAPH))).toBe(canonicalJson(oracleTrace(t, GRAPH)));
    }
  });
});

describe('teacher/isOnPath（标签纪律判定源）', () => {
  const plan = ['add3', 'mul2', 'submit'];

  it('gold 前缀（含整段与空前缀）判真；偏离/超长判假', () => {
    expect(isOnPath([], plan)).toBe(true);
    expect(isOnPath(['add3'], plan)).toBe(true);
    expect(isOnPath(['add3', 'mul2', 'submit'], plan)).toBe(true);
    expect(isOnPath(['mul2'], plan)).toBe(false);
    expect(isOnPath(['add3', 'sub1'], plan)).toBe(false);
    expect(isOnPath(['add3', 'mul2', 'submit', 'check_parity'], plan)).toBe(false);
  });

  it('oracle 轨迹的每步 obs.hist 都在 gold 前缀上（on-path 自检）', () => {
    for (const t of realTasks()) {
      for (const step of oracleTrace(t, GRAPH)) {
        expect(isOnPath(step.obs.hist, t.plan_hidden)).toBe(true);
      }
    }
  });
});
