/**
 * 旁路写防护单测（对标 Python test_self_application.py GuardedStorage
 * 用例段）：演化资产集合直写/整集删除拦截、机制豁免上下文、知识动态
 * 前缀覆盖、checkpoint/事件日志等机制通道透传。
 */

import { describe, expect, it } from 'vitest';

import { EngineEvent } from '../../../src/core/events/events.js';
import { GraphDefinitionError } from '../../../src/core/errors.js';
import { GuardedStorage } from '../../../src/core/self_application/index.js';

import { MemStorage } from './helpers.js';

function _guarded(): { inner: MemStorage; guarded: GuardedStorage } {
  const inner = new MemStorage();
  return { inner, guarded: new GuardedStorage(inner) };
}

describe('GuardedStorage 直写拦截（fail-closed）', () => {
  it('演化资产集合直写拒绝；机制通道不受限', async () => {
    const { guarded } = _guarded();
    await expect(
      guarded.put_record('ui', 'boot.panel', { spec: {} }),
    ).rejects.toThrow(GraphDefinitionError);
    await expect(
      guarded.put_record('ui', 'boot.panel', { spec: {} }),
    ).rejects.toThrow(/旁路写拦截/);
    await guarded.put_record('ui_context', 'latest', { active_view: 'panel' });
    expect(await guarded.get_record('ui_context', 'latest')).toEqual({
      active_view: 'panel',
    });
  });

  it('整集删除与直写同规则拦截（最强旁路写 = delete_collection）', async () => {
    const { inner, guarded } = _guarded();
    await inner.put_record('ui', 'boot.panel', { spec: {} });
    await expect(guarded.delete_collection('ui')).rejects.toThrow(/旁路写拦截/);
    // 机制通道（非演化资产集合）整集删除照常放行
    const count = await guarded.delete_collection('llm_cache');
    expect(count).toBe(0);
  });

  it('守卫令牌匹配放行（机制侧自身写入），令牌不匹配拒绝', async () => {
    const inner = new MemStorage();
    const guarded = new GuardedStorage(inner, { guard_token: 'tok-1' });
    await expect(
      guarded.put_record('harness', 'forge', { name: 'forge' }),
    ).rejects.toThrow(/旁路写拦截/);
    await guarded.put_record('harness', 'forge', { name: 'forge' }, { guard_token: 'tok-1' });
    expect(await guarded.get_record('harness', 'forge')).toEqual({ name: 'forge' });
    await expect(
      guarded.delete_collection('set_audit', { guard_token: 'tok-2' }),
    ).rejects.toThrow(/旁路写拦截/);
  });
});

describe('GuardedStorage 机制豁免上下文', () => {
  it('显式豁免上下文内放行，退出后恢复拦截', async () => {
    const { guarded } = _guarded();
    // 无豁免 = 拦截
    await expect(
      guarded.put_record('event_types', 'thinking_start', { name: 'x' }),
    ).rejects.toThrow(/旁路写拦截/);
    const scope = guarded.allow_mechanism('event_types');
    scope.enter();
    try {
      await guarded.put_record('event_types', 'thinking_start', { name: 'x' });
    } finally {
      scope.exit();
    }
    await expect(
      guarded.put_record('event_types', 'tool_start', { name: 'y' }),
    ).rejects.toThrow(/旁路写拦截/);
    expect(await guarded.get_record('event_types', 'thinking_start')).toEqual({
      name: 'x',
    });
  });

  it('覆盖 harness 与 knowledge:<user> 前缀集合（前缀豁免放行，退出后恢复）', async () => {
    const { guarded } = _guarded();
    await expect(
      guarded.put_record('harness', 'forge', { name: 'forge' }),
    ).rejects.toThrow(/旁路写拦截/);
    await expect(
      guarded.put_record('knowledge:default', 'chain', { base: {} }),
    ).rejects.toThrow(/旁路写拦截/);
    const harnessScope = guarded.allow_mechanism('harness');
    harnessScope.enter();
    try {
      await guarded.put_record('harness', 'forge', { name: 'forge' });
    } finally {
      harnessScope.exit();
    }
    const fullScope = guarded.allow_mechanism();
    fullScope.enter();
    try {
      await guarded.put_record('knowledge:default', 'chain', { base: {} });
    } finally {
      fullScope.exit();
    }
    // 退出豁免后恢复拦截
    await expect(
      guarded.put_record('harness', 'other', { name: 'other' }),
    ).rejects.toThrow(/旁路写拦截/);
  });

  it('ENG1-20：knowledge:<user_id> 任意动态集合全守卫；近前缀不误伤', async () => {
    const { guarded } = _guarded();
    for (const userId of ['default', 'u-1', 'u-42']) {
      await expect(
        guarded.put_record(`knowledge:${userId}`, 'chain', { base: {} }),
      ).rejects.toThrow(/旁路写拦截/);
    }
    // 近前缀（非知识集）集合不受误伤
    await guarded.put_record('knowledge_frag', 'k', { v: 1 });
    expect(await guarded.get_record('knowledge_frag', 'k')).toEqual({ v: 1 });
  });
});

describe('GuardedStorage 透传（非演化资产直写路径）', () => {
  it('checkpoint/事件日志等 Storage 方法原样透传', async () => {
    const { guarded } = _guarded();
    const seq = await guarded.append_event('t1', new EngineEvent({ type: 'reply', payload: {} }));
    expect(seq).toBe(1);
    const events = await guarded.events_after('t1', 0);
    expect(events.length).toBe(1);
    expect(await guarded.latest_event_seq('t1')).toBe(1);
    // restore 为宿主运维通道（放行），其余透传方法保持接口形状
    expect(guarded.snapshot_capable).toBe(false);
  });

  it('守卫令牌 + 假存储后端不抛错（ENG1-7 存储协议不声明 guard_token 形参）', async () => {
    const { guarded } = _guarded();
    await expect(
      guarded.put_record('artifacts', 'a-1', { artifact_id: 'a-1' }, { guard_token: 'tok-x' }),
    ).rejects.toThrow(/旁路写拦截/);
  });
});
