/**
 * 生成侧守卫直测（R2-P0-1/2/3 新公开的三件套：isIdentity / goalEligible / hasShortcut）。
 *
 * isIdentity：恒等=全探针值不变的正/负直测，SKELETONS 不含恒等（构造层序：去冗余后
 * 恒等过滤）；原始枚举仍含恒等（过滤只发生在 SKELETONS 构造层）；goalEligible：正/负直测——长度不变类
 * Str 骨架对 len 目标判不适格，值单调下移类 Int 骨架对 parity/gt 判不适格；
 * hasShortcut：mod7 开头 x∈0..6 场景构造 + 收尾提交长度判定；instance_follow/
 * makeSplit/覆盖集的产物必须无单步捷径（极小性守卫落地自证）。
 */

import { describe, expect, it } from 'vitest';

import {
  enumerateSkeletons,
  goalEligible,
  hasShortcut,
  isIdentity,
  makeCoverageSplitInfo,
  makeSplit,
  makeTask,
  SKELETONS,
  _skelId,
  type Skel,
} from '../gen/generator.js';
import { GRAPH } from '../runner/graph.js';
import { _commit } from '../gen/producibility.js';
import { accept } from '../verify/acceptor.js';
import { initState, runPlan, verdictPass } from '../world/operators.js';
import { instanceFollow } from '../gen/generator.js';
import { makeRng } from '../world/rng.js';
import { hashObj } from '../world/hash.js';
import type { Family, Task } from '../schema.js';

/** 手工构造 follow 任务（与 instance_follow 同构：收尾经 _commit 派 spec），用于守卫直测。 */
function followTask(family: Family, skeleton: readonly string[], x: number | string): Task {
  const st = runPlan(skeleton, initState(x))!;
  const cs = _commit(family, skeleton, st.x as number | string)!;
  return {
    style: 'follow',
    family,
    instruction: '',
    x,
    spec: cs.spec,
    expected: st.x as number | string,
    plan_hidden: cs.plan,
    root: typeof x === 'string' ? 'Str' : 'Int',
    plan_hash: hashObj(cs.plan),
    composition_id: 'guards-manual',
    split: 'train',
  };
}

describe('gen/guards/isIdentity（R2-P0-3 恒等签名判定）', () => {
  it('正例：全探针值不变的骨架判恒等', () => {
    expect(isIdentity('Int', ['neg', 'neg'])).toBe(true);
    expect(isIdentity('Str', ['reverse', 'reverse'])).toBe(true);
    // 更长的偶数次自复合成同样是恒等函数（奇数次 [reverse×3] 等价单 reverse，非恒等）。
    expect(isIdentity('Int', ['neg', 'neg', 'neg', 'neg'])).toBe(true);
    expect(isIdentity('Str', ['reverse', 'reverse', 'reverse', 'reverse'])).toBe(true);
    expect(isIdentity('Str', ['reverse', 'reverse', 'reverse'])).toBe(false);
    expect(isIdentity('Int', ['neg', 'neg', 'neg'])).toBe(false);
  });

  it('负例：普通/近似恒等/域内循环都不算恒等', () => {
    // add3∘sub1 = x+2——计划 C.1 注释把它举例为恒等，与 B.2 变换表矛盾；判定式
    // （全探针值不变）为准，探针 x=10 → 12 ≠ 10 即假（该口径差异登记于
    // `experiment/DataGraphLab/README.md`「待决」节，等规划者复核后回写计划）。
    expect(isIdentity('Int', ['add3', 'sub1'])).toBe(false);
    expect(isIdentity('Int', ['sub1', 'add3'])).toBe(false);
    // mod7∘mod7 只在 [0,6] 上不变，探针 7 → 0 ≠ 7 即假。
    expect(isIdentity('Int', ['mod7', 'mod7'])).toBe(false);
    expect(isIdentity('Int', ['mul2'])).toBe(false);
    expect(isIdentity('Int', ['add3'])).toBe(false);
    expect(isIdentity('Str', ['upper'])).toBe(false);
    expect(isIdentity('Str', ['reverse'])).toBe(false); // 'ab'→'ba' 变值
  });

  it('恒等签名不入 SKELETONS，但原始枚举仍含恒等（恒等过滤只发生在 SKELETONS 构造层，去冗余后执行）', () => {
    expect(SKELETONS.some((sk) => isIdentity(sk.root, sk.plan))).toBe(false);
    const raw = enumerateSkeletons();
    expect(raw.some((sk) => sk.root === 'Int' && sk.plan.join(',') === 'neg,neg')).toBe(true);
    expect(raw.some((sk) => sk.root === 'Str' && sk.plan.join(',') === 'reverse,reverse')).toBe(true);
    expect(SKELETONS.some((sk) => sk.plan.join(',') === 'neg,neg')).toBe(false);
    expect(SKELETONS.some((sk) => sk.plan.join(',') === 'reverse,reverse')).toBe(false);
  });
});

describe('gen/guards/goalEligible（R2-P0-2 适格性直测）', () => {
  it('正例：能改变达标性的骨架适格', () => {
    expect(goalEligible('Int', ['add3'])).toBe(true); // gt0：x=-1 不达标 → 2 达标
    expect(goalEligible('Int', ['mul2'])).toBe(true); // parity0：奇数 → 偶数
    expect(goalEligible('Int', ['cond_even'])).toBe(true);
    expect(goalEligible('Str', ['append_bang'])).toBe(true); // len[2,5]：1→2
    expect(goalEligible('Str', ['reverse', 'append_bang'])).toBe(true);
    expect(goalEligible('Str', ['cond_long'])).toBe(true); // 短串 +'?' 改长度
  });

  it('负例：长度不变 Str 类与值单调/保 parity 的 Int 类不适格', () => {
    expect(goalEligible('Str', ['upper'])).toBe(false);
    expect(goalEligible('Str', ['lower'])).toBe(false);
    expect(goalEligible('Str', ['reverse'])).toBe(false);
    expect(goalEligible('Str', ['upper', 'reverse'])).toBe(false); // 组合仍长度不变
    expect(goalEligible('Str', ['upper', 'lower'])).toBe(false);
    expect(goalEligible('Str', ['str_len'])).toBe(false); // 终值 Int，len 目标类型失配
    expect(goalEligible('Str', ['append_bang', 'str_len'])).toBe(false); // str_len 收尾判负
    // 恒等（判定式直测）：无法改变达标性。
    expect(goalEligible('Int', ['neg', 'neg'])).toBe(false);
    // 值平移 -6：parity 保持、gt 只会变小 → Int 池无「初始不达标∧终值达标」对。
    expect(goalEligible('Int', ['neg', 'add3', 'add3', 'neg'])).toBe(false);
  });

  it('makeTask 对不适格骨架的目标族返回 null（适格池语义）', () => {
    const bad: Skel = { root: 'Str', plan: ['upper'] };
    for (const fam of ['goal', 'goal_verify'] as const) {
      expect(makeTask(0, 'goal', fam, undefined, bad)).toBeNull();
    }
    // 同一骨架走 follow 族不受适格池影响（goalEligible 只管 goal 域两族）。
    expect(makeTask(0, 'follow', 'value', undefined, bad)).not.toBeNull();
  });
});

describe('gen/guards/hasShortcut（R5 轨迹约束后按定义恒 false，保留为安全网）', () => {
  it('恒 false 自证：原 R2-P0-3 命中场景（mod7 恒等、删步、替换）现在全部不判捷径', () => {
    // R5：follow 验收要求 hist == spec.trace 精确匹配，任何"更短合法计划"自带不同
    // trace → 验收拒 → hasShortcut 按定义恒 false（保留代码作安全网，不再滤任务；
    // follow 可产域随之恢复 829 级）。下列断言即该语义的回归钉死。
    expect(hasShortcut(followTask('value', ['mod7', 'add3'], 3), GRAPH)).toBe(false);
    expect(hasShortcut(followTask('value', ['mod7'], 3), GRAPH)).toBe(false);
    expect(hasShortcut(followTask('verify', ['mod7', 'add3'], 3), GRAPH)).toBe(false);
    expect(hasShortcut(followTask('value', ['mod7', 'add3'], 10), GRAPH)).toBe(false);
    expect(hasShortcut(followTask('value', ['add3'], 0), GRAPH)).toBe(false);
    expect(hasShortcut(followTask('verify', ['add3', 'mul2'], 2), GRAPH)).toBe(false);
    expect(hasShortcut(followTask('value', ['add3', 'mod7', 'add3'], -1), GRAPH)).toBe(false);
    expect(hasShortcut(followTask('verify', ['add3', 'mod7', 'add3'], -1), GRAPH)).toBe(false);
    expect(hasShortcut(followTask('value', ['add3', 'add3'], 6), GRAPH)).toBe(false);
    expect(hasShortcut(followTask('value', ['add3'], 5), GRAPH)).toBe(false);
    expect(hasShortcut(followTask('value', ['add3', 'add3', 'add3'], 10), GRAPH)).toBe(false);
  });

  it('产出任务复评：instanceFollow/makeSplit/覆盖集的 follow 任务 hasShortcut 恒 false（安全网不误伤）', () => {
    const plans: ReadonlyArray<readonly string[]> = [
      ['mod7', 'add3'],
      ['mul2'],
      ['add3', 'sub1'], // ≠恒等（x+2），仍在池中
      ['neg', 'mod7', 'sub1'],
      ['cond_even', 'add3'],
    ];
    for (const plan of plans) {
      for (let seed = 0; seed < 8; seed++) {
        for (const family of ['value', 'verify'] as const) {
          const t = instanceFollow(makeRng(seed), 'Int', plan, family);
          if (t === null) continue;
          expect(hasShortcut(t, GRAPH), `${plan.join(',')} ${family} seed=${seed}`).toBe(false);
        }
      }
    }
    const info = makeCoverageSplitInfo('val', 0);
    expect(info.ineligibleCount).toBeGreaterThan(0);
    expect(info.tasks.length).toBeGreaterThan(0);
    for (const t of info.tasks) {
      if (t.style === 'follow') {
        expect(hasShortcut(t, GRAPH), `${t.style}/${t.family}`).toBe(false);
      }
    }
    for (const t of makeSplit('val', 2, 3)) {
      if (t.style === 'follow') expect(hasShortcut(t, GRAPH), t.family).toBe(false);
    }
  }, 180_000);
});

describe('gen/guards/R5 轨迹约束（follow 验收 = 终值 ∧ hist == spec.trace）', () => {
  it('follow 任务 spec 恒带公开 trace 且 == plan_hidden（含收尾终算子）', () => {
    for (const plan of [['mul2'], ['mod7', 'add3'], ['cond_even', 'add3']] as const) {
      for (const family of ['value', 'verify'] as const) {
        for (let seed = 0; seed < 4; seed++) {
          const t = instanceFollow(makeRng(seed), 'Int', plan, family);
          if (t === null) continue;
          expect(t.spec.trace, `${plan.join(',')} ${family} seed=${seed}`).toEqual(t.plan_hidden);
        }
      }
    }
  });

  it('金计划回放穿验收（hist == trace），轨迹不符必拒', () => {
    const t = followTask('value', ['mul2'], 4);
    expect(t.spec.trace).toEqual(['mul2', 'submit']);
    // 回放：hist == trace → 收
    expect(accept(t, runPlan(t.plan_hidden, initState(t.x, t.spec))!)).toBe(true);
    // 终值对但轨迹不符（恒等双负绕路 / 等价重排到同终值）→ 拒
    expect(accept(t, runPlan(['neg', 'neg', 'mul2', 'submit'], initState(t.x, t.spec))!)).toBe(false);
    expect(accept(t, runPlan(['add3', 'add3', 'sub1', 'sub1', 'submit'], initState(t.x, t.spec))!)).toBe(false);
    // 多走冗余步绕回 gold（加前缀）同样不符 → 拒
    expect(accept(t, runPlan(['neg', 'neg', ...t.plan_hidden], initState(t.x, t.spec))!)).toBe(false);
  });

  it('verify 族：值+指纹对但轨迹不符 → 拒；回放 → 收', () => {
    const t = followTask('verify', ['mul2'], 4);
    expect(t.spec.trace).toEqual(['mul2', 'submit', 'check_parity']);
    expect(accept(t, runPlan(t.plan_hidden, initState(t.x, t.spec))!)).toBe(true);
    const bypass = runPlan(['neg', 'neg', 'mul2', 'submit', 'check_parity'], initState(t.x, t.spec))!;
    expect(accept(t, bypass)).toBe(false);
  });

  it('goal 族不设轨迹约束：spec 无 trace、多解仍可接受', () => {
    const t = makeTask(7, 'goal', 'goal');
    expect(t).not.toBeNull();
    if (t === null) return;
    expect('trace' in t.spec).toBe(false);
    expect(accept(t, runPlan(t.plan_hidden, initState(t.x, t.spec))!)).toBe(true);
  });
});

describe('gen/guards/verdictPass 与采样链的端到端绑定', () => {
  it('makeTask 产出的两生产者族任务：金计划 replay 的 verdict 恰为 answer 指纹', () => {
    let checked = 0;
    for (const seed of [1, 2, 5, 13, 31]) {
      for (const [style, family] of [
        ['follow', 'verify'],
        ['goal', 'goal_verify'],
      ] as const) {
        const t = makeTask(seed, style, family);
        if (t === null) continue;
        const st = runPlan(t.plan_hidden, initState(t.x, t.spec))!;
        expect(st.verdict).toBe(verdictPass(st.answer));
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(8);
  });

  it('_skelId 对 root+plan 稳定（适格缓存与注册表共用的唯一指纹）', () => {
    const sk: Skel = { root: 'Int', plan: ['add3', 'mul2'] };
    expect(_skelId(sk)).toBe(_skelId({ root: 'Int', plan: ['add3', 'mul2'] }));
  });
});
