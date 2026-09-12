import { describe, expect, it } from 'vitest';

import { hashObj } from '../world/hash.js';
import { worldVersion } from '../world/version.js';
import { taskHash, type Manifest, type Step, type Task, type Trajectory, type Verdict } from '../schema.js';

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    style: 'follow',
    family: 'value',
    instruction: '起点值12。按顺序做：加三，然后翻倍，接着减一',
    x: 12,
    spec: {},
    expected: 29,
    plan_hidden: ['add3', 'mul2', 'sub1', 'submit'],
    root: 'Int',
    plan_hash: hashObj(['add3', 'mul2', 'sub1', 'submit']),
    composition_id: 'skel-0',
    split: 'train',
    ...overrides,
  };
}

describe('schema/taskHash（C.1 唯一口径）', () => {
  it('同对象 hash 稳定，键序无关', () => {
    const t = baseTask();
    expect(taskHash(t)).toBe(taskHash({ ...t }));
    expect(taskHash(t)).toBe(taskHash(baseTask()));
  });

  it('不同 seed 构造的同任务同 hash：task_hash 不含 seed/plan，差异只由 plan_hash 承载', () => {
    const a = baseTask({
      plan_hidden: ['add3', 'submit'],
      plan_hash: hashObj(['add3', 'submit']),
      composition_id: 'skel-A',
    });
    const b = baseTask({
      plan_hidden: ['add3', 'add3', 'submit'],
      plan_hash: hashObj(['add3', 'add3', 'submit']),
      composition_id: 'skel-B',
    });
    expect(taskHash(a)).toBe(taskHash(b));
  });

  it('task_hash 组成 = hashObj({instruction, family, x, expected, world_version})', () => {
    const t = baseTask();
    expect(taskHash(t)).toBe(
      hashObj({
        instruction: t.instruction,
        family: t.family,
        x: t.x,
        expected: t.expected,
        world_version: worldVersion,
      }),
    );
  });

  it('任一字段变化即换 hash（含 instruction/family/x/expected）', () => {
    const t = baseTask();
    expect(taskHash(baseTask({ instruction: '起点值3。按顺序做：翻倍' }))).not.toBe(taskHash(t));
    expect(taskHash(baseTask({ family: 'verify' }))).not.toBe(taskHash(t));
    expect(taskHash(baseTask({ x: 13 }))).not.toBe(taskHash(t));
    expect(taskHash(baseTask({ expected: 30 }))).not.toBe(taskHash(t));
  });

  it('hash 是 16 位十六进制', () => {
    expect(taskHash(baseTask())).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('schema/Task 构造形态（C.1 instance_follow/instance_goal）', () => {
  it('follow/value：单生产者，plan = 骨架 + submit，spec 为空', () => {
    const task: Task = {
      style: 'follow',
      family: 'value',
      instruction: '起点值12。按顺序做：加三，然后翻倍，接着减一',
      x: 12,
      spec: {},
      expected: 29,
      plan_hidden: ['add3', 'mul2', 'sub1', 'submit'],
      root: 'Int',
      plan_hash: hashObj(['add3', 'mul2', 'sub1', 'submit']),
      composition_id: 'skel-0',
      split: 'train',
    };
    expect(task.plan_hidden.at(-1)).toBe('submit');
    expect(task.spec).toEqual({});
  });

  it('follow/verify：两生产者，spec 依终值反推，plan 含 check_*', () => {
    const task: Task = {
      style: 'follow',
      family: 'verify',
      instruction: '起点值4。按顺序做：翻倍',
      x: 4,
      spec: { parity: 0 },
      expected: 8,
      plan_hidden: ['mul2', 'submit', 'check_parity'],
      root: 'Int',
      plan_hash: hashObj(['mul2', 'submit', 'check_parity']),
      composition_id: 'skel-1',
      split: 'val',
    };
    expect(task.plan_hidden.at(-1)).toBe('check_parity');
    expect(task.spec).toEqual({ parity: 0 });
  });

  it('goal：spec 含公开 goal，指令只描述目标属性', () => {
    const task: Task = {
      style: 'goal',
      family: 'goal',
      instruction: '结果大于20',
      x: 9,
      spec: { goal: { kind: 'gt', target: 20 } },
      expected: 27,
      plan_hidden: ['add3', 'mul2', 'submit'],
      root: 'Int',
      plan_hash: hashObj(['add3', 'mul2', 'submit']),
      composition_id: 'skel-2',
      split: 'heldout',
    };
    expect(task.spec.goal).toEqual({ kind: 'gt', target: 20 });
    expect(task.instruction).not.toMatch(/加三|翻倍/);
  });

  it('goal_verify：spec 同时含 goal 与检查目标，plan 含 check_*', () => {
    const task: Task = {
      style: 'goal',
      family: 'goal_verify',
      instruction: '长度在1到5之间',
      x: 'abc',
      spec: { length: 3, goal: { kind: 'len', min: 1, max: 5 } },
      expected: 'ABC',
      plan_hidden: ['upper', 'submit', 'check_len'],
      root: 'Str',
      plan_hash: hashObj(['upper', 'submit', 'check_len']),
      composition_id: 'skel-3',
      split: 'heldout',
    };
    expect(task.plan_hidden.at(-1)).toBe('check_len');
    expect(task.spec).toEqual({ length: 3, goal: { kind: 'len', min: 1, max: 5 } });
  });
});

describe('schema/其余类型', () => {
  it('Step 按 C.3 形状：step/obs/candidates/action', () => {
    const step: Step = {
      step: 0,
      obs: { x: 12, answer: null, verdict: null, hist: [] },
      candidates: ['add3', 'exit'],
      action: 'add3',
    };
    expect(step.obs.x).toBe(12);
    expect(step.candidates).toEqual(['add3', 'exit']);
  });

  it('Verdict 按 C.2 形状：passed + reason', () => {
    const verdict: Verdict = { passed: false, reason: 'missing:answer' };
    expect(verdict.passed).toBe(false);
  });

  it('Trajectory 含版本/教师/验收/来源全字段', () => {
    const rec: Trajectory = {
      task_id: 't-0',
      task_hash: taskHash(baseTask()),
      world_version: worldVersion,
      generator_version: 'gen-0',
      acceptor_version: 'acc-0',
      style: 'follow',
      family: 'value',
      observation: {
        instruction: '起点值12。按顺序做：加三',
        state_digest: 'digest-0',
        candidate_actions: ['add3', 'exit'],
        action_space_digest: 'space-0',
      },
      step_index: 0,
      action: 'add3',
      done: false,
      teacher: { kind: 'oracle', model_pin: '', plan_id: 'skel-0' },
      verdict: { passed: true, checker: 'acceptor', evidence_hash: 'ev-0', channel: 'answer' },
      split: 'train',
      composition_id: 'skel-0',
      provenance: { seed: 0, ts: '2026-09-12T00:00:00Z', code_hash: 'code-0' },
    };
    expect(rec.teacher.kind).toBe('oracle');
    expect(rec.verdict.channel).toBe('answer');
  });

  it('Manifest 含全部版本 pin', () => {
    const m: Manifest = {
      world_version: worldVersion,
      generator_version: 'gen-0',
      acceptor_version: 'acc-0',
      teacher_pin: 'oracle',
      controller_code_hash: 'code-0',
      probe_hash: 'probe-0',
    };
    expect(m.world_version).toBe(worldVersion);
  });
});
