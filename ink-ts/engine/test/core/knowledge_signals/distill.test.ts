/**
 * 蒸馏确定性基线单测（Python test_knowledge_incubator.py 蒸馏面移植）。
 *
 * 语义检查点：按需触发（复杂度/干预双阈值保守）、结构化压缩（保留成功
 * 路径结论 + 用户修正反例优先，丢弃试错分支——踩坑只入 note）、无可用
 * 信号返回 null（不产出空知识）、DistillOutcome 序列化 round-trip、
 * 精准补丁构造（knowledge_set 单一契约点别名）。
 */

import { describe, expect, it } from 'vitest';

import { KIND_INSIGHT } from '../../../src/core/knowledge_set/_types.js';
import { GraphDefinitionError } from '../../../src/core/errors.js';
import {
  SIGNAL_INSIGHT,
  SIGNAL_PITFALL,
  SIGNAL_USER_CORRECTION,
  DeterministicDistiller,
  DistillOutcome,
  ExecutionSignal,
  build_precise_patch,
} from '../../../src/core/knowledge_signals/index.js';

describe('蒸馏按需触发（双阈值保守）', () => {
  it('复杂度或干预超阈值才蒸馏', () => {
    const distiller = new DeterministicDistiller({
      complexity_threshold: 5,
      intervention_threshold: 1,
    });
    expect(distiller.should_distill({ complexity: 3, interventions: 0 })).toBe(false);
    expect(distiller.should_distill({ complexity: 5, interventions: 0 })).toBe(true);
    expect(distiller.should_distill({ complexity: 1, interventions: 1 })).toBe(true);
  });
});

describe('确定性蒸馏压缩', () => {
  it('保留成功路径结论，丢弃试错分支（踩坑只入 note）', () => {
    const distiller = new DeterministicDistiller();
    const signals: ExecutionSignal[] = [
      new ExecutionSignal({ kind: SIGNAL_PITFALL, message: '试错失败A', source: 'model' }),
      new ExecutionSignal({ kind: SIGNAL_PITFALL, message: '试错失败B', source: 'model' }),
      new ExecutionSignal({
        kind: SIGNAL_INSIGHT,
        message: '成功经验',
        source: 'model',
        context: { n: 1 },
      }),
    ];
    const data = distiller.distill(signals);
    expect(data).not.toBeNull();
    expect(data!.kind).toBe(KIND_INSIGHT);
    const insight = data!.insight as { message: string; note: string };
    expect(insight.message).toBe('成功经验');
    expect(insight.note).toContain('试错失败A'); // 失败原因仅留痕
    expect(insight.message).not.toBe('试错失败A');
  });

  it('用户修正反例优先于洞见（反例 = 最可靠教训素材）', () => {
    const distiller = new DeterministicDistiller();
    const signals: ExecutionSignal[] = [
      new ExecutionSignal({ kind: SIGNAL_INSIGHT, message: '模型经验', source: 'model' }),
      new ExecutionSignal({ kind: SIGNAL_USER_CORRECTION, message: '用户反例', source: 'user' }),
    ];
    const data = distiller.distill(signals);
    expect(data).not.toBeNull();
    expect((data!.insight as { message: string }).message).toBe('用户反例');
  });

  it('无可沉淀信号（全是踩坑）→ null（不产出空知识）', () => {
    const distiller = new DeterministicDistiller();
    const signals = [new ExecutionSignal({ kind: SIGNAL_PITFALL, message: '失败', source: 'model' })];
    expect(distiller.distill(signals)).toBeNull();
  });
});

describe('DistillOutcome 序列化', () => {
  it('round-trip（data/source/tags/title 往返无损）', () => {
    const outcome = new DistillOutcome({
      data: { rule: { message: 'm' } },
      source: 'user',
      tags: ['t'],
      title: '标题',
    });
    const rebuilt = DistillOutcome.from_dict(outcome.to_dict());
    expect(rebuilt.data).toEqual(outcome.data);
    expect(rebuilt.source).toBe('user');
    expect(rebuilt.tags).toEqual(['t']);
  });
});

describe('精准补丁构造（单一契约点别名）', () => {
  it('只改对应段落路径（声明 path + value，不重写整条）', () => {
    const patch = build_precise_patch(['rule', 'message'], '新');
    expect(patch).toEqual({ path: ['rule', 'message'], value: '新' });
  });

  it('空路径拒绝（GraphDefinitionError）', () => {
    expect(() => build_precise_patch([], 'x')).toThrow(GraphDefinitionError);
    expect(() => build_precise_patch([], 'x')).toThrow(/不能为空/);
  });
});