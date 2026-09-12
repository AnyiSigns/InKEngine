/**
 * 隔离试跑基座测试（trial_runner.ts：真实 TrialRunner + verdict 语义 + 隔离）。
 *
 * 测什么：
 * - trial_verdict：成功且有产物 = pass；失败 = fail；降级/阻断/产物为空 =
 *   inconclusive（证据不足不证明安全，verdict_blocks 一致阻断）；
 * - 隔离：make_trial_runner 强制 archive=null —— 试跑轨迹/证据绝不入主组织档案
 *   （即便 base deps 带 archive sink）；run_id 走 `trial:` 命名空间；
 * - 缺省探针：从 TrialSpec 载荷取被变更资产 id 作入口；载荷取不到 = inconclusive；
 * - 采纳前验证闸接线：run_adoption_gate + 真实试跑 runner（pass 放行 /
 *   fail·inconclusive 阻断）。
 */
import { describe, expect, it } from 'vitest';

import { ChannelDirectory, default_channel_seeds } from '../../../src/model/channels/channel_directory.js';
import { EntitySpec } from '../../../src/core/entities/entities.js';
import { ExecutionRuntime } from '../../../src/loop/execution_runtime/execution_runtime.js';
import type { ExecutionResult } from '../../../src/loop/execution_runtime/runtime_types.js';
import {
  default_trial_probe,
  make_trial_runner,
  trial_verdict,
} from '../../../src/loop/trial/trial_runner.js';
import type { ScopeTurnResult } from '../../../src/loop/execution_runtime/scope_turn.js';
import type { ScopeTurnContext, ExecutionRuntimeDeps } from '../../../src/loop/execution_runtime/runtime_types.js';
import { run_adoption_gate, type TrialSpec } from '../../../src/core/controlled_evolution/adoption_gate.js';
import { EvolutionProposal } from '../../../src/core/controlled_evolution/evolution_proposal.js';

function resultWith(outcome: 'success' | 'failure' | 'degraded', emptyProduct = false): ExecutionResult {
  const base: ExecutionResult = {
    root: {
      run_id: 'r',
      parent_run_id: null,
      entry_scope: 'main',
      outcome,
      hops: [],
      cost: {},
      degraded_summaries: [],
      children: [],
      error: outcome === 'failure' ? '失败原因' : null,
    },
    final_product: emptyProduct ? {} : { message: outcome === 'success' ? '产物' : '部分产物' },
    degraded_summaries: outcome === 'degraded' ? ['降级摘要'] : [],
    runs: [],
    trails: [],
    events: [],
    blocked: false,
    block_reason: null,
    pending_approval: false,
    pending_interrupt: null,
    resume_checkpoint_id: null,
  };
  return base;
}

function spec(id: string, kind = 'update_scope'): TrialSpec {
  return {
    kind: kind as TrialSpec['kind'],
    payload: { asset: { id, scope: { guard_level: 'L1' } } },
    rationale: '验证变更',
    confidence: 0.8,
    evidence: { probe: true },
    provenance: 'agent_self',
  };
}

/** 按脚本吐答复的 fake turn（成功 / 失败）。 */
class FakeTurn {
  constructor(private readonly mode: 'ok' | 'fail') {}
  async run_scope_turn(ctx: ScopeTurnContext): Promise<ScopeTurnResult> {
    void ctx;
    if (this.mode === 'fail') {
      return { ok: false, reply: '', reason: 'turn 失败', summary: '作用域加工失败' };
    }
    return { ok: true, reply: '{"message":"试跑产物"}', payload: { message: '试跑产物' } };
  }
}

function baseDeps(mode: 'ok' | 'fail'): ExecutionRuntimeDeps {
  const scopes = new Map<string, EntitySpec>([
    ['planner', new EntitySpec({ id: 'planner', role: 'planner', persona: '规划', model: null })],
  ]);
  const channels = new ChannelDirectory();
  for (const spec of default_channel_seeds()) channels.register(spec);
  return {
    load_scope: (id) => scopes.get(id) ?? null,
    channels,
    turn: new FakeTurn(mode),
  };
}

describe('trial_verdict 语义', () => {
  it('成功且有产物 = pass', () => {
    expect(trial_verdict(resultWith('success'))).toBe('pass');
  });

  it('失败 = fail；降级 = inconclusive；阻断 = inconclusive', () => {
    expect(trial_verdict(resultWith('failure'))).toBe('fail');
    expect(trial_verdict(resultWith('degraded'))).toBe('inconclusive');
    expect(trial_verdict({ ...resultWith('success'), blocked: true, block_reason: 'x' })).toBe('inconclusive');
  });

  it('成功但产物为空 = inconclusive（证据不足）', () => {
    expect(trial_verdict(resultWith('success', true))).toBe('inconclusive');
  });
});

describe('缺省探针', () => {
  it('从载荷 asset.id 取入口作用域', () => {
    const request = default_trial_probe(spec('planner'));
    expect(request?.entry_scope).toBe('planner');
    expect(request?.task).toContain('update_scope');
  });

  it('载荷取不到目标 id = null（执行器返回 inconclusive）', () => {
    const request = default_trial_probe({ ...spec('x'), payload: {} });
    expect(request).toBeNull();
  });
});

describe('隔离与 verdict 回路', () => {
  it('试跑成功 → pass；试跑失败 → fail', async () => {
    const passRunner = make_trial_runner({ deps: baseDeps('ok') });
    expect(await passRunner.run_trial(spec('planner'))).toBe('pass');

    const failRunner = make_trial_runner({ deps: baseDeps('fail') });
    expect(await failRunner.run_trial(spec('planner'))).toBe('fail');
  });

  it('隔离：正式执行向主档案 ingest 轨迹；同一 deps 交给试跑器则零新增', async () => {
    const ingests: string[] = [];
    const mainDeps: ExecutionRuntimeDeps = {
      ...baseDeps('ok'),
      archive: { ingest: () => ingests.push('x') },
    };
    // 对照组：正式执行路径确实 ingest（否则"零新增"断言是空洞通过）
    const main = new ExecutionRuntime(mainDeps);
    await main.run({ task: '正式执行', entry_scope: 'planner' });
    const before = ingests.length;
    expect(before).toBeGreaterThan(0);

    // 试跑器从带同一 archive sink 的 deps 构造：make_trial_runner 强制 archive=null
    const runner = make_trial_runner({ deps: mainDeps });
    expect(await runner.run_trial(spec('planner'))).toBe('pass');
    expect(ingests.length).toBe(before);
  });

  it('采纳前验证闸接线：pass 放行；fail / inconclusive 阻断（verdict_blocks 语义）', async () => {
    const proposal = new EvolutionProposal({
      kind: 'update_scope',
      payload: { asset: { id: 'planner', scope: { guard_level: 'L1' } } },
      provenance: 'agent_self',
      rationale: '验证采纳',
      confidence: 0.8,
      evidence: {},
    });
    const gate = await run_adoption_gate(proposal, { seam: make_trial_runner({ deps: baseDeps('ok') }) });
    expect(gate.required).toBe(true);
    expect(gate.blocked).toBe(false);
    expect(gate.verdict).toBe('pass');

    const blocked = await run_adoption_gate(proposal, { seam: make_trial_runner({ deps: baseDeps('fail') }) });
    expect(blocked.blocked).toBe(true);
    expect(blocked.verdict).toBe('fail');
  });
});
