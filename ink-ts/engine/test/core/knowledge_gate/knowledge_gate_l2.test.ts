/**
 * L2 效果评估关测试（对标 Python test_knowledge_incubator.py test_l2_* 段
 * 与 test_tuning.py 的执行器 seam 语义）。
 *
 * 覆盖：样例测试非谈判项（语义错误被 fixture 拦截、正确规则 accuracy=1.0）；
 * 历史回归用例采样计入评估；无执行语义条目跳过规则执行并显式放行留痕；
 * 规则条目缺 data.rule / 声明引用未注册谓词 = 显式失败；tool_rule 与 rule
 * 同语义；context_rules 合并评估；确定性时间 seam（monotonic 注入）。
 *
 * 延后（defer）：executor/LLM-钩子集成用例（LLM 判定谓词经规则钩子接入
 * 样例闸门的 fail-open/fail-closed 语义归 rules 套件；领域执行器注入形态
 * 如 ParamRegressionExecutor 的整链过闸归宿主装配层套件），本套件只用
 * 确定性规则引擎执行器。
 */
import { describe, expect, it } from 'vitest';

import {
  GateL2FixtureExecutor,
  KnowledgeGate,
} from '../../../src/core/knowledge_gate/index.js';
import { FixtureCase, FixtureSet } from '../../../src/core/rules/index.js';
import {
  entry_of,
  fixtures,
  rule_entry,
  rule_registry,
} from './knowledge_gate_helpers.js';

function gate(): KnowledgeGate {
  return new KnowledgeGate({ registry: rule_registry() });
}

function good_rule(): ReturnType<typeof rule_entry> {
  return rule_entry('语义正确规则', 'bad');
}

describe('L2 效果评估：样例测试非谈判项', () => {
  it('语义错误规则被 fixture 拦截，正确规则通过且 accuracy=1.0', async () => {
    const g = gate();
    const bad = await g.check_l2(rule_entry('语义错误规则', 'ok'), fixtures());
    expect(bad.passed).toBe(false);
    expect(bad.note).toContain('样例闸门');
    expect(bad.accuracy).toBe(0.0);

    const good = await g.check_l2(good_rule(), fixtures());
    expect(good.passed).toBe(true);
    expect(good.accuracy).toBe(1.0);
  });

  it('历史回归用例采样计入评估（追加样例）', async () => {
    const g = gate();
    const regression = new FixtureSet({
      name: 'reg',
      cases: [
        new FixtureCase({
          id: 'r1',
          data: { value: 'bad' },
          expected_pass: false,
          expected_kinds: ['rule'],
        }),
      ],
    });
    const l2 = await g.check_l2(good_rule(), fixtures(), { regression });
    expect(l2.passed).toBe(true);
    expect(l2.regression_samples).toBe(1);
  });

  it('回归合并但执行失败时结果原样返回（失败优先于回归计数）', async () => {
    const g = gate();
    const regression = new FixtureSet({
      name: 'reg',
      cases: [
        new FixtureCase({
          id: 'r1',
          data: { value: 'ok' },
          expected_pass: false,
          expected_kinds: ['rule'],
        }),
      ],
    });
    const l2 = await g.check_l2(rule_entry('语义错误规则', 'ok'), fixtures(), {
      regression,
    });
    expect(l2.passed).toBe(false);
    expect(l2.regression_samples).toBe(0);
  });

  it('无执行语义条目跳过规则执行并显式放行留痕', async () => {
    const g = new KnowledgeGate();
    for (const kind of ['insight', 'template', 'weight', 'path', 'script']) {
      const l2 = await g.check_l2(entry_of(kind), fixtures());
      expect(l2.passed).toBe(true);
      expect(l2.note).toContain('L2 跳过规则执行');
    }
  });

  it('规则条目缺 data.rule 声明 = 显式失败', async () => {
    const g = gate();
    const l2 = await g.check_l2(entry_of('rule'), fixtures());
    expect(l2.passed).toBe(false);
    expect(l2.note).toContain('缺 data.rule 声明');
  });

  it('规则声明引用未注册谓词 = 规则声明非法（建图期拒绝）', async () => {
    const g = gate();
    const entry = entry_of('rule', {
      rule: {
        id: 'r-1',
        message: '未注册谓词规则',
        predicate: 'nope',
        config: { forbid: 'bad' },
        kind: 'rule',
      },
    });
    const l2 = await g.check_l2(entry, fixtures());
    expect(l2.passed).toBe(false);
    expect(l2.note).toContain('规则声明非法');
  });

  it('tool_rule 与 rule 同语义（规则引擎执行）', async () => {
    const g = gate();
    const entry = entry_of('tool_rule', {
      rule: {
        id: 'r-1',
        message: '工具规则',
        predicate: 'forbid_value',
        config: { forbid: 'bad' },
        kind: 'rule',
      },
    });
    const l2 = await g.check_l2(entry, fixtures());
    expect(l2.passed).toBe(true);
    expect(l2.accuracy).toBe(1.0);
  });

  it('context_rules 合并评估（旧集 + 候选按整套语义共同判定）', async () => {
    const g = gate();
    const contextRules = {
      name: 'old',
      rules: [
        {
          id: 'old-1',
          message: '旧规则',
          predicate: 'forbid_value',
          config: { forbid: 'old' },
          kind: 'rule',
        },
      ],
    };
    const l2 = await g.check_l2(good_rule(), fixtures(), { context_rules: contextRules });
    expect(l2.passed).toBe(true);
    expect(l2.accuracy).toBe(1.0);
  });

  it('确定性时间 seam：monotonic 注入后 latency_ms 留痕', async () => {
    const ticks = [0, 0.5];
    let index = 0;
    const executor = new GateL2FixtureExecutor(rule_registry(), {
      monotonic: () => ticks[index++] ?? 0,
    });
    const g = new KnowledgeGate({ l2_executor: executor });
    const l2 = await g.check_l2(good_rule(), fixtures());
    expect(l2.passed).toBe(true);
    expect(l2.latency_ms).toBe(500);
    // 缺省 monotonic = 恒 0（确定性基线）
    const plain = new GateL2FixtureExecutor(rule_registry());
    const plainL2 = await new KnowledgeGate({ l2_executor: plain }).check_l2(
      good_rule(),
      fixtures(),
    );
    expect(plainL2.latency_ms).toBe(0);
  });
});
