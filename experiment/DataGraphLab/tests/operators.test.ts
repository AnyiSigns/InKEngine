import { describe, expect, it } from 'vitest';

import {
  ASCII_ALPHABET,
  applyOp,
  contractOf,
  emod,
  GRAPH_BASE,
  initState,
  obsSnapshot,
  requiresOk,
  requiresTypes,
  runPlan,
  sampleValue,
} from '../world/operators.js';
import { crc32 } from '../world/hash.js';
import { makeRng } from '../world/rng.js';
import type { State } from '../world/operators.js';

describe('world/operators/emod', () => {
  it('emod 恒非负且 < m（含负数输入）', () => {
    const rng = makeRng(7);
    for (let i = 0; i < 2000; i++) {
      const a = rng.randint(-200, 200);
      const m = rng.choice([2, 3, 7, 101]);
      const r = emod(a, m);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(m);
    }
    expect(emod(-1, 7)).toBe(6);
    expect(emod(10, 7)).toBe(3);
  });
});

describe('world/operators/sampleValue（C.1 形状语义）', () => {
  it('Int 落在全域 [-50, 50] 且同 seed 可复现', () => {
    const a = makeRng(5);
    const b = makeRng(5);
    for (let i = 0; i < 500; i++) {
      const v = sampleValue(a, 'Int') as number;
      expect(v).toBeGreaterThanOrEqual(-50);
      expect(v).toBeLessThanOrEqual(50);
      expect(Number.isInteger(v)).toBe(true);
      expect(sampleValue(b, 'Int')).toBe(v);
    }
  });

  it('Str 长度 1..8、字母表 a-h（纯 ASCII）', () => {
    const rng = makeRng(6);
    for (let i = 0; i < 500; i++) {
      const s = sampleValue(rng, 'Str') as string;
      expect(s.length).toBeGreaterThanOrEqual(1);
      expect(s.length).toBeLessThanOrEqual(8);
      expect([...s].every((ch) => ASCII_ALPHABET.includes(ch))).toBe(true);
    }
  });
});

describe('world/operators/initState（B.1）', () => {
  it('形状 = {x, answer:null, verdict:null, hist:[], spec:{}}', () => {
    expect(initState(5)).toEqual({ x: 5, answer: null, verdict: null, hist: [], spec: {} });
  });

  it('显式 spec 原样保留', () => {
    expect(initState('a', { parity: 1 }).spec).toEqual({ parity: 1 });
  });
});

describe('world/operators/契约闸', () => {
  it('dead_end 永不 requiresOk（zzz 恒不在 state）', () => {
    const c = contractOf('dead_end')!;
    expect(requiresOk(c, initState(1))).toBe(false);
    expect(requiresOk(c, initState('abc'))).toBe(false);
    expect(requiresOk(c, { ...initState(1), hist: ['add3'] })).toBe(false);
  });

  it('"any" 通配跳过类型检查且不进 requires_types', () => {
    const submit = contractOf('submit')!;
    expect(requiresOk(submit, initState(5))).toBe(true);
    expect(requiresOk(submit, initState('abc'))).toBe(true);
    expect(requiresTypes(submit)).toEqual([]);
  });

  it('str_len 契约 out_type=Int', () => {
    expect(contractOf('str_len')?.out_type).toBe('Int');
  });
});

describe('world/operators/applyOp（B.2 变换表）', () => {
  const CASES: ReadonlyArray<{
    op: string;
    x: unknown;
    spec?: Readonly<Record<string, unknown>>;
    expected: Record<string, unknown>;
  }> = [
    { op: 'add3', x: 3, expected: { x: 6 } },
    { op: 'mul2', x: 3, expected: { x: 6 } },
    { op: 'sub1', x: 3, expected: { x: 2 } },
    { op: 'neg', x: 3, expected: { x: -3 } },
    { op: 'mod7', x: 10, expected: { x: 3 } },
    { op: 'mod7', x: -1, expected: { x: 6 } },
    { op: 'upper', x: 'aBc!', expected: { x: 'ABC!' } },
    { op: 'lower', x: 'AbC!', expected: { x: 'abc!' } },
    { op: 'reverse', x: 'abc', expected: { x: 'cba' } },
    { op: 'append_bang', x: 'abc', expected: { x: 'abc!' } },
    { op: 'str_len', x: 'abcde', expected: { x: 5 } },
    { op: 'cond_even', x: 4, expected: { x: 5 } },
    { op: 'cond_even', x: 3, expected: { x: 6 } },
    { op: 'cond_long', x: 'abcd', expected: { x: 'ABCD' } },
    { op: 'cond_long', x: 'abc', expected: { x: 'abc?' } },
    { op: 'submit', x: 'abc', expected: { answer: 'abc' } },
    { op: 'check_parity', x: 4, spec: { parity: 0 }, expected: { verdict: 'pass' } },
    { op: 'check_parity', x: 3, spec: { parity: 0 }, expected: { verdict: 'fail' } },
    { op: 'check_len', x: 'abc', spec: { length: 3 }, expected: { verdict: 'pass' } },
    { op: 'check_len', x: 'ab', spec: { length: 3 }, expected: { verdict: 'fail' } },
    { op: 'noop', x: 7, expected: { x: 7 } },
    { op: 'fake_add', x: 3, expected: { x: 5 } },
    { op: 'branch_decoy', x: 5, expected: { x: 25 } },
    { op: 'echo', x: 5, expected: { answer: 'echo:5' } },
    { op: 'echo', x: 'ab', expected: { answer: 'echo:ab' } },
  ];

  it.each(CASES)('$op（x=$x）按 B.2 变换并追加 hist', ({ op, x, spec, expected }) => {
    const out = applyOp(GRAPH_BASE, op, initState(x, spec));
    expect(out).not.toBeNull();
    const o = out as State;
    for (const [k, v] of Object.entries(expected)) expect(o[k]).toEqual(v);
    expect(o.hist).toEqual([op]);
  });

  it('契约不满足 = 零代价死路（null）', () => {
    expect(applyOp(GRAPH_BASE, 'upper', initState(5))).toBeNull();
    expect(applyOp(GRAPH_BASE, 'add3', initState('abc'))).toBeNull();
    expect(applyOp(GRAPH_BASE, 'dead_end', initState(1))).toBeNull();
  });

  it('成功追加 hist 且不改入参', () => {
    const st = initState(3);
    const out = applyOp(GRAPH_BASE, 'add3', st)!;
    expect(out.hist).toEqual(['add3']);
    expect(st.hist).toEqual([]);
    const out2 = applyOp(GRAPH_BASE, 'mul2', out)!;
    expect(out2.hist).toEqual(['add3', 'mul2']);
    expect(out2.x).toBe(12);
    expect(st.x).toBe(3);
  });

  it('shuffle 循环右移 emod(crc32(x), max(1,len)) 位', () => {
    const rng = makeRng(11);
    for (let i = 0; i < 200; i++) {
      const x = sampleValue(rng, 'Str') as string;
      const out = applyOp(GRAPH_BASE, 'shuffle', initState(x))!;
      const k = emod(crc32(x), Math.max(1, x.length));
      expect(out.x).toBe(k === 0 ? x : x.slice(-k) + x.slice(0, x.length - k));
    }
  });

  it('echo 前缀 "echo:" 对 value/goal 都不等于真值', () => {
    const out = applyOp(GRAPH_BASE, 'echo', initState(5))!;
    expect(out.answer).toBe('echo:5');
    expect(out.answer).not.toBe(5);
  });
});

describe('world/operators/runPlan（B.1/C.1）', () => {
  it('顺序回放：hist 与 plan 一致，终值正确，不写 expected', () => {
    const st = initState(12);
    const end = runPlan(['add3', 'mul2', 'sub1', 'submit'], st)!;
    expect(end.hist).toEqual(['add3', 'mul2', 'sub1', 'submit']);
    expect(end.x).toBe(29);
    expect(end.answer).toBe(29);
    expect((end as Record<string, unknown>).expected).toBeUndefined();
    expect(st.hist).toEqual([]);
  });

  it('任一死路即整体 null', () => {
    expect(runPlan(['add3', 'dead_end', 'mul2'], initState(1))).toBeNull();
    expect(runPlan(['upper', 'add3'], initState('abc'))).toBeNull();
  });

  it('verify 族回放：submit + check_* 双生产者就绪', () => {
    const end = runPlan(['mul2', 'submit', 'check_parity'], initState(4, { parity: 0 }))!;
    expect(end.answer).toBe(8);
    expect(end.verdict).toBe('pass');
  });
});

describe('world/operators/确定性（E.8，无随机面）', () => {
  it('applyOp 同输入执行两次，返回 state 与 hist 深相等', () => {
    const cases: ReadonlyArray<[string, unknown, Readonly<Record<string, unknown>>?]> = [
      ['add3', 7],
      ['neg', 7],
      ['mod7', -1],
      ['upper', 'aBc!'],
      ['str_len', 'abcde'],
      ['cond_even', 4],
      ['cond_long', 'abc'],
      ['submit', 5],
      ['check_parity', 4, { parity: 0 }],
      ['check_len', 'ab', { length: 3 }],
      ['noop', 'x'],
      ['fake_add', 3],
      ['shuffle', 'abc'],
      ['dead_end', 1],
      ['echo', 5],
      ['branch_decoy', 5],
    ];
    for (const [op, x, spec] of cases) {
      const a = applyOp(GRAPH_BASE, op, initState(x, spec));
      const b = applyOp(GRAPH_BASE, op, initState(x, spec));
      expect(a, `op=${op}`).toEqual(b);
    }
  });

  it('runPlan 同输入执行两次，返回 state 与 hist 深相等', () => {
    const plan = ['add3', 'mul2', 'sub1', 'submit'];
    const a = runPlan(plan, initState(12));
    const b = runPlan(plan, initState(12));
    expect(a).toEqual(b);
    expect(a).not.toBeNull();
    expect((a as State).hist).toEqual(plan);
  });
});

describe('world/operators/obsSnapshot（B.1 投影）', () => {
  it('只含 x/answer/verdict/hist，不含 spec/expected', () => {
    const st = initState(5, { parity: 1, goal: { kind: 'parity', target: 1 } });
    const snap = obsSnapshot(st) as Record<string, unknown>;
    expect(Object.keys(snap).sort()).toEqual(['answer', 'hist', 'verdict', 'x']);
    expect(snap.spec).toBeUndefined();
    expect(snap.expected).toBeUndefined();
  });

  it('hist 是副本，改快照不影响原 state', () => {
    const st = initState('abc', { length: 3 });
    const snap = obsSnapshot(st);
    (snap.hist as string[]).push('add3');
    expect(st.hist).toEqual([]);
  });
});
