/**
 * 内置种子知识集封装单测：通用种子/注入幂等/序列化契约。
 *
 * 语义检查点：
 * - 通用种子 = 最小可用空壳（默认编排模板 + 默认权重阈值），不含领域成品；
 * - 注入幂等（重复初始化不覆盖使用中演化——种子只读基线语义）；
 * - 领域深度归产品层：产品自写领域知识直接注入（seed_knowledge_set），
 *   机制层不持有领域注册表；
 * - 种子可信度 = 统一来源分级表最高档（用户确认级）。
 *
 * 迁移边界说明：真实存储/执行器侧用例（持久化落库、闸门落库路径）不在
 * 本文件范围——种子注入为纯内存链语义（缺省 storage=null），持久化面
 * 由 knowledge_set_persist 覆盖；真实存储用例照此 defer，待存储面迁移
 * 后补齐。
 */

import { describe, expect, it } from 'vitest';

import { deepEqual } from '../../../src/core/json.js';
import {
  KIND_TEMPLATE,
  KIND_WEIGHT,
  KnowledgeEntry,
  KnowledgeSet,
} from '../../../src/core/knowledge_set/index.js';
import {
  GENERAL_TEMPLATE_SEED_ID,
  GENERAL_WEIGHTS_SEED_ID,
  SEED_CREDIBILITY,
  build_general_seed_entries,
  seed_general,
} from '../../../src/core/seeds/seeds.js';

describe('通用种子 = 最小可用空壳（模板 + 权重阈值，不含领域成品）', () => {
  it('条目集合恰为两个稳定 id 的种子，kind 与数据形态对齐', () => {
    const entries = build_general_seed_entries();
    const byId = new Map(entries.map((e) => [e.id, e]));
    expect(byId.size).toBe(2);
    expect(byId.has(GENERAL_TEMPLATE_SEED_ID)).toBe(true);
    expect(byId.has(GENERAL_WEIGHTS_SEED_ID)).toBe(true);
    const template = byId.get(GENERAL_TEMPLATE_SEED_ID)!;
    const weights = byId.get(GENERAL_WEIGHTS_SEED_ID)!;
    expect(template.kind).toBe(KIND_TEMPLATE);
    const templateData = template.data['template'] as { plan?: { steps?: unknown } };
    expect(templateData.plan?.steps).toBeTruthy();
    expect(weights.kind).toBe(KIND_WEIGHT);
    expect(weights.data['weights']).toBeTruthy();
    expect(weights.data['thresholds']).toBeTruthy();
    expect(entries.every((e) => e.id.startsWith('seed.general.'))).toBe(true);
  });

  it('通用种子注入幂等（种子只读基线：重复初始化不覆盖演化）', () => {
    const ks = new KnowledgeSet('u1');
    expect(seed_general(ks)).toBe(2);
    // 使用中演化种子条目（模拟用户打磨模板）
    ks.update(GENERAL_TEMPLATE_SEED_ID, {
      data: { template: { name: '打磨后' } },
    });
    expect(seed_general(ks)).toBe(0); // 幂等：已存在跳过
    const item = ks.get(GENERAL_TEMPLATE_SEED_ID)!;
    const templateData = item.data['template'] as { name?: unknown };
    expect(templateData.name).toBe('打磨后');
  });

  it('通用种子条目可序列化（补丁链落库/导出的数据契约）', () => {
    for (const entry of build_general_seed_entries()) {
      const rebuilt = KnowledgeEntry.from_dict(entry.to_dict());
      expect(deepEqual(rebuilt.to_dict(), entry.to_dict())).toBe(true);
    }
  });

  it('种子可信度 = 统一来源分级表最高档（用户确认级 0.9）', () => {
    expect(SEED_CREDIBILITY).toBe(0.9);
    expect(
      build_general_seed_entries().every((e) => e.credibility === SEED_CREDIBILITY),
    ).toBe(true);
  });
});