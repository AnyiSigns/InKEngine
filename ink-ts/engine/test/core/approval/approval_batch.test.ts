/**
 * approve_batch 合并卡移植对标测试（对标 ink_engine/tests/test_approval.py 的
 * test_batch_* 系列）：同回合多写操作聚合一张卡——单次挂起、注入一个决议
 * 作用于全部动作（accept 全部执行 / edit 对齐替换 / reject 全部跳过 /
 * 全部 auto 不挂起）、非法对齐 fail-closed、超时默认拒绝。
 */
import { describe, expect, it } from 'vitest';

import {
  DECISION_ACCEPT,
  DECISION_AUTO,
  DECISION_EDIT,
  DECISION_REJECT,
  DefaultInterruptPolicy,
  approve_batch,
} from '../../../src/core/approval/approval.js';
import type { ApprovalInterruptContext } from '../../../src/core/approval/approval.js';

const BATCH_ACTIONS: Record<string, unknown>[] = [
  { tool: 'write_file', args: { path: 'a.md' }, summary: '写入 a.md' },
  { tool: 'update_entity', args: { name: '林晚' }, summary: '更新角色' },
  { tool: 'write_file', args: { path: 'b.md' }, summary: '写入 b.md' },
];

/** 模拟引擎 interrupt 原语的挂起信号（Python 侧 InterruptSignal 形态）。 */
class HungSignal extends Error {
  readonly key: string;
  readonly payload: Record<string, unknown>;

  constructor(key: string, payload: Record<string, unknown>) {
    super(`interrupt[${key}]`);
    this.name = 'HungSignal';
    this.key = key;
    this.payload = payload;
  }
}

/** 鸭子类型节点上下文：无注入值挂起（抛 HungSignal），有则消费返回。
 * onInterrupt 在挂起后调用（模拟"用户晚批"的时间流逝）。 */
class FakeCtx implements ApprovalInterruptContext {
  private readonly injects: Map<string, unknown>;
  private readonly onInterrupt?: () => void;
  hung: [string, Record<string, unknown>] | null = null;

  constructor(inject: Record<string, unknown> = {}, onInterrupt?: () => void) {
    this.injects = new Map(Object.entries(inject));
    this.onInterrupt = onInterrupt;
  }

  async interrupt(key: string, payload: Record<string, unknown>): Promise<unknown> {
    this.hung = [key, payload];
    if (this.onInterrupt) this.onInterrupt();
    if (this.injects.has(key)) {
      const injected = this.injects.get(key);
      this.injects.delete(key);
      return injected;
    }
    throw new HungSignal(key, payload);
  }
}

/** 可控时钟（Python _FakeClock 同构）。 */
class FakeClock {
  now: number;

  constructor(start = 1000) {
    this.now = start;
  }

  advance(seconds: number): void {
    this.now += seconds;
  }
}

function clockOf(fake: FakeClock): () => number {
  return () => fake.now;
}

describe('approve_batch 合并卡', () => {
  it('accept 决议作用于全部动作', async () => {
    const ctx = new FakeCtx({ batch: { decision: DECISION_ACCEPT } });
    const decisions = await approve_batch(ctx, 'batch', BATCH_ACTIONS);
    expect(decisions.length).toBe(3);
    expect(decisions.every((d) => d.decision === DECISION_ACCEPT)).toBe(true);
    expect(decisions.map((d) => d.action)).toEqual(BATCH_ACTIONS);
  });

  it('edit 决议需 edited_contents 与动作数对齐，逐条替换', async () => {
    const ctx = new FakeCtx({
      batch: { decision: DECISION_EDIT, edited_contents: ["a'", "b'", "c'"] },
    });
    const decisions = await approve_batch(ctx, 'batch', BATCH_ACTIONS);
    expect(decisions.map((d) => d.decision)).toEqual([DECISION_EDIT, DECISION_EDIT, DECISION_EDIT]);
    expect(decisions.map((d) => d.edited_content)).toEqual(["a'", "b'", "c'"]);
  });

  it('edit 内容未对齐 → 全部 reject（source=invalid）', async () => {
    const ctx = new FakeCtx({ batch: { decision: DECISION_EDIT, edited_contents: ["a'"] } });
    const decisions = await approve_batch(ctx, 'batch', BATCH_ACTIONS);
    expect(decisions.every((d) => d.decision === DECISION_REJECT)).toBe(true);
    expect(decisions.every((d) => d.source === 'invalid')).toBe(true);
  });

  it('reject 决议带 reason 透传（全部跳过）', async () => {
    const ctx = new FakeCtx({ batch: { decision: DECISION_REJECT, reason: '全部取消' } });
    const decisions = await approve_batch(ctx, 'batch', BATCH_ACTIONS);
    expect(decisions.every((d) => d.decision === DECISION_REJECT)).toBe(true);
    expect(decisions[0]!.reason).toBe('全部取消');
  });

  it('全部工具直过名单命中 → 整批 auto 且不挂起', async () => {
    const policy = new DefaultInterruptPolicy(new Set(), new Set(['write_file', 'update_entity']));
    const ctx = new FakeCtx();
    const decisions = await approve_batch(ctx, 'batch', BATCH_ACTIONS, null, policy);
    expect(decisions.every((d) => d.decision === DECISION_AUTO)).toBe(true);
    expect(ctx.hung).toBeNull();
  });

  it('合并卡单次挂起：key 一次 + actions 聚合', async () => {
    const ctx = new FakeCtx();
    await expect(approve_batch(ctx, 'batch', BATCH_ACTIONS)).rejects.toBeInstanceOf(HungSignal);
    expect(ctx.hung).not.toBeNull();
    const [key, card] = ctx.hung!;
    expect(key).toBe('batch');
    expect(card['review_type']).toBe('gate');
    expect((card['actions'] as unknown[]).length).toBe(3);
  });

  it('批处理窗口过期 → 全部 reject（source=expired）', async () => {
    const clock = new FakeClock();
    const policy = new DefaultInterruptPolicy(new Set(), new Set(), 10);
    const ctx = new FakeCtx({ batch: { decision: DECISION_ACCEPT } }, () => clock.advance(11));
    const decisions = await approve_batch(ctx, 'batch', BATCH_ACTIONS, null, policy, {
      clock: clockOf(clock),
    });
    expect(decisions.every((d) => d.decision === DECISION_REJECT)).toBe(true);
    expect(decisions.every((d) => d.source === 'expired')).toBe(true);
  });
});
