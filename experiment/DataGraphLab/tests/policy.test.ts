import { describe, expect, it } from 'vitest';

import { H, Policy, type PolicyWeights } from '../controller/policy.js';
import {
  ACT_DIM,
  OBS_DIM,
  featurizeAction,
  featurizeGoalStruct,
  featurizeObs,
} from '../controller/features.js';
import { EXIT, ROUTING } from '../world/operators.js';
import { GRAPH, candidates, MAX_STEPS } from '../runner/graph.js';
import { initState } from '../world/operators.js';
import { makeRng } from '../world/rng.js';

function zerosPolicy(featureSet: 'lang' | 'hash_only' = 'lang'): Policy {
  const obsDim = OBS_DIM[featureSet];
  const z = (n: number): number[] => new Array<number>(n).fill(0);
  return new Policy(
    {
      wo: { shape: [H, obsDim], data: z(H * obsDim) },
      bo: { shape: [H], data: z(H) },
      wa: { shape: [H, ACT_DIM], data: z(H * ACT_DIM) },
      ba: { shape: [H], data: z(H) },
      ws: { shape: [H], data: z(H) },
      wp: { shape: [H], data: z(H) },
      bp: { shape: [1], data: z(1) },
    },
    featureSet,
    'progress',
  );
}

/** 独立参考实现（测试内复算，不 import 生产内部）：逐式对照前向数学。 */
function refScores(p: PolicyWeights, o: Float32Array, acts: readonly Float32Array[]): number[] {
  const matvec = (w: readonly number[], bias: readonly number[], v: Float32Array): Float64Array => {
    const out = new Float64Array(H);
    const width = v.length;
    for (let r = 0; r < H; r++) {
      let acc = bias[r]!;
      for (let c = 0; c < width; c++) acc += w[r * width + c]! * v[c]!;
      out[r] = Math.tanh(acc);
    }
    return out;
  };
  const h = matvec(p.wo.data, p.bo.data, o);
  const s = acts.map((a) => {
    const z = matvec(p.wa.data, p.ba.data, a);
    let acc = 0;
    for (let r = 0; r < H; r++) acc += p.ws.data[r]! * h[r]! * z[r]!;
    return acc;
  });
  const m = Math.max(...s);
  const ex = s.map((x) => Math.exp(x - m));
  const sum = ex.reduce((x, y) => x + y, 0);
  return ex.map((x) => x / sum);
}

describe('Policy 构造与随机初始化', () => {
  it('同 seed 两次 random 参数逐位相同、异 seed 不同', () => {
    const a = Policy.random(7, 'lang');
    const b = Policy.random(7, 'lang');
    const c = Policy.random(8, 'lang');
    expect(a.params.wo.data).toEqual(b.params.wo.data);
    expect(a.params.wa.data).toEqual(b.params.wa.data);
    expect(a.params.ws.data).toEqual(b.params.ws.data);
    expect(a.params.wo.data).not.toEqual(c.params.wo.data);
    expect(a.params.bo.data.every((v) => v === 0)).toBe(true);
    expect(a.params.wo.data.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('shape/长度不符与 NaN 注入 fail-fast', () => {
    const good = Policy.random(3).params;
    expect(
      () =>
        new Policy(
          { ...good, wo: { shape: [H, 10], data: good.wo.data } },
          'lang',
          'progress',
        ),
    ).toThrow(/shape/);
    expect(
      () =>
        new Policy(
          { ...good, ba: { shape: [H], data: [1, 2, 3] } },
          'lang',
          'progress',
        ),
    ).toThrow(/长度/);
    expect(() =>
      new Policy(
        { ...good, ws: { shape: [H], data: new Array(H).fill(Number.NaN) } },
        'lang',
        'progress',
      ),
    ).toThrow(/非有限/);
  });

  it('hash_only 与 struct 按各自 obsDim 校验', () => {
    const p = Policy.random(1, 'hash_only');
    expect(p.obsDim).toBe(671);
    expect(() =>
      p.scoresFromObs(new Float32Array(OBS_DIM.lang), [featurizeAction(GRAPH, EXIT)]),
    ).toThrow(/长度/);
  });
});

describe('前向 scoresFromObs', () => {
  const cand = ['add3', 'mul2'];
  const obsFeat = featurizeObs('先加三再翻倍', { x: 5, answer: null, verdict: null, hist: [] });
  const acts = cand.map((nid) => featurizeAction(GRAPH, nid));

  it('softmax 和为 1、非负；空候选与脏输入 fail-fast', () => {
    const p = Policy.random(11);
    const s = p.scoresFromObs(obsFeat, acts);
    expect(s.length).toBe(2);
    let sum = 0;
    for (const v of s) {
      expect(v).toBeGreaterThanOrEqual(0);
      sum += v;
    }
    expect(sum).toBeCloseTo(1, 6);
    expect(() => p.scoresFromObs(obsFeat, [])).toThrow(/空/);
    expect(() => p.scoresFromObs(obsFeat.slice(0, 10), acts)).toThrow(/obs/);
    const bad = Float32Array.from(obsFeat);
    bad[0] = Number.POSITIVE_INFINITY;
    expect(() => p.scoresFromObs(bad, acts)).toThrow(/非有限/);
  });

  it('与测试内独立复算的前向公式逐元素一致', () => {
    const p = Policy.random(11);
    const got = p.scoresFromObs(obsFeat, acts);
    const want = refScores(p.params, obsFeat, acts);
    for (let i = 0; i < want.length; i++) expect(got[i]).toBeCloseTo(want[i]!, 6);
  });

  it('零权重 ⇒ 均匀分布，greedy 并列取最小下标', () => {
    const p = zerosPolicy();
    const s = p.scoresFromObs(obsFeat, acts);
    expect(s[0]).toBeCloseTo(0.5, 6);
    expect(s[1]).toBeCloseTo(0.5, 6);
    expect(p.actFromObs(obsFeat, acts)).toBe(0);
    // 反序候选（同一对特征换列序）并列时仍选中下标 0。
    expect(p.actFromObs(obsFeat, [acts[1]!, acts[0]!]!)).toBe(0);
  });

  it('采样分布合法且必须显式 rng', () => {
    const p = zerosPolicy();
    expect(() => p.actFromObs(obsFeat, acts, false)).toThrow(/rng/);
    const rng = makeRng(5);
    let c0 = 0;
    for (let i = 0; i < 300; i++) if (p.actFromObs(obsFeat, acts, false, rng) === 0) c0++;
    expect(c0).toBeGreaterThan(60);
    expect(c0).toBeLessThan(240);
  });
});

describe('进度 critic 头与动作嵌入', () => {
  it('progressHead 确定性有限值；head=none 拒用', () => {
    const p = Policy.random(4, 'lang', 'progress');
    const v = p.progressHead(obsDimFeat());
    expect(Number.isFinite(v)).toBe(true);
    expect(p.progressHead(obsDimFeat())).toBe(v);
    const off = Policy.random(4, 'lang', 'none');
    expect(() => off.progressHead(obsDimFeat())).toThrow(/进度头/);
    const o = new Float32Array(OBS_DIM.lang);
    for (let i = 0; i < o.length; i++) o[i] = 0;
    expect(off.params.wp.data.length).toBe(0);
  });

  it('embedActions 覆盖 ROUTING 全部节点且按图缓存', () => {
    const p = Policy.random(2);
    const m1 = p.embedActions(GRAPH);
    expect(m1.size).toBe(ROUTING.length);
    expect(m1.has(EXIT)).toBe(true);
    expect(m1.get('add3')!.length).toBe(H);
    expect(p.embedActions(GRAPH)).toBe(m1);
  });
});

function obsDimFeat(): Float32Array {
  return featurizeObs('把结果变成大于10的数', { x: 13, answer: 13, verdict: 'pass:abcd', hist: ['add3'] });
}

describe('act 便捷面端到端', () => {
  it('真实图上 greedy 确定、采样合法', () => {
    const p = Policy.random(13, 'lang');
    const st = initState(7, {});
    const cand = candidates(GRAPH, st, []);
    expect(cand.length).toBeGreaterThan(1);
    expect(cand.length).toBeLessThanOrEqual(ROUTING.length);
    const a1 = p.act('依次执行：加三，然后翻倍', { x: st.x, answer: st.answer, verdict: st.verdict, hist: st.hist }, cand, GRAPH);
    const a2 = p.act('依次执行：加三，然后翻倍', { x: st.x, answer: st.answer, verdict: st.verdict, hist: st.hist }, cand, GRAPH);
    expect(a1).toBe(a2);
    expect(cand).toContain(a1);
    const sampled = p.act('依次执行：加三，然后翻倍', { x: 7, answer: null, verdict: null, hist: [] }, cand, GRAPH, false, makeRng(1));
    expect(cand).toContain(sampled);
    const ho = Policy.random(13, 'hash_only');
    expect(cand).toContain(ho.act('加三', { x: 7, answer: null, verdict: null, hist: [] }, cand, GRAPH));
    expect(() => p.act('x', { x: 1, answer: null, verdict: null, hist: [] }, [], GRAPH)).toThrow(/空/);
    expect(MAX_STEPS).toBe(12);
  });

  it('struct 诊断臂拒绝白名单便捷口', () => {
    const p = Policy.random(0, 'struct');
    const obs = { x: 1, answer: null, verdict: null, hist: [] };
    expect(() => p.act('加三', obs, ['add3', EXIT], GRAPH)).toThrow(/struct/);
    // 装配面：基座 + goal 段拼接后走 scoresFromObs。
    const base = featurizeObs('加三', obs, 'struct');
    const full = new Float32Array(OBS_DIM.struct);
    full.set(base, 0);
    full.set(featurizeGoalStruct({ goal: { kind: 'gt', target: 5 } }), base.length);
    const s = p.scoresFromObs(full, [featurizeAction(GRAPH, 'add3'), featurizeAction(GRAPH, EXIT)]);
    expect(s.length).toBe(2);
    let sum = 0;
    for (const v of s) sum += v;
    expect(sum).toBeCloseTo(1, 6);
  });

  it('load 不存在的文件抛错', () => {
    expect(() => Policy.load('/nonexistent/definitely-not-here.json')).toThrow(/读取失败/);
  });
});
