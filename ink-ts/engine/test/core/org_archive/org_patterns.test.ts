/**
 * 组织模式派生单测（org_patterns.ts：轨迹 → 转场/链模式 + 键编解码）。
 *
 * 覆盖：
 * - 转场模式派生：hop 的 commit 缺省归一全量回传、fan_width 携带、空 hops = 无；
 * - 链模式派生：相邻 hop 对 → A→R→C（两跳连续）；0/1 跳无链；
 * - 作用域使用派生：入口 + 各跳目标去重保序、收尾作用域判定（含单作用域）；
 * - 键编解码：转场/链键稳定可逆 round-trip、便捷键（commit 缺省归一）、
 *   非法/词表外键解码 = null（键不承载第二套枚举）。
 */

import { describe, expect, it } from 'vitest';

import { CHANNEL_COMMIT_BEST, CHANNEL_COMMIT_FULL } from '../../../src/model/channels/channel_spec.js';
import {
  parse_execution_trail,
  type ExecutionTrail,
} from '../../../src/core/org_archive/execution_trail.js';
import {
  chain_key_of,
  chain_pattern_key,
  chains_of_trail,
  decode_chain_key,
  decode_transition_key,
  hop_commit,
  hop_fan_width,
  scope_usage_of_trail,
  transition_key_of,
  transition_pattern_key,
  transitions_of_trail,
} from '../../../src/core/org_archive/org_patterns.js';

/** 合法轨迹（解析后 hop commit 归一为 full/best 显式值）。 */
function trail_of(hops: unknown[], outcome = 'success'): ExecutionTrail {
  return parse_execution_trail({
    run_id: 'r',
    parent_run_id: null,
    entry_scope: 'main',
    hops,
    outcome,
  });
}

const coding = [
  { from: 'main', to: 'planner', shape: 'delegate' },
  { from: 'planner', to: 'coder', shape: 'fan_out', count: 3, commit: 'best' },
  { from: 'coder', to: 'critic', shape: 'fan_in', commit: 'best' },
];

describe('org_patterns 转场模式派生', () => {
  it('每条 hop 派生一条转场（commit 缺省归一 full，fan_width 携带）', () => {
    const patterns = transitions_of_trail(trail_of(coding));
    expect(patterns).toHaveLength(3);
    expect(patterns[0]).toEqual({
      from: 'main',
      to: 'planner',
      shape: 'delegate',
      commit: CHANNEL_COMMIT_FULL,
      fan_width: null,
    });
    expect(patterns[1]).toEqual({
      from: 'planner',
      to: 'coder',
      shape: 'fan_out',
      commit: CHANNEL_COMMIT_BEST,
      fan_width: 3,
    });
    expect(patterns[2]!.fan_width).toBeNull();
  });

  it('单作用域直答（空 hops）= 无转场观察', () => {
    expect(transitions_of_trail(trail_of([]))).toEqual([]);
  });

  it('hop_commit / hop_fan_width 归一缺省', () => {
    const trail = trail_of([{ from: 'main', to: 'planner', shape: 'delegate' }]);
    const hop = trail.hops[0]!;
    expect(hop_commit(hop)).toBe(CHANNEL_COMMIT_FULL);
    expect(hop_fan_width(hop)).toBeNull();
  });
});

describe('org_patterns 链模式派生', () => {
  it('相邻 hop 对 → 链 A→R→C', () => {
    const chains = chains_of_trail(trail_of(coding));
    expect(chains).toHaveLength(2);
    expect(chains[0]).toEqual({
      a: 'main',
      mid: 'planner',
      c: 'coder',
      shape1: 'delegate',
      commit1: CHANNEL_COMMIT_FULL,
      shape2: 'fan_out',
      commit2: CHANNEL_COMMIT_BEST,
    });
    expect(chains[1]!.a).toBe('planner');
    expect(chains[1]!.mid).toBe('coder');
    expect(chains[1]!.c).toBe('critic');
  });

  it('0/1 跳轨迹无链观察', () => {
    expect(chains_of_trail(trail_of([]))).toEqual([]);
    expect(chains_of_trail(trail_of([coding[0]]))).toEqual([]);
  });
});

describe('org_patterns 作用域使用派生', () => {
  it('入口 + 各跳目标去重保序，收尾 = 末跳目标', () => {
    const usage = scope_usage_of_trail(trail_of(coding));
    expect(usage.scopes).toEqual(['main', 'planner', 'coder', 'critic']);
    expect(usage.terminal).toBe('critic');
  });

  it('重复经过作用域只记一次（main 来回），收尾仍为末跳目标', () => {
    const usage = scope_usage_of_trail(
      trail_of([
        { from: 'main', to: 'planner', shape: 'delegate' },
        { from: 'planner', to: 'main', shape: 'return' },
      ]),
    );
    expect(usage.scopes).toEqual(['main', 'planner']);
    expect(usage.terminal).toBe('main');
  });

  it('单作用域直答：收尾 = 入口作用域', () => {
    const usage = scope_usage_of_trail(trail_of([]));
    expect(usage.scopes).toEqual(['main']);
    expect(usage.terminal).toBe('main');
  });
});

describe('org_patterns 键编解码', () => {
  it('转场键稳定可逆 round-trip', () => {
    const key = transition_pattern_key('main', 'planner', 'delegate', CHANNEL_COMMIT_FULL);
    expect(key).toBe(transition_pattern_key('main', 'planner', 'delegate', CHANNEL_COMMIT_FULL));
    expect(decode_transition_key(key)).toEqual({
      from: 'main',
      to: 'planner',
      shape: 'delegate',
      commit: CHANNEL_COMMIT_FULL,
    });
  });

  it('提交契约 full/best 是不同转场模式（键不同）', () => {
    const full = transition_pattern_key('main', 'planner', 'delegate', CHANNEL_COMMIT_FULL);
    const best = transition_pattern_key('main', 'planner', 'delegate', CHANNEL_COMMIT_BEST);
    expect(full).not.toBe(best);
    expect(decode_transition_key(best)!.commit).toBe(CHANNEL_COMMIT_BEST);
  });

  it('便捷键 commit 缺省归一 full，与显式 full 键一致', () => {
    const viaConvenience = transition_key_of({ from: 'main', to: 'planner', shape: 'delegate' });
    expect(viaConvenience).toBe(
      transition_key_of({ from: 'main', to: 'planner', shape: 'delegate', commit: CHANNEL_COMMIT_FULL }),
    );
  });

  it('链键稳定可逆 round-trip（含便捷键）', () => {
    const key = chain_pattern_key('main', 'planner', 'coder', 'delegate', 'full', 'fan_out', 'best');
    expect(key).toBe(chain_pattern_key('main', 'planner', 'coder', 'delegate', 'full', 'fan_out', 'best'));
    expect(decode_chain_key(key)).toEqual({
      a: 'main',
      mid: 'planner',
      c: 'coder',
      shape1: 'delegate',
      commit1: 'full',
      shape2: 'fan_out',
      commit2: 'best',
    });
    expect(chain_key_of({ a: 'main', mid: 'planner', c: 'coder', shape1: 'delegate', shape2: 'fan_out' }))
      .toBe(chain_pattern_key('main', 'planner', 'coder', 'delegate', 'full', 'fan_out', 'full'));
  });

  it('非 JSON/结构错位/词表外键解码 = null（键面不另立枚举）', () => {
    expect(decode_transition_key('garbage')).toBeNull();
    expect(decode_transition_key('["transition","main"]')).toBeNull();
    expect(decode_transition_key('["transition","main","planner","beam","full"]')).toBeNull();
    expect(decode_transition_key('["transition","main","planner","delegate","partial"]')).toBeNull();
    expect(decode_chain_key('["chain","a","b","c","delegate","full"]')).toBeNull();
    expect(decode_chain_key('["chain","a","b","c","delegate","full","beam","full"]')).toBeNull();
  });
});
