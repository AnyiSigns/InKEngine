/**
 * 通道资产目录单测（channel_directory.ts：注册容器 + 出厂典型素材）。
 *
 * 覆盖：
 * - 注册/查询/废弃/替换门禁（重复/未注册/配额）；
 * - 出厂典型素材覆盖四形态、词表内契约、各自条件合理；
 * - 素材每次调用返回新鲜数据。
 */

import { describe, expect, it } from 'vitest';

import {
  CHANNEL_COMMIT_FULL,
  CHANNEL_SHAPES,
  ChannelSpec,
} from '../../../src/model/channels/channel_spec.js';
import {
  CHANNELS_COLLECTION_PREFIX,
  ChannelDirectory,
  channel_collection,
  channel_directory_from_rows,
  channel_directory_snapshot,
  default_channel_seeds,
} from '../../../src/model/channels/channel_directory.js';

function spec(id = 'delegate'): ChannelSpec {
  return new ChannelSpec({ id, shape: 'delegate' });
}

describe('ChannelDirectory 注册门禁', () => {
  it('register/get/names/specs 按注册序稳定', () => {
    const dir = new ChannelDirectory();
    dir.register(spec('a'));
    dir.register(spec('b'));
    expect(dir.get('a')?.id).toBe('a');
    expect(dir.get('missing')).toBeNull();
    expect(dir.names()).toEqual(['a', 'b']);
    expect(dir.specs()).toHaveLength(2);
  });

  it('重复注册 / unregister 未注册 / replace 未注册 = 显式拒绝', () => {
    const dir = new ChannelDirectory();
    dir.register(spec('a'));
    expect(() => dir.register(spec('a'))).toThrow(/重复注册/);
    expect(() => dir.unregister('b')).toThrow(/未注册/);
    dir.unregister('a');
    expect(dir.get('a')).toBeNull();
    expect(() => dir.replace(spec('b'))).toThrow(/演化不代创建/);
    dir.register(spec('a'));
    dir.replace(new ChannelSpec({ id: 'a', shape: 'fan_out' }));
    expect(dir.get('a')?.shape).toBe('fan_out');
  });

  it('配额超限拒绝', () => {
    const dir = new ChannelDirectory({ maxChannels: 1 });
    dir.register(spec('a'));
    expect(() => dir.register(spec('b'))).toThrow(/配额上限/);
  });
});

describe('ChannelDirectory 出厂典型素材', () => {
  it('覆盖四形态且契约词表内', () => {
    const seeds = default_channel_seeds();
    const shapes = seeds.map((s) => s.shape);
    for (const shape of CHANNEL_SHAPES) expect(shapes).toContain(shape);
    for (const seed of seeds) expect(seed.commit).toBeTruthy();
    expect(seeds.find((s) => s.id === 'return')?.commit).toBe(CHANNEL_COMMIT_FULL);
  });

  it('每次调用返回新鲜数据（防就地改写污染素材）', () => {
    const a = default_channel_seeds();
    const b = default_channel_seeds();
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
  });

  it('典型素材可入目录（受控注册容器消费面）', () => {
    const dir = new ChannelDirectory();
    for (const seed of default_channel_seeds()) dir.register(seed);
    expect(dir.names().sort()).toEqual(['delegate', 'fan_in', 'fan_out', 'return']);
  });
});

describe('ChannelDirectory 封禁（seal/unseal）', () => {
  it('seal 把启用通道置位 disabled；未注册/已封禁显式拒绝', () => {
    const dir = new ChannelDirectory();
    dir.register(spec('a'));
    expect(dir.get('a')?.disabled).toBe(false);
    dir.seal('a');
    expect(dir.get('a')?.disabled).toBe(true);
    expect(() => dir.seal('a')).toThrow(/已封禁/);
    expect(() => dir.seal('missing')).toThrow(/未注册/);
  });

  it('unseal 重开封禁通道；未注册/未封禁显式拒绝', () => {
    const dir = new ChannelDirectory();
    dir.register(spec('a'));
    expect(() => dir.unseal('a')).toThrow(/未封禁/);
    dir.seal('a');
    dir.unseal('a');
    expect(dir.get('a')?.disabled).toBe(false);
  });

  it('seal 只改 disabled 不动条件/契约（封禁是声明置位非删除）', () => {
    const dir = new ChannelDirectory();
    dir.register(new ChannelSpec({ id: 'a', shape: 'fan_out', conditions: { max_parallel: 4 } }));
    dir.seal('a');
    const sealed = dir.get('a')!;
    expect(sealed.disabled).toBe(true);
    expect(sealed.conditions.max_parallel).toBe(4);
  });
});

describe('ChannelDirectory 集合命名与持久化 codec', () => {
  it('channel_collection 按集隔离（缺省集 = -）', () => {
    expect(CHANNELS_COLLECTION_PREFIX).toBe('channels:');
    expect(channel_collection()).toBe('channels:-');
    expect(channel_collection('host')).toBe('channels:host');
  });

  it('快照/重建 round-trip：含封禁态与条件字段完整保持', () => {
    const dir = new ChannelDirectory();
    dir.register(new ChannelSpec({ id: 'delegate', shape: 'delegate' }));
    dir.register(
      new ChannelSpec({
        id: 'fan_out_coding',
        shape: 'fan_out',
        conditions: { max_parallel: 3, approval: 'L1' },
      }),
    );
    dir.seal('fan_out_coding');
    const restored = channel_directory_from_rows(channel_directory_snapshot(dir));
    expect(restored.names().sort()).toEqual(['delegate', 'fan_out_coding']);
    expect(restored.get('fan_out_coding')?.disabled).toBe(true);
    expect(restored.get('fan_out_coding')?.conditions.max_parallel).toBe(3);
    expect(restored.get('delegate')?.disabled).toBe(false);
  });

  it('重建对重复行幂等（重复 id 跳过）', () => {
    const rows = [
      { id: 'a', shape: 'delegate' },
      { id: 'a', shape: 'fan_out' },
    ];
    const dir = channel_directory_from_rows(rows);
    expect(dir.names()).toEqual(['a']);
    expect(dir.get('a')?.shape).toBe('delegate');
  });
});
