/**
 * S6 回归断言（先补后摘，§14.12 S6 卡 A）：runtime 主线路在无 legacy 演化管线
 * 装配下行为不变。
 *
 * 摘除对象（§12.3 S6：growth/entity_evolution/self_application/self_proposal/
 * evolution 五族装配 + evolve_offline 候选段）移除后，本套件必须仍全绿——本套件
 * 锁的是「受控通道活线（记忆抽取 / 技能结晶容器 / 收尾调参 / 评审边界清理）照常
 * 接线、boot→stop 干净」这一不可回退契约，不锁 legacy 内部字段（防断言迁就摘除）。
 *
 * 相关：rounds/execution/evolution 命令面的全链回归见 plugins/commands/*
 * faces/logic（evolution.evaluate/evaluation.crystallize 经 ControlledEvolutionApplier
 * 活线），本套件只守 runtime 装配面。
 */

import { describe, expect, it } from 'vitest';

import { DefaultInterruptPolicy } from '../../../src/gate/approval/approval.js';
import type { Host } from '../../../src/loop/runtime/index.js';
import { AssemblyRecipe, Runtime } from '../../../src/loop/runtime/index.js';
import { GENERAL_WEIGHTS_SEED_ID } from '../../../src/model/seeds/seeds.js';
import { TunableParams } from '../../../src/evolve/param_tuning/index.js';
import { MemoryStorage } from '../../graph/executor/helpers.js';

class ClosableLLM {
  async ainvoke(): Promise<unknown> {
    return null;
  }
  async aclose(): Promise<void> {
    return;
  }
}

class FakeHost {
  llm: ClosableLLM | null = null;
  policy = new DefaultInterruptPolicy();
  storage: MemoryStorage | null = null;
  async create_storage(): Promise<MemoryStorage> {
    this.storage = new MemoryStorage();
    return this.storage;
  }
  async resolve_llm(): Promise<ClosableLLM | null> {
    return this.llm;
  }
  interrupt_policy(): unknown {
    return this.policy;
  }
  build_transport(): { send(): Promise<void> } {
    return { send: async () => undefined };
  }
  async close(): Promise<void> {
    return;
  }
}

function toHost(h: FakeHost): Host {
  return h as unknown as Host;
}

function minimalRecipe(overrides: Partial<AssemblyRecipe> = {}): AssemblyRecipe {
  const base = new AssemblyRecipe({
    set_id: 'default',
    harness_definitions: [],
    event_type_specs: [],
    ui_spec: null,
    ui_allowed_components: [],
    ui_allowed_theme_tokens: [],
    tool_wiring: {
      self_specs: () => [],
      self_executor_factory: () => (): Promise<unknown> => Promise.resolve(null),
      self_operation_of: () => ['read', '*'] as [string, string],
    },
    approval_levels: {},
  });
  return Object.assign(base, overrides);
}

describe('runtime 主线路无 legacy 管线装配（S6 回归）', () => {
  it('boot 默认配方装配活线（记忆/技能/调参在位）+ stop 干净', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), minimalRecipe());
    expect(runtime.memory_store).not.toBeNull();
    expect(runtime.knowledge_skill_store).not.toBeNull();
    expect(runtime.meta_tuner).not.toBeNull();
    await runtime.stop();
  });

  it('memory_extract_enabled=false / skill_crystal_enabled=false 开关仍生效', async () => {
    const runtime = await new Runtime().boot(
      toHost(new FakeHost()),
      minimalRecipe({ memory_extract_enabled: false, skill_crystal_enabled: false }),
    );
    expect(runtime.memory_store).toBeNull();
    expect(runtime.knowledge_skill_store).toBeNull();
    await runtime.stop();
  });

  it('收尾调参失败信号 → 参数回写知识集（MetaTuner 活线）', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), minimalRecipe());
    runtime.turn_metrics!.record_turn({ failed: true });
    runtime.tune_after_round({ failed: true, error: '失败回合' });
    const entry = runtime.knowledge_set!.get(GENERAL_WEIGHTS_SEED_ID);
    expect(entry).not.toBeNull();
    const params = TunableParams.from_dict(entry!.data as never);
    expect(params.retry_budget).toBeGreaterThanOrEqual(2);
    expect(params.web_verify_threshold).toBeLessThan(0.5);
    await runtime.stop();
  });
});