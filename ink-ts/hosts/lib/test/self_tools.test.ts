/**
 * 产品自指执行器续跑意图写（P4-B-1 目标 2）单测——测的是：
 * - apply_patch 落地成功（响应 ok=true）→ 当前回合 state 置
 *   _round_continuation={reason:'evolved'}（引擎回合收尾据此自动续回合）；
 * - apply 未落地 / propose / revert 一律不续（只有落地才算显式进化）；
 * - 无 ctx.state（离线/单测上下文）直通不写；审批 auto 直过的前置标注不
 *   影响落地判定。
 *
 * core 为测试 seam：注入假内核返回 canned JSON，验证包装层的行为，不依赖
 * 真实自指管线（机制语义在 engine，host 只接线）。
 */

import { describe, expect, it } from 'vitest';
import { ROUND_CONTINUATION_STATE_KEY } from '@ink-ts/engine';
import type {
  SelfApplicationPipeline,
  SelfToolContext,
  SelfToolExecutor,
  SelfToolNodeContext,
  ToolSpec,
} from '@ink-ts/engine';

import { make_product_self_executor } from '../src/self_tools.js';

/** 假上下文（含 round/thread 元信息 + 回合 state 读写面 + interrupt seam）。 */
function fakeCtx(): { ctx: SelfToolNodeContext; state: Record<string, unknown> } {
  const state: Record<string, unknown> = { input: 'demo' };
  return {
    ctx: {
      round_id: 'r1',
      thread_id: 't1',
      state,
      interrupt: async () => null,
      get_interrupt_payload: async () => null,
    },
    state,
  };
}

/** 构造产品执行器（core 注入假内核）。 */
function executorReturning(text: string): SelfToolExecutor {
  const pipeline = {} as unknown as SelfApplicationPipeline;
  const contextGetter = (): SelfToolContext => ({} as unknown as SelfToolContext);
  const fakeCore: SelfToolExecutor = async () => text;
  return make_product_self_executor(pipeline, contextGetter, fakeCore);
}

function spec(name: string): ToolSpec {
  return { name } as unknown as ToolSpec;
}

describe('产品自指执行器续跑意图写（apply_patch 落地 → _round_continuation）', () => {
  it('apply_patch 落地成功（ok=true）→ state 置 evolved 意图（meta 带 patch_id）', async () => {
    const { ctx, state } = fakeCtx();
    const executor = executorReturning(
      JSON.stringify({ ok: true, status: 'applied', decision: 'accept', patch_id: 7, reason: null }),
    );
    const text = await executor(ctx, spec('apply_patch'), { kind: 'tool' }, null);
    expect(text).toContain('"ok":true');
    expect(state[ROUND_CONTINUATION_STATE_KEY]).toEqual({
      reason: 'evolved',
      meta: { patch_id: 7 },
    });
  });

  it('apply_patch 未落地（ok=false：审批拒/校验不过）→ 不写意图', async () => {
    const { ctx, state } = fakeCtx();
    const executor = executorReturning(
      JSON.stringify({ ok: false, status: 'rejected', decision: 'reject', reason: '审批未通过' }),
    );
    await executor(ctx, spec('apply_patch'), { kind: 'tool' }, null);
    expect(state[ROUND_CONTINUATION_STATE_KEY]).toBeUndefined();
  });

  it('propose_patch / revert_patch 结果 ok 也不续（仅落地=显式进化）', async () => {
    const proposeCtx = fakeCtx();
    await executorReturning(
      JSON.stringify({ ok: true, violations: [], current_version: 3 }),
    )(proposeCtx.ctx, spec('propose_patch'), { kind: 'rule' }, null);
    expect(proposeCtx.state[ROUND_CONTINUATION_STATE_KEY]).toBeUndefined();

    const revertCtx = fakeCtx();
    await executorReturning(
      JSON.stringify({ ok: true, status: 'reverted', decision: 'accept', patch_id: 3 }),
    )(revertCtx.ctx, spec('revert_patch'), { patch_id: 3 }, null);
    expect(revertCtx.state[ROUND_CONTINUATION_STATE_KEY]).toBeUndefined();
  });

  it('审批 auto 直过前置标注（结果前置文案）不阻断落地判定', async () => {
    const { ctx, state } = fakeCtx();
    const executor = executorReturning(
      `【已自动批准执行】${JSON.stringify({ ok: true, status: 'applied', patch_id: 9 })}`,
    );
    await executor(ctx, spec('apply_patch'), { kind: 'knowledge' }, null);
    expect(state[ROUND_CONTINUATION_STATE_KEY]).toEqual({
      reason: 'evolved',
      meta: { patch_id: 9 },
    });
  });

  it('apply_patch 响应非 JSON（异常/截断文本）→ 不写意图直通', async () => {
    const { ctx, state } = fakeCtx();
    const executor = executorReturning('工具执行异常：boom');
    await executor(ctx, spec('apply_patch'), { kind: 'tool' }, null);
    expect(state[ROUND_CONTINUATION_STATE_KEY]).toBeUndefined();
  });

  it('无 ctx.state（离线/单测上下文）→ 直通不写不抛', async () => {
    const ctx = {
      round_id: 'r1',
      interrupt: async () => null,
    } as SelfToolNodeContext;
    const executor = executorReturning(
      JSON.stringify({ ok: true, status: 'applied', patch_id: 1 }),
    );
    await expect(executor(ctx, spec('apply_patch'), { kind: 'tool' }, null)).resolves.toContain(
      '"ok":true',
    );
  });
});
