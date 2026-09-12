import { describe, expect, it } from 'vitest';

import { FUZZ_COUNT, WRONG_ARTIFACTS, runAll } from '../verify/adversarial.js';
import { accept } from '../verify/acceptor.js';
import { initState, runPlan, verdictPass } from '../world/operators.js';
import { goalOk } from '../world/goal.js';
import { hashObj } from '../world/hash.js';
import type { Goal, } from '../world/goal.js';
import type { Task } from '../schema.js';

describe('verify/adversarial 必拒错误产物套件（§4 对抗清单）', () => {
  it('套件非空且四族全覆盖', () => {
    expect(WRONG_ARTIFACTS.length).toBeGreaterThan(0);
    const families = new Set(WRONG_ARTIFACTS.map((c) => c.task.family));
    expect([...families].sort()).toEqual(['goal', 'goal_verify', 'value', 'verify']);
  });

  it('套件内每一条错误产物都被 accept 拒绝', () => {
    for (const c of WRONG_ARTIFACTS) {
      expect(accept(c.task, c.state), `${c.label} 应被拒`).toBe(false);
    }
  });

  it('runAll：错误产物 100% 被拒 + 正确通道产物 100% 被收（防全拒通关）', () => {
    const r = runAll();
    expect(r.rejectRatio).toBe(1);
    expect(r.acceptCorrectRatio).toBe(1);
    expect(r.caseCount).toBe(WRONG_ARTIFACTS.length + FUZZ_COUNT);
  });

  it('runAll 确定性：固定 seed 两次运行结果一致', () => {
    expect(runAll()).toEqual(runAll());
  });
});

describe('verify/adversarial R2-P0-1 verdict 指纹绑定四组正反例', () => {
  // 双生产者 goal_verify 任务：submit 与 check_* 之间 x 不变 → verdict 绑定 answer。
  const goal = { kind: 'gt', target: 20 } as Goal;
  const spec = { parity: 0, goal };
  const task: Task = {
    style: 'goal',
    family: 'goal_verify',
    instruction: '结果大于20',
    x: 9,
    spec,
    expected: 24,
    plan_hidden: ['add3', 'mul2', 'submit', 'check_parity'],
    root: 'Int',
    plan_hash: hashObj(['add3', 'mul2', 'submit', 'check_parity']),
    composition_id: 'adv-bind-goal-verify',
    split: 'heldout',
  };

  it('正例：先 submit 后 check → answer=24、verdict=pass:24，accept 真', () => {
    const st = runPlan(task.plan_hidden, initState(task.x, task.spec))!;
    expect(st.answer).toBe(24);
    expect(st.verdict).toBe(verdictPass(24));
    expect(accept(task, st)).toBe(true);
  });

  it('反例：先 check 得 pass:24 → 改 x → submit 得 answer=27，旧指纹配新 answer → 必拒', () => {
    const st = runPlan(['add3', 'mul2', 'check_parity', 'add3', 'submit'], initState(task.x, task.spec))!;
    expect(st.x).toBe(27);
    expect(st.answer).toBe(27);
    expect(st.verdict).toBe(verdictPass(24)); // 仍是旧 24 的指纹
    expect(goalOk(27, { goal })).toBe(true); // 27 仍满足公开目标 gt20（值判定过关）
    expect(accept(task, st)).toBe(false); // 但 verdict↔answer 绑定把它拦下
  });

  it('反例：跨任务搬运旧 verdict（本任务 answer 达标 27、verdict 是他题 pass:8）→ 必拒', () => {
    const stOther = runPlan(['mul2', 'submit', 'check_parity'], initState(4, { parity: 0 }))!;
    expect(stOther.verdict).toBe(verdictPass(8));
    const st = { ...stOther, x: 27, answer: 27 };
    expect(accept(task, st)).toBe(false);
  });

  it('正例：改值后重跑 check_*（末段 submit→新 check）得 answer 自指纹 → 通过', () => {
    // add3 两次把 24 推到 30（仍偶）：末段 check_parity 按新 answer 重写自洽指纹。
    const st = runPlan(
      ['add3', 'mul2', 'submit', 'check_parity', 'add3', 'add3', 'submit', 'check_parity'],
      initState(task.x, task.spec),
    )!;
    expect(st.answer).toBe(30);
    expect(st.verdict).toBe(verdictPass(30));
    expect(accept(task, st)).toBe(true);
  });
});
