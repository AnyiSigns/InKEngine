/**
 * gen/generator 测试（C.1 全语义 + D 表必须断言）。
 *
 * 覆盖：终算子不入骨架、MAX_REPEAT 与 candidates 同口径、签名去冗余（同签名
 * 只留最短/同长取字典序首，Int 全域探针可证正确）、G0.1 同 seed 确定性、G0.2
 * 每个 emitted task 的 plan_hidden 回放穿验收 100%、goal gold=传入骨架且无
 * depth-1 捷径、makeSplit 配额不足报错、goalProbeHit 判定语义、
 * makeCoverageSplit 可产域覆盖构造（注册表判定见 tests/producibility.test.ts）。
 *
 * 世界结构：heldout 部分骨架在 goal 族结构性不可产（实测 211/830：str_len
 * 收尾的 Str 骨架、恒等类 Int 骨架等）——gen/producibility.ts 在模块加载时
 * 精确判定（Int 全域、Str 保守有界）出该域并入册 UNPRODUCIBLE_HELDOUT；
 * makeCoverageSplit 跳过注册表成员（记为 known-unproducible 带出计数），覆盖
 * 声明在可产域上可判定成立，follow 全域与 goal 可产域构造均不抛错。
 */

import { describe, expect, it } from 'vitest';

import {
  coverageKey,
  dedupeBySignature,
  goalProbeHit,
  HELDOUT_SKELETONS,
  instanceFollow,
  instanceGoal,
  instanceTask,
  makeCoverageSplit,
  makeCoverageSplitInfo,
  makeSplit,
  makeTask,
  MAX_DEPTH,
  sampleGoal,
  SKELETONS,
  splitOf,
  STRATA,
  STYLES,
  UNPRODUCIBLE_HELDOUT,
  _skelId,
  type Skel,
} from '../gen/generator.js';
import { MAX_REPEAT, applyOp, initState, runPlan } from '../world/operators.js';
import { GRAPH, candidates } from '../runner/graph.js';
import { makeRng } from '../world/rng.js';
import { hashObj } from '../world/hash.js';
import { goalOk, type Goal } from '../world/goal.js';
import { accept } from '../verify/acceptor.js';
import { taskHash, type Task } from '../schema.js';

/** 非 op 节点（终算子/decoy/结构节点）绝不能进骨架采样池。 */
const NON_OP = new Set([
  'submit',
  'check_parity',
  'check_len',
  'noop',
  'fake_add',
  'shuffle',
  'dead_end',
  'echo',
  'branch_decoy',
  'entry',
  'exit',
]);

/** 回放任务隐藏计划并断言穿验收。 */
function replayAccepted(t: Task): void {
  const st = runPlan(t.plan_hidden, initState(t.x, t.spec));
  expect(st, `${t.style}/${t.family} ${t.plan_hidden.join(',')}`).not.toBeNull();
  expect(accept(t, st!), `${t.style}/${t.family} ${t.plan_hidden.join(',')}`).toBe(true);
}

describe('gen/generator/骨架枚举（C.1）', () => {
  it('终算子/decoy/结构节点零出现', () => {
    for (const sk of SKELETONS) {
      for (const op of sk.plan) expect(NON_OP.has(op)).toBe(false);
    }
  });

  it('同算子出现次数 ≤ MAX_REPEAT（与 candidates 同口径，防 runner 判非法计划）', () => {
    for (const sk of SKELETONS) {
      for (const op of new Set(sk.plan)) {
        expect(sk.plan.filter((o) => o === op).length).toBeLessThanOrEqual(MAX_REPEAT);
      }
    }
  });

  it('深度 ≤ MAX_DEPTH，且双起点 Int/Str 均非空', () => {
    for (const sk of SKELETONS) expect(sk.plan.length).toBeLessThanOrEqual(MAX_DEPTH);
    expect(SKELETONS.some((sk) => sk.root === 'Int')).toBe(true);
    expect(SKELETONS.some((sk) => sk.root === 'Str')).toBe(true);
  });

  it('每个骨架类型合法：任意探针回放成功且 hist 与 plan 一致', () => {
    for (const sk of SKELETONS) {
      const st = runPlan(sk.plan, initState(sk.root === 'Int' ? 1 : 'ab'));
      expect(st, sk.plan.join(',')).not.toBeNull();
      expect(st!.hist).toEqual([...sk.plan]);
    }
  });
});

describe('gen/generator/签名与去冗余（C.1）', () => {
  it('构造等价对：同签名只留最短、同长取字典序首', () => {
    // 等价对：add3+sub1 ≡ sub1+add3（x+2，同长取字典序首）；neg+neg+mul2 ≡ mul2；
    // upper+lower ≡ lower（lower∘upper=lower）；lower+upper ≡ upper（upper∘lower=upper）。
    const skels: Skel[] = [
      { root: 'Int', plan: ['add3', 'sub1'] },
      { root: 'Int', plan: ['sub1', 'add3'] },
      { root: 'Int', plan: ['mul2'] },
      { root: 'Int', plan: ['neg', 'neg', 'mul2'] },
      { root: 'Str', plan: ['upper', 'lower'] },
      { root: 'Str', plan: ['lower'] },
      { root: 'Str', plan: ['lower', 'upper'] },
      { root: 'Str', plan: ['upper'] },
      { root: 'Str', plan: ['reverse', 'reverse'] },
    ];
    const out = dedupeBySignature(skels);
    expect(out.map((s) => `${s.root}:${s.plan.join(',')}`)).toEqual([
      'Int:add3,sub1',
      'Int:mul2',
      'Str:lower',
      'Str:reverse,reverse',
      'Str:upper',
    ]);
  });

  it('SKELETONS 内部不并存等价骨架（去冗余已落地）', () => {
    const has = (root: string, plan: string): boolean =>
      SKELETONS.some((s) => s.root === root && s.plan.join(',') === plan);
    expect(has('Int', 'add3,sub1')).toBe(true);
    expect(has('Int', 'sub1,add3')).toBe(false);
    expect(has('Int', 'mul2')).toBe(true);
    expect(has('Int', 'neg,neg,mul2')).toBe(false);
    expect(has('Str', 'upper')).toBe(true);
    expect(has('Str', 'lower')).toBe(true);
    expect(has('Str', 'lower,upper')).toBe(false); // ≡ upper，已去冗余
    expect(has('Str', 'upper,lower')).toBe(false); // ≡ lower，已去冗余
  });

  it('增量签名与回放签名一致：对 SKELETONS 用回放路径重去冗余结果不变', () => {
    const redone = dedupeBySignature([...SKELETONS]);
    expect(redone.map(_skelId)).toEqual(SKELETONS.map(_skelId));
  });
});

describe('gen/generator/STRATA 分层', () => {
  it('覆盖全部深度 1..MAX_DEPTH 的 plain/cond 两层', () => {
    for (let d = 1; d <= MAX_DEPTH; d++) {
      expect(STRATA.has(`${d}|plain`), `${d}|plain`).toBe(true);
      expect(STRATA.has(`${d}|cond`), `${d}|cond`).toBe(true);
    }
  });

  it('每层 ≥2 骨架，且每个骨架分组与 _stratum 一致', () => {
    for (const [key, sks] of STRATA) expect(sks.length, key).toBeGreaterThanOrEqual(2);
    for (const sk of SKELETONS) {
      const hasCond = sk.plan.some((o) => o.startsWith('cond_'));
      expect(STRATA.get(`${sk.plan.length}|${hasCond ? 'cond' : 'plain'}`)?.includes(sk)).toBe(true);
    }
  });
});

describe('gen/generator/instance_follow（C.1）', () => {
  it('expected=回放值、plan_hash=hashObj(plan)、回放穿 accept', () => {
    for (const [seed, root, plan] of [
      [0, 'Int', ['add3', 'mul2']],
      [1, 'Int', ['neg', 'mod7', 'sub1']],
      [2, 'Str', ['upper', 'reverse']],
      [3, 'Str', ['cond_long', 'str_len', 'mul2']],
    ] as const) {
      for (const family of ['value', 'verify'] as const) {
        const t = instanceFollow(makeRng(seed), root, plan, family);
        expect(t, `${root}/${family} ${plan.join(',')}`).not.toBeNull();
        const replay = runPlan(plan, initState(t!.x))!;
        expect(t!.expected).toBe(replay.x);
        expect(t!.plan_hash).toBe(hashObj(t!.plan_hidden));
        expect(t!.plan_hidden.slice(0, plan.length)).toEqual([...plan]);
        replayAccepted(t!);
      }
    }
  });
});

describe('gen/generator/instance_goal（C.1）', () => {
  it('gold=传入骨架、初始态不达标、无 depth-1 捷径、回放穿 accept', () => {
    for (const [seed, root, plan] of [
      [5, 'Int', ['add3', 'mul2']],
      [6, 'Int', ['cond_even', 'mod7']],
      [7, 'Str', ['append_bang', 'upper']],
      [8, 'Str', ['cond_long', 'reverse']],
    ] as const) {
      for (const family of ['goal', 'goal_verify'] as const) {
        const t = instanceGoal(makeRng(seed), root, plan, family);
        expect(t, `${root}/${family} ${plan.join(',')}`).not.toBeNull();
        expect(t!.plan_hidden.slice(0, plan.length)).toEqual([...plan]);
        const spec = t!.spec as Readonly<{ goal: Goal }>;
        expect(goalOk(t!.x, spec)).toBe(false);
        expect(goalOk(t!.expected, spec)).toBe(true);
        replayAccepted(t!);
      }
    }
  });

  it('STR_GOALS 的 len 区间 max ≤ 5：echo 产物长度恒 ≥6 不达标（单步捷径关死）', () => {
    for (let i = 0; i < 200; i++) {
      const g = sampleGoal(makeRng(i), 'Str') as Extract<Goal, { kind: 'len' }>;
      expect(g.kind).toBe('len');
      expect(g.max).toBeLessThanOrEqual(5);
    }
  });
});

describe('gen/generator/goalProbeHit（可达性探针语义）', () => {
  it('Int 全域精确（恒等越上界/翻倍恒偶判不可达；平移可达判可达）；Str 探针只提示', () => {
    expect(goalProbeHit('Int', ['neg', 'neg'], { kind: 'gt', target: 50 })).toBe(false); // 恒等：-50..50 内无 >50
    expect(goalProbeHit('Int', ['add3', 'sub1'], { kind: 'gt', target: 50 })).toBe(true); // x+2，50→52
    expect(goalProbeHit('Int', ['mul2'], { kind: 'parity', target: 1 })).toBe(false); // 翻倍恒偶
    expect(goalProbeHit('Int', ['mul2'], { kind: 'parity', target: 0 })).toBe(true);
    // Str 探针只是提示不剪枝（长度保持的恒等骨架照样在探针上「命中」len 目标）。
    expect(goalProbeHit('Str', ['reverse', 'reverse'], { kind: 'len', min: 3, max: 5 })).toBe(true);
  });
});

describe('gen/generator/G0.1 同 seed 确定性（禁 Math.random）', () => {
  it('makeTask 同 seed 两次：taskHash 逐字相同且任务全字段深等', () => {
    for (const seed of [0, 1, 7, 42]) {
      const a = makeTask(seed, 'follow');
      const b = makeTask(seed, 'follow');
      expect(a).not.toBeNull();
      expect(taskHash(a!)).toBe(taskHash(b!));
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      const ga = makeTask(seed, 'goal');
      const gb = makeTask(seed, 'goal');
      expect(ga, `goal seed=${seed}`).not.toBeNull();
      expect(taskHash(ga!)).toBe(taskHash(gb!));
      expect(JSON.stringify(ga)).toBe(JSON.stringify(gb));
    }
  });

  it('makeSplit 同 seed：taskHash 列表逐字相同', () => {
    const a = makeSplit('val', 2, 3);
    const b = makeSplit('val', 2, 3);
    expect(a.map(taskHash)).toEqual(b.map(taskHash));
  });
});

describe('gen/generator/G0.2 生成可解（回放穿验收 100%）', () => {
  it('批量任务的 plan_hidden 全部回放穿 accept', () => {
    const tasks: Task[] = [];
    for (let seed = 0; seed < 30; seed++) {
      for (const [style, family] of [
        ['follow', 'value'],
        ['follow', 'verify'],
        ['goal', 'goal'],
        ['goal', 'goal_verify'],
      ] as const) {
        const t = makeTask(seed, style, family);
        if (t !== null) tasks.push(t);
      }
    }
    tasks.push(...makeSplit('val', 2, 13));
    tasks.push(...makeSplit('train', 1, 17));
    expect(tasks.length).toBeGreaterThan(100);
    for (const t of tasks) replayAccepted(t);
  }, 30_000);

  it('gold 计划每一步都在 candidates 内（oracle 前提，candidates 唯一过滤点）', () => {
    for (const t of makeSplit('val', 2, 13)) {
      let st = initState(t.x, t.spec);
      for (const op of t.plan_hidden) {
        expect(candidates(GRAPH, st, st.hist)).toContain(op);
        const next = applyOp(GRAPH, op, st);
        expect(next).not.toBeNull();
        st = next!;
      }
    }
  });
});

describe('gen/generator/makeTask', () => {
  it('split 指定时只返回该切分任务', () => {
    const t = makeTask(0, 'follow', undefined, 'heldout');
    expect(t).not.toBeNull();
    expect(t!.split).toBe('heldout');
    expect(HELDOUT_SKELETONS.has(t!.composition_id)).toBe(true);
  });

  it('skeleton 指定时 gold 即该骨架', () => {
    const sk: Skel = { root: 'Str', plan: ['upper', 'reverse', 'append_bang'] };
    const t = makeTask(0, 'goal', undefined, undefined, sk);
    expect(t).not.toBeNull();
    expect(t!.plan_hidden.slice(0, sk.plan.length)).toEqual([...sk.plan]);
  });
});

describe('gen/generator/makeSplit（配额制）', () => {
  it('每 (style, family) 恰 per_family 条', () => {
    const out = makeSplit('val', 2, 5);
    const counts = new Map<string, number>();
    for (const t of out) {
      const key = `${t.style}|${t.family}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.get('follow|value')).toBe(2);
    expect(counts.get('follow|verify')).toBe(2);
    expect(counts.get('goal|goal')).toBe(2);
    expect(counts.get('goal|goal_verify')).toBe(2);
    expect(out.length).toBe(8);
  });

  it('配额不足抛错，不静默降级', () => {
    expect(() => makeSplit('val', 99999, 0, 1)).toThrow(/quota .*unmet/);
  });
});

describe('gen/generator/makeCoverageSplit（可产域覆盖集）', () => {
  const heldout = SKELETONS.filter((sk) => splitOf(sk) === 'heldout');

  it('follow 域：全部 heldout 骨架 × {value, verify} 均可产（重试逐次推进 seed）', () => {
    for (const sk of heldout) {
      for (const fam of ['value', 'verify'] as const) {
        let ok = false;
        for (let attempt = 0; attempt < 10 && !ok; attempt++) {
          const t = instanceTask(makeRng(99 + attempt), sk.root, sk.plan, fam, 'follow');
          ok = t !== null && t.split === 'heldout';
        }
        expect(ok, `骨架 ${_skelId(sk)} follow/${fam}`).toBe(true);
      }
    }
  }, 60_000);

  it('goal 域：可产域抽样必产（重试推进 seed），且产出对同 seed 逐字确定', () => {
    // 覆盖声明的可判定论域 = heldout − 注册表；重试如用同一 seed 只是确定性空转，
    // 逐次推进 seed 才有重试语义。
    const sample = heldout
      .filter((sk) => !UNPRODUCIBLE_HELDOUT.has(coverageKey('goal', 'goal', _skelId(sk))))
      .slice(0, 24);
    let goalTasks = 0;
    for (const sk of sample) {
      for (const fam of ['goal', 'goal_verify'] as const) {
        let produced: { task: Task; seed: number } | null = null;
        for (let attempt = 0; attempt < 10 && produced === null; attempt++) {
          const seed = 99 + attempt;
          const t = instanceTask(makeRng(seed), sk.root, sk.plan, fam, 'goal');
          if (t !== null && t.split === 'heldout') produced = { task: t, seed };
        }
        expect(produced, `可产骨架 ${_skelId(sk)} goal/${fam} 未能在预算内产出`).not.toBeNull();
        goalTasks++;
        const again = instanceTask(makeRng(produced!.seed), sk.root, sk.plan, fam, 'goal');
        expect(JSON.stringify(again), `骨架 ${_skelId(sk)} goal/${fam} 同 seed 确定性`).toBe(
          JSON.stringify(produced!.task),
        );
      }
    }
    expect(goalTasks).toBe(sample.length * 2);
  }, 120_000);

  it('heldout 全量冒烟（固定 seed）：follow 全域 + goal 可产域每骨架每 (style,family) 恰 1 条、注册表命中计数、不抛错', () => {
    const info = makeCoverageSplitInfo('heldout', 0);
    expect(info.unproducibleCount).toBe(UNPRODUCIBLE_HELDOUT.size);
    expect(new Set(info.unproducible).size).toBe(info.unproducible.length);
    expect([...info.unproducible].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(
      [...UNPRODUCIBLE_HELDOUT].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    const counts = new Map<string, number>();
    for (const t of info.tasks) {
      const k = coverageKey(t.style, t.family, t.composition_id);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    for (const [k, n] of counts) expect(n, `${k} 重复覆盖`).toBe(1);
    const heldoutIds = new Set(heldout.map(_skelId));
    let producedGoalCombos = 0;
    for (const id of heldoutIds) {
      for (const fam of ['value', 'verify'] as const) {
        expect(counts.get(coverageKey('follow', fam, id)), `follow/${fam}/${id}`).toBe(1);
      }
      for (const fam of ['goal', 'goal_verify'] as const) {
        const knownUnproducible = UNPRODUCIBLE_HELDOUT.has(coverageKey('goal', fam, id));
        expect(counts.has(coverageKey('goal', fam, id)), `goal/${fam}/${id}`).toBe(!knownUnproducible);
        producedGoalCombos += knownUnproducible ? 0 : 1;
      }
    }
    expect(info.tasks.length).toBe(heldoutIds.size * 2 + producedGoalCombos);
    expect(makeCoverageSplit('heldout', 0).map(taskHash)).toEqual(info.tasks.map(taskHash));
  }, 120_000);

  it('fail-fast：可产域判定可产但 50 次重试仍产不出即抛错（注入论域外的结构性不可产骨架）', () => {
    // [reverse,reverse] 诱导恒等 → Str len 池下无「初始不达标∧终值达标」witness，
    // 但组成 id 不在注册表（论域只含 heldout 骨架）⇒ 按可产域处理，重试耗尽必抛。
    const idSkel: Skel = { root: 'Str', plan: ['reverse', 'reverse'] };
    const sp = splitOf(idSkel);
    expect(sp).not.toBe('heldout');
    expect(UNPRODUCIBLE_HELDOUT.has(coverageKey('goal', 'goal', _skelId(idSkel)))).toBe(false);
    expect(() => makeCoverageSplitInfo(sp, 0, [idSkel])).toThrow(/yields no task/);
  }, 120_000);
});


describe('gen/generator/STYLES 与 composition_id', () => {
  it('STYLES 映射 = follow→value/verify、goal→goal/goal_verify', () => {
    expect(STYLES).toEqual({
      follow: ['value', 'verify'],
      goal: ['goal', 'goal_verify'],
    });
  });

  it('composition_id = _skelId(root, skeleton)（与切分注册表同口径）', () => {
    // value 族 plan = 骨架 + submit，去掉收尾终算子即骨架本体。
    const t = makeTask(3, 'follow', 'value');
    expect(t).not.toBeNull();
    expect(t!.composition_id).toBe(_skelId({ root: t!.root, plan: t!.plan_hidden.slice(0, -1) }));
  });
});
