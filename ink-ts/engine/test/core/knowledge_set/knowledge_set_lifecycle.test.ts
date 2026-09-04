/**
 * 知识集生命周期单测（归档不删除 + 种子幂等 + 分层晋升）。
 *
 * 语义检查点：归档 = 移出活跃索引（entries/search 不再命中）不删除、
 * 恢复原样保留内容、归档幂等且缺失条目显式拒绝、归档状态随补丁链
 * 导出/导入、归档是状态迁移非删除（链历史完整）、检索默认只扫活跃
 * 索引、种子注入幂等（重复初始化不覆盖演化）、晋升 = namespace 迁移
 * （工作→项目→用户，不跳级，id 跨层级稳定）。
 */

import { describe, expect, it } from 'vitest';

import type { JsonRecord } from '../../../src/core/json.js';
import { PatchChain } from '../../../src/core/patch/patchChain.js';
import { KnowledgeSet } from '../../../src/core/knowledge_set/knowledge_set.js';
import { KnowledgeSetBase } from '../../../src/core/knowledge_set/knowledge_set_core.js';
import {
  LEVEL_PROJECT,
  LEVEL_USER,
  LEVEL_WORK,
} from '../../../src/core/knowledge_set/_types.js';
import { seed_knowledge_set } from '../../../src/core/knowledge_set/_sources.js';
import { entry, rawEntry } from './knowledge_helpers.js';

describe('归档/淘汰（生命周期 = 归档不删除，可恢复）', () => {
  it('归档 = 移出活跃索引（entries/search 不再命中），不删除', () => {
    const ks = new KnowledgeSet('u1');
    ks.add(entry('k-1', LEVEL_WORK, { tags: ['x'] }));
    ks.add(entry('k-2', LEVEL_WORK, { tags: ['x'] }));
    const archived = ks.archive('k-1');
    expect(archived.archived).toBe(true);
    expect(ks.entries().map((e) => e.id)).toEqual(['k-2']); // 活跃索引不含 k-1
    expect(ks.archived_entries().map((e) => e.id)).toEqual(['k-1']);
    expect(ks.search('x')[0]!.id).toBe('k-2'); // 检索不命中归档条目
    expect(ks.get('k-1')).not.toBeNull(); // 数据与演化历史完整保留
  });

  it('恢复归档条目：重新进入活跃索引，内容原样保留', () => {
    const ks = new KnowledgeSet('u1');
    ks.add(entry('k-1', LEVEL_WORK, { tags: ['x'] }));
    ks.archive('k-1');
    const restored = ks.unarchive('k-1');
    expect(restored.archived).toBe(false);
    const data = ks.get('k-1')!;
    expect(data.data).toEqual({ rule: { message: '规则 k-1' } });
    expect(ks.search('x')[0]!.id).toBe('k-1');
  });

  it('归档幂等；不存在的条目归档/恢复显式拒绝', () => {
    const ks = new KnowledgeSet('u1');
    ks.add(entry('k-1'));
    ks.archive('k-1');
    expect(ks.archive('k-1').archived).toBe(true); // 重复归档幂等
    expect(() => ks.archive('ghost')).toThrow(/不存在/);
    expect(() => ks.unarchive('ghost')).toThrow(/不存在/);
  });

  it('归档标记随补丁链导出/导入（可移植性覆盖归档状态）', () => {
    const ks = new KnowledgeSet('u1');
    ks.add(entry('k-1'));
    ks.archive('k-1');
    const rebuilt = KnowledgeSet.from_export('u2', ks.export());
    expect(rebuilt.archived_entries().map((e) => e.id)).toEqual(['k-1']);
    expect(rebuilt.entries()).toEqual([]);
  });

  it('归档是状态迁移非删除：链历史完整（回退仍可取旧版本）', () => {
    const ks = new KnowledgeSet('u1');
    ks.add(entry('k-1'));
    ks.archive('k-1');
    const chain = ks.export();
    expect((chain['patches'] as unknown[]).length).toBe(2); // 新增 + 归档各一补丁
    const chainFromExport = JSON.parse(
      JSON.stringify({
        base: chain['base'],
        patches: (chain['patches'] as unknown[]).slice(0, 1),
      }),
    );
    const snapshot = PatchChain.from_dict(
      chainFromExport as Parameters<typeof PatchChain.from_dict>[0],
    );
    const raw = rawEntry(snapshot.assemble(), 'k-1');
    expect(raw['archived']).toBeFalsy(); // 回退到归档前 = 活跃状态
  });
});

describe('种子注入（幂等：重复初始化不覆盖演化）', () => {
  it('同 id 跳过，已演化内容保留', () => {
    const ks = new KnowledgeSet('u1');
    expect(seed_knowledge_set(ks, [entry()])).toBe(1);
    ks.update('k-1', { data: { rule: { message: '使用中修正' } } });
    expect(seed_knowledge_set(ks, [entry()])).toBe(0); // 已存在，跳过
    const data = ks.get('k-1')!.data;
    expect((data['rule'] as JsonRecord)['message']).toBe('使用中修正');
  });
});

describe('分层晋升（先沉淀后压缩，顺序固定）', () => {
  it('晋升链路：工作 → 项目 → 用户（不跳级，id 稳定）', () => {
    const ks = new KnowledgeSet('u1');
    ks.add(entry());
    let promoted = ks.promote('k-1'); // work → project
    expect(promoted.level).toBe(LEVEL_PROJECT);
    promoted = ks.promote('k-1'); // project → user
    expect(promoted.level).toBe(LEVEL_USER);
    expect(ks.get('k-1')!.id).toBe('k-1'); // 身份跨层级稳定
    expect(() => ks.promote('k-1')).toThrow(/最高层级/);
  });

  it('跳级晋升拒绝（先沉淀后压缩，顺序固定）', () => {
    const ks = new KnowledgeSet('u1');
    ks.add(entry());
    expect(() => ks.promote('k-1', { to_level: LEVEL_USER })).toThrow(/逐级向上/);
  });

  it('晋升不存在的条目拒绝', () => {
    const ks = new KnowledgeSet('u1');
    expect(() => ks.promote('ghost')).toThrow(/不存在/);
  });
});

describe('内部基类与公开类的组合形态', () => {
  it('KnowledgeSet 同时具备基类写读与公开类检索能力', () => {
    const ks = new KnowledgeSet('u1');
    ks.add(entry('k-1', LEVEL_WORK, { tags: ['x'] }));
    expect(ks.entries().length).toBe(1);
    expect(ks.search('x').length).toBe(1);
  });

  it('KnowledgeSetBase 独立可用（内部形态保留）', () => {
    const base = new KnowledgeSetBase('u1');
    base.add(entry('k-1'));
    expect(base.get('k-1')).not.toBeNull();
  });
});