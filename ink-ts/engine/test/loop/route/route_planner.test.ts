/**
 * 路由规划测试（route_planner.ts：决策 + 目录状态 → 计划/拒绝原因）。
 *
 * 测什么：
 * - delegate（kind=scope 走缺省 delegate 通道；channel 显式委托）：计划带目标
 *   作用域/契约/1 路；
 * - fan_out：count 必填、count 通过；fan_in：计划带归并目标；return：父在场判定
 *   （根执行 return = 拒绝）；converge/sink：收口计划；
 * - 拒绝原因词表：通道未注册/通道封禁/通道形态不匹配（delegate 期望）/目标作用域
 *   未注册/目录与临时目标并存（scope_and_temp）/临时定义非法/count 非法；
 * - 临时作用域目标不经目录校验（现场定义即通过结构校验）。
 */
import { describe, expect, it } from 'vitest';

import { ChannelDirectory, default_channel_seeds } from '../../../src/model/channels/channel_directory.js';
import { ChannelSpec } from '../../../src/model/channels/channel_spec.js';
import {
  CHANNEL_SHAPE_DELEGATE,
  CHANNEL_SHAPE_FAN_OUT,
} from '../../../src/model/channels/channel_spec.js';
import {
  plan_routing,
  route_blocked,
  route_ok,
} from '../../../src/loop/route/route_planner.js';

function dir(ids: string[]): { has_scope(id: string): boolean } {
  const set = new Set(ids);
  return { has_scope: (id) => set.has(id) };
}

function channels(rows: ChannelSpec[]): ChannelDirectory {
  const d = new ChannelDirectory();
  for (const spec of rows) d.register(spec);
  return d;
}

const dflt = () => channels(default_channel_seeds());

const baseOpts = {
  currentScope: 'main',
  hasParent: false,
  directory: dir(['main', 'planner', 'coder', 'collaborator', 'subagent', 'critic']),
  channels: dflt(),
};

describe('delegate（1→1 委托）', () => {
  it('kind=scope：缺省走 delegate 通道 → delegate 计划（target/契约/full）', () => {
    const plan = plan_routing({ kind: 'scope', target: 'planner' }, baseOpts);
    expect(route_ok(plan)).toBe(true);
    if (!route_ok(plan)) return;
    expect(plan.kind).toBe('delegate');
    expect(plan.channel_id).toBe('delegate');
    expect(plan.shape).toBe('delegate');
    expect(plan.target_scope).toBe('planner');
    expect(plan.contract).toBe('full');
    expect(plan.count).toBe(1);
  });

  it('kind=channel + delegate：显式委托通道', () => {
    const plan = plan_routing({ kind: 'channel', channel: 'delegate', target: 'subagent', contract: 'full' }, baseOpts);
    expect(route_ok(plan)).toBe(true);
    if (!route_ok(plan)) return;
    expect(plan.kind).toBe('delegate');
    expect(plan.target_scope).toBe('subagent');
  });

  it('delegate count≠1 = 拒绝（1→1 语义）', () => {
    const result = plan_routing({ kind: 'scope', target: 'planner', count: 2 }, baseOpts);
    expect(route_blocked(result)).toBe(true);
    if (route_blocked(result)) expect(result.reason).toBe('delegate_count_must_be_one');
  });

  it('目标作用域未注册 = 拒绝（scope_unknown）', () => {
    const result = plan_routing({ kind: 'scope', target: 'ghost' }, baseOpts);
    expect(route_blocked(result)).toBe(true);
    if (route_blocked(result)) expect(result.reason).toBe('scope_unknown');
  });

  it('目标作用域缺省 = 拒绝（no_target）；临时作用域现场定义可作目标', () => {
    const result = plan_routing({ kind: 'scope' } as never, baseOpts);
    expect(route_blocked(result)).toBe(true);
    const tempPlan = plan_routing({ kind: 'scope', temp_scope: { role: 'subagent', persona: '临时' } }, baseOpts);
    expect(route_ok(tempPlan)).toBe(true);
  });
});

describe('通道结构校验（在册/封禁/形态匹配）', () => {
  it('通道未注册 / 通道已封禁 = 拒绝', () => {
    const missing = plan_routing({ kind: 'channel', channel: 'nope', target: 'planner' }, baseOpts);
    expect(route_blocked(missing)).toBe(true);
    if (route_blocked(missing)) expect(missing.reason).toBe('channel_unknown');

    const sealed = channels([new ChannelSpec({ id: 'sealed_delegate', shape: CHANNEL_SHAPE_DELEGATE, disabled: true })]);
    const blocked = plan_routing({ kind: 'channel', channel: 'sealed_delegate', target: 'planner' }, {
      ...baseOpts,
      channels: sealed,
    });
    expect(route_blocked(blocked)).toBe(true);
    if (route_blocked(blocked)) expect(blocked.reason).toBe('channel_disabled');
  });

  it('kind=scope 引用非 delegate 形态通道 = 拒绝（shape_mismatch）', () => {
    const fanChannels = channels([new ChannelSpec({ id: 'fan_out', shape: CHANNEL_SHAPE_FAN_OUT })]);
    const result = plan_routing({ kind: 'scope', target: 'planner', channel: 'fan_out' }, {
      ...baseOpts,
      channels: fanChannels,
    });
    expect(route_blocked(result)).toBe(true);
    if (route_blocked(result)) expect(result.reason).toBe('channel_shape_mismatch');
  });
});

describe('fan_out / fan_in / return / 收口', () => {
  it('fan_out：count 必填；声明通过（并行路数随计划携带）', () => {
    const noCount = plan_routing({ kind: 'channel', channel: 'fan_out', target: 'coder' }, baseOpts);
    expect(route_blocked(noCount)).toBe(true);
    if (route_blocked(noCount)) expect(noCount.reason).toBe('fan_out_count_required');

    const plan = plan_routing({ kind: 'channel', channel: 'fan_out', target: 'collaborator', count: 3 }, baseOpts);
    expect(route_ok(plan)).toBe(true);
    if (route_ok(plan)) {
      expect(plan.kind).toBe('fan_out');
      expect(plan.count).toBe(3);
    }
  });

  it('fan_in：N→1 归并计划带目标作用域', () => {
    const plan = plan_routing({ kind: 'channel', channel: 'fan_in', target: 'critic', count: 3 }, baseOpts);
    expect(route_ok(plan)).toBe(true);
    if (route_ok(plan)) {
      expect(plan.kind).toBe('fan_in');
      expect(plan.target_scope).toBe('critic');
    }
  });

  it('return：父在场判定（根执行 return = 拒绝）', () => {
    const root = plan_routing({ kind: 'channel', channel: 'return', target: 'main' }, baseOpts);
    expect(route_blocked(root)).toBe(true);
    if (route_blocked(root)) expect(root.reason).toBe('return_without_parent');
    const child = plan_routing({ kind: 'channel', channel: 'return', target: 'main' }, { ...baseOpts, hasParent: true });
    expect(route_ok(child)).toBe(true);
  });

  it('converge / sink：收口计划（无通道/目标/并行）', () => {
    for (const kind of ['converge', 'sink'] as const) {
      const plan = plan_routing({ kind }, baseOpts);
      expect(route_ok(plan)).toBe(true);
      if (route_ok(plan)) {
        expect(plan.kind).toBe(kind);
        expect(plan.channel_id).toBe('');
        expect(plan.target_scope).toBeNull();
      }
    }
  });

  it('临时作用域定义非法 = 拒绝（temp_scope_invalid）', () => {
    const result = plan_routing({ kind: 'channel', channel: 'fan_out', temp_scope: { role: '' }, count: 2 }, baseOpts);
    expect(route_blocked(result)).toBe(true);
    if (route_blocked(result)) expect(result.reason).toBe('temp_scope_invalid');
  });

  it('目录引用与现场定义并存 = 拒绝（scope_and_temp，二选一语义未定）', () => {
    const result = plan_routing(
      { kind: 'channel', channel: 'fan_out', target: 'planner', count: 2, temp_scope: { role: 'x' } },
      baseOpts,
    );
    expect(route_blocked(result)).toBe(true);
    if (route_blocked(result)) expect(result.reason).toBe('scope_and_temp');
  });
});
