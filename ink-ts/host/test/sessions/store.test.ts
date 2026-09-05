/**
 * 会话薄服务单测（memory 存储后端；簿记/改名/删除/分支树推导）。
 */

import { describe, expect, it } from 'vitest';

import { create_storage } from '@ink-ts/engine';

import { HostSessionStore } from '../../src/sessions/store.js';
import { branch_tree_from_chain, fallback_title, normalize_title } from '../../src/sessions/model.js';

async function makeStore(): Promise<HostSessionStore> {
  const storage = await create_storage('memory://');
  return new HostSessionStore(() => storage);
}

describe('会话薄服务（HostSessionStore）', () => {
  it('create/rename/remove 簿记闭环（删除 = 逻辑删除过滤）', async () => {
    const store = await makeStore();
    const created = await store.create('t-1');
    expect(created.title).toBe('');
    expect(created.round_count).toBe(0);
    expect(await store.get('t-1')).not.toBeNull();

    const renamed = await store.rename('t-1', '  项目会话  ');
    expect(renamed.title).toBe('项目会话');
    expect(renamed.rename_count).toBe(1);

    await store.remove('t-1');
    expect(await store.get('t-1')).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it('rename 非法标题拒绝；不存在的会话 rename/remove 显式错误或幂等', async () => {
    const store = await makeStore();
    await expect(store.rename('missing', 'x')).rejects.toMatchObject({ code: 'session_not_found' });
    await expect(store.rename('t-2', '   ')).rejects.toMatchObject({ code: 'invalid_title' });
  });

  it('touch 收尾簿记：round_count/last_round_id/结局随调用累加', async () => {
    const store = await makeStore();
    await store.create('t-3');
    await store.touch('t-3', { round_id: 'r1', outcome: 'reply', checkpoint_id: 10 });
    await store.touch('t-3', { round_id: 'r2', outcome: 'reply', checkpoint_id: 11 });
    const record = await store.get('t-3');
    expect(record!.round_count).toBe(2);
    expect(record!.last_round_id).toBe('r2');
    expect(record!.current_leaf).toBe(11);
    expect(record!.message_count).toBe(0);
  });

  it('branch_tree_from_chain 推导多叶形态（子叶移除后余叶为叶）', () => {
    const tree = branch_tree_from_chain(
      't-x',
      [
      { checkpoint_id: 1, parent_id: null, reason: 'entry' },
      { checkpoint_id: 2, parent_id: 1, reason: 'ok' },
      { checkpoint_id: 3, parent_id: 1, reason: 'ok' },
    ],
    3,
  );
  expect(tree.current_leaf).toBe(3);
  expect(tree.nodes.map((node: { leaf: number }) => node.leaf).sort()).toEqual([2, 3]);
  expect(tree.nodes.find((node: { leaf: number; parent: number | null }) => node.leaf === 3)!.parent).toBe(1);
  });
});

describe('会话模型纯函数', () => {
  it('normalize_title 折叠空白并截断；空串拒绝', () => {
    expect(normalize_title('  新 会话  ')).toBe('新 会话');
    expect(normalize_title('')).toBeNull();
    expect(normalize_title('x'.repeat(80))).toHaveLength(32);
  });

  it('fallback_title 输出 YYYY-MM-DD HH:mm', () => {
    const value = fallback_title(0);
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});
