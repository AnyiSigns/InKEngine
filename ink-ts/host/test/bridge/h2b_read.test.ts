/**
 * host bridge H2b 架构/演化读取类命令面单测（graph.instance / pool.snapshot
 * / pool.evaluate / edge_evidence.list / metrics.snapshot / assemble.stats /
 * cache.stats / path.state / entities.snapshot）。覆盖：
 * 方法表三向一致（CODING §9 / BRIDGE_METHODS / 装配表）、入参校验、无数据源
 * 结构化空态（不抛错不编造）、写类/越权未登记、数据源 = 引擎 runtime 装配产物。
 * // gate: 超限(353 行) - 多方法数据源/空态/别名断言集中在一文件便于交叉核验
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EngineEvent } from '@ink-ts/engine';
import { afterEach, describe, expect, it } from 'vitest';

import { BRIDGE_METHODS } from '../../src/bridge/index.js';
import { createHost } from '../../src/index.js';
import type { HostHandle } from '../../src/index.js';
import { echoGraphRecipe } from '../_graphs.js';
const CTX = { autoApprove: false };

function dirs(): { dir: string; events: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ink-h2b-'));
  return { dir, events: path.join(dir, 'events') };
}
describe('H2b 方法表三向一致', () => {
  let handle: HostHandle;

  afterEach(async () => {
    await handle.dispose();
  });

  it('BRIDGE_METHODS 含全部新读取方法且装配表双向一致；写类/越权不提供', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events }, { graph_recipe: echoGraphRecipe });
    expect([...handle.bridge.keys()].sort()).toEqual([...BRIDGE_METHODS].sort());
    for (const method of [
      'graph.instance',
      'pool.snapshot',
      'pool.evaluate',
      'edge_evidence.list',
      'metrics.snapshot',
      'assemble.stats',
      'cache.stats',
      'path.state',
      'entities.snapshot',
    ]) {
      expect(handle.bridge.get(method)).toBeTypeOf('function');
    }
    for (const absent of [
      'edge_evidence.update',
      'edge_downgrade_tier',
      'edge_restore_tier',
      'cache.clear',
      'cache.invalidate',
      'cache.rebuild',
      'path.assemble',
      'path.choose_candidate',
      'path.set_multipath',
      'path.clear_candidate',
      'graph.edge_evidence_update',
    ]) {
      expect(handle.bridge.has(absent)).toBe(false);
    }
  });

  it('graph.instance / pool.evaluate 入参校验（缺 thread_id/proposal → invalid_params）', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events }, { graph_recipe: echoGraphRecipe });
    await expect(handle.bridge.get('graph.instance')!({}, CTX)).rejects.toMatchObject({
      code: 'invalid_params',
    });
    await expect(handle.bridge.get('graph.instance')!({ thread_id: '' }, CTX)).rejects.toMatchObject({
      code: 'invalid_params',
    });
    await expect(handle.bridge.get('pool.evaluate')!({}, CTX)).rejects.toMatchObject({
      code: 'invalid_params',
    });
    await expect(
      handle.bridge.get('pool.evaluate')!({ proposal: { fields: ['a'] } }, CTX),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });
});

describe('graph.instance（回合图实例执行态摘要）', () => {
  let handle: HostHandle;

  afterEach(async () => {
    await handle.dispose();
  });

  it('graph.instance 按线程事件归集最近一回合执行态（error=failed/其余=success）', async () => {
    const made = dirs();
    handle = await createHost({ data_dir: made.dir, events_dir: made.events }, { graph_recipe: echoGraphRecipe });
    const storage = handle.runtime.storage!;
    await storage.append_event(
      't-vis',
      new EngineEvent({ type: 'execution_started', node: 'agent', round_id: 'r-vis', thread_id: 't-vis' }),
    );
    await storage.append_event(
      't-vis',
      new EngineEvent({ type: 'error', node: 'mid', round_id: 'r-vis', thread_id: 't-vis', payload: { message: 'boom' } }),
    );
    const view = (await handle.bridge.get('graph.instance')!({ thread_id: 't-vis' }, CTX)) as {
      round_id: string | null;
      graph: { nodes: unknown[]; edges: unknown[] };
      node_status: Record<string, string>;
    };
    expect(view.round_id).toBe('r-vis');
    expect(view.node_status).toEqual({ agent: 'success', mid: 'failed' });
    expect(Array.isArray(view.graph.nodes)).toBe(true);
  });

  it('graph.instance 无事件线程 → round_id:null + 空 node_status（不白屏）', async () => {
    const made = dirs();
    handle = await createHost({ data_dir: made.dir, events_dir: made.events }, { graph_recipe: echoGraphRecipe });
    const view = (await handle.bridge.get('graph.instance')!({ thread_id: 't-idle' }, CTX)) as {
      round_id: string | null;
      node_status: Record<string, string>;
    };
    expect(view.round_id).toBeNull();
    expect(view.node_status).toEqual({});
  });
});

describe('pool.snapshot / pool.evaluate（池治理登记快照 + 引擎判定）', () => {
  let handle: HostHandle;

  afterEach(async () => {
    await handle.dispose();
  });

  it('空登记 → 结构化空态（entries 空 + last_round:null）；evaluate 登记后可读', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events }, { graph_recipe: echoGraphRecipe });
    const empty = (await handle.bridge.get('pool.snapshot')!(null, CTX)) as {
      available: boolean;
      governance_log: unknown[];
      last_round: null;
    };
    expect(empty.available).toBe(true);
    expect(empty.governance_log).toEqual([]);
    expect(empty.last_round).toBeNull();

    const evaluated = (await handle.bridge.get('pool.evaluate')!(
      {
        proposal: { node_id: 'candidate', fields: ['a', 'b'] },
        snapshot: { pool_count: 3, used_this_week: 0, pool_nodes: [] },
      },
      CTX,
    )) as { evaluated: boolean; verdict: string; budget_remaining: number };
    expect(evaluated.evaluated).toBe(true);
    expect(typeof evaluated.verdict).toBe('string');
    expect(typeof evaluated.budget_remaining).toBe('number');

    const after = (await handle.bridge.get('pool.snapshot')!(null, CTX)) as {
      governance_log: Array<Record<string, unknown>>;
      last_round: { node_id: string; verdict: string } | null;
      counts: { pool_count: number; evaluations: number };
    };
    expect(after.governance_log).toHaveLength(1);
    expect(after.last_round?.node_id).toBe('candidate');
    expect(after.counts.evaluations).toBe(1);
    expect(after.counts.pool_count).toBe(1);
  });

  it('pool.evaluate 近重复判定透传引擎 verdict（merge_target 命中池内结点）', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events }, { graph_recipe: echoGraphRecipe });
    const evaluated = (await handle.bridge.get('pool.evaluate')!(
      {
        proposal: { node_id: 'new_node', fields: ['a', 'b', 'c', 'd', 'e', 'f'] },
        snapshot: {
          pool_count: 10,
          used_this_week: 0,
          pool_nodes: [{ node_id: 'existing', fields: ['a', 'b', 'c', 'd', 'e'] }],
        },
      },
      CTX,
    )) as { verdict: string; merge_target: string };
    expect(evaluated.verdict).toBe('merge');
    expect(evaluated.merge_target).toBe('existing');
  });
});

describe('edge_evidence.list / metrics.snapshot（只读窗口）', () => {
  let handle: HostHandle;

  afterEach(async () => {
    await handle.dispose();
  });

  it('edge_evidence.list 空 store → 结构化空态；非法 limit 拒绝', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events }, { graph_recipe: echoGraphRecipe });
    const view = (await handle.bridge.get('edge_evidence.list')!(null, CTX)) as {
      available: boolean;
      edges: unknown[];
    };
    expect(view.edges).toEqual([]);
    await expect(
      handle.bridge.get('edge_evidence.list')!({ limit: 0 }, CTX),
    ).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(
      handle.bridge.get('edge_evidence.list')!({ domain: '' }, CTX),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('metrics.snapshot 回合窗口随 echo 回合递增（rounds/failures/avg）', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events }, { graph_recipe: echoGraphRecipe });
    const send = handle.bridge.get('rounds.send')!;
    await send({ input: 'a' }, CTX);
    await send({ input: 'b' }, CTX);
    const view = (await handle.bridge.get('metrics.snapshot')!(null, CTX)) as {
      available: boolean;
      rounds: number;
      failures: number;
      avg: number;
      crystallized: number;
    };
    expect(view.available).toBe(true);
    expect(view.rounds).toBe(2);
    expect(view.failures).toBe(0);
    expect(view.avg).toBe(0);
    expect(typeof view.crystallized).toBe('number');
  });
});

describe('assemble.stats / cache.stats / path.state / entities.snapshot（装配态快照）', () => {
  let handle: HostHandle;

  afterEach(async () => {
    await handle.dispose();
  });

  it('assemble.stats 组装链统计形态（开关位 + 恢复诊断/技能结晶 + canary 门）', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events }, { graph_recipe: echoGraphRecipe });
    const view = (await handle.bridge.get('assemble.stats')!(null, CTX)) as {
      available: boolean;
      assembler_enabled: boolean;
      contract_enabled: boolean;
      multipath_enabled: boolean;
      canary_gate: boolean;
      stats: Record<string, unknown>;
      restore_diag: string[];
      skill_crystal: { available: boolean; count: number; crystallized: string[] };
      fingerprint_cache: { available: boolean; entries: number; stats: Record<string, number> };
    };
    expect(typeof view.available).toBe('boolean');
    expect(typeof view.assembler_enabled).toBe('boolean');
    expect(typeof view.contract_enabled).toBe('boolean');
    expect(typeof view.multipath_enabled).toBe('boolean');
    expect(typeof view.canary_gate).toBe('boolean');
    expect(typeof view.stats).toBe('object');
    // 恢复诊断与技能结晶投影（runtime.restore_diag / skill_crystallizer）
    expect(Array.isArray(view.restore_diag)).toBe(true);
    expect(typeof view.skill_crystal.available).toBe('boolean');
    expect(typeof view.skill_crystal.count).toBe('number');
    expect(Array.isArray(view.skill_crystal.crystallized)).toBe(true);
    expect(typeof view.fingerprint_cache.entries).toBe('number');
    expect(typeof view.fingerprint_cache.stats.lookups).toBe('number');
  });

  it('cache.stats 指纹缓存计数 + multipath 配置态（无数据源 = 全零空态）', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events }, { graph_recipe: echoGraphRecipe });
    const view = (await handle.bridge.get('cache.stats')!(null, CTX)) as {
      fingerprint_cache: {
        available: boolean;
        entries: number;
        per_domain: Array<{ domain: string; count: number }>;
        stats: Record<string, number>;
      };
      multipath: { available: boolean; enabled: boolean };
    };
    expect(typeof view.fingerprint_cache.entries).toBe('number');
    expect(Array.isArray(view.fingerprint_cache.per_domain)).toBe(true);
    expect(typeof view.fingerprint_cache.stats.lookups).toBe('number');
    expect(typeof view.multipath.enabled).toBe('boolean');
  });

  it('path.state 装配状态形态（挂载/开关位/canary/最近组装候选）', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events }, { graph_recipe: echoGraphRecipe });
    const view = (await handle.bridge.get('path.state')!(null, CTX)) as {
      available: boolean;
      runtime_mounted: boolean;
      enabled: Record<string, boolean>;
      canary_gate: boolean;
      candidates: { last_assembly_count: number | null; chosen_candidate: unknown };
    };
    expect(typeof view.runtime_mounted).toBe('boolean');
    expect(typeof view.enabled.assembler).toBe('boolean');
    expect(typeof view.enabled.contract).toBe('boolean');
    expect(typeof view.canary_gate).toBe('boolean');
    expect(view.candidates.last_assembly_count).toBeNull();
    expect(view.candidates.chosen_candidate).toBeNull();
  });

  it('entities.snapshot 实体注册表目录快照（id/label + 配额态；无实体 = 空清单非报错）', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events }, { graph_recipe: echoGraphRecipe });
    const view = (await handle.bridge.get('entities.snapshot')!(null, CTX)) as {
      available: boolean;
      version: number;
      count: number;
      max: number | null;
      entities: Array<{ id: string; label: string }>;
      degraded: boolean;
    };
    expect(view.available).toBe(true);
    expect(view.count).toBe(view.entities.length);
    expect(typeof view.max).toBe('number');
    expect(view.degraded).toBe(false);
  });
});
