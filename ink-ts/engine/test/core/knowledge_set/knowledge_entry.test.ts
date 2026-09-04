/**
 * 知识条目结构/序列化单测（知识条目 = 补丁链数据，来源分级 + 可信度 +
 * 渲染 + 上下文源适配）。
 *
 * 语义检查点：来源分级默认可信度（web 最低、用户确认最高，防 web 注入
 * 污染）、显式可信度优先、层级/可信度越界在构造期拒绝、渲染层软上限
 * 截断、条目 → ContextSource 适配（type=层级、weight=可信度）。
 */

import { describe, expect, it } from 'vitest';

import { ContextSource } from '../../../src/core/context/context_types.js';
import { KnowledgeEntry } from '../../../src/core/knowledge_set/knowledge_entry.js';
import { LEVEL_WORK } from '../../../src/core/knowledge_set/_types.js';
import { default_credibility } from '../../../src/core/knowledge_set/_types.js';
import { entry } from './knowledge_helpers.js';

describe('来源分级与默认可信度', () => {
  it('来源可信度分级：web 最低、用户确认最高（防 web 注入污染）', () => {
    const web = KnowledgeEntry.from_dict({
      id: 'k-web',
      level: 'work',
      kind: 'demo',
      data: {},
      source: 'web',
    });
    const user = KnowledgeEntry.from_dict({
      id: 'k-user',
      level: 'work',
      kind: 'demo',
      data: {},
      source: 'user',
    });
    expect(web.credibility).toBe(0.3);
    expect(user.credibility).toBe(0.9);
    expect(default_credibility('web')).toBeLessThan(default_credibility('user'));
    // 显式声明的可信度优先于来源默认
    const explicit = KnowledgeEntry.from_dict({
      id: 'k-x',
      level: 'work',
      kind: 'demo',
      data: {},
      source: 'web',
      credibility: 0.8,
    });
    expect(explicit.credibility).toBe(0.8);
  });

  it('可信度越界拒绝（构造期暴露）', () => {
    expect(() => entry('k-1', LEVEL_WORK, { credibility: 1.5 })).toThrow(/可信度/);
  });

  it('未知层级拒绝', () => {
    expect(() => entry('k-1', 'archive')).toThrow(/层级非法/);
  });

  it('渲染层软上限：非规则条目 JSON 摘要截断 + 溢出标记', () => {
    const big = new KnowledgeEntry({
      id: 'k-big',
      level: 'work',
      kind: 'template',
      data: { blob: 'x'.repeat(10_000) },
      title: '超长条目',
    });
    const rendered = big.render_content();
    expect(rendered.length).toBeLessThan(5000);
    expect(rendered).toContain('渲染截断');
  });
});

describe('知识条目 → ContextSource 适配', () => {
  it('type=层级、weight=可信度、relevance=任务相关度、去重键与元数据', () => {
    const item = entry('k-1', LEVEL_WORK, { credibility: 0.8, tags: ['t'] });
    const source = item.as_context_source({ relevance: 0.6 });
    expect(source).toBeInstanceOf(ContextSource);
    expect(source.type).toBe(LEVEL_WORK);
    expect(source.weight).toBe(0.8);
    expect(source.relevance).toBe(0.6);
    expect(source.dedup_key).toBe('knowledge:k-1');
    expect(source.meta['entry_id']).toBe('k-1');
    expect(source.meta['source']).toBe('model');
  });

  it('条目正文随源注入（模型可见的正文非空，可重建可留痕）', () => {
    const rule = entry('k-1', LEVEL_WORK, {
      title: '伏笔规则',
      data: {
        rule: {
          id: 'r-1',
          message: '伏笔必须先埋设后回收',
          predicate: 'gap',
          config: {},
          kind: 'demo',
        },
      },
    });
    const source = rule.as_context_source({ relevance: 0.6 });
    expect(source.content).toContain('伏笔规则');
    expect(source.content).toContain('伏笔必须先埋设后回收');

    // 非规则条目 = 紧凑 JSON 摘要（标题 + 结构化内容）
    const plain = entry('k-2', LEVEL_WORK, {
      title: '权重快照',
      data: { weights: { a: 0.5 } },
    });
    expect(plain.as_context_source().content).toContain('权重快照');
    expect(plain.as_context_source().content).toContain('weights');
  });

  it('任务相关度越界拒绝', () => {
    expect(() => entry().as_context_source({ relevance: 1.5 })).toThrow(
      /任务相关度/,
    );
  });
});

describe('序列化往返', () => {
  it('to_dict 省略默认值、往返保留失败日志等字段', () => {
    const item = entry('k-1', LEVEL_WORK, {
      usage_count: 1,
      failure_logs: ['a', 'b'],
    });
    const dict = item.to_dict();
    expect(dict['usage_count']).toBe(1);
    expect(dict['failure_logs']).toEqual(['a', 'b']);
    expect(dict['title']).toBe('条目 k-1');
    expect(dict['archived']).toBeUndefined(); // 默认值省略

    const rebuilt = KnowledgeEntry.from_dict(dict);
    expect(rebuilt.failure_logs).toEqual(['a', 'b']);
    expect(rebuilt.credibility).toBe(0.7);
    expect(rebuilt.id).toBe('k-1');
  });

  it('反序列化校验：缺 id / 缺 kind / data 非 dict 拒绝', () => {
    expect(() => KnowledgeEntry.from_dict({ level: 'work', kind: 'rule' })).toThrow(
      /缺 id/,
    );
    expect(() =>
      KnowledgeEntry.from_dict({ id: 'k-1', level: 'work' }),
    ).toThrow(/缺 kind/);
    expect(() =>
      KnowledgeEntry.from_dict({ id: 'k-1', level: 'work', kind: 'rule', data: 'x' }),
    ).toThrow(/data 须为 dict/);
  });

  it('反序列化校验：tags/失败日志须为字符串清单，计数须为整数', () => {
    expect(() =>
      KnowledgeEntry.from_dict({ ...entry('k-1').to_dict(), tags: [1] }),
    ).toThrow(/tags 须为字符串清单/);
    expect(() =>
      KnowledgeEntry.from_dict({
        ...entry('k-1').to_dict(),
        failure_logs: ['ok', 3],
      }),
    ).toThrow(/failure_logs 须为字符串清单/);
    expect(() =>
      KnowledgeEntry.from_dict({
        ...entry('k-1').to_dict(),
        usage_count: 1.5,
      }),
    ).toThrow(/usage_count 须为整数/);
  });
});