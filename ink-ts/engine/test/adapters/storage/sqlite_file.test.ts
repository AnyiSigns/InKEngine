/**
 * SqliteStorage 真实文件/temp 用例：pragma 护栏、file 后端、use-after-close、
 * 多连接并发 append 原子性、回放容错、schema 自检与连接串工厂。
 *
 * 对标 pytest test_storage.py 的 sqlite-only 用例（tmp_path 形态）；每个
 * 用例用独立 temp 文件，afterEach 统一清理。
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { StorageError } from '../../../src/core/errors.js';
import { EngineEvent, PROTOCOL_VERSION } from '../../../src/core/events/events.js';
import type { Storage } from '../../../src/core/storage/storage.js';
import { CheckpointRecord } from '../../../src/core/storage/storage_records.js';
import { create_storage } from '../../../src/adapters/storage/index.js';
import { MemoryStorage } from '../../../src/adapters/storage/memory.js';
import { SqliteStorage } from '../../../src/adapters/storage/sqlite.js';
import { buildSchemaSql, SCHEMA_SQL, SCHEMA_TABLES } from '../../../src/adapters/storage/sqlite_schema.js';
import { makeTempDir, cleanupTempDirs } from './helpers.js';

afterEach(() => {
  cleanupTempDirs();
});

/** 便捷构造（镜像 Python _cp）。 */
function cp(init: Partial<ConstructorParameters<typeof CheckpointRecord>[0]> = {}): CheckpointRecord {
  return new CheckpointRecord({ checkpoint_id: 0, thread_id: 't1', node: 'n1', ...init });
}

describe('sqlite 连接 pragma 护栏（ENG5-1）', () => {
  it('busy_timeout/WAL/synchronous 立即生效且读写不受影响', async () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'pragma.db');
    const store = new SqliteStorage(dbPath);
    const anyStore = store as unknown as {
      _connect(): Promise<void>;
      _db: { prepare(sql: string): { get(...a: unknown[]): Record<string, unknown> | undefined } };
    };
    try {
      await anyStore._connect();
      // PRAGMA 返回列名与 pragma 名不同（busy_timeout → timeout），按列取
      const row = (name: string): Record<string, unknown> =>
        anyStore._db.prepare(`PRAGMA ${name}`).get() ?? {};
      expect(row('busy_timeout')['timeout']).toBe(5000);
      expect(String(row('journal_mode')['journal_mode']).toLowerCase()).toBe('wal');
      expect(row('synchronous')['synchronous']).toBe(1); // NORMAL
      const rec = await store.put_checkpoint(cp({ state: { x: 1 } }));
      const got = await store.get_checkpoint(rec.checkpoint_id);
      expect(got!.state).toEqual({ x: 1 });
    } finally {
      await store.close();
    }
  });
});

describe('sqlite schema 自检与 DDL 同构', () => {
  it('buildSchemaSql 生成 python 同构 DDL（三表 + 索引 + 主键）', () => {
    const sql = buildSchemaSql();
    for (const table of SCHEMA_TABLES) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`);
    }
    expect(sql).toContain('INTEGER PRIMARY KEY AUTOINCREMENT');
    expect(sql).toContain('PRIMARY KEY (collection, key)');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_checkpoints_thread ON checkpoints(thread_id, checkpoint_id DESC)');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_event_log_thread ON event_log(thread_id, seq)');
    expect(SCHEMA_SQL).toBe(sql);
  });

  it('旧版 checkpoints 表（缺列）→ 明确指令拒绝（不做迁移）', async () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'legacy.db');
    // 预置旧版表（缺 error/interrupt/graph_version/plan 列）
    const raw = new SqliteStorage(dbPath);
    await (raw as unknown as { _connect(): Promise<void> })._connect();
    const db = (raw as unknown as { _db: { exec(sql: string): void } })._db;
    db.exec('DROP TABLE checkpoints');
    db.exec('CREATE TABLE checkpoints (checkpoint_id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, node TEXT)');
    await raw.close();

    const store = new SqliteStorage(dbPath);
    await expect(store.get_latest_checkpoint('t1')).rejects.toMatchObject({
      message: expect.stringContaining('检测到旧版 checkpoints 表'),
    });
  });
});

describe('sqlite 真实文件后端', () => {
  it('create_storage("sqlite:///file.db") 落盘持久化', async () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'engine.db');
    const store = create_storage(`sqlite:///${dbPath}`);
    const rec = await store.put_checkpoint(cp({ state: { x: 1 } }));
    const got = await store.get_checkpoint(rec.checkpoint_id);
    expect(got!.state).toEqual({ x: 1 });
    await store.close();
    // 重开同一文件可见数据（真实持久化）
    const again = create_storage(`sqlite:///${dbPath}`);
    const got2 = await again.get_checkpoint(rec.checkpoint_id);
    expect(got2!.state).toEqual({ x: 1 });
    await again.close();
  });

  it('use-after-close 显式报错（不静默重连成空库）', async () => {
    const store = create_storage('sqlite:///:memory:');
    await store.put_checkpoint(cp({ state: { x: 1 } }));
    await store.close();
    await expect(store.get_latest_checkpoint('t1')).rejects.toMatchObject({
      name: 'StorageError',
      message: expect.stringContaining('存储已关闭'),
    });
  });
});

describe('sqlite 多连接并发 append 原子性（ENG2-4/16）', () => {
  it('两个独立连接并发 append：seq 全局唯一、各连接内单调、AUTOINCREMENT 不复用', async () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'conc.db');
    const s1 = create_storage(`sqlite:///${dbPath}`);
    const s2 = create_storage(`sqlite:///${dbPath}`);
    try {
      await (s1 as unknown as { _connect(): Promise<void> })._connect();
      await (s2 as unknown as { _connect(): Promise<void> })._connect();
      const hammer = async (store: Storage, thread: string, count: number): Promise<number[]> => {
        const seqs: number[] = [];
        for (let i = 0; i < count; i++) {
          seqs.push(await store.append_event(thread, new EngineEvent({ type: 't', payload: { i } })));
        }
        return seqs;
      };
      const [a, b] = await Promise.all([hammer(s1, 't-sql', 10), hammer(s2, 't-sql', 10)]);
      const flat = [...a, ...b];
      expect(new Set(flat).size).toBe(flat.length); // 全局唯一
      for (const group of [a, b]) {
        expect(group).toEqual([...group].sort((x, y) => x - y)); // 各连接内单调
      }
      expect((await s1.events_after('t-sql', 0)).length).toBe(20);
    } finally {
      await s1.close();
      await s2.close();
    }
  });
});

describe('sqlite 事件回放容错（ENG5-4）', () => {
  it('单条旧版本/损坏事件跳过，不中断整段重放', async () => {
    const store = new SqliteStorage(':memory:');
    const anyStore = store as unknown as { _connect(): Promise<void>; _db: { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): void } } };
    try {
      const good1 = await store.append_event('t1', new EngineEvent({ type: 'a', payload: { n: 1 } }));
      const good2 = await store.append_event('t1', new EngineEvent({ type: 'c', payload: { n: 3 } }));
      // 直接注入旧版本事件（绕过 append_event——它按当前协议写）
      const rawOld: Record<string, unknown> = {
        type: 'legacy',
        version: PROTOCOL_VERSION + 1,
        payload: {},
        seq: 0,
        step_id: null,
        parent_step_id: null,
        round_id: null,
        node: null,
        graph_path: [],
        trace_id: '-',
        thread_id: '-',
      };
      await anyStore._connect();
      anyStore._db
        .prepare('INSERT INTO event_log (thread_id, event) VALUES (?, ?)')
        .run('t1', JSON.stringify(rawOld));
      // 中间位置注入损坏行
      anyStore._db.prepare('INSERT INTO event_log (thread_id, event) VALUES (?, ?)').run('t1', 'not-json{{');
      const events = await store.events_after('t1', 0);
      expect(events.map((e) => e.type)).toEqual(['a', 'c']);
      expect(events.map((e) => e.seq)).toEqual([good1, good2]);
    } finally {
      await store.close();
    }
  });
});

describe('sqlite 连接串工厂（create_storage sqlite 分支）', () => {
  it('未知协议拒绝', () => {
    expect(() => create_storage('mysql://x')).toThrowError(/未知存储连接串协议/);
  });

  it('sqlite 形态路由：裸协议/查询参数/相对路径', async () => {
    const dir = makeTempDir();
    // 查询参数形态（:memory:?x=1）与 Python 同构透传给 SqliteStorage
    const withQuery = create_storage('sqlite:///:memory:?x=1');
    expect(withQuery).toBeInstanceOf(SqliteStorage);
    await withQuery.close();
    const relPath = path.join(dir, 'q.db');
    const fileStore = create_storage(`sqlite:///${relPath}`);
    expect(fileStore).toBeInstanceOf(SqliteStorage);
    await fileStore.close();
  });

  it('少斜杠 sqlite:/path 形态拒绝；.. 穿越片段拒绝', async () => {
    expect(() => create_storage('sqlite:/bad/path.db')).toThrowError(/非法 sqlite 连接串/);
    expect(() => create_storage('sqlite:///../escape.db')).toThrowError(/拒绝 \.\. 片段/);
  });

  it('memory 分支已路由 MemoryStorage；postgres 未移植显式报错', () => {
    expect(create_storage('memory://')).toBeInstanceOf(MemoryStorage);
    expect(() => create_storage('postgresql://u:p@localhost/db')).toThrowError(/postgresql/);
  });
});

describe('sqlite 链级原语与压缩底座', () => {
  it('delete_checkpoints / set_checkpoint_parent 行数语义', async () => {
    const store = new SqliteStorage(':memory:');
    try {
      const c1 = await store.put_checkpoint(cp({ state: { v: 1 } }));
      const c2 = await store.put_checkpoint(
        new CheckpointRecord({ checkpoint_id: 0, thread_id: 't1', node: 'n2', state: { v: 2 }, parent_id: c1.checkpoint_id }),
      );
      const c3 = await store.put_checkpoint(
        new CheckpointRecord({ checkpoint_id: 0, thread_id: 't1', node: 'n3', state: { v: 3 }, parent_id: c2.checkpoint_id }),
      );
      // set_checkpoint_parent：改写中间节点父指针
      expect(await store.set_checkpoint_parent('t1', c3.checkpoint_id, c1.checkpoint_id)).toBe(1);
      expect(await store.set_checkpoint_parent('t1', 9999, null)).toBe(0);
      const links = await store.chain_index('t1');
      const linkC3 = links.find((l) => l.checkpoint_id === c3.checkpoint_id)!;
      expect(linkC3.parent_id).toBe(c1.checkpoint_id);
      expect(linkC3.reason).toBeNull();
      // delete_checkpoints：只删同线程 id
      expect(await store.delete_checkpoints('t1', [c2.checkpoint_id, 8888])).toBe(1);
      expect(await store.get_checkpoint(c2.checkpoint_id)).toBeNull();
      expect(await store.delete_checkpoints('t1', [])).toBe(0);
      // list limit
      expect((await store.list_checkpoints('t1', { limit: 1 })).length).toBe(1);
    } finally {
      await store.close();
    }
  });

  it('trim_events 裁剪日志前缀', async () => {
    const store = new SqliteStorage(':memory:');
    try {
      const s1 = await store.append_event('t1', new EngineEvent({ type: 'a' }));
      await store.append_event('t1', new EngineEvent({ type: 'b' }));
      expect(await store.trim_events('t1', s1)).toBe(1);
      expect((await store.events_after('t1', 0)).map((e) => e.seq)).toEqual([s1 + 1]);
    } finally {
      await store.close();
    }
  });

  it('snapshot_capable 声明 = true', async () => {
    const store = new SqliteStorage(':memory:');
    expect(store.snapshot_capable).toBe(true);
    await store.close();
  });
});
