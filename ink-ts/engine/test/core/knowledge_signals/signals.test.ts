/**
 * 执行信号与五类分类路由单测（Python test_knowledge_incubator.py 信号面移植；
 * knowledge_signals 目录对应机制件——信号感知/蒸馏/复用）。
 *
 * 语义检查点：五类信号分类路由（踩坑/用户修正/洞见/缺口 + 噪音过滤）、
 * 重复根因升级（同一 root key ≥3 次 → repeated_root_cause，count 聚合、
 * context.repeat_count 留痕）、低于阈值不升级、ExecutionSignal 序列化
 * round-trip（时间 seam 确定值）。
 *
 * 未移植（header 说明）：knowledge_gate 三层闸门（L1 注入/熵启发/最小
 * 功能测试、L2 样例执行、L3 目标筛选）、evolution 进化工厂、rules/
 * schema_validator 依赖面用例属执行器/集成口径，待 knowledge_gate/
 * evolution 等模块迁移后另行对标——本目录只覆盖 knowledge_signals 机制件。
 */

import { describe, expect, it } from 'vitest';

import {
  SIGNAL_GAP,
  SIGNAL_INSIGHT,
  SIGNAL_PITFALL,
  SIGNAL_REPEATED_ROOT_CAUSE,
  SIGNAL_USER_CORRECTION,
  ExecutionSignal,
  SignalClassifier,
} from '../../../src/core/knowledge_signals/index.js';

describe('五类信号分类路由', () => {
  it('分类路由五类信号（确定性基线）', () => {
    const classifier = new SignalClassifier();
    expect(classifier.classify({ type: 'error', message: 'x' })?.kind).toBe(SIGNAL_PITFALL);
    expect(classifier.classify({ type: 'edit', message: 'x' })?.kind).toBe(
      SIGNAL_USER_CORRECTION,
    );
    expect(classifier.classify({ type: 'review_pass', message: 'x' })?.kind).toBe(
      SIGNAL_INSIGHT,
    );
    expect(classifier.classify({ type: 'gap', message: 'x' })?.kind).toBe(SIGNAL_GAP);
    expect(classifier.classify({ type: 'reply_token' })).toBeNull(); // 噪音不沉淀
  });

  it('分类信号默认回落消息模板与来源（无 message 时）', () => {
    const classifier = new SignalClassifier();
    expect(classifier.classify({ type: 'node_error' })?.message).toBe('执行异常: node_error');
    expect(classifier.classify({ type: 'reject' })?.message).toBe('用户修正: reject');
    expect(classifier.classify({ type: 'user_confirm' })?.message).toBe('可复用经验: user_confirm');
    expect(classifier.classify({ type: 'missing_capability' })?.message).toBe('能力缺失（新建候选）');
  });
});

describe('同因聚合：重复根因升级', () => {
  it('同一问题 ≥3 次 → repeated_root_cause（人工确认候选，count 聚合）', () => {
    const classifier = new SignalClassifier();
    const signals = [0, 1, 2].map(() =>
      new ExecutionSignal({ kind: SIGNAL_PITFALL, message: '同一错误', source: 'model' }),
    );
    const upgraded = classifier.aggregate(signals);
    expect(upgraded.every((s) => s.kind === SIGNAL_REPEATED_ROOT_CAUSE)).toBe(true);
    expect(upgraded[0]!.count).toBe(3);
    expect(upgraded[0]!.context.repeat_count).toBe(3);
  });

  it('低于阈值不升级（普通信号原样保留）', () => {
    const classifier = new SignalClassifier();
    const signals = [0, 1].map(() =>
      new ExecutionSignal({ kind: SIGNAL_PITFALL, message: '同一错误', source: 'model' }),
    );
    const upgraded = classifier.aggregate(signals);
    expect(upgraded.every((s) => s.kind === SIGNAL_PITFALL)).toBe(true);
  });
});

describe('ExecutionSignal 序列化', () => {
  it('round-trip（时间 seam 确定值；count>1 与 context 往返无损）', () => {
    const signal = new ExecutionSignal({
      kind: SIGNAL_INSIGHT,
      message: 'm',
      source: 'user',
      context: { k: 1 },
      count: 2,
      clock: { now: () => 1700000000 },
    });
    const rebuilt = ExecutionSignal.from_dict(signal.to_dict());
    expect(rebuilt.to_dict()).toEqual(signal.to_dict());
    expect(rebuilt.timestamp).toBe(1700000000);
  });

  it('默认形态序列化紧凑（context 空/count=1 省略）', () => {
    const signal = new ExecutionSignal({ kind: SIGNAL_INSIGHT, message: 'm' });
    const data = signal.to_dict();
    expect(data.context).toBeUndefined();
    expect(data.count).toBeUndefined();
    expect(data.source).toBe('model');
  });
});