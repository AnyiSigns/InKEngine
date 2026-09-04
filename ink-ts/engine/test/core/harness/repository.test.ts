/**
 * harness 仓库单测（Python test_harness.py 仓库三用例移植）：版本链
 * append / 历史保留 / 回退 = 组装到指定版本 / 列表返回最新。
 *
 * 存储 seam 说明：Python 侧用 conftest memory_storage fixture（真实
 * MemoryStorage 后端）；TS core 零 IO 不留后端实现，以本文件内嵌的
 * MemStore（records 通道内存假存储）承接同一 seam 语义（与
 * evolution_writer / knowledge_set 测试同套路），非真实后端集成。
 */
import { describe, expect, it } from 'vitest';

import type { HarnessStorage } from '../../../src/core/harness/index.js';
import { HarnessRepository } from '../../../src/core/harness/index.js';

import { _harness } from './helpers.js';

/** 内存 records 假存储：get/put/list 全量记录（JSON 深拷贝防串改）。 */
class MemStore implements HarnessStorage {
  readonly records = new Map<string, Map<string, unknown>>();

  async get_record(collection: string, key: string): Promise<Record<string, unknown> | null> {
    const value = this.records.get(collection)?.get(key);
    return value === undefined || value === null
      ? null
      : (value as Record<string, unknown>);
  }

  async put_record(collection: string, key: string, data: Record<string, unknown>): Promise<void> {
    if (!this.records.has(collection)) this.records.set(collection, new Map());
    this.records.get(collection)!.set(key, JSON.parse(JSON.stringify(data)) as unknown);
  }

  async list_records(collection: string): Promise<Record<string, unknown>[]> {
    const bucket = this.records.get(collection);
    return bucket === undefined
      ? []
      : ([...bucket.values()] as Record<string, unknown>[]);
  }
}

/** 仓库构造（固定时间轴 0：版本索引 created_at 落确定值，可复现断言）。 */
function makeRepo(): { store: MemStore; repo: HarnessRepository } {
  const store = new MemStore();
  const repo = new HarnessRepository(store, null, { now: () => 0 });
  return { store, repo };
}

describe('harness 仓库版本链', () => {
  it('版本链：新版本 append、历史保留、回退 = 组装到指定版本', async () => {
    const { repo } = makeRepo();
    const v1 = await repo.save(_harness({ description: 'v1 描述' }));
    const v2 = await repo.save(_harness({ description: 'v2 描述' }), { note: '调整' });
    expect([v1, v2]).toEqual([1, 2]);

    const current = await repo.get('plotter');
    expect(current?.description).toBe('v2 描述');
    const rolled_back = await repo.get('plotter', { version: 1 });
    expect(rolled_back?.description).toBe('v1 描述');

    const versions = await repo.versions('plotter');
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[1]?.note).toBe('调整');

    // 越界版本/不存在 harness → null
    expect(await repo.get('plotter', { version: 99 })).toBeNull();
    expect(await repo.get('ghost')).toBeNull();
  });

  it('多版本演进后旧版本数据完整可回退（append-only 不物理删除）', async () => {
    const { repo } = makeRepo();
    await repo.save(_harness({ description: '初版' }));
    await repo.save(_harness({ description: '二版' }));
    await repo.save(_harness({ description: '三版' }));
    expect((await repo.get('plotter', { version: 1 }))?.description).toBe('初版');
    expect((await repo.get('plotter', { version: 2 }))?.description).toBe('二版');
    expect((await repo.get('plotter', { version: 3 }))?.description).toBe('三版');
  });

  it('仓库列表返回各能力包最新版本', async () => {
    const { repo } = makeRepo();
    await repo.save(_harness({ name: 'a', description: 'a1' }));
    await repo.save(_harness({ name: 'a', description: 'a2' }));
    await repo.save(_harness({ name: 'b', description: 'b1' }));
    const definitions = await repo.list();
    const by_name = new Map(definitions.map((d) => [d.name, d]));
    expect(new Set(by_name.keys())).toEqual(new Set(['a', 'b']));
    expect(by_name.get('a')?.description).toBe('a2'); // 最新版本
    expect(by_name.get('b')?.description).toBe('b1');
  });
});
