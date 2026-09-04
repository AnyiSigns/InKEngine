/**
 * 知识集注册为检索源（E-P6 Retriever 注册路线）单测。
 *
 * 覆盖：检索命中 → 可信度分级透传 level + meta（weight=credibility 注入
 * 面）、正文渲染透传、知识集实例延迟取用（链恢复替换实例后仍读到最新）。
 *
 * 迁移边界说明（延迟项）：真实知识闸门与指令注入扫描（knowledge_gate
 * 未迁移）不经本路径验证——知识条目照例经注册表的注入防线 seam 统一墙防
 * （剔除行为见 retrieval_registry.test.ts 的假扫描器用例）；与下游上下文
 * 装配/执行器联动的集成用例未移植。
 */

import { describe, expect, it } from 'vitest';

import { KnowledgeSet } from '../../../src/core/knowledge_set/knowledge_set.js';
import {
  SOURCE_DIALOG,
  SOURCE_USER,
  SOURCE_WEB,
} from '../../../src/core/retrieval/_types.js';
import { KnowledgeSetRetriever } from '../../../src/core/retrieval/knowledge_set_retriever.js';
import { RetrieverRegistry } from '../../../src/core/retrieval/retriever_registry.js';
import { knowledge_entry } from './retrieval_helpers.js';

describe('知识集注册为检索源（weight=credibility 注入面）', () => {
  it('检索命中 → 可信度分级透传 level + meta', async () => {
    const ks = new KnowledgeSet('u1');
    ks.add(knowledge_entry('k-web', 0.3, 'web'));
    ks.add(knowledge_entry('k-dialog', 0.6, 'dialog'));
    ks.add(knowledge_entry('k-user', 0.9, 'user'));
    const registry = new RetrieverRegistry();
    registry.register(new KnowledgeSetRetriever(ks));
    const chunks = await registry.retrieve('知识', { limit: 8 });
    const byId = new Map(chunks.map((c) => [c.meta['entry_id'], c]));
    expect(byId.get('k-web')!.level).toBe(SOURCE_WEB);
    expect(byId.get('k-dialog')!.level).toBe(SOURCE_DIALOG);
    expect(byId.get('k-user')!.level).toBe(SOURCE_USER);
    expect(byId.get('k-web')!.meta['credibility']).toBe(0.3);
    expect(byId.get('k-user')!.meta['credibility']).toBe(0.9);
    // 正文随 chunk 透传（渲染形态，与注入渲染同源）
    expect(byId.get('k-user')!.text).toContain('规则 k-user');
  });

  it('知识集实例延迟取用：替换实例后检索源仍读到最新', async () => {
    const holder: { ks: KnowledgeSet } = { ks: new KnowledgeSet('u1') };
    const retriever = new KnowledgeSetRetriever(() => holder.ks);
    const registry = new RetrieverRegistry();
    registry.register(retriever);
    holder.ks.add(knowledge_entry('k-1', 0.9, 'user'));
    const first = await registry.retrieve('知识', { limit: 8 });
    expect(first.map((c) => c.doc_id)).toEqual(['k-1']);

    // 替换实例（重启后链恢复语义）→ 检索命中新实例
    const fresh = new KnowledgeSet('u1');
    fresh.add(knowledge_entry('k-2', 0.8, 'model'));
    holder.ks = fresh;
    const second = await registry.retrieve('知识', { limit: 8 });
    expect(second.map((c) => c.doc_id)).toEqual(['k-2']);
  });
});