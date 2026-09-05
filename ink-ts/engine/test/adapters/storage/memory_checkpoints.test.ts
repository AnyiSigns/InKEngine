// gate: 超限(378 行) - checkpoint 版本链契约覆盖（创建/更新/乐观锁/链一致性/归属校验），单文件成组便于对照 pytest
/**
 * MemoryStorage checkpoint 版本链测试（对标 pytest test_storage.py memory://
 * 分支：创建/读取/最新/列表、乐观锁、链一致性不变量、敏感键剥离、深拷贝
 * 隔离、删除/父指针改写、validate_chain 整链一致）。
 */

import { describe, expect, it } from 'vitest';

import { CheckpointConflictError, StorageError } from '../../../src/core/errors.js';
import { validate_chain } from '../../../src/core/storage/storage.js';
import { CheckpointRecord } from '../../../src/core/storage/storage_records.js';
import { MemoryStorage } from '../../../src/adapters/storage/memory.js';

function cp(over: Partial<ConstructorParameters<typeof CheckpointRecord>[0]> = {}): CheckpointRecord {
  return new CheckpointRecord({ checkpoint_id: 0, thread_id: 't1', node: 'n1', ...over });
}

describe('checkpoint 创建/读取/列表', () => {
  it('创建返回自增 id，get 还原字段', async () => {
    const store = new MemoryStorage();
    const rec = await store.put_checkpoint(cp({ state: { a: 1 } }));
    expect(rec.checkpoint_id).toBeGreaterThan(0);
    const got = await store.get_checkpoint(rec.checkpoint_id);
    expect(got?.state).toEqual({ a: 1 });
    expect(got?.node).toBe('n1');
    await store.close();
  });

  it('latest + list 倒序，链头之后正常续链', async () => {
    const store = new MemoryStorage();
    const c1 = await store.put_checkpoint(cp({ state: { v: 1 } }));
    const c2 = await store.put_checkpoint(
      cp({ node: 'n2', state: { v: 2 }, parent_id: c1.checkpoint_id }),
    );
    const latest = await store.get_latest_checkpoint('t1');
    expect(latest?.checkpoint_id).toBe(c2.checkpoint_id);
    const list = await store.list_checkpoints('t1');
    expect(list.map((c) => c.checkpoint_id)).toEqual([c2.checkpoint_id, c1.checkpoint_id]);
    expect(await store.get_latest_checkpoint('missing')).toBeNull();
    await store.close();
  });

  it('list limit 生效且各线程隔离', async () => {
    const store = new MemoryStorage();
    for (let i = 0; i < 5; i++) await store.put_checkpoint(cp({ state: { i } }));
    await store.put_checkpoint(cp({ thread_id: 't2' }));
    const list = await store.list_checkpoints('t1', { limit: 3 });
    expect(list).toHaveLength(3);
    expect(await store.list_checkpoints('t2')).toHaveLength(1);
    await store.close();
  });
});

describe('checkpoint 乐观锁与更新路径', () => {
  it('期望版本匹配则 version+1；旧期望则冲突', async () => {
    const store = new MemoryStorage();
    const rec = await store.put_checkpoint(cp({ state: { v: 1 } }));
    const updated = await store.put_checkpoint(
      new CheckpointRecord({
        checkpoint_id: rec.checkpoint_id,
        thread_id: 't1',
        node: 'n1',
        state: { v: 2 },
        version: rec.version,
      }),
      { expected_version: rec.version },
    );
    expect(updated.version).toBe(rec.version + 1);
    await expect(
      store.put_checkpoint(
        new CheckpointRecord({
          checkpoint_id: rec.checkpoint_id,
          thread_id: 't1',
          node: 'n1',
          state: { v: 3 },
          version: rec.version,
        }),
        { expected_version: rec.version },
      ),
    ).rejects.toThrow(CheckpointConflictError);
    await store.close();
  });

  it('expected_version 缺省自动读当前版本（三后端同口径）', async () => {
    const store = new MemoryStorage();
    const rec = await store.put_checkpoint(cp({ state: { v: 1 } }));
    const updated = await store.put_checkpoint(
      new CheckpointRecord({
        checkpoint_id: rec.checkpoint_id,
        thread_id: 't1',
        node: 'n1',
        state: { v: 2 },
        version: rec.version,
      }),
    );
    expect(updated.version).toBe(rec.version + 1);
    await store.close();
  });

  it('更新不存在的 checkpoint 抛 StorageError（杜绝静默插入任意 id）', async () => {
    const store = new MemoryStorage();
    await expect(
      store.put_checkpoint(
        new CheckpointRecord({ checkpoint_id: 12345, thread_id: 't1', node: 'n1', state: { v: 1 } }),
      ),
    ).rejects.toThrow(StorageError);
    await store.close();
  });

  it('更新路径父指针不可变（注入非法 parent 不得改写链上父指针）', async () => {
    const store = new MemoryStorage();
    const rec = await store.put_checkpoint(cp({ state: { v: 1 } }));
    const child = await store.put_checkpoint(cp({ state: { v: 9 }, parent_id: rec.checkpoint_id }));
    const updated = await store.put_checkpoint(
      new CheckpointRecord({
        checkpoint_id: child.checkpoint_id,
        thread_id: 't1',
        node: 'n2',
        state: { v: 10 },
        parent_id: 999,
        version: child.version,
      }),
      { expected_version: child.version },
    );
    expect(updated.parent_id).toBe(rec.checkpoint_id);
    expect((await store.get_checkpoint(child.checkpoint_id))?.parent_id).toBe(rec.checkpoint_id);
    expect(await validate_chain(store, 't1')).toEqual([]);
    await store.close();
  });

  it('更新保持记录类型：graph_path 仍为只读数组形态、version 递增', async () => {
    const store = new MemoryStorage();
    const rec = await store.put_checkpoint(cp({ state: { v: 1 } }));
    const updated = await store.put_checkpoint(
      new CheckpointRecord({
        checkpoint_id: rec.checkpoint_id,
        thread_id: 't1',
        node: 'n1',
        state: { v: 2 },
        version: rec.version,
      }),
    );
    expect(updated.graph_path).toEqual([]);
    expect(updated.version).toBe(rec.version + 1);
    await store.close();
  });

  it('异线程 checkpoint_id 更新被拒：不迁移线程、不污染他线程链尾', async () => {
    const store = new MemoryStorage();
    const rec = await store.put_checkpoint(cp({ state: { v: 1 } }));
    await expect(
      store.put_checkpoint(
        new CheckpointRecord({
          checkpoint_id: rec.checkpoint_id,
          thread_id: 't2',
          node: 'n2',
          state: { v: 2 },
          version: rec.version,
        }),
      ),
    ).rejects.toThrow(CheckpointConflictError);
    await expect(
      store.put_checkpoint(
        new CheckpointRecord({
          checkpoint_id: rec.checkpoint_id,
          thread_id: 't2',
          node: 'n2',
          state: { v: 2 },
          version: rec.version,
        }),
      ),
    ).rejects.toThrow(/归属他线程/);
    // 记录仍归原线程（未迁移），t2 无链尾
    expect((await store.get_checkpoint(rec.checkpoint_id))?.thread_id).toBe('t1');
    expect(await store.get_latest_checkpoint('t2')).toBeNull();
    await store.close();
  });

  it('graph_version + plan 跨 创建/守卫式续链/更新 三路径保持', async () => {
    const store = new MemoryStorage();
    const rec = await store.put_checkpoint(
      cp({
        state: { v: 1 },
        graph_version: 'a'.repeat(64),
        plan: { steps: [{ nodes: ['a'] }, { nodes: ['b'] }], index: 1 },
      }),
    );
    const c2 = await store.put_checkpoint(
      cp({ state: { v: 2 }, parent_id: rec.checkpoint_id, graph_version: 'b'.repeat(64), plan: null }),
    );
    expect((await store.get_checkpoint(c2.checkpoint_id))?.plan).toBeNull();
    const updated = await store.put_checkpoint(
      new CheckpointRecord({
        checkpoint_id: c2.checkpoint_id,
        thread_id: 't1',
        node: 'n2',
        state: { v: 3 },
        parent_id: rec.checkpoint_id,
        version: c2.version,
        graph_version: 'b'.repeat(64),
        plan: { steps: [{ nodes: ['b'] }], index: 0 },
      }),
      { expected_version: c2.version },
    );
    expect(updated.graph_version).toBe('b'.repeat(64));
    expect(updated.plan).toEqual({ steps: [{ nodes: ['b'] }], index: 0 });
    expect(await validate_chain(store, 't1')).toEqual([]);
    await store.close();
  });
});

describe('checkpoint 链一致性不变量', () => {
  it('链尾已前进时续链冲突；fork 允许锚点历史链', async () => {
    const store = new MemoryStorage();
    const c1 = await store.put_checkpoint(cp({ state: { v: 1 } }));
    const c2 = await store.put_checkpoint(cp({ state: { v: 2 }, parent_id: c1.checkpoint_id }));
    await expect(
      store.put_checkpoint(cp({ state: { v: 3 }, parent_id: c1.checkpoint_id })),
    ).rejects.toThrow(CheckpointConflictError);
    const forkRec = await store.put_checkpoint(
      cp({ state: { v: 3 }, parent_id: c1.checkpoint_id }),
      { fork: true },
    );
    expect(forkRec.checkpoint_id).toBeGreaterThan(c2.checkpoint_id);
    await store.close();
  });

  it('悬挂父指针拒绝', async () => {
    const store = new MemoryStorage();
    await expect(store.put_checkpoint(cp({ parent_id: 999 }))).rejects.toThrow(
      CheckpointConflictError,
    );
    await store.close();
  });

  it('跨线程父指针拒绝（版本链不跨线程）', async () => {
    const store = new MemoryStorage();
    const c1 = await store.put_checkpoint(cp({ state: { v: 1 } }));
    await expect(
      store.put_checkpoint(
        new CheckpointRecord({
          checkpoint_id: 0,
          thread_id: 't2',
          node: 'n2',
          state: { v: 2 },
          parent_id: c1.checkpoint_id,
        }),
      ),
    ).rejects.toThrow(CheckpointConflictError);
    await store.close();
  });

  it('event_seq 回退（低于父锚点）拒绝', async () => {
    const store = new MemoryStorage();
    const c1 = await store.put_checkpoint(cp({ state: { v: 1 }, event_seq: 5 }));
    await expect(
      store.put_checkpoint(cp({ state: { v: 2 }, parent_id: c1.checkpoint_id, event_seq: 2 })),
    ).rejects.toThrow(CheckpointConflictError);
    await store.close();
  });

  it('fork 豁免链一致性：锚点历史链 + event_seq 低于父锚点', async () => {
    const store = new MemoryStorage();
    const c1 = await store.put_checkpoint(cp({ state: { v: 1 }, event_seq: 100 }));
    const forkRec = await store.put_checkpoint(
      cp({ state: { v: 2 }, parent_id: c1.checkpoint_id, event_seq: 10 }),
      { fork: true },
    );
    expect(forkRec.checkpoint_id).toBeGreaterThan(c1.checkpoint_id);
    await store.close();
  });

  it('非 JSON 状态拒绝（StorageError，切库不炸）', async () => {
    const store = new MemoryStorage();
    class _Obj {}
    await expect(
      store.put_checkpoint(cp({ state: { obj: new _Obj() } as never })),
    ).rejects.toThrow(StorageError);
    await store.close();
  });
});

describe('checkpoint 安全与快照隔离', () => {
  it('敏感键剥离：嵌套 api_key 置空保留，业务键不伤', async () => {
    const store = new MemoryStorage();
    const rec = await store.put_checkpoint(
      cp({ state: { model_config: { api_key: 'sk-secret', model: 'x' }, ok: 1 } }),
    );
    const got = await store.get_checkpoint(rec.checkpoint_id);
    const cfg = got?.state?.model_config as Record<string, unknown> | undefined;
    expect(cfg?.api_key).toBe('');
    expect(cfg?.model).toBe('x');
    expect(got?.state.ok).toBe(1);
    await store.close();
  });

  it('常见凭据前后缀键剥离，指标/业务键不误伤', async () => {
    const store = new MemoryStorage();
    const rec = await store.put_checkpoint(
      cp({
        state: {
          openai_api_key: 'sk-secret',
          client_secret: 's',
          auth_token: 't',
          token_count: 3,
          key_insight: '剧情关键',
          ok: 1,
        },
      }),
    );
    const state = (await store.get_checkpoint(rec.checkpoint_id))?.state as Record<string, unknown>;
    expect(state.openai_api_key).toBe('');
    expect(state.client_secret).toBe('');
    expect(state.auth_token).toBe('');
    expect(state.token_count).toBe(3);
    expect(state.key_insight).toBe('剧情关键');
    await store.close();
  });

  it('调用方修改返回记录不污染存储内快照', async () => {
    const store = new MemoryStorage();
    const rec = await store.put_checkpoint(cp({ state: { items: [1] } }));
    (rec.state as { items: number[] }).items.push(2);
    const got = await store.get_checkpoint(rec.checkpoint_id);
    expect((got?.state as { items: number[] }).items).toEqual([1]);
    await store.close();
  });
});

describe('checkpoint 删除与父指针改写', () => {
  it('delete_checkpoints 归属校验：跨线程 id 不删除，返回删除数', async () => {
    const store = new MemoryStorage();
    const c1 = await store.put_checkpoint(cp({ state: { v: 1 } }));
    const c2 = await store.put_checkpoint(cp({ state: { v: 2 }, parent_id: c1.checkpoint_id }));
    const other = await store.put_checkpoint(
      new CheckpointRecord({ checkpoint_id: 0, thread_id: 't2', node: 'n', state: {} }),
    );
    expect(
      await store.delete_checkpoints('t1', [c1.checkpoint_id, c2.checkpoint_id, other.checkpoint_id, 999]),
    ).toBe(2);
    expect(await store.get_checkpoint(c1.checkpoint_id)).toBeNull();
    expect(await store.get_checkpoint(other.checkpoint_id)).not.toBeNull();
    expect(await store.get_latest_checkpoint('t1')).toBeNull();
    await store.close();
  });

  it('删除非链尾节点后 latest 保持链尾', async () => {
    const store = new MemoryStorage();
    const c1 = await store.put_checkpoint(cp({ state: { v: 1 } }));
    const c2 = await store.put_checkpoint(cp({ state: { v: 2 }, parent_id: c1.checkpoint_id }));
    await store.delete_checkpoints('t1', [c1.checkpoint_id]);
    expect((await store.get_latest_checkpoint('t1'))?.checkpoint_id).toBe(c2.checkpoint_id);
    await store.close();
  });

  it('set_checkpoint_parent 改写父指针；无匹配/跨线程静默 0', async () => {
    const store = new MemoryStorage();
    const c1 = await store.put_checkpoint(cp({ state: { v: 1 } }));
    const c2 = await store.put_checkpoint(cp({ state: { v: 2 }, parent_id: c1.checkpoint_id }));
    const c3 = await store.put_checkpoint(cp({ state: { v: 3 }, parent_id: c2.checkpoint_id }));
    expect(await store.set_checkpoint_parent('t1', c3.checkpoint_id, c1.checkpoint_id)).toBe(1);
    expect((await store.get_checkpoint(c3.checkpoint_id))?.parent_id).toBe(c1.checkpoint_id);
    expect(await store.set_checkpoint_parent('t1', 12345, null)).toBe(0);
    expect(await store.set_checkpoint_parent('t2', c1.checkpoint_id, null)).toBe(0);
    await store.close();
  });

  it('validate_chain 对线性链（含空线程）返回无违规', async () => {
    const store = new MemoryStorage();
    const c1 = await store.put_checkpoint(cp({ state: { v: 1 }, event_seq: 0 }));
    const c2 = await store.put_checkpoint(
      cp({ state: { v: 2 }, parent_id: c1.checkpoint_id, event_seq: 5 }),
    );
    await store.put_checkpoint(cp({ state: { v: 3 }, parent_id: c2.checkpoint_id, event_seq: 5 }));
    expect(await validate_chain(store, 't1')).toEqual([]);
    expect(await validate_chain(store, 'missing_thread')).toEqual([]);
    await store.close();
  });
});
