/**
 * 知识集条目读写单测（种子注入/补丁链演化/精准修正 path 补丁结构适配）。
 *
 * 语义检查点：新增条目落链可读回、同 id 重复添加拒绝（防静默覆盖）、
 * 修正 = 精准补丁（data 顶层合并 / 嵌套深路径 replace 只改对应段落 /
 * 显式 null 合法）、身份字段不可修正、删除幂等、演化历史 append-only
 * 可回退、调用留痕（usage/fail 计数 + 失败日志截尾）、变更钩子每次
 * 内存链变更后同步触发。
 */

import { describe, expect, it } from 'vitest';

import type { Json, JsonRecord } from '../../../src/core/json.js';
import { PatchChain } from '../../../src/core/patch/patchChain.js';
import { KnowledgeEntry } from '../../../src/core/knowledge_set/knowledge_entry.js';
import { KnowledgeSet } from '../../../src/core/knowledge_set/knowledge_set.js';
import { LEVEL_WORK } from '../../../src/core/knowledge_set/_types.js';
import { entry, rawEntry } from './knowledge_helpers.js';

describe('新增与读取', () => {
  it('新增条目落链，get 可取回（补丁链组装）', () => {
    const ks = new KnowledgeSet('u1');
    ks.add(entry());
    const item = ks.get('k-1');
    expect(item).not.toBeNull();
    expect(item!.id).toBe('k-1');
    expect(item!.level).toBe(LEVEL_WORK);
    expect(item!.credibility).toBe(0.7);
  });

  it('同 id 重复添加拒绝（防静默覆盖既有知识）', () => {
    const ks = new KnowledgeSet('u1');
    ks.add(entry());
    expect(() => ks.add(entry())).toThrow(/已存在/);
  });

  it('删除幂等（不存在返回 false）', () => {
    const ks = new KnowledgeSet('u1');
    ks.add(entry());
    expect(ks.remove('k-1')).toBe(true);
    expect(ks.remove('k-1')).toBe(false);
    expect(ks.get('k-1')).toBeNull();
  });

  it('未知层级过滤拒绝', () => {
    const ks = new KnowledgeSet('u1');
    ks.add(entry());
    expect(() => ks.entries('archive')).toThrow(/未知知识层级/);
  });
});

describe('修正（精准补丁：只改对应字段，不重写整条）', () => {
  it('data 顶层合并：只替换现有 data 顶层对应键', () => {
    const ks = new KnowledgeSet('u1');
    ks.add(entry());
    const updated = ks.update('k-1', {
      data: { rule: { message: '新规则' } },
    });
    expect((updated.data['rule'] as JsonRecord)['message']).toBe('新规则');
    expect(updated.credibility).toBe(0.7); // 未变更字段保持
    expect(updated.title).toBe('条目 k-1');
  });

  it('嵌套精准补丁：沿路径只改对应段落，兄弟字段与顶层均不受影响', () => {
    const ks = new KnowledgeSet('u1');
    ks.add(
      entry('k-1', LEVEL_WORK, {
        data: {
          rule: {
            id: 'r-1',
            message: '旧消息',
            config: { threshold: 0.5 },
          },
        },
      }),
    );
    const updated = ks.update('k-1', {
      path: ['rule', 'config', 'threshold'],
      value: 0.9,
    });
    const rule = updated.data['rule'] as JsonRecord;
    expect((rule['config'] as JsonRecord)['threshold']).toBe(0.9);
    expect(rule['message']).toBe('旧消息'); // 兄弟字段不受影响
    expect(rule['id']).toBe('r-1');
    expect(updated.credibility).toBe(0.7); // 顶层字段不受影响

    // 显式写入 null 合法（值哨兵区分「未传」与「传 null」）
    const cleared = ks.update('k-1', { path: ['rule', 'config'], value: null });
    const clearedRule = cleared.data['rule'] as JsonRecord;
    expect(clearedRule['config']).toBeNull();
    expect(clearedRule['message']).toBe('旧消息');
  });

  it('data 与 path 互斥（一次修正只走一种精准语义）', () => {
    const ks = new KnowledgeSet('u1');
    ks.add(entry());
    expect(() =>
      ks.update('k-1', {
        data: { x: 1 },
        path: ['rule', 'message'],
        value: 'v',
      }),
    ).toThrow(/二选一/);
  });

  it('嵌套精准补丁缺 value → 拒绝（显式值语义）', () => {
    const ks = new KnowledgeSet('u1');
    ks.add(entry());
    expect(() => ks.update('k-1', { path: ['rule', 'message'] })).toThrow(
      /缺 value/,
    );
  });

  it('身份字段（id/created_at）不可修正', () => {
    const ks = new KnowledgeSet('u1');
    ks.add(entry());
    expect(() =>
      ks.update('k-1', { changes: { id: 'k-other' } }),
    ).toThrow(/身份字段/);
    expect(() =>
      ks.update('k-1', { changes: { created_at: 1 } }),
    ).toThrow(/身份字段/);
  });

  it('修正不存在的条目拒绝', () => {
    const ks = new KnowledgeSet('u1');
    expect(() => ks.update('ghost', { changes: { title: 'x' } })).toThrow(
      /不存在/,
    );
  });
});

describe('演化历史（append-only，可回退）', () => {
  it('修正/删除后链历史仍在，回退 = 组装前段补丁', () => {
    const ks = new KnowledgeSet('u1');
    ks.add(entry());
    ks.update('k-1', { data: { rule: { message: '修正版' } } });
    const chainData = ks.export();
    expect((chainData['patches'] as unknown[]).length).toBe(2); // 新增 + 修正各一补丁

    // 回退到仅新增补丁 = 原始版本
    const chain = ks.export();
    const snapshot = PatchChain.from_dict(
      JSON.parse(
        JSON.stringify({
          base: chain['base'],
          patches: (chain['patches'] as unknown[]).slice(0, 1),
        }),
      ) as {
        base: { [key: string]: Json };
        patches: Array<{
          op: 'append' | 'replace' | 'delete';
          path: (string | number)[];
          value: Json;
        }>;
      },
    );
    const raw = rawEntry(snapshot.assemble(), 'k-1');
    expect((raw['data'] as JsonRecord)['rule']).toEqual({
      message: '规则 k-1',
    });
  });

  it('调用留痕：usage/fail 计数累积；失败日志留存（反思式变异的输入）', () => {
    const ks = new KnowledgeSet('u1');
    ks.add(entry());
    ks.record_usage('k-1');
    ks.record_usage('k-1', { failed: true, log: '目标不存在: 引用悬空' });
    ks.record_usage('k-1', { failed: true, log: '边界校验越界' });
    const item = ks.get('k-1')!;
    expect(item.usage_count).toBe(3);
    expect(item.fail_count).toBe(2);
    expect(item.failure_logs).toEqual(['目标不存在: 引用悬空', '边界校验越界']);
    // 序列化往返保留失败日志（导出/导入可移植）
    const rebuilt = KnowledgeEntry.from_dict(item.to_dict());
    expect(rebuilt.failure_logs).toEqual(item.failure_logs);
  });

  it('对不存在的条目留痕为静默跳过', () => {
    const ks = new KnowledgeSet('u1');
    expect(() => ks.record_usage('ghost', { failed: true, log: 'x' })).not.toThrow();
  });
});

describe('变更钩子（关键路径显式持久化的接线点）', () => {
  it('add/update/record_usage/remove 后同步触发', () => {
    const events: string[] = [];
    const ks = new KnowledgeSet('u1', { on_mutation: () => events.push('mutated') });
    ks.add(entry('k-1'));
    ks.record_usage('k-1');
    ks.update('k-1', { data: { rule: { message: 'v2' } } });
    ks.remove('k-1');
    expect(events.length).toBe(4);
  });

  it('钩子异常不阻断主流程', () => {
    const ks = new KnowledgeSet('u1', {
      on_mutation: () => {
        throw new Error('钩子失败');
      },
    });
    expect(() => ks.add(entry('k-1'))).not.toThrow();
    expect(ks.get('k-1')).not.toBeNull();
  });
});