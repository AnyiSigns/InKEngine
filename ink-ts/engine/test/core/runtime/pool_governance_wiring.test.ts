/**
 * Pool governance write seam runtime assembly tests (R3 decision A wiring):
 * - after boot with an entity registry, runtime.pool_governance_writable is
 *   bound to the registry-backed implementation (list() reflects entities);
 * - failing-round candidates that are not entity ids keep the seam a no-op
 *   while pool governance still records registration + audit (fallback).
 */

import { describe, expect, it } from 'vitest';

import { AssemblyRecipe, Runtime } from '../../../src/core/runtime/index.js';
import type { Host, GraphRecipeContext } from '../../../src/core/runtime/index.js';
import { Graph } from '../../../src/core/graph/graph.js';
import { DefaultInterruptPolicy } from '../../../src/core/approval/approval.js';
import { EntitySpec } from '../../../src/core/entities/entities.js';
import { MemoryStorage } from '../executor/helpers.js';

class FakeHost {
  policy: unknown = new DefaultInterruptPolicy();
  async create_storage(): Promise<MemoryStorage> {
    return new MemoryStorage();
  }
  async resolve_llm(): Promise<unknown> {
    return null;
  }
  interrupt_policy(): unknown {
    return this.policy;
  }
  build_transport(): { send(): Promise<void> } {
    return { send: async () => undefined };
  }
  async close(): Promise<void> {}
}

function toHost(host: FakeHost): Host {
  return host as unknown as Host;
}

function failingGraph(_ctx: GraphRecipeContext): Graph {
  const boom = async (): Promise<never> => {
    throw new Error('node failed');
  };
  const g = new Graph({ name: 'pgw-fail', entry: 'start' });
  g.add_node('start', (async () => ({ started: true })) as never);
  g.add_node('mid', boom as never);
  g.add_edge('start', 'mid');
  g.add_exit('mid');
  return g;
}

function recipe(): AssemblyRecipe {
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
    graph_recipe: failingGraph,
  });
  return base;
}

describe('runtime pool governance write seam assembly', () => {
  it('entity registry present -> pool_governance_writable bound (list reflects entities)', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), recipe());
    expect(runtime.entity_registry).not.toBeNull();
    expect(runtime.pool_governance).not.toBeNull();
    expect(runtime.pool_governance_writable).not.toBeNull();
    runtime.entity_registry!.register(new EntitySpec({ id: 'reviewer_a', label: 'reviewer' }));
    await expect(runtime.pool_governance_writable!.list()).resolves.toContain('reviewer_a');
    await runtime.stop();
  });

  it('failing-round candidate not an entity -> seam no-op, registration + audit remain', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), recipe());
    const gov = runtime.pool_governance!;
    await runtime.engine!.ainvoke({ input: 'fail' }, { thread_id: 't-pg', round_id: 'r1' });
    expect(runtime.entity_registry!.names()).toEqual([]);
    expect(gov.log.length).toBeGreaterThanOrEqual(1);
    const audits = await runtime.storage!.list_records('set_audit');
    expect(audits.some((r) => r['type'] === 'pool_governance_audit')).toBe(true);
    await runtime.stop();
  });
});
