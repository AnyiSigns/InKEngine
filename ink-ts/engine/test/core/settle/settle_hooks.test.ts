/**
 * 沉淀单元：归因钩子落库 / 失败审计 / 注册体隔离。
 *
 * 对标 ink_engine/tests/test_settle.py 的「存储钩子集成」「失败审计」
 * 「注册体」节：
 * - 归因钩子落库：成功全边 +1，失败只记失败结点入边（加权分摊 + 诊断）；
 * - 成本滑动均值随执行次数归集；
 * - 失败日志留痕审计 append-only（回调同源）；
 * - 注册体按序触发；单钩子异常 = 跳过不阻断其余钩子；非协议实现显式拒绝。
 */

import { describe, expect, it } from 'vitest';

import { EdgeEvidenceStore } from '../../../src/core/edge_evidence/store.js';
import {
  EdgeEvidenceSettleHook,
  FailureAuditSettleHook,
  SettleHooks,
} from '../../../src/core/settle/hooks.js';
import {
  TRACE_FAILED,
  TRACE_SUCCESS,
} from '../../../src/core/settle/_constants.js';
import { edgeKey, makeCtx, stepsOf } from './helpers.js';

describe('EdgeEvidenceSettleHook 归因钩子落库', () => {
  it('成功全边 +1，失败只记失败结点入边', async () => {
    const store = new EdgeEvidenceStore();
    const hook = new EdgeEvidenceSettleHook(store);
    // 成功 run
    await hook.settle(
      makeCtx(
        stepsOf(
          ['start', TRACE_SUCCESS],
          ['mid', TRACE_SUCCESS],
          ['end', TRACE_SUCCESS],
        ),
      ),
    );
    const e1 = await store.get(edgeKey('start', 'mid'));
    const e2 = await store.get(edgeKey('mid', 'end'));
    expect(e1).not.toBeNull();
    expect(e1!.success_count).toBe(1);
    expect(e2).not.toBeNull();
    expect(e2!.success_count).toBe(1);
    // 失败 run：只记失败结点入边
    await hook.settle(
      makeCtx(stepsOf(['start', TRACE_SUCCESS], ['mid', TRACE_FAILED]), {
        reason: 'error',
        error: 'boom',
      }),
    );
    const e1b = await store.get(edgeKey('start', 'mid'));
    // 加权分摊：失败前该边已有 1 次成功（权重 2），失败结点入边诊断 +1
    // → delta=3；失败信号按真实证据强度回撤，不再被成功膨胀稀释
    expect(e1b).not.toBeNull();
    expect(e1b!.fail_count).toBe(3);
    expect(e1b!.success_count).toBe(1);
    await store.close();
  });

  it('成本：avg_cost 滑动均值随执行次数归集', async () => {
    const store = new EdgeEvidenceStore();
    const hook = new EdgeEvidenceSettleHook(store);
    const successSteps = stepsOf(
      ['start', TRACE_SUCCESS],
      ['mid', TRACE_SUCCESS],
      ['end', TRACE_SUCCESS],
    );
    await hook.settle(makeCtx(successSteps, { tokens: { mid: 100, end: 100 } }));
    await hook.settle(
      makeCtx(successSteps, { tokens: { mid: 300, end: 300 } }),
    );
    const ev = await store.get(edgeKey('start', 'mid'));
    expect(ev).not.toBeNull();
    expect(ev!.avg_cost).toBe(200.0); // (100+300)/2
    await store.close();
  });
});

describe('FailureAuditSettleHook 失败审计', () => {
  it('失败日志留痕审计：append-only 登记（含回调同源）', async () => {
    const sink: Array<Record<string, unknown>> = [];
    const hook = new FailureAuditSettleHook({ sink: (record) => sink.push(record) });
    await hook.settle(
      makeCtx(stepsOf(['start', TRACE_SUCCESS], ['mid', TRACE_FAILED]), {
        reason: 'error',
        error: '节点执行失败',
      }),
    );
    expect(hook.records.length).toBe(1);
    expect(hook.records[0]!['node']).toBe('mid');
    expect(hook.records[0]!['domain']).toBe('code');
    expect(hook.records[0]!['reason']).toBe('节点执行失败');
    expect(sink).toEqual(hook.records);
    // 再次触发 = 追加不覆盖
    await hook.settle(
      makeCtx(stepsOf(['start', TRACE_SUCCESS], ['end', TRACE_FAILED]), {
        reason: 'error',
      }),
    );
    expect(hook.records.length).toBe(2);
  });
});

describe('SettleHooks 注册体', () => {
  it('注册体按序触发；单钩子异常 = 跳过，不阻断其余钩子', async () => {
    const calls: string[] = [];
    const hookA = {
      async settle(): Promise<void> {
        calls.push('a');
      },
    };
    const hookB = {
      async settle(): Promise<void> {
        throw new Error('钩子故障');
      },
    };
    const hookC = {
      async settle(): Promise<void> {
        calls.push('c');
      },
    };
    const hooks = new SettleHooks();
    hooks.register(hookA);
    hooks.register(hookB);
    hooks.register(hookC);
    const errors = await hooks.run(
      makeCtx(stepsOf(['start', TRACE_SUCCESS], ['mid', TRACE_SUCCESS])),
    );
    expect(calls).toEqual(['a', 'c']); // b 故障不阻断 c
    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(Error);
  });

  it('注册类型校验：非协议实现显式拒绝', () => {
    const hooks = new SettleHooks();
    expect(() => hooks.register('not-a-hook')).toThrow(TypeError);
  });
});
