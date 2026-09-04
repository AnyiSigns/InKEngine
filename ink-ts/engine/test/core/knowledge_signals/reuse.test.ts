/**
 * 复用优先于生成单测（Python test_knowledge_incubator.py 复用面移植）。
 *
 * 语义检查点：检索命中 → 跳过重新蒸馏（蒸馏器不被调用，组合断言
 * reused_first）、未命中 → 走蒸馏（产物带来源与可检索标签）、蒸馏产物
 * 来源取 SOURCE_RANK 最高者（ENG1-12：非 signals[0]）、两路皆空 → note
 * 说明不产出空知识、ReuseDecision 序列化（命中条目 id 清单）。
 */

import { describe, expect, it } from 'vitest';

import { KIND_RULE, LEVEL_WORK } from '../../../src/core/knowledge_set/_types.js';
import { KnowledgeEntry } from '../../../src/core/knowledge_set/knowledge_entry.js';
import { KnowledgeSet } from '../../../src/core/knowledge_set/knowledge_set.js';
import {
  SIGNAL_INSIGHT,
  SIGNAL_PITFALL,
  SIGNAL_USER_CORRECTION,
  SOURCE_RANK,
  DeterministicDistiller,
  ExecutionSignal,
  ReuseDecision,
  reuse_or_distill,
} from '../../../src/core/knowledge_signals/index.js';
import type { Distiller, ExecutionSignal as Signal } from '../../../src/core/knowledge_signals/index.js';

function ruleEntry(entry_id = 'k-1'): KnowledgeEntry {
  return new KnowledgeEntry({
    id: entry_id,
    level: LEVEL_WORK,
    kind: KIND_RULE,
    data: { rule: { message: `规则 ${entry_id}` } },
    source: 'model',
    credibility: 0.7,
    title: `条目 ${entry_id}`,
    tags: ['测试'],
  });
}

describe('复用优先于生成', () => {
  it('检索命中优先于重新蒸馏——命中时蒸馏器不被调用', () => {
    const ks = new KnowledgeSet('u1');
    ks.add(
      new KnowledgeEntry({
        id: 'k-1',
        level: LEVEL_WORK,
        kind: KIND_RULE,
        data: { rule: { message: '角色一致性规则' } },
        source: 'model',
        credibility: 0.8,
        title: '角色一致性',
        tags: ['角色'],
      }),
    );
    const shouldNotCall: Distiller = {
      distill: () => {
        throw new Error('复用命中时不得重新蒸馏');
      },
    };
    const signals: Signal[] = [
      new ExecutionSignal({ kind: SIGNAL_INSIGHT, message: '角色经验', source: 'model' }),
    ];
    const decision = reuse_or_distill(ks, '角色', signals, shouldNotCall);
    expect(decision.reused_first).toBe(true);
    expect(decision.reused[0]!.id).toBe('k-1');
    expect(decision.distilled).toBeNull();
    expect(decision.note).toContain('跳过重新蒸馏');
  });

  it('未命中复用 → 走蒸馏，产物带来源与可检索标签', () => {
    const ks = new KnowledgeSet('u1');
    const signals: Signal[] = [
      new ExecutionSignal({ kind: SIGNAL_USER_CORRECTION, message: '用户反例', source: 'user' }),
    ];
    const decision = reuse_or_distill(ks, '全新场景', signals, new DeterministicDistiller());
    expect(decision.reused).toEqual([]);
    expect(decision.distilled).not.toBeNull();
    expect((decision.distilled!.data.insight as { message: string }).message).toBe('用户反例');
    expect(decision.distilled!.source).toBe('user');
    expect(decision.distilled!.tags).toEqual(['全新场景']); // 可再检索
  });

  it('ENG1-12：蒸馏产物来源取 SOURCE_RANK 最高者（非 signals[0]）', () => {
    const ks = new KnowledgeSet('u1');
    // web 信号在前、model 信号在后：旧实现取 web，新实现取 model
    const signals: Signal[] = [
      new ExecutionSignal({ kind: SIGNAL_INSIGHT, message: 'web 经验', source: 'web' }),
      new ExecutionSignal({ kind: SIGNAL_INSIGHT, message: '模型经验', source: 'model' }),
    ];
    const decision = reuse_or_distill(ks, '全新场景', signals, new DeterministicDistiller());
    expect(decision.distilled).not.toBeNull();
    expect(decision.distilled!.source).toBe('model');
    expect(SOURCE_RANK.user!).toBeGreaterThan(SOURCE_RANK.model!);
    expect(SOURCE_RANK.model!).toBeGreaterThan(SOURCE_RANK.dialog!);
    expect(SOURCE_RANK.dialog!).toBeGreaterThan(SOURCE_RANK.web!);
    // 蒸馏可用信号全噪音时按全部信号取最高来源（web 不因位置靠前胜出）
    const noisy: Signal[] = [
      new ExecutionSignal({ kind: SIGNAL_PITFALL, message: '试错', source: 'web' }),
      new ExecutionSignal({ kind: SIGNAL_PITFALL, message: '试错2', source: 'dialog' }),
    ];
    const decision2 = reuse_or_distill(ks, '新词', noisy, new DeterministicDistiller());
    expect(decision2.distilled).toBeNull(); // 无可沉淀素材
    // 只有一条可用信号 = 该信号来源
    const single: Signal[] = [
      new ExecutionSignal({ kind: SIGNAL_INSIGHT, message: '经验', source: 'dialog' }),
    ];
    const decision3 = reuse_or_distill(ks, '单源', single, new DeterministicDistiller());
    expect(decision3.distilled).not.toBeNull();
    expect(decision3.distilled!.source).toBe('dialog');
  });

  it('两路皆空（无命中 + 蒸馏无产物）→ note 说明，不产出空知识', () => {
    const ks = new KnowledgeSet('u1');
    const signals: Signal[] = [
      new ExecutionSignal({ kind: SIGNAL_PITFALL, message: '试错', source: 'model' }),
    ];
    const decision = reuse_or_distill(ks, '新词', signals, new DeterministicDistiller());
    expect(decision.reused).toEqual([]);
    expect(decision.distilled).toBeNull();
    expect(decision.note).toContain('未命中');
  });

  it('ReuseDecision 序列化（复用命中的条目引用清单）', () => {
    const decision = new ReuseDecision({
      reused: [ruleEntry('k-1')],
      note: '复用检索命中，跳过重新蒸馏',
    });
    const data = decision.to_dict();
    expect(data.reused).toEqual(['k-1']);
    expect(data.distilled).toBeUndefined();
    expect(decision.reused_first).toBe(true);
  });
});