/**
 * 轨迹记录数据面单测（execution_trail.ts：执行树轨迹记录的解析/校验/序列化）。
 *
 * 覆盖：
 * - 词汇/常量：终态三值、commit 缺省 = 全量回传（与通道缺省契约同口径）；
 * - round-trip：parse ↔ trail_to_dict 全字段保持（父 id/成本/时刻/多跳），
 *   未知键忽略（前向兼容），缺省维度序列化不落键；
 * - 解析校验 fail-closed：run_id/作用域 id 形态（长度/空白/控制字符）、
 *   parent_run_id 类型、hops 非 list、hop 字段（from/to/词表外形态与契约/
 *   count 正整数/自环）、首跳起点 = 入口作用域、转场连续性、outcome 词表、
 *   cost 字段（dict/非负/整数口径）、ended_at_ms；
 * - validate_execution_trail 独立结构校验抛错。
 */

import { describe, expect, it } from 'vitest';

import {
  CHANNEL_COMMIT_BEST,
  CHANNEL_SHAPES,
} from '../../../src/model/channels/channel_spec.js';
import { GraphDefinitionError } from '../../../src/model/errors.js';
import {
  RUN_ID_MAX_LENGTH,
  TRAIL_OUTCOMES,
  parse_execution_trail,
  trail_to_dict,
  validate_execution_trail,
  validate_scope_ref,
  type ExecutionTrail,
  type TrailHop,
} from '../../../src/core/org_archive/execution_trail.js';

function hop(from: string, to: string, shape: string, extra: Partial<TrailHop> = {}): TrailHop {
  return { from, to, shape: shape as TrailHop['shape'], ...extra };
}

/** 合法轨迹（解析后 commit 缺省 = full 的规范化形态）。 */
function valid_trail(): Record<string, unknown> {
  return {
    run_id: 'run_1',
    parent_run_id: 'run_0',
    entry_scope: 'main',
    hops: [
      { from: 'main', to: 'planner', shape: 'delegate' },
      { from: 'planner', to: 'main', shape: 'return', commit: 'best' },
    ],
    outcome: 'success',
    cost: { steps: 4, cost: 2.5, tokens: 1200, ms: 300 },
    ended_at_ms: 1700000000000,
  };
}

describe('execution_trail 词汇与缺省', () => {
  it('终态三值 = success/failure/degraded', () => {
    expect(TRAIL_OUTCOMES).toEqual(['success', 'failure', 'degraded']);
  });

  it('hop 未显式 commit = 全量回传（序列化不落缺省，解析回填）', () => {
    const trail = parse_execution_trail({
      run_id: 'r',
      entry_scope: 'main',
      hops: [{ from: 'main', to: 'planner', shape: 'delegate' }],
      outcome: 'success',
    });
    expect(trail.hops[0]!.commit).toBe('full');
    const dict = trail_to_dict(trail);
    expect(dict['hops']).toEqual([{ from: 'main', to: 'planner', shape: 'delegate' }]);
  });
});

describe('execution_trail 解析/序列化 round-trip', () => {
  it('parse ↔ to_dict 全字段保持（父 id/成本/时刻/两跳）', () => {
    const parsed = parse_execution_trail(valid_trail());
    expect(parsed.run_id).toBe('run_1');
    expect(parsed.parent_run_id).toBe('run_0');
    expect(parsed.entry_scope).toBe('main');
    expect(parsed.hops).toHaveLength(2);
    expect(parsed.hops[1]!.commit).toBe(CHANNEL_COMMIT_BEST);
    expect(parsed.outcome).toBe('success');
    expect(parsed.cost).toEqual({ steps: 4, cost: 2.5, tokens: 1200, ms: 300 });
    expect(parsed.ended_at_ms).toBe(1700000000000);
    const restored = parse_execution_trail(trail_to_dict(parsed));
    expect(restored).toEqual(parsed);
  });

  it('单作用域直答（空 hops）+ 根执行（parent null）零漂移 round-trip', () => {
    const dict = { run_id: 'r', entry_scope: 'main', outcome: 'degraded' };
    const parsed = parse_execution_trail(dict);
    expect(parsed.hops).toEqual([]);
    expect(parsed.parent_run_id).toBeNull();
    expect(parsed.cost).toBeUndefined();
    expect(parsed.ended_at_ms).toBeUndefined();
    expect(trail_to_dict(parsed)).toEqual({
      run_id: 'r',
      entry_scope: 'main',
      hops: [],
      outcome: 'degraded',
    });
    expect(parse_execution_trail(trail_to_dict(parsed))).toEqual(parsed);
  });

  it('未知键忽略（前向兼容宿主扩展字段）', () => {
    const parsed = parse_execution_trail({ ...valid_trail(), future_flag: true, extra: { x: 1 } });
    expect(parsed.run_id).toBe('run_1');
  });
});

describe('execution_trail 解析校验（fail-closed）', () => {
  it('非 dict / 缺必需字段 / 终态词表外拒绝', () => {
    expect(() => parse_execution_trail('x')).toThrow(GraphDefinitionError);
    expect(() => parse_execution_trail({ entry_scope: 'main', outcome: 'success' })).toThrow(
      /run_id/,
    );
    expect(() => parse_execution_trail({ run_id: 'r', outcome: 'success' })).toThrow(
      /entry_scope/,
    );
    expect(() => parse_execution_trail({ run_id: 'r', entry_scope: 'main' })).toThrow(/outcome/);
    expect(() =>
      parse_execution_trail({ run_id: 'r', entry_scope: 'main', outcome: 'ok' }),
    ).toThrow(/outcome/);
  });

  it('run_id/作用域 id 形态：空白、超长、控制字符拒绝', () => {
    expect(() =>
      parse_execution_trail({ run_id: ' ', entry_scope: 'main', outcome: 'success' }),
    ).toThrow(/run_id/);
    expect(() =>
      parse_execution_trail({ run_id: 'r'.repeat(RUN_ID_MAX_LENGTH + 1), entry_scope: 'main', outcome: 'success' }),
    ).toThrow(/run_id/);
    expect(() =>
      parse_execution_trail({ run_id: 'r', entry_scope: 'bad scope', outcome: 'success' }),
    ).toThrow(/entry_scope/);
    expect(() =>
      parse_execution_trail({ run_id: 'r', entry_scope: 'main', outcome: 'success', hops: [{ from: 'main', to: 'bad\x01', shape: 'delegate' }] }),
    ).toThrow(/hops/);
  });

  it('parent_run_id 类型非法拒绝（数字）', () => {
    expect(() =>
      parse_execution_trail({ run_id: 'r', parent_run_id: 5, entry_scope: 'main', outcome: 'success' }),
    ).toThrow(/parent_run_id/);
  });

  it('hops 非 list / hop 非 dict / 缺 from-to / 自环拒绝', () => {
    const base = { run_id: 'r', entry_scope: 'main', outcome: 'success' };
    expect(() => parse_execution_trail({ ...base, hops: 'x' })).toThrow(/hops/);
    expect(() => parse_execution_trail({ ...base, hops: ['x'] })).toThrow(/hops\[0\]/);
    expect(() =>
      parse_execution_trail({ ...base, hops: [{ to: 'planner', shape: 'delegate' }] }),
    ).toThrow(/from/);
    expect(() =>
      parse_execution_trail({ ...base, hops: [{ from: 'main', shape: 'delegate' }] }),
    ).toThrow(/to/);
    expect(() =>
      parse_execution_trail({ ...base, hops: [{ from: 'main', to: 'main', shape: 'delegate' }] }),
    ).toThrow(/自环/);
  });

  it('hop 通道维度复用 Wave-1 词表：形态/契约词表外拒绝', () => {
    const base = { run_id: 'r', entry_scope: 'main', outcome: 'success' };
    expect(() =>
      parse_execution_trail({ ...base, hops: [{ from: 'main', to: 'p', shape: 'teleport' }] }),
    ).toThrow(/shape/);
    expect(() =>
      parse_execution_trail({ ...base, hops: [{ from: 'main', to: 'p', shape: 'delegate', commit: 'partial' }] }),
    ).toThrow(/commit/);
    // 词表本身与通道数据面同源（非第二套枚举）
    expect(CHANNEL_SHAPES).toContain('delegate');
  });

  it('hop count 须为正整数（0/负数/小数拒绝）', () => {
    const base = { run_id: 'r', entry_scope: 'main', outcome: 'success' };
    for (const count of [0, -1, 2.5]) {
      expect(() =>
        parse_execution_trail({
          ...base,
          hops: [{ from: 'main', to: 'coder', shape: 'fan_out', count }],
        }),
      ).toThrow(/count/);
    }
    expect(
      parse_execution_trail({
        ...base,
        hops: [{ from: 'main', to: 'coder', shape: 'fan_out', count: 3 }],
      }).hops[0]!.count,
    ).toBe(3);
  });

  it('首跳起点须为入口作用域', () => {
    expect(() =>
      parse_execution_trail({
        run_id: 'r',
        entry_scope: 'main',
        hops: [{ from: 'planner', to: 'coder', shape: 'delegate' }],
        outcome: 'success',
      }),
    ).toThrow(/首跳起点须为入口作用域/);
  });

  it('转场须连续（后一跳起点 = 前一跳目标）', () => {
    expect(() =>
      parse_execution_trail({
        run_id: 'r',
        entry_scope: 'main',
        hops: [
          { from: 'main', to: 'planner', shape: 'delegate' },
          { from: 'coder', to: 'main', shape: 'return' },
        ],
        outcome: 'success',
      }),
    ).toThrow(/转场断链/);
  });

  it('cost 字段校验：非 dict / 负值 / 小数 steps/tokens 拒绝', () => {
    const base = { run_id: 'r', entry_scope: 'main', outcome: 'success' };
    expect(() => parse_execution_trail({ ...base, cost: 'x' })).toThrow(/cost/);
    expect(() => parse_execution_trail({ ...base, cost: { cost: -1 } })).toThrow(/cost.cost/);
    expect(() => parse_execution_trail({ ...base, cost: { steps: 1.5 } })).toThrow(/steps/);
    expect(() => parse_execution_trail({ ...base, cost: { tokens: '10' } })).toThrow(/tokens/);
    expect(() => parse_execution_trail({ ...base, cost: { ms: -3 } })).toThrow(/ms/);
  });

  it('ended_at_ms 非法拒绝', () => {
    expect(() =>
      parse_execution_trail({ run_id: 'r', entry_scope: 'main', outcome: 'success', ended_at_ms: -1 }),
    ).toThrow(/ended_at_ms/);
  });

  it('validate_execution_trail 对构造对象的自环/断链显式抛错', () => {
    const ok: ExecutionTrail = {
      run_id: 'r',
      parent_run_id: null,
      entry_scope: 'main',
      hops: [hop('main', 'planner', 'delegate')],
      outcome: 'success',
    };
    expect(() => validate_execution_trail(ok)).not.toThrow();
    const selfLoop: ExecutionTrail = {
      ...ok,
      hops: [hop('main', 'main', 'delegate')],
    };
    expect(() => validate_execution_trail(selfLoop)).toThrow(/自环/);
    const broken: ExecutionTrail = {
      ...ok,
      hops: [hop('main', 'planner', 'delegate'), hop('critic', 'main', 'return')],
    };
    expect(() => validate_execution_trail(broken)).toThrow(/转场断链/);
  });

  it('validate_scope_ref 拒绝空白与超长作用域引用', () => {
    expect(() => validate_scope_ref('planner')).not.toThrow();
    expect(() => validate_scope_ref('bad id')).toThrow(GraphDefinitionError);
    expect(() => validate_scope_ref('x'.repeat(49))).toThrow(GraphDefinitionError);
  });
});
