/**
 * 蒸馏 router 角色槽建链与角色槽蒸馏器单测（原蒸馏挡位建链测试的语义迁移）。
 *
 * 语义检查点：DistillConfig 序列化 round-trip 与默认值（开关开启 + router
 * 角色槽；历史 tier 字段兼容读入）、resolve_distill_chain（router_config 建链 /
 * router 槽未配置回落 agent / agent_config 别名 main_config 兼容 / 双缺返回
 * null）、RoleDistiller 开关关闭恒停用、开关开启链缺失回落确定性基线、异步
 * LLM 蒸馏回调成功走产物/失败 fail-open 回落确定性。
 */

import { describe, expect, it } from 'vitest';

import type { JsonRecord } from '../../../src/core/json.js';
import {
  SIGNAL_INSIGHT,
  DistillConfig,
  ExecutionSignal,
  RoleDistiller,
  resolve_distill_chain,
} from '../../../src/core/knowledge_signals/index.js';

const ROUTER_MODEL_CONFIG: JsonRecord = {
  router_config: {
    adapter: 'openai_compat',
    model_id: 'router',
    base_url: 'http://r',
  },
  agent_config: {
    adapter: 'openai_compat',
    model_id: 'agent',
    base_url: 'http://a',
  },
};

describe('DistillConfig 序列化', () => {
  it('round-trip（开关 + 建链角色槽；历史 tier 字段兼容读入）', () => {
    const config = new DistillConfig({ enabled: false, role: 'router' });
    const rebuilt = DistillConfig.from_dict(config.to_dict());
    expect(rebuilt.enabled).toBe(false);
    expect(rebuilt.role).toBe('router');
    expect(DistillConfig.from_dict({ enabled: false, tier: 'router' }).role).toBe('router');
  });

  it('默认：开关开启 + router 角色槽建链', () => {
    const config = new DistillConfig();
    expect(config.enabled).toBe(true);
    expect(config.role).toBe('router');
  });
});

describe('蒸馏角色槽建链（resolve_distill_chain）', () => {
  it('router_config 存在 → router 角色槽链', () => {
    const chain = resolve_distill_chain(ROUTER_MODEL_CONFIG);
    expect(chain).not.toBeNull();
    expect(chain!.configs[0]!.model_id).toBe('router');
  });

  it('router 槽未配置 → resolve 回落 agent（agent_config / main_config 别名）', () => {
    const agentChain = resolve_distill_chain({
      agent_config: { adapter: 'openai_compat', model_id: 'agent', base_url: 'http://a' },
    });
    expect(agentChain).not.toBeNull();
    expect(agentChain!.configs[0]!.model_id).toBe('agent');
    const aliasChain = resolve_distill_chain({
      main_config: { adapter: 'openai_compat', model_id: 'main', base_url: 'http://m' },
    });
    expect(aliasChain).not.toBeNull();
    expect(aliasChain!.configs[0]!.model_id).toBe('main');
  });

  it('router/agent 均无配置 → null（回落确定性蒸馏基线）', () => {
    expect(resolve_distill_chain(null)).toBeNull();
    expect(resolve_distill_chain({})).toBeNull();
  });
});

describe('RoleDistiller（开关 + 链缺失回落）', () => {
  it('distill_enabled=False：触发判定恒 False、蒸馏恒无产物', () => {
    const distiller = new RoleDistiller({ config: new DistillConfig({ enabled: false }) });
    expect(distiller.should_distill({ complexity: 10, interventions: 5 })).toBe(false);
    const signals = [new ExecutionSignal({ kind: SIGNAL_INSIGHT, message: '经验', source: 'model' })];
    expect(distiller.distill(signals)).toBeNull();
  });

  it('开关开启但链缺失（router/agent 均未配置）→ 回落确定性蒸馏基线', () => {
    const distiller = new RoleDistiller({ config: new DistillConfig(), chain: null });
    expect(distiller.should_distill({ complexity: 5, interventions: 0 })).toBe(true);
    const signals = [
      new ExecutionSignal({ kind: SIGNAL_INSIGHT, message: '成功经验', source: 'model' }),
    ];
    const data = distiller.distill(signals);
    expect(data).not.toBeNull();
    expect((data!.insight as { message: string }).message).toBe('成功经验');
  });

  it('异步入口：LLM 回调异常 → fail-open 回落确定性基线', async () => {
    const distiller = new RoleDistiller({ config: new DistillConfig(), chain: {} });
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
    const distiller = new RoleDistiller({ config: new DistillConfig(), chain: {} });
    const signals = [new ExecutionSignal({ kind: SIGNAL_INSIGHT, message: 'x', source: 'model' })];
    const data = await distiller.distill_async(signals, {
      llm_distill: async () => ({ kind: 'insight', insight: { message: 'LLM 蒸馏产物' } }),
    });
    expect((data!.insight as { message: string }).message).toBe('LLM 蒸馏产物');
  });
});
