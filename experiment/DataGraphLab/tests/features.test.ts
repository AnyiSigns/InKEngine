import { describe, expect, it } from 'vitest';

import {
  ACT_DIM,
  E_OFF,
  FIELD_ORDER,
  GOAL_HINT_DIM,
  GOAL_STRUCT_DIM,
  HASH_DIM,
  HIST_DIM,
  HIST_LEN,
  KIND_LIST,
  K_OFF,
  MENTION_DIM,
  NUM_DIM,
  OBS_DIM,
  OP_BUCKETS,
  P_OFF,
  STATE_DIM,
  STEP_DIM,
  T_OFF,
  featurizeAction,
  featurizeGoalStruct,
  featurizeInstr,
  featurizeObs,
  featurizeState,
  histFeatures,
  stateStats,
} from '../controller/features.js';
import { HIST_SLOTS, NODE_SLOT } from '../controller/slots.js';
import { EXIT } from '../world/operators.js';
import { crc32 } from '../world/hash.js';
import { applyOp, initState, GRAPH_BASE as G } from '../world/operators.js';
import { GRAPH } from '../runner/graph.js';

/** obs/state/hist/step 之外剩余即指令段宽度。 */
const NON_INSTR = STATE_DIM + HIST_DIM + STEP_DIM + GOAL_STRUCT_DIM;

describe('特征 dims 恒等（防手写漂移）', () => {
  it('三套特征集的 OBS_DIM 与常量求和一致', () => {
    expect(MENTION_DIM).toBe(45);
    expect(GOAL_HINT_DIM).toBe(8);
    expect(NUM_DIM).toBe(8);
    expect(HASH_DIM).toBe(256);
    expect(STATE_DIM).toBe(30);
    expect(HIST_LEN).toBe(12);
    expect(HIST_SLOTS).toBe(32);
    expect(HIST_DIM).toBe(384);
    expect(GOAL_STRUCT_DIM).toBe(8);
    expect(OBS_DIM.lang).toBe(732);
    expect(OBS_DIM.hash_only).toBe(671);
    expect(OBS_DIM.struct).toBe(740);
    expect(MENTION_DIM + GOAL_HINT_DIM + NUM_DIM + HASH_DIM + NON_INSTR - GOAL_STRUCT_DIM).toBe(
      OBS_DIM.lang,
    );
    expect(HASH_DIM + NON_INSTR - GOAL_STRUCT_DIM).toBe(OBS_DIM.hash_only);
    expect(MENTION_DIM + GOAL_HINT_DIM + NUM_DIM + HASH_DIM + NON_INSTR).toBe(OBS_DIM.struct);
  });

  it('ACT_DIM 由偏移推导、块界互不重叠', () => {
    expect(P_OFF).toBe(0);
    expect(K_OFF).toBe(3);
    expect(T_OFF).toBe(7);
    expect(E_OFF).toBe(19);
    expect(OP_BUCKETS).toBe(64);
    expect(ACT_DIM).toBe(E_OFF + OP_BUCKETS);
    expect(ACT_DIM).toBe(83);
    expect(FIELD_ORDER).toEqual(['x', 'answer', 'verdict']);
  });
});

describe('stateStats / featurizeState', () => {
  it('Int 保留符号与奇偶，负数经 neg 后不被抹号', () => {
    const neg7 = stateStats(-7);
    expect(neg7[0]).toBeCloseTo(Math.tanh(-7 / 50), 10);
    expect(neg7[0]).toBeLessThan(0);
    expect(neg7[1]).toBeCloseTo(0.07, 10);
    expect(neg7[2]).toBe(1);
    const even = stateStats(8);
    expect(even[0]).toBeGreaterThan(0);
    expect(even[2]).toBe(0);
    expect(stateStats(200)[1]).toBe(1);
  });

  it('Bool/Str/None/其它类型口径', () => {
    expect(stateStats(true)).toEqual([1, 0, 0]);
    expect(stateStats(false)).toEqual([0, 0, 0]);
    expect(stateStats('x'.repeat(20))[0]).toBe(1);
    expect(stateStats('abc')[0]).toBeCloseTo(3 / 16, 10);
    expect(stateStats(null)).toEqual([0, 0, 0]);
    expect(stateStats(undefined)).toEqual([0, 0, 0]);
    expect(stateStats([1, 2])).toEqual([0, 0, 0]);
    expect(stateStats(Number.NaN)).toEqual([0, 0, 0]);
    expect(stateStats(3.5)).toEqual([0, 0, 0]);
  });

  it('每字段 10 维：present + 类型 onehot + 值摘要', () => {
    const a = featurizeState({ x: 49, answer: null, verdict: false });
    expect(a.length).toBe(STATE_DIM);
    expect(a[0]).toBe(1);
    expect(a[1]).toBe(1); // Int onehot
    expect(a[7]).toBeCloseTo(Math.tanh(49 / 50), 6); // 值摘要在段内第 8..10 维
    expect(a[8]).toBeCloseTo(0.49, 6);
    expect(a[9]).toBe(1); // 49 为奇数
    expect(a[10]).toBe(0); // answer=None 不存在
    expect(a[16]).toBe(1); // None onehot（第 6 类）
    expect(a[20]).toBe(1); // verdict 存在
    expect(a[23]).toBe(1); // Bool onehot
    expect(a[27]).toBe(0); // false 摘要首位
  });
});

describe('featurizeInstr', () => {
  it('numHint 从“长度在3到7之间”解析区间端点', () => {
    const a = featurizeInstr('长度在3到7之间');
    const b = MENTION_DIM + GOAL_HINT_DIM;
    expect(a[b]).toBe(1);
    expect(a[b + 1]).toBeCloseTo(3 / 50, 6);
    expect(a[b + 2]).toBe(1);
    expect(a[b + 3]).toBeCloseTo(7 / 50, 6);
    expect(a[b + 4]).toBe(0);
  });

  it('mention 命中数/首现/序位三格口径', () => {
    const a = featurizeInstr('加三然后翻倍');
    expect(a[0]).toBeCloseTo(1 / 3, 6); // add3（k=0）命中 1 次
    expect(a[1]).toBe(1); // 首现于 0 号 token
    expect(a[2]).toBe(1); // 序位第一
    expect(a[3]).toBeCloseTo(1 / 3, 6); // mul2（k=1）命中 1 次
    expect(a[4]).toBeCloseTo(1 - 4 / 5, 6); // 首现位置归一
    expect(a[5]).toBeCloseTo(1 - 1 / 15, 6); // rank=1（add3 更早首现）
    expect(a[6]).toBe(0); // sub1（k=2）未命中
    expect(a[8]).toBe(0);
  });

  it('空指令与无意义指令零命中', () => {
    const a = featurizeInstr('');
    for (const v of a) expect(v).toBe(0);
    const b = featurizeInstr('呓语呢囔');
    for (let i = 0; i < MENTION_DIM + GOAL_HINT_DIM + NUM_DIM; i++) expect(b[i]).toBe(0);
  });

  it('目标义项第四组是合取连接词', () => {
    const a = featurizeInstr('结果是偶数，并且超过二十');
    const o = MENTION_DIM;
    expect(a[o]).toBeCloseTo(1 / 3, 6); // parity「偶数」
    expect(a[o + 2]).toBeCloseTo(1 / 3, 6); // gt「超过」
    expect(a[o + 6]).toBeGreaterThan(0); // conj「并且」
  });

  it('hash_only 只剩 256 维哈希袋且 L2 归一', () => {
    const a = featurizeInstr('加三然后翻倍', 'hash_only');
    expect(a.length).toBe(HASH_DIM);
    let nrm = 0;
    let nonzero = 0;
    for (const v of a) {
      nrm += v * v;
      if (v > 0) nonzero++;
    }
    expect(nonzero).toBeGreaterThan(0);
    expect(Math.sqrt(nrm)).toBeCloseTo(1, 6);
    const e = featurizeInstr('！？。', 'hash_only');
    expect(e.length).toBe(HASH_DIM);
    for (const v of e) expect(v).toBe(0);
  });
});

describe('histFeatures', () => {
  it('滚窗 reverse 后 j=0 是最近动作，槽位零碰撞', () => {
    const a = histFeatures(['add3', 'mul2']);
    expect(a.length).toBe(HIST_DIM);
    expect(a[0 * HIST_SLOTS + NODE_SLOT.get('mul2')!]).toBe(1);
    expect(a[1 * HIST_SLOTS + NODE_SLOT.get('add3')!]).toBe(1);
    let ones = 0;
    for (const v of a) ones += v;
    expect(ones).toBe(2);
  });

  it('超窗截断：只保留最近 HIST_LEN 步，重复同槽合并，未知节点跳过', () => {
    const a = histFeatures(Array.from({ length: HIST_LEN + 3 }, () => 'add3'));
    let ones = 0;
    for (const v of a) ones += v;
    expect(ones).toBe(HIST_LEN); // 12 个 j 块各占 add3 槽，第 13 条滚出窗口
    const b = histFeatures(['no_such_node', 'add3']);
    let onesB = 0;
    for (const v of b) onesB += v;
    expect(onesB).toBe(1);
  });
});

describe('featurizeAction', () => {
  it('exit 只置 kind 位', () => {
    const a = featurizeAction(GRAPH, EXIT);
    expect(a.length).toBe(ACT_DIM);
    expect(a[K_OFF + KIND_LIST.indexOf('exit')]).toBe(1);
    let ones = 0;
    for (const v of a) ones += v;
    expect(ones).toBe(1);
  });

  it('"any" 在 accepts/returns 段一律不置位', () => {
    for (const nid of ['submit', 'echo']) {
      const a = featurizeAction(GRAPH, nid);
      for (let i = T_OFF; i < T_OFF + 12; i++) expect(a[i]).toBe(0);
      expect(a[P_OFF + 1]).toBe(1); // provides=answer
    }
    const add3 = featurizeAction(GRAPH, 'add3');
    expect(add3[P_OFF]).toBe(1);
    expect(add3[K_OFF]).toBe(1);
    expect(add3[T_OFF]).toBe(1); // accepts Int
    expect(add3[T_OFF + 6]).toBe(1); // returns Int
    expect(add3[E_OFF + (crc32('add3') % OP_BUCKETS)]).toBe(1);
    expect([...add3].reduce((s, v) => s + v, 0)).toBe(5);
  });

  it('entry 不可特征化，未知节点 fail-fast', () => {
    expect(() => featurizeAction(GRAPH, 'entry')).toThrow();
    expect(() => featurizeAction(G, 'ghost')).toThrow();
  });
});

describe('白名单审计（唯一特征源不看见 spec/expected）', () => {
  it('featurizeObs 只接收公开观测面，签名层不存在 spec 通路', () => {
    const obsA = { x: 7, answer: null, verdict: null, hist: ['add3'] };
    const obsB = { x: 7, answer: null, verdict: null, hist: ['add3'] };
    // 同 obs 配两份完全不同的“任务语境”：spec/expected 只存在于任务对象上，
    // featurizeObs 的入参类型（string + {x,answer,verdict,hist}）决定其输出。
    const t1 = featurizeObs('对 x 加三', obsA, 'lang');
    const t2 = featurizeObs('对 x 加三', obsB, 'lang');
    expect(t1).toEqual(t2);
    // 由世界原语走一遍：obsSnapshot 投影本身就物理排除 spec/expected。
    let st = initState(7, { goal: { kind: 'parity', target: 0 }, expected: 999, plan_hidden: ['neg'] });
    st = applyOp(G, 'add3', st)!;
    const v1 = featurizeObs('把值翻倍', { x: st.x, answer: st.answer, verdict: st.verdict, hist: st.hist });
    let st2 = initState(7, { goal: { kind: 'gt', target: -50 } });
    st2 = applyOp(G, 'add3', st2)!;
    const v2 = featurizeObs('把值翻倍', { x: st2.x, answer: st2.answer, verdict: st2.verdict, hist: st2.hist });
    expect(v1).toEqual(v2);
  });

  it('三套特征集输出长度与 OBS_DIM 一致且全 float32 无 NaN', () => {
    const obs = { x: -3, answer: 'ok', verdict: true, hist: ['add3', 'neg', 'submit'] };
    for (const fs of ['lang', 'hash_only'] as const) {
      const v = featurizeObs('先变号再取模七', obs, fs);
      expect(v).toBeInstanceOf(Float32Array);
      expect(v.length).toBe(OBS_DIM[fs]);
      for (const x of v) expect(Number.isNaN(x)).toBe(false);
    }
    // struct 臂：基座 732，goal 段由诊断侧自行追加成 740。
    const base = featurizeObs('先变号再取模七', obs, 'struct');
    expect(base.length).toBe(OBS_DIM.lang);
    const full = new Float32Array(OBS_DIM.struct);
    full.set(base, 0);
    full.set(featurizeGoalStruct({ goal: { kind: 'gt', target: 10 } }), base.length);
    expect(full.length).toBe(OBS_DIM.struct);
  });
});

describe('featurizeGoalStruct（struct 诊断臂唯一例外）', () => {
  it('四类目标的编码口径', () => {
    expect([...featurizeGoalStruct({ goal: { kind: 'parity', target: 1 } })]).toEqual([
      1, 0, 0, 1, 0, 0, 0, 0,
    ]);
    const gt = [...featurizeGoalStruct({ goal: { kind: 'gt', target: 30 } })];
    expect(gt).toEqual([0, 1, 0, 0, expect.closeTo(0.6, 6), 0, 0, 0]);
    const len = featurizeGoalStruct({ goal: { kind: 'len', min: 3, max: 7 } });
    expect(len[2]).toBe(1);
    expect(len[5]).toBeCloseTo(3 / 16, 10);
    expect(len[6]).toBeCloseTo(7 / 16, 10);
    expect(len[7]).toBe(0);
    expect(featurizeGoalStruct({ goal: { kind: 'len', min: 2, max: 40 } })[6]).toBe(1);
  });

  it('all 合取：前两条子目标并写，参数冲突后到覆盖', () => {
    const a = [...featurizeGoalStruct({
      goal: {
        kind: 'all',
        of: [
          { kind: 'parity', target: 0 },
          { kind: 'gt', target: 20 },
        ],
      },
    })];
    expect(a[0]).toBe(1);
    expect(a[1]).toBe(1);
    expect(a[3]).toBe(0);
    expect(a[4]).toBeCloseTo(0.4, 6);
    expect(a[7]).toBe(1);
    const b = featurizeGoalStruct({
      goal: {
        kind: 'all',
        of: [
          { kind: 'parity', target: 0 },
          { kind: 'parity', target: 1 },
        ],
      },
    });
    expect(b[0]).toBe(1);
    expect(b[3]).toBe(1);
    expect(b[7]).toBe(1);
  });

  it('只读 goal 字段：其余键（含 expected/plan）不参与编码', () => {
    const clean = featurizeGoalStruct({ goal: { kind: 'gt', target: 5 } });
    const dirty = featurizeGoalStruct({
      goal: { kind: 'gt', target: 5 },
      expected: 123,
      plan_hidden: ['mul2'],
      seed: 7,
    });
    expect(dirty).toEqual(clean);
    for (const v of featurizeGoalStruct({})) expect(v).toBe(0);
    expect(featurizeGoalStruct({ goal: { kind: 'bogus' } })).toEqual(clean.map(() => 0));
    expect(featurizeGoalStruct({ goal: { kind: 'parity', target: 'odd' as unknown } })[3]).toBe(0);
  });
});
