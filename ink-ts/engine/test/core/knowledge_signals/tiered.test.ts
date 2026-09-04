/**
 * 蒸馏挡位建链与挡位蒸馏器单测（Python test_knowledge_incubator.py 挡位面移植）。
 *
 * 语义检查点：DistillConfig 序列化 round-trip 与默认值（开关开启 +
 * router 挡位）、resolve_distill_chain（router_config 建链 / router
 * 缺失回落 main_config / 双缺返回 null）、TieredDistiller 开关关闭恒
 * 停用、开关开启链缺失回落确定性基线、异步 LLM 蒸馏回调成功走产物/
 * 失败 fail-open 回落确定性。
 */

import { describe, expect, it } from 'vitest';

import type { JsonRecord } from '../../../src/core/json.js';
import {
  SIGNAL_INSIGHT,
  DistillConfig,
  ExecutionSignal,
  TieredDistiller,
  resolve_distill_chain,
} from '../../../src/core/knowledge_signals/index.js';

const ROUTER_MODEL_CONFIG: JsonRecord = {
  router_config: {
    adapter: 'openai_compat',
    model_id: 'router',
    base_url: 'http://r',
  },
  main_config: {
    adapter: 'openai_compat',
    model_id: 'main',
    base_url: 'http://m',
  },
};

describe('DistillConfig 序列化', () => {
  it('round-trip（开关 + 建链挡位）', () => {
    const config = new DistillConfig({ enabled: false, tier: 'router' });
    const rebuilt = DistillConfig.from_dict(config.to_dict());
    expect(rebuilt.enabled).toBe(false);
    expect(rebuilt.tier).toBe('router');
  });

  it('默认：开关开启 + router 挡位建链', () => {
    const config = new DistillConfig();
    expect(config.enabled).toBe(true);
    expect(config.tier).toBe('router');
  });
});

describe('蒸馏挡位建链（resolve_distill_chain）', () => {
  it('router_config 存在 → router 挡位链', () => {
    const chain = resolve_distill_chain(ROUTER_MODEL_CONFIG, 'router');
    expect(chain).not.toBeNull();
    expect(chain!.configs[0]!.model_id).toBe('router');
  });

  it('router_config 缺失 → 回落 main_config（挡位统一回落语义）', () => {
    const chain = resolve_distill_chain(
      { main_config: { adapter: 'openai_compat', model_id: 'main', base_url: 'http://m' } },
      'router',
    );
    expect(chain).not.toBeNull();
    expect(chain!.configs[0]!.model_id).toBe('main');
  });

  it('router/main 均无配置 → null（回落确定性蒸馏基线）', () => {
    expect(resolve_distill_chain(null, 'router')).toBeNull();
    expect(resolve_distill_chain({}, 'router')).toBeNull();
  });
});

describe('TieredDistiller（开关 + 链缺失回落）', () => {
  it('distill_enabled=False：触发判定恒 False、蒸馏恒无产物', () => {
    const distiller = new TieredDistiller({ config: new DistillConfig({ enabled: false }) });
    expect(distiller.should_distill({ complexity: 10, interventions: 5 })).toBe(false);
    const signals = [new ExecutionSignal({ kind: SIGNAL_INSIGHT, message: '经验', source: 'model' })];
    expect(distiller.distill(signals)).toBeNull();
  });

  it('开关开启但链缺失（无挡位配置）→ 回落确定性蒸馏基线', () => {
    const distiller = new TieredDistiller({ config: new DistillConfig(), chain: null });
    expect(distiller.should_distill({ complexity: 5, interventions: 0 })).toBe(true);
    const signals = [
      new ExecutionSignal({ kind: SIGNAL_INSIGHT, message: '成功经验', source: 'model' }),
    ];
    const data = distiller.distill(signals);
    expect(data).not.toBeNull();
    expect((data!.insight as { message: string }).message).toBe('成功经验');
  });

  it('异步入口：LLM 回调异常 → fail-open 回落确定性基线', async () => {
    const distiller = new TieredDistiller({ config: new DistillConfig(), chain: {} });
    const signals = [new ExecutionSignal({ kind: SIGNAL_INSIGHT, message: '经验', source: 'model' })];
    const data = await distiller.distill_async(signals, {
      llm_distill: async () => {
        throw new Error('LLM 蒸馏失败');
      },
    });
    expect(data).not.toBeNull(); // fail-open：LLM 失败不阻断沉淀
    expect((data!.insight as { message: string }).message).toBe('经验');
  });

  it('异步入口：LLM 回调产出 → 使用 LLM 蒸馏产物（不经确定性）', async () => {
    const distiller = new TieredDistiller({ config: new DistillConfig(), chain: {} });
    const signals = [new ExecutionSignal({ kind: SIGNAL_INSIGHT, message: 'x', source: 'model' })];
    const data = await distiller.distill_async(signals, {
      llm_distill: async () => ({ kind: 'insight', insight: { message: 'LLM 蒸馏产物' } }),
    });
    expect((data!.insight as { message: string }).message).toBe('LLM 蒸馏产物');
  });
});