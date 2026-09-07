/**
 * 池治理状态持久化 store 单元测试。
 *
 * - Set 面（merged/invalidated/promoted/downgraded）落 records：同 storage 的
 *   新 store 实例（模拟重启）读取去重集合不重置；
 * - 判定记录行（周预算已用口径）跨实例追加不覆盖（键按 domain/round/trace/
 *   候选复合），重启后仍可计入窗口；
 * - 内存回落 seam 与 Records 实现同接口可替换。
 */

import { describe, expect, it } from 'vitest';

import { MemoryStorage } from '../executor/helpers.js';
import {
  RecordsPoolGovernanceStateStore,
  memory_pool_governance_state,
  pool_governance_collection,
} from '../../../src/core/pool_governance/state_store.js';
import { weekly_proposal_usage } from '../../../src/core/pool_governance/pool_governance.js';

function make_store(storage: MemoryStorage): RecordsPoolGovernanceStateStore {
  return new RecordsPoolGovernanceStateStore(storage, pool_governance_collection('default'), {
    now: () => 1000,
  });
}

describe('RecordsPoolGovernanceStateStore 持久化（重启不重置）', () => {
  it('去重集合与判定记录跨 store 实例（同 records）保留', async () => {
    const storage = new MemoryStorage();
    const first = make_store(storage);
    await first.mark_merged('code\u001fllm_decider');
    await first.mark_invalidated('code\u001ftool_pipeline');
    await first.mark_promoted(JSON.stringify([['a', 'b']]));
    await first.mark_downgraded('code\u001fstart\u001fmid');
    await first.append_decision({
      domain: 'code',
      round_id: 'r1',
      trace_id: 'trace-1',
      candidate: 'mid',
      verdict: 'allow',
      ts: 1000,
    });
    // 模拟重启：同 storage 新建 store 实例
    const revived = make_store(storage);
    expect(await revived.merged_keys()).toEqual(new Set(['code\u001fllm_decider']));
    expect(await revived.invalidated_keys()).toEqual(new Set(['code\u001ftool_pipeline']));
    expect(await revived.promoted_signatures()).toEqual(
      new Set([JSON.stringify([['a', 'b']])]),
    );
    expect(await revived.downgraded_keys()).toEqual(new Set(['code\u001fstart\u001fmid']));
    const decisions = await revived.decisions();
    expect(decisions.length).toBe(1);
    // 周预算已用口径读取持久判定行
    expect(weekly_proposal_usage(decisions, { now: 2000 })).toBe(1);
  });

  it('判定记录跨重启追加（键不互相覆盖，窗口计数累积）', async () => {
    const storage = new MemoryStorage();
    const first = make_store(storage);
    await first.append_decision({
      domain: 'code', round_id: 'r1', trace_id: 't1', candidate: 'mid', ts: 100,
    });
    await first.append_decision({
      domain: 'code', round_id: 'r2', trace_id: 't1', candidate: 'mid', ts: 200,
    });
    const second = make_store(storage);
    await second.append_decision({
      domain: 'code', round_id: 'r3', trace_id: 't1', candidate: 'mid', ts: 300,
    });
    const decisions = await second.decisions();
    expect(decisions.length).toBe(3);
    expect(weekly_proposal_usage(decisions, { now: 400 })).toBe(3);
  });

  it('memory 回落 seam 与 Records 实现接口等价', async () => {
    const memory = memory_pool_governance_state();
    await memory.mark_merged('a\u001fb');
    await memory.append_decision({ domain: 'x', round_id: 'r', candidate: 'c', ts: 1 });
    expect((await memory.merged_keys()).has('a\u001fb')).toBe(true);
    expect(await memory.decisions()).toHaveLength(1);
    await memory.mark_merged('a\u001fb');
    expect((await memory.merged_keys()).size).toBe(1);
  });
});
