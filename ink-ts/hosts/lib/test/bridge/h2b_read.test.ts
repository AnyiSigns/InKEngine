/**
 * host bridge H2b 架构/演化读取类命令面单测（edge_evidence.list /
 * metrics.snapshot / entities.snapshot）。覆盖：方法表三向一致（CODING §9 /
 * BRIDGE_METHODS / 装配表）、入参校验、无数据源结构化空态（不抛错不编造）、
 * 写类/越权未登记、数据源 = 引擎 runtime 装配产物。
 *
 * 组装链读取面（graph.instance / pool.snapshot / pool.evaluate /
 * assemble.stats / cache.stats / path.state）已随组装链路退役（W7-B）。
 * // gate: 超限(230 行) - 多方法数据源/空态/别名断言集中在一文件便于交叉核验
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BRIDGE_METHODS } from '../../src/bridge/index.js';
import { createHost } from '../../src/index.js';
import type { HostHandle } from '../../src/index.js';
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

  it('BRIDGE_METHODS 含全部保留读取方法且装配表双向一致；写类/越权不提供', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
    expect([...handle.bridge.keys()].sort()).toEqual([...BRIDGE_METHODS].sort());
    for (const method of [
      'edge_evidence.list',
      'metrics.snapshot',
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
      // 组装链桥面（已随组装链路退役）
      'graph.instance',
      'pool.snapshot',
      'pool.evaluate',
      'assemble.stats',
      'cache.stats',
      'path.state',
    ]) {
      expect(handle.bridge.has(absent)).toBe(false);
    }
  });
});

describe('edge_evidence.list / metrics.snapshot / entities.snapshot（只读窗口）', () => {
  let handle: HostHandle;

  afterEach(async () => {
    await handle.dispose();
  });

  it('edge_evidence.list 空 store → 结构化空态；非法 limit 拒绝', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
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

  it('metrics.snapshot 只读窗口形态（主线回合不经组装 metrics 通道 → 空窗口如实）', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
    const view = (await handle.bridge.get('metrics.snapshot')!(null, CTX)) as {
      available: boolean;
      rounds: number;
      failures: number;
      avg: number;
      crystallized: number;
    };
    expect(view.available).toBe(true);
    expect(view.rounds).toBe(0);
    expect(view.failures).toBe(0);
    expect(view.avg).toBe(0);
    expect(typeof view.crystallized).toBe('number');
  });

  it('entities.snapshot 实体注册表目录快照（id/label + 配额态；无实体 = 空清单非报错）', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
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