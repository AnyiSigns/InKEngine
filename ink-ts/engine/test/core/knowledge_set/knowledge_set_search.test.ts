/**
 * 知识集复用检索单测（关键词命中 + 可信度排序 + CJK 2-gram 滑窗）。
 *
 * 语义检查点：标题/标签/数据文本命中 + 可信度排序、多关键词 AND 语义、
 * 中文长句（装配 query = 回合输入全文，无空格边界）不再必然 0 命中——
 * CJK 长 token 按 2-gram 滑窗展开 + 按命中片段数评分、层级过滤、
 * 默认上限 = DEFAULT_SEARCH_LIMIT（5，魔法数字数据化）。
 */

import { describe, expect, it } from 'vitest';

import { KnowledgeSet } from '../../../src/core/knowledge_set/knowledge_set.js';
import {
  DEFAULT_SEARCH_LIMIT,
  LEVEL_USER,
  LEVEL_WORK,
} from '../../../src/core/knowledge_set/_types.js';
import { entry } from './knowledge_helpers.js';

describe('复用检索：命中与排序', () => {
  it('标题/标签/数据文本命中 + 可信度排序', () => {
    const ks = new KnowledgeSet('u1');
    ks.add(entry('k-1', LEVEL_WORK, { credibility: 0.5, tags: ['伏笔'] }));
    ks.add(
      entry('k-2', LEVEL_WORK, {
        credibility: 0.9,
        tags: ['角色'],
        data: { rule: { message: '角色一致性' } },
      }),
    );
    expect(ks.search('角色').map((h) => h.id)).toEqual(['k-2']);
    // 多关键词 = 全部命中（AND 语义）
    expect(ks.search('角色 一致性')[0]!.id).toBe('k-2');
    expect(ks.search('不存在词')).toEqual([]);
    // 空 query / 非正 limit 直接返回空
    expect(ks.search('')).toEqual([]);
    expect(ks.search('x', { limit: 0 })).toEqual([]);
  });

  it('级别过滤：按层级筛选命中集', () => {
    const ks = new KnowledgeSet('u1');
    ks.add(entry('k-1', LEVEL_WORK, { tags: ['x'] }));
    ks.add(entry('k-2', LEVEL_USER, { tags: ['x'] }));
    expect(ks.search('x', { level: LEVEL_USER }).map((h) => h.id)).toEqual(['k-2']);
  });

  it('默认上限 = DEFAULT_SEARCH_LIMIT（5，魔法数字数据化）', () => {
    expect(DEFAULT_SEARCH_LIMIT).toBe(5);
    const ks = new KnowledgeSet('u1');
    for (let i = 0; i < 8; i++) {
      ks.add(entry(`k-${i}`, LEVEL_WORK, { tags: ['批量'] }));
    }
    expect(ks.search('批量').length).toBe(DEFAULT_SEARCH_LIMIT);
    expect(ks.search('批量', { limit: 3 }).length).toBe(3);
  });

  it('检索不存在的层级拒绝', () => {
    const ks = new KnowledgeSet('u1');
    ks.add(entry('k-1', LEVEL_WORK, { tags: ['x'] }));
    expect(() => ks.search('x', { level: 'archive' })).toThrow(/未知知识层级/);
  });
});

describe('CJK 长句检索（2-gram 滑窗展开 + 部分命中评分）', () => {
  it('中文长句装配 query 不再必然 0 命中，命中片段多者排前', () => {
    const ks = new KnowledgeSet('u1');
    ks.add(entry('k-1', LEVEL_WORK, { credibility: 0.5, tags: ['伏笔'] }));
    ks.add(
      entry('k-2', LEVEL_WORK, {
        credibility: 0.9,
        tags: ['角色'],
        data: { rule: { message: '来源可信度 领域基线 一致性' } },
      }),
    );
    // 长句含「来源可信度」「领域基线」等关键片段 → 命中 k-2（整段塌缩为
    // 1 token 的全词交集实现必然 0 命中）
    const hits = ks.search('请基于来源可信度验证领域基线并确保角色一致性');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.id).toBe('k-2');
    // 命中片段数多的条目排前（评分语义：非全有全无）
    ks.add(entry('k-3', LEVEL_WORK, { credibility: 0.8, tags: ['角色'] }));
    const hits2 = ks.search('角色一致性');
    expect(hits2[0]!.id).toBe('k-2'); // 命中片段更多（角色 + 一致性）
  });
});