/**
 * 自学习族运行时接线测试（EC2 全量接线上班，组装退役后裁剪）：
 * - 回合收尾自动调参（turn_metrics 聚合 → 失败信号参数回写知识集）；
 * - 回合记忆抽取（MemoryExtractSettleHook 经 runtime 装配面接线，确认类
 *   事件入账本语义由 test/kernel/memory_extract 族覆盖）；
 * - evolution 离线调度入口（失败率候选 → 变异 → 闸门防退化落库）。
 *
 * 随组装链路退役裁剪：技能结晶 settle 链（原触发源 = 指纹缓存命中，已退役；
 * skill_crystal 容器/评估器覆盖见 test/kernel/skill_crystal）；
 * resume_run 决议入账本（组装审批卡重入点已退役，执行主线决议语义走
 * execution runtime，引擎侧 _record_review_decision 无调用方留痕）。
 * 回合引擎形态（B3）：无常驻静态引擎——保留用例直接调 runtime 公开入口
 * （tune_after_round / evolve_offline / 记忆钩子接线断言），不经组合回合。
 */

import { describe, expect, it } from 'vitest';

import { DefaultInterruptPolicy } from '../../../src/gate/approval/approval.js';
import type { Host } from '../../../src/loop/runtime/index.js';
import { AssemblyRecipe, Runtime } from '../../../src/loop/runtime/index.js';
import {
  KIND_PATH,
  KnowledgeEntry,
} from '../../../src/core/knowledge_set/index.js';
import { GENERAL_WEIGHTS_SEED_ID } from '../../../src/model/seeds/seeds.js';
import { TunableParams } from '../../../src/kernel/tuning/index.js';
import { DEFAULT_NAMESPACE } from '../../../src/kernel/memory_extract/index.js';
import { MemoryStorage } from '../../graph/executor/helpers.js';
import type { EvolutionGate } from '../../../src/kernel/evolution/index.js';

/** 假 LLM（引擎重建/stop 关停路径可复用）。 */
class ClosableLLM {
  async ainvoke(): Promise<unknown> {
    return null;
  }
  async aclose(): Promise<void> {
    return;
  }
}

/** Host 五件套 mock（最小可 boot 形态）。 */
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

function toHost(host: FakeHost): Host {
  return host as unknown as Host;
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

describe('runtime 自学习族接线（组装退役后保留面）', () => {
  it('记忆抽取族装配：memory_store 随配方装配（受控通道 kind=memory）', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), minimalRecipe());
    expect(runtime.memory_store).not.toBeNull();
    expect(runtime.knowledge_skill_store).not.toBeNull();
    // 结晶器观察面恒 null（自动触发源已退役；容器对外读写见 skill_crystal 族）
    expect(runtime.skill_crystallizer).toBeNull();
    await runtime.stop();
  });

  it('回合收尾自动调参：失败信号 → 指标聚合 → 参数回写知识集', async () => {
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

  it('记忆抽取钩子接线：memory_extract_enabled=false = 不装配存储', async () => {
    const runtime = await new Runtime().boot(
      toHost(new FakeHost()),
      minimalRecipe({ memory_extract_enabled: false }),
    );
    expect(runtime.memory_store).toBeNull();
    expect(runtime.knowledge_skill_store).not.toBeNull();
    await runtime.stop();
  });

  it('evolve_offline 调度入口：失败率候选 → 变异 → 闸门保留落库', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), minimalRecipe());
    runtime.knowledge_set!.add(
      new KnowledgeEntry({
        id: 'rule-evo',
        level: 'work',
        kind: 'rule',
        data: { rule: { message: '规则A' } },
        source: 'model',
        credibility: 0.6,
        usage_count: 6,
        fail_count: 4,
        failure_logs: ['日志1', '日志2'],
        title: '进化目标',
        tags: ['evo'],
      }),
    );
    const gate: EvolutionGate = {
      check: async () =>
        [
          { passed: true, errors: [] },
          { passed: true, note: '' },
          { passed: true, reason: 'ok' },
        ] as never,
    };
    const result = await runtime.evolve_offline({ gate, batch: 3 });
    expect(result.candidates).toBeGreaterThanOrEqual(1);
    expect(result.kept).toBeGreaterThanOrEqual(1);
    expect(runtime.knowledge_set!.get('rule-evo:v1')).not.toBeNull();
    await runtime.stop();
  });
});