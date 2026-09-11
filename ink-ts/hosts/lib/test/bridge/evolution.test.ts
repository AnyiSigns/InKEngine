/**
 * evolution.crystallize 桥命令单测（结晶宿主入口：观测读取 → 引擎评估 →
 * 采纳闸（隔离试跑）→ 受控落库 → 回执）。
 *
 * 测什么：
 * - 方法面挂载：evolution.crystallize 在 BRIDGE_METHODS/bridge 表内（evolution 域）；
 * - 参数校验：pose/role/dry_run 非法 → invalid_params；
 * - 无观测 = no_proposals（回执含 patterns/results 空集，零写入）；
 * - review 姿态 + 无策略直过 = approval_required fail-closed（headless 无挂卡通道）；
 * - 假 llm 全链 E2E（pose=auto）：5 条同模式观测（4 成 1 败 = 0.8 达标）→
 *   评估产 add_scope 提案（org_pruning + 证据）→ 隔离试跑 pass（trial_runner
 *   真执行经 overlay 装载）→ ControlledEvolutionApplier 过审批落库：实体注册表
 *   换入 + entities 受守卫集合落盘 + 回执 applied；再跑 = already_registered
 *   （目录感知，不重复转正）；
 * - dry_run：闸照常隔离试跑（gate_passed）但注册表无该资产、集合无落盘；
 * - role 过滤只评该模式；观测不足 = no_proposals（below_min_sightings 可见）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BRIDGE_METHODS } from '../../src/bridge/index.js';
import { createHost } from '../../src/index.js';
import type { HostHandle } from '../../src/index.js';
import { TEMP_SIGHTINGS_COLLECTION } from '../../src/execution/convene_board.js';
import { FakeOpenAIServer } from '../_fake_openai.js';

const CTX = { autoApprove: false };

function tempSighting(role: string, seatIndex: number, outcome: string): Record<string, unknown> {
  return {
    role,
    def: { role, persona: `${role} 临时人格` },
    outcome,
    run_id: `collab:${seatIndex + 1}:1`,
    seat: 0,
    times: 1,
    ts: 1700 + seatIndex,
  };
}

async function seedSightings(
  handle: HostHandle,
  role: string,
  outcomes: string[],
): Promise<void> {
  const storage = handle.runtime.storage!;
  for (let i = 0; i < outcomes.length; i++) {
    await storage.put_record(
      TEMP_SIGHTINGS_COLLECTION,
      `collab:${i + 1}:1#0`,
      tempSighting(role, i, outcomes[i]!),
    );
  }
}

describe('evolution.crystallize 挂载与参数校验', () => {
  it('方法面：evolution.crystallize 经 EVOLUTION_COMMANDS 声明并挂载', () => {
    expect(BRIDGE_METHODS).toContain('evolution.crystallize');
  });

  it('非法 pose/role/dry_run/非对象 → invalid_params', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ink-cryst-param-'));
    const handle = await createHost({ data_dir: dir, events_dir: path.join(dir, 'events') });
    try {
      const run = handle.bridge.get('evolution.crystallize')!;
      await expect(run({ pose: 'yolo' }, CTX)).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(run({ role: '  ' }, CTX)).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(run({ dry_run: 'yes' }, CTX)).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(run(null, CTX)).rejects.toMatchObject({ code: 'invalid_params' });
    } finally {
      await handle.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('零观测 = no_proposals；观测不足 = below_min_sightings 可见', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ink-cryst-none-'));
    const handle = await createHost({ data_dir: dir, events_dir: path.join(dir, 'events') });
    try {
      const run = handle.bridge.get('evolution.crystallize')!;
      const empty = (await run({}, CTX)) as { status: string; sightings: number; results: unknown[] };
      expect(empty.status).toBe('no_proposals');
      expect(empty.sightings).toBe(0);
      await seedSightings(handle, 'debater', ['success', 'success', 'success']);
      const few = (await run({}, CTX)) as {
        status: string;
        patterns: Array<{ reason: string }>;
      };
      expect(few.status).toBe('no_proposals');
      expect(few.patterns[0]!.reason).toContain('below_min_sightings');
    } finally {
      await handle.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('evolution.crystallize 假 llm 全链（evaluate → 隔离试跑闸 → 落库）', () => {
  let handle: HostHandle;
  let dir = '';
  let server: FakeOpenAIServer;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ink-cryst-e2e-'));
    server = new FakeOpenAIServer({ content: '结晶试跑通过' });
    await server.start();
    handle = await createHost({
      data_dir: dir,
      events_dir: path.join(dir, 'events'),
      model_config: {
        agent_config: {
          protocol: 'openai_compatible',
          base_url: server.baseUrl,
          api_key: 'sk-crystal-test',
          model_id: 'crystal-test-model',
        },
      },
    });
  });

  afterEach(async () => {
    await handle.dispose();
    await server.close();
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it('5 成观测（4/5=0.8 边界达标）→ 提案过强制试跑闸并落库；再跑不重复转正', async () => {
    const run = handle.bridge.get('evolution.crystallize')!;
    await seedSightings(handle, 'debater', ['success', 'success', 'success', 'success', 'failure']);
    const receipt = (await run({ pose: 'auto' }, CTX)) as {
      ok: boolean;
      status: string;
      applied: number;
      proposals: Array<Record<string, unknown>>;
      results: Array<Record<string, unknown>>;
    };
    expect(receipt.ok).toBe(true);
    expect(receipt.status).toBe('applied');
    expect(receipt.applied).toBe(1);
    const proposal = receipt.proposals[0]!;
    expect(proposal['kind']).toBe('add_scope');
    expect(proposal['provenance']).toBe('org_pruning');
    expect((proposal['evidence'] as Record<string, unknown>)['sightings']).toBe(5);
    const result = receipt.results[0]!;
    expect(result['status']).toBe('applied');
    expect(result['asset_id']).toBe('crystal:debater');
    expect((result['gate'] as Record<string, unknown>)['required']).toBe(true);
    expect((result['gate'] as Record<string, unknown>)['verdict']).toBe('pass');
    // 落库：活跃注册表换入 + 受守卫集合记录（受控注册/补丁链通道）
    const entitiesCollection = handle.runtime.entity_registry!.collection;
    expect(handle.runtime.entity_registry!.get('crystal:debater')?.role).toBe('debater');
    const row = await handle.runtime.storage!.get_record(entitiesCollection, 'crystal:debater');
    expect(row?.['id']).toBe('crystal:debater');
    expect(((row?.['meta'] as Record<string, unknown>)?.['temp_sightings'])).toBe('debater');
    // 再跑：目录感知跳过，不重复转正
    const again = (await run({ pose: 'auto' }, CTX)) as {
      status: string;
      patterns: Array<{ reason: string }>;
    };
    expect(again.status).toBe('no_proposals');
    expect(again.patterns[0]!.reason).toContain('already_registered');
  });

  it('dry_run：闸（真实隔离试跑）照常执行但不落库', async () => {
    const run = handle.bridge.get('evolution.crystallize')!;
    await seedSightings(handle, 'auditor', ['success', 'success', 'success', 'success', 'success']);
    const receipt = (await run({ pose: 'auto', dry_run: true, role: 'auditor' }, CTX)) as {
      status: string;
      sightings: number;
      applied: number | undefined;
      patterns: Array<{ ref: string }>;
      results: Array<Record<string, unknown>>;
    };
    expect(receipt.status).toBe('dry_run');
    expect(receipt.sightings).toBe(5);
    // role 过滤：只评 auditor（debater 行不可见 → 计数来自 auditor 五观测）
    expect(receipt.patterns.every((p) => p.ref.startsWith('auditor'))).toBe(true);
    expect(receipt.results[0]!['status']).toContain('gate_passed');
    expect((receipt.results[0]!['gate'] as Record<string, unknown>)['verdict']).toBe('pass');
    expect(handle.runtime.entity_registry!.get('crystal:auditor')).toBeNull();
    const row = await handle.runtime.storage!.get_record(
      handle.runtime.entity_registry!.collection,
      'crystal:auditor',
    );
    expect(row).toBeNull();
  });

  it('隔离试跑执行了假 llm（trial 真执行，非空过闸）', async () => {
    const run = handle.bridge.get('evolution.crystallize')!;
    await seedSightings(handle, 'debater', ['success', 'success', 'success', 'success', 'failure']);
    await run({ pose: 'auto' }, CTX);
    expect(server.requestCount).toBeGreaterThanOrEqual(1);
  });

  it('review 姿态无挂卡通道 = approval_required fail-closed（不落库不试跑写）', async () => {
    const run = handle.bridge.get('evolution.crystallize')!;
    await seedSightings(handle, 'debater', ['success', 'success', 'success', 'success', 'success']);
    await expect(run({}, CTX)).rejects.toMatchObject({ code: 'approval_required' });
    expect(handle.runtime.entity_registry!.get('crystal:debater')).toBeNull();
  });
});
