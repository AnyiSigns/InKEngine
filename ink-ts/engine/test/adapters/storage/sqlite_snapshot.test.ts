/**
 * SqliteStorage 快照/恢复单测（对标 pytest test_storage_snapshot.py 的
 * TestSqliteSnapshot）：snapshot = 目标库一致副本（backup API 语义，三通道
 * 齐全）；restore = 源内容整体替换当前库（可信快照目录限定 + 常规文件校验）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { EngineEvent } from '../../../src/core/events/events.js';
import { CheckpointRecord } from '../../../src/core/storage/storage_records.js';
import { SqliteStorage } from '../../../src/adapters/storage/sqlite.js';
import { makeTempDir, cleanupTempDirs } from './helpers.js';

afterEach(() => {
  cleanupTempDirs();
});

function sampleRecord(checkpointId: number, threadId = 't1', count = 1): CheckpointRecord {
  return new CheckpointRecord({ checkpoint_id: checkpointId, thread_id: threadId, node: 'start', state: { count } });
}

/** 落一个 checkpoint + 一条事件 + 一条 record（三通道齐全）。 */
async function fill(storage: SqliteStorage, threadId = 't1'): Promise<void> {
  await storage.put_checkpoint(sampleRecord(0, threadId));
  await storage.append_event(threadId, new EngineEvent({ type: 'reply_token', payload: { token: 'x' }, thread_id: threadId }));
  await storage.put_record('notes', 'k1', { title: 'hello' });
}

function ensureDirs(...dirs: string[]): void {
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
}

describe('sqlite 快照/恢复', () => {
  it('snapshot 产出一致副本（checkpoint/事件/records 全通道）', async () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'engine.db');
    const snapPath = path.join(dir, 'snapshot.db');
    const storage = new SqliteStorage(dbPath);
    await fill(storage);
    await storage.snapshot(snapPath);

    const copy = new SqliteStorage(snapPath);
    const latest = await copy.get_latest_checkpoint('t1');
    expect(latest).not.toBeNull();
    expect(latest!.state).toEqual({ count: 1 });
    const events = await copy.events_after('t1', 0);
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe('reply_token');
    expect(await copy.get_record('notes', 'k1')).toEqual({ title: 'hello' });
    await copy.close();
    await storage.close();
  });

  it('restore 回到快照时点（快照后修改被覆盖）', async () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'engine.db');
    const snapPath = path.join(dir, 'snapshot.db');
    const storage = new SqliteStorage(dbPath);
    await fill(storage);
    await storage.snapshot(snapPath);
    // 快照后继续修改（新 record + 新 checkpoint）
    await storage.put_record('notes', 'k1', { title: 'changed' });
    await storage.put_checkpoint(sampleRecord(0, 't1', 99));
    await storage.restore(snapPath);
    expect(await storage.get_record('notes', 'k1')).toEqual({ title: 'hello' });
    const latest = await storage.get_latest_checkpoint('t1');
    expect(latest!.state).toEqual({ count: 1 });
    // restore 后当前连接可正常读写（重开生效）
    await storage.put_checkpoint(sampleRecord(0, 't1', 5));
    expect((await storage.get_latest_checkpoint('t1'))!.state).toEqual({ count: 5 });
    await storage.close();
  });

  it('快照/恢复源与当前库同路径拒绝（防误覆盖）', async () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'engine.db');
    const storage = new SqliteStorage(dbPath);
    await fill(storage);
    await expect(storage.snapshot(dbPath)).rejects.toMatchObject({
      message: expect.stringContaining('不同位置'),
    });
    await expect(storage.restore(dbPath)).rejects.toMatchObject({
      message: expect.stringContaining('当前库已是'),
    });
    await storage.close();
  });

  it('内存库（:memory:）同样可快照到文件', async () => {
    const dir = makeTempDir();
    const snapPath = path.join(dir, 'mem.db');
    const storage = new SqliteStorage(':memory:');
    await fill(storage);
    await storage.snapshot(snapPath);
    const copy = new SqliteStorage(snapPath);
    expect(await copy.get_record('notes', 'k1')).toEqual({ title: 'hello' });
    await copy.close();
    await storage.close();
  });

  it('restore 拒绝目录外/不存在/目录形态来源（ENG5-6）', async () => {
    const dir = makeTempDir();
    const dbDir = path.join(dir, 'db');
    const otherDir = path.join(dir, 'other');
    ensureDirs(dbDir, otherDir);
    const dbPath = path.join(dbDir, 'engine.db');
    const snapPath = path.join(dbDir, 'snapshot.db');
    const outside = path.join(otherDir, 'foreign.db');
    const storage = new SqliteStorage(dbPath);
    await fill(storage);
    await storage.snapshot(snapPath);
    // 可信目录（缺省 = 库文件所在目录）内的快照可恢复
    await storage.restore(snapPath);
    // 目录外合法 sqlite 库文件的恢复源：拒绝
    const outsideSrc = new SqliteStorage(outside);
    await fill(outsideSrc);
    await outsideSrc.close();
    await expect(storage.restore(outside)).rejects.toMatchObject({
      message: expect.stringContaining('可信快照目录'),
    });
    // 可信目录内但文件不存在 / 目录形态：按文件校验拒绝
    await expect(storage.restore(path.join(dbDir, 'missing.db'))).rejects.toMatchObject({
      message: expect.stringContaining('常规文件'),
    });
    await expect(storage.restore(otherDir)).rejects.toMatchObject({
      message: expect.stringContaining('可信快照目录'),
    });
    await storage.close();
  });

  it('snapshot_dir 构造参数覆盖默认可信目录（ENG5-6）', async () => {
    const dir = makeTempDir();
    const trusted = path.join(dir, 'trusted');
    const untrusted = path.join(dir, 'untrusted');
    ensureDirs(trusted, untrusted);
    const snapPath = path.join(trusted, 'snap.db');
    const storage = new SqliteStorage(path.join(dir, 'engine.db'), { snapshot_dir: trusted });
    await fill(storage);
    await storage.snapshot(snapPath);
    await storage.restore(snapPath);
    // 可信目录内任意快照文件可恢复（兄弟库文件同受信任）
    const sibling = new SqliteStorage(path.join(trusted, 'other.db'));
    await fill(sibling);
    await sibling.close();
    await storage.restore(path.join(trusted, 'other.db'));
    // 可信目录之外（即使与库同目录）的快照：拒绝
    const untrustedSnap = new SqliteStorage(path.join(untrusted, 'foreign.db'));
    await fill(untrustedSnap);
    await untrustedSnap.close();
    await expect(storage.restore(path.join(untrusted, 'foreign.db'))).rejects.toMatchObject({
      message: expect.stringContaining('可信快照目录'),
    });
    await storage.close();
  });
});
