/**
 * 默认组织先验素材单测（scope_priors.ts：起点路线素材 + 结构校验）。
 *
 * 覆盖：
 * - 出厂四条路线素材的结构/触发标签/终态 sink；
 * - validate_scope_prior 的 fail-closed：形态词表、首跳入口、sink 非末跳、
 *   末跳非 sink（缺收口）、sink 未回到入口、转场断链、自环、count 取值、
 *   commit 词表；
 * - dict 反序列化 round-trip（scope_prior_from_dict）。
 */

import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/model/errors.js';
import {
  SCOPE_PRIOR_SINK,
  default_scope_priors,
  scope_prior_from_dict,
  validate_scope_prior,
  type ScopePriorPattern,
} from '../../../src/model/scopes/scope_priors.js';
import { CHANNEL_SHAPE_DELEGATE, CHANNEL_COMMIT_FULL } from '../../../src/model/channels/channel_spec.js';

function pattern_over(over: Partial<ScopePriorPattern>): ScopePriorPattern {
  return {
    id: 't',
    label: '测试先验',
    entry_scope: 'main',
    trigger_kinds: ['casual'],
    hops: [{ from: 'main', shape: SCOPE_PRIOR_SINK }],
    ...over,
  };
}

describe('scope_priors 出厂素材', () => {
  it('四条起点路线存在且结构合法', () => {
    const priors = default_scope_priors();
    expect(priors.map((p) => p.id).sort()).toEqual(
      ['casual', 'coding', 'delegation', 'multi_opinion'].sort(),
    );
    for (const prior of priors) {
      expect(() => validate_scope_prior(prior)).not.toThrow();
      // 末跳必为 sink（首跳起点 = main 入口）
      expect(prior.hops[prior.hops.length - 1]!.shape).toBe(SCOPE_PRIOR_SINK);
      expect(prior.hops[0]!.from).toBe(prior.entry_scope);
    }
  });

  it('casual = 主持人直答短路（仅 sink 一跳）', () => {
    const casual = default_scope_priors().find((p) => p.id === 'casual')!;
    expect(casual.hops).toEqual([{ from: 'main', shape: SCOPE_PRIOR_SINK }]);
  });

  it('coding = main→planner→coder×N→critic→main→收（引用出厂目录行）', () => {
    const coding = default_scope_priors().find((p) => p.id === 'coding')!;
    const hops = coding.hops;
    expect(hops[0]).toMatchObject({ from: 'main', shape: 'delegate', to: 'planner' });
    expect(hops[1]).toMatchObject({ from: 'planner', shape: 'fan_out', to: 'coder' });
    expect(hops[1]!.count).toBeGreaterThanOrEqual(1);
    expect(hops[2]).toMatchObject({ from: 'coder', shape: 'fan_in', to: 'critic' });
    expect(hops[3]).toMatchObject({ from: 'critic', shape: 'return', to: 'main' });
  });

  it('coding 分片归并端走 full（全量并入 critic，非候选择优）', () => {
    const coding = default_scope_priors().find((p) => p.id === 'coding')!;
    expect(coding.hops[1]!.commit).toBe(CHANNEL_COMMIT_FULL);
    expect(coding.hops[2]!.commit).toBe(CHANNEL_COMMIT_FULL);
  });

  it('multi_opinion 意见全收（fan-in 归并端 full，主持人裁决）', () => {
    const multi = default_scope_priors().find((p) => p.id === 'multi_opinion')!;
    expect(multi.hops[0]!.commit).toBe(CHANNEL_COMMIT_FULL);
    expect(multi.hops[1]!.commit).toBe(CHANNEL_COMMIT_FULL);
  });

  it('delegation 走子代理委托 → 回传（delegate/return 成对）', () => {
    const delegation = default_scope_priors().find((p) => p.id === 'delegation')!;
    expect(delegation.hops[0]).toMatchObject({ shape: CHANNEL_SHAPE_DELEGATE, to: 'subagent' });
    expect(delegation.hops[1]).toMatchObject({ from: 'subagent', shape: 'return', to: 'main' });
  });

  it('每次调用返回新鲜数据（防就地改写污染素材）', () => {
    const a = default_scope_priors();
    const b = default_scope_priors();
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
  });
});

describe('scope_priors 结构校验（fail-closed）', () => {
  it('sink 出现于非末跳 = 拒绝', () => {
    expect(() =>
      validate_scope_prior(
        pattern_over({
          hops: [
            { from: 'main', shape: SCOPE_PRIOR_SINK },
            { from: 'planner', shape: 'delegate', to: 'coder' },
          ],
        }),
      ),
    ).toThrow(/sink 必须为末跳/);
  });

  it('sink 带目标作用域 = 拒绝', () => {
    expect(() =>
      validate_scope_prior(
        pattern_over({
          hops: [{ from: 'main', shape: SCOPE_PRIOR_SINK, to: 'planner' }],
        }),
      ),
    ).toThrow(/不得带目标作用域/);
  });

  it('形态词表外 hop / 自环 / count 非法 / commit 词表外 = 拒绝', () => {
    expect(() =>
      validate_scope_prior(
        pattern_over({
          hops: [
            { from: 'main', shape: 'teleport' as never, to: 'planner' },
            { from: 'planner', shape: SCOPE_PRIOR_SINK },
          ],
        }),
      ),
    ).toThrow(/形态非法/);
    expect(() =>
      validate_scope_prior(
        pattern_over({
          hops: [
            { from: 'main', shape: 'delegate', to: 'main' },
            { from: 'main', shape: SCOPE_PRIOR_SINK },
          ],
        }),
      ),
    ).toThrow(/自环/);
    expect(() =>
      validate_scope_prior(
        pattern_over({
          hops: [
            { from: 'main', shape: 'fan_out', to: 'planner', count: 0 },
            { from: 'planner', shape: SCOPE_PRIOR_SINK },
          ],
        }),
      ),
    ).toThrow(/count 须为正整数/);
    expect(() =>
      validate_scope_prior(
        pattern_over({
          hops: [
            { from: 'main', shape: 'fan_out', to: 'planner', commit: 'partial' as never },
            { from: 'planner', shape: SCOPE_PRIOR_SINK },
          ],
        }),
      ),
    ).toThrow(/提交契约非法/);
  });

  it('首跳起点与入口作用域不一致 = 拒绝', () => {
    expect(() =>
      validate_scope_prior(
        pattern_over({
          hops: [
            { from: 'planner', shape: 'delegate', to: 'coder' },
            { from: 'coder', shape: SCOPE_PRIOR_SINK },
          ],
        }),
      ),
    ).toThrow(/首跳起点须为入口作用域/);
  });

  it('空转场序列 = 拒绝', () => {
    expect(() => validate_scope_prior(pattern_over({ hops: [] }))).toThrow(/缺转场序列/);
  });

  it('末跳非 sink（缺收口）= 拒绝', () => {
    expect(() =>
      validate_scope_prior(
        pattern_over({
          hops: [
            { from: 'main', shape: 'delegate', to: 'planner' },
            { from: 'planner', shape: 'return', to: 'main' },
          ],
        }),
      ),
    ).toThrow(/末跳须为 sink/);
  });

  it('sink 未回到入口作用域收口 = 拒绝', () => {
    expect(() =>
      validate_scope_prior(
        pattern_over({
          hops: [
            { from: 'main', shape: 'delegate', to: 'planner' },
            { from: 'planner', shape: SCOPE_PRIOR_SINK },
          ],
        }),
      ),
    ).toThrow(/sink 起点须回到入口作用域/);
  });

  it('转场断链（前跳目标 ≠ 后跳起点）= 拒绝', () => {
    expect(() =>
      validate_scope_prior(
        pattern_over({
          hops: [
            { from: 'main', shape: 'delegate', to: 'planner' },
            { from: 'coder', shape: 'fan_in', to: 'critic' },
            { from: 'critic', shape: 'return', to: 'main' },
            { from: 'main', shape: SCOPE_PRIOR_SINK },
          ],
        }),
      ),
    ).toThrow(/转场断链/);
  });
});

describe('scope_priors dict 反序列化', () => {
  it('round-trip 保持模式结构', () => {
    const prior = default_scope_priors().find((p) => p.id === 'multi_opinion')!;
    const restored = scope_prior_from_dict(JSON.parse(JSON.stringify(prior)));
    expect(restored).toEqual(prior);
  });

  it('非法 dict（缺 id/entry/hops/坏 hop）显式拒绝', () => {
    expect(() => scope_prior_from_dict({ entry_scope: 'main' })).toThrow(/缺 id/);
    expect(() =>
      scope_prior_from_dict({ id: 'x', entry_scope: 'main', hops: [] }),
    ).toThrow(GraphDefinitionError);
    expect(() =>
      scope_prior_from_dict({
        id: 'x',
        entry_scope: 'main',
        hops: [{ from: 'main', shape: 'delegate' }],
      }),
    ).toThrow(/缺目标作用域/);
  });
});
