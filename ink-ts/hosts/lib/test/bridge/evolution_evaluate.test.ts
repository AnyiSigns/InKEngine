/**
 * evolution.evaluate 桥命令单测（§六 择优半环收口：组织档案 → 引擎评估/适配
 * 产提案 → 强制隔离试跑闸 → 受控落库 → 回执；§十一#6 参数固化配置面）。
 *
 * 测什么：
 * - 方法面挂载：evolution.evaluate 在 BRIDGE_METHODS（evolution 域）；
 * - 参数校验：pose/dry_run/非对象 → invalid_params；
 * - 空档案 = no_proposals（回执含 archive 计数 + 缺省阈值回显 + keeps 空）；
 * - 假 llm 全链 E2E（pose=auto）：先结晶注册 crystal:debater 目录资产 → 档案
 *   快照（常胜链=短路 / 高失败转场=降权 / 低使用高失败作用域=下架）→ 三提案
 *   （apply_shortcut/downrank/retire_scope，org_pruning 来源 + 证据）→ 强制
 *   隔离试跑 pass（假 llm 真执行）→ 落库：org_priors 两行 + entities 退役行
 *   （补丁链受控通道）+ 注册表摘除；
 * - dry_run：闸照常真试跑（gate_passed）但 org_priors/entities 零写入、资产
 *   不退役；
 * - review 姿态 + 无策略直过 = approval_required fail-closed（不落库）；
 * - 阈值参数下发改变评估结果（两配置对比）：缺省 downrank_min_evidence=8 无
 *   降权提案；配置放宽到 4 出现 downrank 提案 + thresholds_effective 回显 +
 *   非法键进 thresholds_ignored（缺省回落现实验值）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CHANNEL_COMMIT_FULL,
  CHANNEL_SHAPE_FAN_OUT,
  chain_pattern_key,
  transition_pattern_key,
} from '@ink-ts/engine';
import { BRIDGE_METHODS } from '../../src/bridge/index.js';
import { createHost } from '../../src/index.js';
import type { HostHandle } from '../../src/index.js';
import { TEMP_SIGHTINGS_COLLECTION } from '../../src/execution/convene_board.js';
import { FakeOpenAIServer } from '../_fake_openai.js';

const CTX = { autoApprove: false };
const ORG_ARCHIVE_KEY = 'snapshot';

function st(success: number, failure: number, degraded: number): Record<string, unknown> {
  return { success, failure, degraded };
}

/** 择优证据档案快照：常胜链（短路）+ 高失败转场（降权 count=6）+ 低使用高失败作用域（下架）。 */
function archiveSnapshot(): Record<string, unknown> {
  return {
    schema_version: 1,
    ingested: 20,
    chains: {
      [chain_pattern_key('main', 'searcher', 'coder',
        CHANNEL_SHAPE_FAN_OUT, CHANNEL_COMMIT_FULL, CHANNEL_SHAPE_FAN_OUT, CHANNEL_COMMIT_FULL)]:
        st(9, 0, 0),
    },
    patterns: {
      [transition_pattern_key('main', 'critic', CHANNEL_SHAPE_FAN_OUT, CHANNEL_COMMIT_FULL)]:
        st(2, 6, 0),
    },
    scopes: {
      searcher: st(2, 0, 0),
      'crystal:debater': st(1, 4, 1),
    },
  };
}

function sighting(role: string, index: number, outcome: string): Record<string, unknown> {
  return {
    role,
    def: { role, persona: `${role} 临时人格` },
    outcome,
    run_id: `collab:${index + 1}:1`,
    seat: 0,
    times: 1,
    ts: 1700 + index,
  };
}

async function seedDebaterSightings(
  handle: HostHandle,
  outcomes: string[],
): Promise<void> {
  const storage = handle.runtime.storage!;
  for (let i = 0; i < outcomes.length; i++) {
    await storage.put_record(TEMP_SIGHTINGS_COLLECTION, `collab:${i + 1}:1#0`, sighting('debater', i, outcomes[i]!));
  }
}

async function seedArchive(handle: HostHandle): Promise<void> {
  await handle.runtime.storage!.put_record('org.archive', ORG_ARCHIVE_KEY, archiveSnapshot());
}

/** 结晶注册 crystal:debater 目录资产（retire 目标必须是已注册未下架作用域资产）。 */
async function registerDebaterAsset(handle: HostHandle): Promise<void> {
  const crystallize = handle.bridge.get('evolution.crystallize')!;
  await seedDebaterSightings(handle, ['success', 'success', 'success', 'success', 'failure']);
  const receipt = (await crystallize({ pose: 'auto' }, CTX)) as { status: string };
  expect(receipt.status).toBe('applied');
}

interface EvaluateReceipt {
  ok: boolean;
  status: string;
  archive: { ingested: number; patterns: number; chains: number; scopes: number };
  thresholds_effective: Record<string, number>;
  thresholds_ignored: string[];
  directory_scopes: string[];
  keeps: unknown[];
  proposals: Array<Record<string, unknown>>;
  applied?: number;
  results: Array<Record<string, unknown>>;
}

async function makeHandle(
  prefix: string,
  server: FakeOpenAIServer | null,
  extraModelConfig: Record<string, unknown> = {},
): Promise<{ handle: HostHandle; dir: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const handle = await createHost({
    data_dir: dir,
    events_dir: path.join(dir, 'events'),
    model_config: server === null
      ? { ...extraModelConfig }
      : {
        agent_config: {
          protocol: 'openai_compatible',
          base_url: server.baseUrl,
          api_key: 'sk-eval-test',
          model_id: 'eval-test-model',
        },
        ...extraModelConfig,
      },
  });
  return { handle, dir };
}

describe('evolution.evaluate 挂载与轻路径', () => {
  it('方法面：evolution.evaluate 经 EVOLUTION_COMMANDS 声明并挂载', () => {
    expect(BRIDGE_METHODS).toContain('evolution.evaluate');
  });

  it('非法 pose/dry_run/非对象 → invalid_params', async () => {
    const { handle, dir } = await makeHandle('ink-eval-param-', null);
    try {
      const run = handle.bridge.get('evolution.evaluate')!;
      await expect(run({ pose: 'yolo' }, CTX)).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(run({ dry_run: 'yes' }, CTX)).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(run(null, CTX)).rejects.toMatchObject({ code: 'invalid_params' });
    } finally {
      await handle.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('空档案 = no_proposals（缺省阈值回显现实验值 + keeps 空）', async () => {
    const { handle, dir } = await makeHandle('ink-eval-empty-', null);
    try {
      const run = handle.bridge.get('evolution.evaluate')!;
      const receipt = (await run({}, CTX)) as EvaluateReceipt;
      expect(receipt.ok).toBe(true);
      expect(receipt.status).toBe('no_proposals');
      expect(receipt.archive).toEqual({ ingested: 0, patterns: 0, chains: 0, scopes: 0 });
      expect(receipt.thresholds_effective.downrankMinEvidence).toBe(8);
      expect(receipt.thresholds_ignored).toEqual([]);
      expect(receipt.keeps).toEqual([]);
      expect(receipt.results).toEqual([]);
    } finally {
      await handle.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('evolution.evaluate 假 llm 全链（档案 → 提案 → 强制闸 → 落库）', () => {
  let handle: HostHandle;
  let dir = '';
  let server: FakeOpenAIServer;

  beforeEach(async () => {
    server = new FakeOpenAIServer({ content: '择优试跑通过' });
    await server.start();
    const made = await makeHandle('ink-eval-e2e-', server);
    handle = made.handle;
    dir = made.dir;
  });

  afterEach(async () => {
    await handle.dispose();
    await server.close();
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it('三种提案全链：短路/降权入 org_priors，下架入 entities（补丁链受控通道）', async () => {
    await registerDebaterAsset(handle);
    expect(handle.runtime.entity_registry!.get('crystal:debater')).not.toBeNull();
    await seedArchive(handle);
    const run = handle.bridge.get('evolution.evaluate')!;
    const receipt = (await run({ pose: 'auto' }, CTX)) as EvaluateReceipt;
    expect(receipt.ok).toBe(true);
    expect(receipt.status).toBe('applied');
    expect(receipt.applied).toBe(3);
    expect(receipt.archive).toEqual({ ingested: 20, patterns: 1, chains: 1, scopes: 2 });
    expect(receipt.directory_scopes).toContain('crystal:debater');
    const kinds = receipt.proposals.map((p) => p['kind']);
    expect(kinds).toEqual(['apply_shortcut', 'downrank', 'retire_scope']);
    for (const p of receipt.proposals) {
      expect(p['provenance']).toBe('org_pruning');
      expect(p['evidence']).toBeTruthy();
    }
    // 回执目标描述 + 闸（强制隔离试跑全 pass）+ 审批（pose=auto 直放）
    expect(receipt.results.map((r) => r['asset_id'])).toEqual([
      'main→searcher→coder',
      'main→critic',
      'crystal:debater',
    ]);
    for (const r of receipt.results) {
      expect(r['status']).toBe('applied');
      expect((r['gate'] as Record<string, unknown>)['required']).toBe(true);
      expect((r['gate'] as Record<string, unknown>)['verdict']).toBe('pass');
      expect((r['approval'] as Record<string, unknown>)['decision']).toBe('auto');
    }
    expect(server.requestCount).toBeGreaterThanOrEqual(3); // 试跑真执行假 llm（非空过闸）
    // 落库：先验两条覆盖行（shortcut + weight）经 org_priors 受守卫前缀
    const priors = await handle.runtime.storage!.list_records('org_priors:-');
    expect(priors.length).toBe(2);
    expect(priors.some((r) => (r as Record<string, unknown>)['kind'] === 'shortcut')).toBe(true);
    expect(priors.some((r) => (r as Record<string, unknown>)['kind'] === 'weight')).toBe(true);
    // 下架：entities 行改 retired 标记 + 活跃注册表摘除（可审计/可回退）
    const row = await handle.runtime.storage!.get_record(
      handle.runtime.entity_registry!.collection, 'crystal:debater',
    );
    expect(((row?.['meta'] as Record<string, unknown>)?.['retired'])).toBe(true);
    expect(handle.runtime.entity_registry!.get('crystal:debater')).toBeNull();
    // 幂等观感：档案再评 = 下架目标已不在目录现状（不重复产下架提案）
    const again = (await run({ pose: 'auto' }, CTX)) as EvaluateReceipt;
    expect(again.proposals.map((p) => p['kind'])).not.toContain('retire_scope');
  });

  it('dry_run：真隔离试跑（gate_passed）但零写入、资产不退役', async () => {
    await registerDebaterAsset(handle);
    await seedArchive(handle);
    const run = handle.bridge.get('evolution.evaluate')!;
    const receipt = (await run({ pose: 'auto', dry_run: true }, CTX)) as EvaluateReceipt;
    expect(receipt.status).toBe('dry_run');
    expect(receipt.applied).toBe(0);
    expect(receipt.proposals.length).toBe(3);
    for (const r of receipt.results) {
      expect(String(r['status'])).toContain('gate_passed');
      expect((r['gate'] as Record<string, unknown>)['verdict']).toBe('pass');
    }
    expect(await handle.runtime.storage!.list_records('org_priors:-')).toEqual([]);
    expect(handle.runtime.entity_registry!.get('crystal:debater')).not.toBeNull();
    const row = await handle.runtime.storage!.get_record(
      handle.runtime.entity_registry!.collection, 'crystal:debater',
    );
    expect(((row?.['meta'] as Record<string, unknown>)?.['retired'])).not.toBe(true);
  });

  it('review 姿态无挂卡通道 = approval_required fail-closed（不落库）', async () => {
    await registerDebaterAsset(handle);
    await seedArchive(handle);
    const run = handle.bridge.get('evolution.evaluate')!;
    await expect(run({}, CTX)).rejects.toMatchObject({ code: 'approval_required' });
    expect(await handle.runtime.storage!.list_records('org_priors:-')).toEqual([]);
    expect(handle.runtime.entity_registry!.get('crystal:debater')).not.toBeNull();
  });
});

describe('evolution.evaluate 阈值参数下发（两配置对比 = §十一#6 参数固化）', () => {
  let server: FakeOpenAIServer;

  beforeEach(async () => {
    server = new FakeOpenAIServer({ content: '阈值对比试跑' });
    await server.start();
  });
  afterEach(async () => {
    await server.close();
  });

  it('缺省档案不产降权；配置放宽 downrank_min_evidence=4 后产物出现 + 回显与忽略清单', async () => {
    // 仅转场证据档：主→评审 count=6、失败率 0.667（缺省证据线 8 触发不了）
    const cmpSnapshot: Record<string, unknown> = {
      schema_version: 1,
      ingested: 6,
      patterns: {
        [transition_pattern_key('main', 'critic', CHANNEL_SHAPE_FAN_OUT, CHANNEL_COMMIT_FULL)]:
          st(2, 4, 0),
      },
    };
    const seedCmp = async (handle: HostHandle): Promise<void> => {
      await handle.runtime.storage!.put_record('org.archive', ORG_ARCHIVE_KEY, cmpSnapshot);
    };
    // 配置 A（缺省）：无提案
    const a = await makeHandle('ink-eval-cfgA-', server);
    try {
      await seedCmp(a.handle);
      const ra = (await a.handle.bridge.get('evolution.evaluate')!({}, CTX)) as EvaluateReceipt;
      expect(ra.status).toBe('no_proposals');
      expect(ra.thresholds_effective.downrankMinEvidence).toBe(8);
    } finally {
      await a.handle.dispose();
      rmSync(a.dir, { recursive: true, force: true });
    }
    // 配置 B（产品配置面下发）：放宽到 4 → 降权提案出现；非法键忽略回缺省
    const b = await makeHandle('ink-eval-cfgB-', server, {
      org_evolution: {
        evaluate_thresholds: {
          downrank_min_evidence: 4,
          downrank_failure_rate: 0.6,
          retire_failure_rate: 2,
          not_a_threshold: 3,
        },
        guardrails: { max_parallel: 6, max_cost: 'oops' },
      },
    });
    try {
      await seedCmp(b.handle);
      const rb = (await b.handle.bridge.get('evolution.evaluate')!(
        { pose: 'auto', dry_run: true }, CTX,
      )) as EvaluateReceipt;
      const kinds = rb.proposals.map((p) => p['kind']);
      expect(kinds).toEqual(['downrank']);
      expect(rb.thresholds_effective.downrankMinEvidence).toBe(4);
      expect(rb.thresholds_effective.downrankFailureRate).toBe(0.6);
      expect(rb.thresholds_effective.retireFailureRate).toBe(0.6); // 非法 2 → 缺省
      expect(rb.thresholds_ignored).toEqual(['retire_failure_rate=2', 'not_a_threshold=<unknown>']);
      // keep 证据同步可见（阈值放宽不动 keep 线，报告清单随回执透出）
      expect(Array.isArray(rb.keeps)).toBe(true);
    } finally {
      await b.handle.dispose();
      rmSync(b.dir, { recursive: true, force: true });
    }
  });
});
