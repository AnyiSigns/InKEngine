/**
 * MemoryStorage 快照/恢复 + 工厂 + 能力声明 + close 测试（对标 pytest
 * test_storage_snapshot.py TestMemorySnapshot 与 test_storage.py 的工厂
 * /snapshot_capable/urlsplit 用例 memory 分支）。
 *
 * 覆盖：snapshot 后修改再 restore 回快照时点；快照可被另一内存实例恢复
 * （迁移引子）；restore 全量替换；损坏快照文件显式拒绝；snapshot 目标
 * 目录不存在报错；snapshot_capable 声明；create_memory_storage /
 * create_storage memory 形态路由（'' / memory / memory://）；close 幂等
 * 且 close 后仍可读写（Python MemoryStorage.close 为 pass 同口径）。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EngineEvent } from '../../../src/core/events/events.js';
import { StorageError } from '../../../src/core/errors.js';
import { CheckpointRecord } from '../../../src/core/storage/storage_records.js';
import type { Storage } from '../../../src/core/storage/storage.js';
import {
  MemoryStorage,
  create_memory_storage,
} from '../../../src/adapters/storage/memory.js';
import { create_storage } from '../../../src/adapters/storage/index.js';

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'inkts-memstorage-'));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 落一个 checkpoint + 一条事件 + 一条 record（三通道齐全）。 */
async function fill(store: Storage, threadId = 't1'): Promise<void> {
  await store.put_checkpoint(
    new CheckpointRecord({
      checkpoint_id: 0,
      thread_id: threadId,
      node: 'start',
      state: { count: 1 },
    }),
  );
  await store.append_event(
    threadId,
    new EngineEvent({ type: 'reply_token', payload: { token: 'x' }, thread_id: threadId }),
  );
  await store.put_record('notes', 'k1', { title: 'hello' });
}

function snapPath(name: string): string {
  return join(tmpDir, name);
}

describe('快照/恢复', () => {
  it('snapshot 后修改再 restore 回快照时点', async () => {
    const path = snapPath('roundtrip.json');
    const store = create_memory_storage();
    await fill(store);
    await store.snapshot(path);
    await store.put_record('notes', 'k1', { title: 'mutated' });
    await store.put_checkpoint(
      new CheckpointRecord({
        checkpoint_id: 0,
        thread_id: 't1',
        node: 'start',
        state: { count: 99 },
      }),
    );
    await store.restore(path);
    expect(await store.get_record('notes', 'k1')).toEqual({ title: 'hello' });
    const latest = await store.get_latest_checkpoint('t1');
    expect(latest?.state).toEqual({ count: 1 });
    expect(await store.events_after('t1', 0)).toHaveLength(1);
    await store.close();
  });

  it('快照可被另一个内存实例恢复（迁移引子）', async () => {
    const path = snapPath('fresh.json');
    const store = create_memory_storage();
    await fill(store);
    await store.snapshot(path);
    const other = create_memory_storage();
    await other.restore(path);
    expect(await other.get_record('notes', 'k1')).toEqual({ title: 'hello' });
    expect((await other.get_latest_checkpoint('t1'))?.state).toEqual({ count: 1 });
    await other.put_record('notes', 'k2', { new: true });
    await other.close();
    await store.close();
  });

  it('restore 全量替换：快照后新增数据消失、快照时点数据在位', async () => {
    const path = snapPath('replace.json');
    const store = create_memory_storage();
    await store.put_record('notes', 'k1', { title: 'pre' });
    await store.snapshot(path);
    await store.put_record('extra', 'k', { v: 2 });
    await store.put_record('old', 'k', { v: 1 });
    await store.restore(path);
    expect(await store.get_record('old', 'k')).toBeNull();
    expect(await store.get_record('extra', 'k')).toBeNull();
    expect(await store.get_record('notes', 'k1')).toEqual({ title: 'pre' });
    await store.close();
  });

  it('损坏快照文件拒绝（StorageError 携带恢复失败语义）', async () => {
    const bad = snapPath('bad.json');
    writeFileSync(bad, '{not valid json', 'utf8');
    const store = create_memory_storage();
    await expect(store.restore(bad)).rejects.toThrow(StorageError);
    await expect(store.restore(bad)).rejects.toThrow(/恢复失败/);
    await store.close();
  });

  it('snapshot 目标目录不存在抛 StorageError', async () => {
    const store = create_memory_storage();
    await expect(
      store.snapshot(join(tmpDir, 'no-such-dir', 'x.json')),
    ).rejects.toThrow(StorageError);
    await store.close();
  });
});

describe('工厂/能力/close', () => {
  it('create_memory_storage 返回 MemoryStorage 且声明快照能力', () => {
    const store = create_memory_storage();
    expect(store).toBeInstanceOf(MemoryStorage);
    expect(store.snapshot_capable).toBe(true);
  });

  it("create_storage memory 形态路由（'' / memory / memory://）", () => {
    expect(create_storage('memory')).toBeInstanceOf(MemoryStorage);
    expect(create_storage('memory://')).toBeInstanceOf(MemoryStorage);
    expect(create_storage('')).toBeInstanceOf(MemoryStorage);
    expect(() => create_storage('mysql://x')).toThrow();
  });

  it('close 幂等且 close 后仍可读写（内存后端无资源释放语义）', async () => {
    const store = create_memory_storage();
    await store.put_record('c', 'k', { v: 1 });
    await store.close();
    await store.close();
    expect(await store.get_record('c', 'k')).toEqual({ v: 1 });
    await store.put_record('c', 'k2', { v: 2 });
    expect(await store.list_records('c')).toHaveLength(2);
  });
});
