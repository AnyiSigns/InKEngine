/**
 * 实体演化对作用域声明块的保留性单测。
 *
 * 测什么：作用域资产 = 带 scope 声明块的实体；实体演化的两条重建路径都不得
 * 吞掉 scope 声明块——① 失败信号驱动的变异蒸馏 _derive_mutation 重建
 * EntitySpec；② EntityEvolutionPipeline 晋升（工作 → 项目）经 _try_promote
 * 重建 EntitySpec。目录资产的能力/契约/守卫档维度须随教训蒸馏/晋升保留
 * （否则演化一次即丢目录维度，作用域资产与普通实体同目录的前提被破坏）。
 */

import { describe, expect, it } from 'vitest';

import { EntityRegistry, EntitySpec } from '../../../src/core/entities/entities.js';
import { ExecutionSignal } from '../../../src/core/knowledge_signals/signals.js';
import { EngineEvent } from '../../../src/core/events/events.js';
import type { EvolutionRecord, EvolutionWriter } from '../../../src/kernel/evolution_writer/_types.js';
import {
  COLLAB_TOOL_NAME,
  EntityEvolutionConfig,
  EntityEvolutionPipeline,
} from '../../../src/kernel/entity_evolution/index.js';
import { _derive_mutation } from '../../../src/kernel/entity_evolution/_mutation.js';
import { build_scope_asset } from '../../../src/model/scopes/scope_directory.js';

/** EvolutionWriter 记录桩（断言晋升写入留痕）。 */
class RecorderWriter implements EvolutionWriter {
  writes: Array<{ kind: string; asset_id: string; note: string }> = [];
  async write(
    _collection: string,
    _key: string,
    _data: EvolutionRecord,
    options: { kind: string; asset_id: string; note?: string },
  ): Promise<void> {
    this.writes.push({ kind: options.kind, asset_id: options.asset_id, note: options.note ?? '' });
  }
}

function toolStart(callId: string, entityId: string): EngineEvent {
  return new EngineEvent({
    type: 'tool_start',
    payload: { tool: COLLAB_TOOL_NAME, args: { entity_id: entityId, task: 'x' }, tool_call_id: callId },
  });
}

function toolEnd(callId: string, success: boolean, message: string): EngineEvent {
  return new EngineEvent({
    type: 'tool_end',
    payload: { tool: COLLAB_TOOL_NAME, success, message, tool_call_id: callId },
  });
}

async function feed(pipeline: EntityEvolutionPipeline, ...events: EngineEvent[]): Promise<void> {
  for (const event of events) {
    await pipeline.send(event);
  }
  await pipeline.flush_round();
}

function evolution(spec: EntitySpec): Record<string, unknown> {
  return spec.meta['evolution'] as Record<string, unknown>;
}

describe('实体演化保留作用域声明块', () => {
  it('变异产物携带原 scope 声明（persona 追加教训后目录维度不丢）', () => {
    const scopeAsset = build_scope_asset({
      id: 'coder',
      role: 'coder',
      persona: '编码器',
      capabilities: [{ id: 'patch', class: 'function' }],
      contract: {
        consumes: [{ shape: 'field', key: 'plan' }],
        produces: [{ shape: 'field', key: 'patch' }],
      },
    });
    const signal = new ExecutionSignal({
      kind: 'pitfall',
      message: '增量 patch 未对照验收标准被拒',
      source: 'model',
    });
    const result = _derive_mutation(scopeAsset, [signal]);
    expect(result).not.toBeNull();
    const mutated = result!.spec as EntitySpec;
    expect(mutated.scope).toEqual(scopeAsset.scope);
    expect(mutated.role).toBe('coder');
    expect(mutated.persona).toContain('已知教训');
    expect(scopeAsset.scope?.capabilities?.[0]?.id).toBe('patch');
  });
});

describe('实体演化管线晋升保留作用域声明块', () => {
  it('晋升（变异→稳定→工作→项目）后 scope 声明与 role 完整在场', async () => {
    const asset = build_scope_asset({
      id: 'coder',
      role: 'coder',
      persona: '编码器',
      capabilities: [{ id: 'patch', class: 'function' }],
      contract: {
        consumes: [{ shape: 'field', key: 'plan' }],
        produces: [{ shape: 'field', key: 'patch' }],
      },
    });
    const registry = new EntityRegistry();
    registry.register(asset);
    const writer = new RecorderWriter();
    const pipeline = new EntityEvolutionPipeline(registry, writer, {
      config: new EntityEvolutionConfig({ promotion_rounds: 1 }),
    });

    // 失败信号 → 管线内变异（_try_mutate/_derive_mutation 路径）→ 工作层
    await feed(pipeline, toolStart('c1', 'coder'), toolEnd('c1', false, '增量 patch 未对照验收标准被拒'));
    const afterMutation = registry.get('coder')!;
    expect(afterMutation.scope).toEqual(asset.scope);
    expect(afterMutation.role).toBe('coder');
    expect(evolution(afterMutation)['level']).toBe('work');

    // 连续零失败 1 回合 → 晋升（工作 → 项目）经 _try_promote 重建实体
    await feed(pipeline);
    const afterPromotion = registry.get('coder')!;
    expect(pipeline.promotions).toBe(1);
    expect(evolution(afterPromotion)['level']).toBe('project');
    expect(afterPromotion.scope).toEqual(asset.scope);
    expect(afterPromotion.role).toBe('coder');
    expect(writer.writes[writer.writes.length - 1]!.note).toContain('实体晋升');
    expect(writer.writes[writer.writes.length - 1]!.asset_id).toBe('coder');
  });
});
