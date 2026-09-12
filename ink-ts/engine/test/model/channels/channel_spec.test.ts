/**
 * 通道条件数据面单测（channel_spec.ts：通道资产类型/校验/序列化）。
 *
 * 覆盖：
 * - 形态/提交契约词汇表（四形态 + 三契约，缺省契约 = full）；
 * - ChannelSpec 构造 + from/to_dict round-trip（含条件子集序列化最小化）；
 * - id 命名校验（长度/空白/控制字符）；
 * - from_dict 字段类型 fail-closed（label/observable/conditions 非 dict 拒绝；
 *   条件字段词表外经构造器拒绝）与条件归一（缺省补齐）；
 * - 条件校验 fail-closed：approval 词表、max_parallel 正整数、
 *   cost_pool_cap 非负、eligibility 非空字符串清单；
 * - 观测 flag 缺省开、可显式关。
 */

import { describe, expect, it } from 'vitest';

import {
  CHANNEL_COMMITS,
  CHANNEL_COMMIT_BEST,
  CHANNEL_COMMIT_DEFAULT,
  CHANNEL_COMMIT_FULL,
  CHANNEL_ID_MAX_LENGTH,
  CHANNEL_SHAPES,
  CHANNEL_SHAPE_DELEGATE,
  CHANNEL_SHAPE_FAN_IN,
  ChannelSpec,
  channel_with_disabled,
  default_channel_conditions,
} from '../../../src/model/channels/channel_spec.js';

describe('channel_spec 词汇表', () => {
  it('形态四值：委托/fan-out/fan-in/回传', () => {
    expect(CHANNEL_SHAPES).toEqual(['delegate', 'fan_out', 'fan_in', 'return']);
  });

  it('提交契约三值：全量/择优/仅决策；缺省 = 全量', () => {
    expect(CHANNEL_COMMITS).toEqual(['full', 'best', 'decision_only']);
    expect(CHANNEL_COMMIT_DEFAULT).toBe(CHANNEL_COMMIT_FULL);
  });

  it('缺省条件 = 无资格墙/无审批/无并行与成本上限', () => {
    expect(default_channel_conditions()).toEqual({
      eligibility: [],
      approval: null,
      max_parallel: null,
      cost_pool_cap: null,
    });
  });
});

describe('ChannelSpec 构造/序列化', () => {
  it('构造即取词表外形态/契约显式拒绝', () => {
    expect(
      () => new ChannelSpec({ id: 'c', shape: 'beam' as never }),
    ).toThrow(/形态非法/);
    expect(
      () => new ChannelSpec({ id: 'c', shape: CHANNEL_SHAPE_DELEGATE, commit: 'all' as never }),
    ).toThrow(/提交契约非法/);
  });

  it('缺省提交契约 = full；观测缺省开', () => {
    const spec = new ChannelSpec({ id: 'delegate', shape: CHANNEL_SHAPE_DELEGATE });
    expect(spec.commit).toBe(CHANNEL_COMMIT_FULL);
    expect(spec.observable).toBe(true);
    expect(spec.conditions).toEqual(default_channel_conditions());
  });

  it('to/from_dict round-trip 保持全字段', () => {
    const spec = new ChannelSpec({
      id: 'fan_out_coding',
      label: '编码并行',
      shape: 'fan_out',
      commit: CHANNEL_COMMIT_FULL,
      conditions: {
        eligibility: ['coder'],
        approval: 'L1',
        max_parallel: 3,
        cost_pool_cap: 100,
      },
      observable: false,
    });
    const restored = ChannelSpec.from_dict(spec.to_dict());
    expect(restored).toEqual(spec);
  });

  it('to_dict 只序列化非缺省维度（零漂移输出形状）', () => {
    const spec = new ChannelSpec({ id: 'plain', shape: CHANNEL_SHAPE_DELEGATE });
    expect(spec.to_dict()).toEqual({ id: 'plain', shape: 'delegate' });
  });

  it('id 命名校验：超长/空白/控制字符拒绝', () => {
    expect(() => new ChannelSpec({ id: 'x'.repeat(CHANNEL_ID_MAX_LENGTH + 1), shape: 'delegate' }))
      .toThrow(/超长/);
    expect(() => new ChannelSpec({ id: 'bad id', shape: 'delegate' })).toThrow(/空白或控制字符/);
    expect(() => new ChannelSpec({ id: 'ok_id', shape: 'delegate' })).not.toThrow();
  });

  it('from_dict 缺 id/shape/非 dict 拒绝', () => {
    expect(() => ChannelSpec.from_dict({ shape: 'delegate' })).toThrow(/缺 id/);
    expect(() => ChannelSpec.from_dict({ id: 'c' })).toThrow(/缺 shape/);
    expect(() => ChannelSpec.from_dict('c')).toThrow(/期望 dict/);
  });

  it('from_dict 对 label/observable/conditions 字段类型 fail-closed', () => {
    expect(() =>
      ChannelSpec.from_dict({ id: 'c', shape: 'delegate', label: 7 }),
    ).toThrow(/label 须为字符串/);
    expect(() =>
      ChannelSpec.from_dict({ id: 'c', shape: 'delegate', observable: 'yes' }),
    ).toThrow(/observable 须为 boolean/);
    expect(() =>
      ChannelSpec.from_dict({ id: 'c', shape: 'delegate', conditions: 'L1' }),
    ).toThrow(/conditions 须为 dict/);
    expect(() =>
      ChannelSpec.from_dict({ id: 'c', shape: 'delegate', conditions: null }),
    ).not.toThrow();
  });

  it('from_dict 携坏 shape/commit/条件字段词表外 = 经构造器拒绝', () => {
    expect(() => ChannelSpec.from_dict({ id: 'c', shape: 'teleport' })).toThrow(/形态非法/);
    expect(() =>
      ChannelSpec.from_dict({ id: 'c', shape: 'delegate', commit: 'partial' }),
    ).toThrow(/提交契约非法/);
    expect(() =>
      ChannelSpec.from_dict({ id: 'c', shape: 'delegate', conditions: { approval: 'L9' } }),
    ).toThrow(/approval 非法/);
  });

  it('from_dict 条件归一：缺省补齐 + 序列化子集最小化', () => {
    const spec = ChannelSpec.from_dict({
      id: 'c',
      shape: 'fan_in',
      conditions: { approval: 'L0', max_parallel: 2 },
    });
    expect(spec.conditions).toEqual({
      eligibility: [],
      approval: 'L0',
      max_parallel: 2,
      cost_pool_cap: null,
    });
    expect(spec.to_dict()).toEqual({
      id: 'c',
      shape: 'fan_in',
      conditions: { approval: 'L0', max_parallel: 2 },
    });
  });
});

describe('ChannelSpec 条件校验（fail-closed）', () => {
  it('approval 只收审批档词表（null = 不设）', () => {
    expect(
      () => new ChannelSpec({ id: 'c', shape: 'fan_in', conditions: { approval: 'L9' as never } }),
    ).toThrow(/approval 非法/);
    expect(
      new ChannelSpec({ id: 'c', shape: 'fan_in', conditions: { approval: 'L0' } }).conditions.approval,
    ).toBe('L0');
  });

  it('max_parallel 须为正整数', () => {
    expect(
      () => new ChannelSpec({ id: 'c', shape: 'fan_out', conditions: { max_parallel: 0 } }),
    ).toThrow(/max_parallel 须为正整数/);
    expect(
      () => new ChannelSpec({ id: 'c', shape: 'fan_out', conditions: { max_parallel: 2.5 } }),
    ).toThrow(/max_parallel 须为正整数/);
    expect(
      () => new ChannelSpec({ id: 'c', shape: 'fan_out', conditions: { max_parallel: 4 } }),
    ).not.toThrow();
  });

  it('cost_pool_cap 须为非负有限数', () => {
    expect(
      () => new ChannelSpec({ id: 'c', shape: 'fan_in', conditions: { cost_pool_cap: -1 } }),
    ).toThrow(/cost_pool_cap 须为非负数/);
    expect(
      () => new ChannelSpec({ id: 'c', shape: 'fan_in', conditions: { cost_pool_cap: 0 } }),
    ).not.toThrow();
  });

  it('eligibility 只收非空字符串 token 清单', () => {
    expect(
      () => new ChannelSpec({ id: 'c', shape: 'fan_in', conditions: { eligibility: [''] } }),
    ).toThrow(/eligibility/);
    expect(
      () => new ChannelSpec({ id: 'c', shape: 'fan_in', conditions: { eligibility: [1] as never } }),
    ).toThrow(/eligibility/);
  });

  it('回传/fan-in 形态与提交契约各自可取', () => {
    const ret = new ChannelSpec({ id: 'r', shape: 'return', commit: CHANNEL_COMMIT_FULL });
    expect(ret.shape).toBe('return');
    const fanIn = new ChannelSpec({ id: 'f', shape: CHANNEL_SHAPE_FAN_IN, commit: CHANNEL_COMMIT_BEST });
    expect(fanIn.commit).toBe(CHANNEL_COMMIT_BEST);
    expect(fanIn.observable).toBe(true);
  });
});

describe('ChannelSpec 封禁标记（disabled / 下架置位）', () => {
  it('disabled 缺省 false；to_dict 不序列化缺省（旧记录零漂移）', () => {
    const spec = new ChannelSpec({ id: 'c', shape: 'delegate' });
    expect(spec.disabled).toBe(false);
    expect(spec.to_dict()).toEqual({ id: 'c', shape: 'delegate' });
    const legacy = ChannelSpec.from_dict({ id: 'c', shape: 'delegate' });
    expect(legacy.disabled).toBe(false);
  });

  it('disabled=true 序列化 + from/to_dict round-trip 保持封禁态', () => {
    const spec = new ChannelSpec({ id: 'c', shape: 'delegate', disabled: true });
    expect(spec.to_dict()['disabled']).toBe(true);
    const restored = ChannelSpec.from_dict(spec.to_dict());
    expect(restored.disabled).toBe(true);
    expect(restored).toEqual(spec);
  });

  it('from_dict 对 disabled 类型 fail-closed', () => {
    expect(() =>
      ChannelSpec.from_dict({ id: 'c', shape: 'delegate', disabled: 'yes' }),
    ).toThrow(/disabled 须为 boolean/);
  });

  it('channel_with_disabled 只翻 disabled 保留其余字段（封/解封构造）', () => {
    const spec = new ChannelSpec({
      id: 'fan_out_coding',
      shape: 'fan_out',
      conditions: { max_parallel: 3 },
      observable: false,
    });
    const sealed = channel_with_disabled(spec, true);
    expect(sealed.disabled).toBe(true);
    expect(sealed.id).toBe('fan_out_coding');
    expect(sealed.shape).toBe('fan_out');
    expect(sealed.conditions.max_parallel).toBe(3);
    expect(sealed.observable).toBe(false);
    const reopened = channel_with_disabled(sealed, false);
    expect(reopened.disabled).toBe(false);
    expect(reopened.conditions.max_parallel).toBe(3);
  });
});
