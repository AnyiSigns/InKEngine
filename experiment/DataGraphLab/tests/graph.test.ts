/**
 * runner/graph 测试（B.3 唯一口径 + D 表必须断言）。
 *
 * B.3 不变量代码层焊死：entry 永不在 candidates、每步至少含 exit、访问上限
 * （MAX_REPEAT）过滤只在本函数实现——oracle/search/runner 全部 import 本函数，
 * 别处不复制过滤。测试同时覆盖 MAX_STEPS=12 与 applyOp re-export。
 */

import { describe, expect, it } from 'vitest';

import { GRAPH, MAX_STEPS, applyOp, candidates } from '../runner/graph.js';
import {
  EXIT,
  ENTRY,
  GRAPH_BASE,
  MAX_REPEAT,
  NODES_BASE,
  initState,
  requiresOk,
  type Graph,
  type State,
} from '../world/operators.js';
import { makeRng } from '../world/rng.js';

/** 以固定 seed 构造一批覆盖多类型的初始状态（Int/Str/带 spec 的 check 前置态）。 */
function sampleStates(): State[] {
  const rng = makeRng(11);
  const out: State[] = [initState(5), initState('abc'), initState(-17), initState('aBcDe')];
  for (let i = 0; i < 40; i++) {
    const st = initState(rng.randint(-50, 50));
    out.push(applyOp(GRAPH, 'add3', st) ?? st);
  }
  out.push({ ...initState('abcd'), verdict: 'pass' });
  out.push(initState(9, { parity: 1 }));
  out.push(initState('hello', { length: 5 }));
  return out;
}

describe('runner/graph/GRAPH（由 OPS/NODES_BASE 组装）', () => {
  it('节点集 = NODES_BASE 全量（含 entry/exit 结构节点）', () => {
    expect(Object.keys(GRAPH.nodes).sort()).toEqual([...NODES_BASE].sort());
  });

  it('entry/exit 在图中 alive，契约字段为结构占位', () => {
    const entry = GRAPH.nodes[ENTRY]!;
    const exit = GRAPH.nodes[EXIT]!;
    expect(entry.alive).toBe(true);
    expect(exit.alive).toBe(true);
    expect(requiresOk(entry, initState(1))).toBe(true);
    expect(requiresOk(exit, initState(1))).toBe(true);
  });

  it('op 节点契约与 world/operators 一致（复用 GRAPH_BASE）', () => {
    for (const nid of Object.keys(GRAPH_BASE.nodes)) {
      expect(GRAPH.nodes[nid]).toEqual(GRAPH_BASE.nodes[nid]);
    }
  });
});

describe('runner/graph/candidates（B.3 唯一口径）', () => {
  it('entry 永不在 candidates（多种状态/图）', () => {
    for (const st of sampleStates()) {
      expect(candidates(GRAPH, st, st.hist)).not.toContain(ENTRY);
    }
  });

  it('每步至少含 exit', () => {
    for (const st of sampleStates()) {
      expect(candidates(GRAPH, st, st.hist)).toContain(EXIT);
    }
  });

  it('返回按节点 id 字典序排序（确定性参考序）', () => {
    for (const st of sampleStates()) {
      const c = candidates(GRAPH, st, st.hist);
      expect(c).toEqual([...c].sort());
    }
  });

  it('访问上限过滤唯一在此实现：契约可满足但超过 MAX_REPEAT 即被滤除', () => {
    const over = { ...initState(5), hist: ['add3', 'add3'] };
    expect(requiresOk(GRAPH.nodes.add3!, over)).toBe(true);
    expect(candidates(GRAPH, over, over.hist)).not.toContain('add3');
    const once = { ...initState(5), hist: ['add3'] };
    expect(candidates(GRAPH, once, once.hist)).toContain('add3');
  });

  it('exit 恒在候选且不受 MAX_REPEAT 约束', () => {
    const st = { ...initState(5), hist: ['exit', 'exit', 'exit'] };
    expect(candidates(GRAPH, st, st.hist)).toContain(EXIT);
  });

  it('requiresOk 过滤：dead_end 永不出现；契约满足的 decoy 干扰项保留', () => {
    for (const st of sampleStates()) {
      expect(candidates(GRAPH, st, st.hist)).not.toContain('dead_end');
    }
    const c = candidates(GRAPH, initState(3), []);
    expect(c).toContain('fake_add');
    expect(c).toContain('branch_decoy');
  });

  it('alive=false 的节点不进候选（结构层预留的干扰/下线开关）', () => {
    const dead = {
      nodes: {
        ...GRAPH.nodes,
        mul2: { ...GRAPH.nodes.mul2!, alive: false },
      },
    } as Graph;
    const c = candidates(dead, initState(4), []);
    expect(c).not.toContain('mul2');
    expect(c).toContain('add3');
    expect(c).toContain(EXIT);
  });
});

describe('runner/graph/MAX_STEPS（C.7/E.14）', () => {
  it('= 12：深度 5 + submit + check + exit 再留 4 步冗余', () => {
    expect(MAX_STEPS).toBe(12);
  });
});

describe('runner/graph/applyOp re-export（世界唯一实现仍在 world/operators）', () => {
  it('与 operators 同一函数：变换结果一致', () => {
    const a = applyOp(GRAPH, 'add3', initState(3));
    const b = applyOp(GRAPH_BASE, 'add3', initState(3));
    expect(a).toEqual(b);
  });

  it('可经 candidates+applyOp 完成一次合法回放（oracle 的前提）', () => {
    let st = initState(4);
    for (const op of ['add3', 'mul2', 'submit']) {
      expect(candidates(GRAPH, st, st.hist)).toContain(op);
      const next = applyOp(GRAPH, op, st);
      expect(next).not.toBeNull();
      st = next!;
    }
    expect(st.x).toBe(14);
    expect(st.answer).toBe(14);
    expect(st.hist).toEqual(['add3', 'mul2', 'submit']);
  });
});
