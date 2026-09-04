/**
 * 知识集可移植与持久化单测（导出/导入 round-trip + 存储 seam 注入）。
 *
 * 语义检查点：导出 = 补丁链全量演化历史（跨部署迁移复用）、非法导出
 * 数据显式拒绝（不静默建空集）、落库/读回共用 knowledge:<user> 集合、
 * 无记录 = 空集（种子注入由使用方初始化时执行）。存储经 seam 注入
 * （KnowledgeStorage 最小契约；测试以裸内存存储承载，不依赖真实后端）。
 */

import { describe, expect, it } from 'vitest';

import type { JsonRecord } from '../../../src/core/json.js';
import { PatchChain } from '../../../src/core/patch/patchChain.js';
import { KnowledgeSet } from '../../../src/core/knowledge_set/knowledge_set.js';
import { _CHAIN_KEY } from '../../../src/core/knowledge_set/_types.js';
import { LEVEL_PROJECT } from '../../../src/core/knowledge_set/_types.js';
import { KnowledgeEntry } from '../../../src/core/knowledge_set/knowledge_entry.js';
import { knowledge_collection } from '../../../src/core/knowledge_set/knowledge_utils.js';
import { entry, MemStore } from './knowledge_helpers.js';

describe('导出/导入 round-trip（可移植 = 内容可带走）', () => {
  it('补丁链无损还原：条目/修正/链条数完整迁移', () => {
    const store = new MemStore();
    const ks = new KnowledgeSet('u1', { storage: store });
    ks.add(entry('k-1'));
    ks.add(entry('k-2', LEVEL_PROJECT));
    ks.update('k-1', { data: { rule: { message: '修正' } } });
    const exported = ks.export();

    const rebuilt = KnowledgeSet.from_export('u2', exported);
    expect(rebuilt.entries().map((e) => e.to_dict())).toEqual(
      ks.entries().map((e) => e.to_dict()),
    );
    const rebuiltEntry = rebuilt.get('k-1')!;
    expect((rebuiltEntry.data['rule'] as JsonRecord)['message']).toBe('修正');
    expect(rebuiltEntry.credibility).toBe(0.7);
    // 链条数一致（演化历史完整迁移）
    expect((rebuilt.export()['patches'] as unknown[]).length).toBe(3);
  });

  it('非法导出数据显式拒绝（不静默建空集）', () => {
    expect(() => KnowledgeSet.from_export('u1', { nonsense: true })).toThrow(
      /导出数据非法/,
    );
    expect(() => KnowledgeSet.from_export('u1', null)).toThrow(/导出数据非法/);
  });
});

describe('落库/读回（存储 seam：knowledge:<user> 集合，chain 键）', () => {
  it('save 后 load 还原条目与用户 id', async () => {
    const store = new MemStore();
    const ks = new KnowledgeSet('u1', { storage: store });
    ks.add(entry());
    await ks.save();

    const loaded = await KnowledgeSet.load('u1', { storage: store });
    expect(loaded.get('k-1')).not.toBeNull();
    expect(loaded.user_id).toBe('u1');
    // 集合名 = knowledge:<user>，键 = chain
    expect(store.records.get(knowledge_collection('u1'))?.has(_CHAIN_KEY)).toBe(
      true,
    );
  });

  it('无记录 = 空集（种子注入由使用方初始化时执行）', async () => {
    const store = new MemStore();
    const loaded = await KnowledgeSet.load('nobody', { storage: store });
    expect(loaded.entries()).toEqual([]);
  });

  it('storage 未注入 = 纯内存集，save 跳过落库', async () => {
    const ks = new KnowledgeSet('u1');
    ks.add(entry());
    await expect(ks.save()).resolves.toBeUndefined();
    const loaded = await KnowledgeSet.load('u1');
    expect(loaded.entries()).toEqual([]);
  });

  it('落库数据序列化往返：条目结构经 JSON 保持', async () => {
    const store = new MemStore();
    const ks = new KnowledgeSet('u1', { storage: store });
    ks.add(entry('k-1', 'work', { credibility: 0.8, tags: ['x'] }));
    await ks.save();

    // 落库载荷 = 补丁链（base + patches）；条目数据在 replace 补丁里，
    // 组装回放后与内存快照一致
    const raw = store.records.get(knowledge_collection('u1'))!.get(_CHAIN_KEY)!;
    const snapshot = PatchChain.from_dict(
      raw as unknown as Parameters<typeof PatchChain.from_dict>[0],
    );
    const entries = snapshot.assemble()['entries'] as { [key: string]: unknown };
    const rebuilt = KnowledgeEntry.from_dict(entries['k-1'] as JsonRecord);
    expect(rebuilt.credibility).toBe(0.8);
    expect(rebuilt.tags).toEqual(['x']);
  });
});