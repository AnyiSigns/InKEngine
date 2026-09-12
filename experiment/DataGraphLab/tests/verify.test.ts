import { describe, expect, it } from 'vitest';

import { CHANNEL, accept, acceptChannelled } from '../verify/acceptor.js';
import { runSandboxed } from '../verify/sandbox.js';
import { initState, verdictPass } from '../world/operators.js';
import { goalOk } from '../world/goal.js';
import { hash8, hashObj } from '../world/hash.js';
import type { State } from '../world/operators.js';
import type { Goal } from '../world/goal.js';
import type { Task } from '../schema.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    style: 'follow',
    family: 'value',
    instruction: '起点值4。按顺序做：翻倍',
    x: 4,
    spec: {},
    expected: 8,
    plan_hidden: ['mul2', 'submit'],
    root: 'Int',
    plan_hash: hashObj(['mul2', 'submit']),
    composition_id: 'skel-u2-verify-0',
    split: 'train',
    ...overrides,
  };
}

const valueTask = makeTask();
const verifyTask = makeTask({
  family: 'verify',
  spec: { parity: 0 },
  plan_hidden: ['mul2', 'submit', 'check_parity'],
  plan_hash: hashObj(['mul2', 'submit', 'check_parity']),
});
const goalTask = makeTask({
  style: 'goal',
  family: 'goal',
  x: 9,
  expected: 24,
  spec: { goal: { kind: 'gt', target: 20 } },
  plan_hidden: ['add3', 'mul2', 'submit'],
  plan_hash: hashObj(['add3', 'mul2', 'submit']),
});
const goalVerifyTask = makeTask({
  style: 'goal',
  family: 'goal_verify',
  x: 9,
  expected: 24,
  spec: { parity: 0, goal: { kind: 'gt', target: 20 } },
  plan_hidden: ['add3', 'mul2', 'submit', 'check_parity'],
  plan_hash: hashObj(['add3', 'mul2', 'submit', 'check_parity']),
});

const withAnswer = (x: unknown, answer: unknown, extra: Record<string, unknown> = {}): State => ({
  ...initState(x),
  answer,
  ...extra,
});

describe('verify/CHANNEL（B.4 通道表唯一真源）', () => {
  it('形状 = value/goal 单生产者，verify/goal_verify 双生产者', () => {
    expect(CHANNEL).toEqual({
      value: ['answer'],
      verify: ['answer', 'verdict'],
      goal: ['answer'],
      goal_verify: ['answer', 'verdict'],
    });
  });

  it('通道表深冻结：外层与字段数组都不可变', () => {
    expect(Object.isFrozen(CHANNEL)).toBe(true);
    for (const fields of Object.values(CHANNEL)) {
      expect(Object.isFrozen(fields)).toBe(true);
    }
  });
});

describe('verify/accept B.4 配方族 value', () => {
  it('answer 与 expected 深等才接受', () => {
    expect(accept(valueTask, withAnswer(4, 8))).toBe(true);
    expect(accept(valueTask, withAnswer(4, 9))).toBe(false);
    expect(accept(valueTask, withAnswer(4, 'echo:8'))).toBe(false);
    expect(accept(valueTask, withAnswer(4, valueTask.instruction))).toBe(false);
  });

  it('answer 为 null 即拒', () => {
    expect(accept(valueTask, initState(4))).toBe(false);
  });
});

describe('verify/accept B.4 配方族 verify（双生产者，verdict=pass:answer 指纹）', () => {
  it('answer 正确 + verdict=pass:{hash8(answer)} 才接受', () => {
    expect(accept(verifyTask, withAnswer(4, 8, { verdict: verdictPass(8) }))).toBe(true);
  });

  it('verdict 缺失或非指纹（含裸 pass/fail/PASS）一律拒', () => {
    expect(accept(verifyTask, withAnswer(4, 8))).toBe(false);
    expect(accept(verifyTask, withAnswer(4, 8, { verdict: 'fail' }))).toBe(false);
    expect(accept(verifyTask, withAnswer(4, 8, { verdict: 'PASS' }))).toBe(false);
    // 旧口径的裸 "pass" 旗标在新口径下不再被接受（必须绑定 answer 指纹）。
    expect(accept(verifyTask, withAnswer(4, 8, { verdict: 'pass' }))).toBe(false);
  });

  it('指纹漂移：answer 对但 verdict 是别的值的指纹 → 拒', () => {
    expect(accept(verifyTask, withAnswer(4, 8, { verdict: verdictPass(9) }))).toBe(false);
  });

  it('旧 verdict 复用：answer 改错后即使携带原 answer 指纹也拒（answer 已不等于该指纹）', () => {
    expect(accept(verifyTask, withAnswer(4, 7, { verdict: verdictPass(8) }))).toBe(false);
  });

  it('value 族不受 verdict 牵制：answer 正确即接受（verdict 可为任意脏值）', () => {
    expect(accept(valueTask, withAnswer(4, 8, { verdict: 'fail' }))).toBe(true);
    expect(accept(valueTask, withAnswer(4, 8, { verdict: 'pass' }))).toBe(true);
  });
});

describe('verify/accept B.4 目标族 goal（多解可接受）', () => {
  it('满足目标谓词的任一答案都接受', () => {
    expect(accept(goalTask, withAnswer(9, 24))).toBe(true);
    expect(accept(goalTask, withAnswer(9, 21))).toBe(true);
    expect(accept(goalTask, withAnswer(9, 100))).toBe(true);
  });

  it('不满足目标谓词拒（含临界值）', () => {
    expect(accept(goalTask, withAnswer(9, 20))).toBe(false);
    expect(accept(goalTask, withAnswer(9, 0))).toBe(false);
    expect(accept(goalTask, withAnswer(9, 'echo:24'))).toBe(false);
  });

  it('类型不匹配返回 false 不抛异常', () => {
    expect(() => accept(goalTask, withAnswer(9, 'abc'))).not.toThrow();
    expect(accept(goalTask, withAnswer(9, 'abc'))).toBe(false);
  });

  it('goal 族忽略 verdict：缺失或 fail 均接受，与 goal_verify 必拒对称', () => {
    expect(accept(goalTask, withAnswer(9, 24))).toBe(true);
    expect(accept(goalTask, withAnswer(9, 24, { verdict: 'fail' }))).toBe(true);
    expect(accept(goalTask, withAnswer(9, 21, { verdict: 'fail' }))).toBe(true);
    expect(accept(goalVerifyTask, withAnswer(9, 24))).toBe(false);
    expect(accept(goalVerifyTask, withAnswer(9, 24, { verdict: 'fail' }))).toBe(false);
  });
});

describe('verify/accept B.4 目标族 goal_verify（双生产者 + R2-P0-1 指纹绑定）', () => {
  it('answer 满足目标 + verdict=pass:{hash8(answer)} 才接受', () => {
    expect(accept(goalVerifyTask, withAnswer(9, 24, { verdict: verdictPass(24) }))).toBe(true);
  });

  it('verdict 缺失或非当次值指纹一律拒', () => {
    expect(accept(goalVerifyTask, withAnswer(9, 24))).toBe(false);
    expect(accept(goalVerifyTask, withAnswer(9, 24, { verdict: 'fail' }))).toBe(false);
    expect(accept(goalVerifyTask, withAnswer(9, 24, { verdict: 'pass' }))).toBe(false);
    expect(accept(goalVerifyTask, withAnswer(9, 24, { verdict: verdictPass(21) }))).toBe(false);
  });

  it('复活态：answer 改后不达标即使携带旧 answer 指纹也拒', () => {
    expect(accept(goalVerifyTask, withAnswer(9, 10, { verdict: verdictPass(24) }))).toBe(false);
  });

  it('关键封堵：answer 被换成另一达标值（100>20）而 verdict 仍是旧值指纹 → 必拒', () => {
    // 先 check 过 24 得 pass:{hash8(24)}，再改值后 submit 答 100（仍满足 gt20）——
    // 目标判定成立、通道齐备，唯一拒因就是 verdict↔answer 绑定（旧 "pass" 旗标口径会放行）。
    expect(goalOk(100, (goalVerifyTask.spec as { goal: Goal }))).toBe(true);
    expect(accept(goalVerifyTask, withAnswer(9, 100, { verdict: verdictPass(24) }))).toBe(false);
  });
});

describe('verify/accept 未知 family', () => {
  it('family 不在四族内即抛错，不静默放过', () => {
    const bad = makeTask({ family: 'bogus' as Task['family'] });
    expect(() => accept(bad, withAnswer(4, 8))).toThrow();
  });
});

describe('verify/acceptChannelled（C.2 通道收口）', () => {
  it('本族通道字段缺失（含 null）即 reason=missing:<field>', () => {
    expect(acceptChannelled(valueTask, initState(4))).toEqual({ passed: false, reason: 'missing:answer' });
    expect(acceptChannelled(verifyTask, withAnswer(4, 8))).toEqual({ passed: false, reason: 'missing:verdict' });
    expect(acceptChannelled(goalTask, initState(9))).toEqual({ passed: false, reason: 'missing:answer' });
    expect(acceptChannelled(goalVerifyTask, withAnswer(9, 24))).toEqual({ passed: false, reason: 'missing:verdict' });
  });

  it('通道齐备后交给 accept：正确通过、错误拒绝', () => {
    expect(acceptChannelled(valueTask, withAnswer(4, 8))).toEqual({ passed: true, reason: 'accepted' });
    expect(acceptChannelled(verifyTask, withAnswer(4, 8, { verdict: verdictPass(8) }))).toEqual({ passed: true, reason: 'accepted' });
    expect(acceptChannelled(goalTask, withAnswer(9, 21))).toEqual({ passed: true, reason: 'accepted' });
    expect(acceptChannelled(goalVerifyTask, withAnswer(9, 24, { verdict: verdictPass(24) }))).toEqual({ passed: true, reason: 'accepted' });
    expect(acceptChannelled(valueTask, withAnswer(4, 9))).toEqual({ passed: false, reason: 'rejected' });
    expect(acceptChannelled(verifyTask, withAnswer(4, 7, { verdict: verdictPass(8) }))).toEqual({ passed: false, reason: 'rejected' });
  });
});

describe('verify/sandbox（E.2 接口占位）', () => {
  it('代码族验证未启用：调用即抛错，不执行子进程', async () => {
    await expect(runSandboxed('console.log(1)', 'assert(true)')).rejects.toThrow(/未启用/);
  });
});
