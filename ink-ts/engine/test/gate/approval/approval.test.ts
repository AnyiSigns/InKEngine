// gate: 超限(382 行) - approval 全决议分支/超时/pose 姿态用例共用同一断言装置，整链回归可读性优先
/**
 * approval 挂卡审批移植对标测试（语义逐点对标 ink_engine/tests/test_approval.py
 * 的非引擎用例）：全决议分支（accept/edit/reject/terminate/auto）、策略钩子
 * 替换、超时默认拒绝（fail-closed 兜底）、非法注入 fail-closed、gate 卡形态。
 *
 * 引擎级用例未移植（test_engine_hang_then_resume_accept / test_engine_resume_edit
 * / test_engine_resume_terminate / test_engine_hang_without_inject_keeps_card /
 * 同轮同工具审批 #2 指纹 3 例）：它们断言 graph/interrupt 协调器的 checkpoint
 * 持久化、注入重入续跑与发卡键指纹语义（interrupt.py 的 InterruptCoordinator +
 * Graph 运行时），不属于本模块——approval 对中断键原样透传、不掺指纹。对应
 * TS 引擎运行时模块移植后再对标（同 chain_rebase 先例：引擎集成用例随引擎移植，
 * 本文件只覆盖本模块自身语义）。
 *
 * 测试用 FakeCtx 为鸭子类型节点上下文（模拟挂起抛控制流信号/注入消费/重入读
 * 回已挂卡），FakeClock 为可控时钟注入——与 Python 侧 _FakeCtx/_FakeClock 同构。
 */
import { describe, expect, it } from 'vitest';

import {
  DECISION_ACCEPT,
  DECISION_AUTO,
  DECISION_EDIT,
  DECISION_REJECT,
  DECISION_TERMINATE,
  POSE_AUTO,
  POSE_DENY,
  DefaultInterruptPolicy,
  approve_batch,
  approve_before_execute,
} from '../../../src/gate/approval/approval.js';
import type { ApprovalInterruptContext, InterruptPolicy } from '../../../src/gate/approval/approval.js';

const ACTION_WRITE: Record<string, unknown> = {
  tool: 'write_file',
  args: { path: 'a.md' },
  summary: '写入 a.md',
};

const BATCH_ACTIONS: Record<string, unknown>[] = [
  ACTION_WRITE,
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
 * onInterrupt 在挂起后调用（模拟"用户晚批"的时间流逝）；saved 供
 * get_interrupt_payload 读回已挂卡（模拟 checkpoint 持久化）。 */
class FakeCtx implements ApprovalInterruptContext {
  private readonly injects: Map<string, unknown>;
  private readonly onInterrupt?: () => void;
  private readonly saved: Record<string, unknown> | null;
  hung: [string, Record<string, unknown>] | null = null;

  constructor(
    inject: Record<string, unknown> = {},
    onInterrupt?: () => void,
    saved: Record<string, unknown> | null = null,
  ) {
    this.injects = new Map(Object.entries(inject));
    this.onInterrupt = onInterrupt;
    this.saved = saved;
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

  async get_interrupt_payload(): Promise<unknown> {
    return this.saved;
  }
}

/** 可控时钟（Python _FakeClock 同构；clock 注入闭包读 now）。 */
class FakeClock {
  now: number;

  constructor(start = 1000) {
    this.now = start;
  }

  advance(seconds: number): void {
    this.now += seconds;
  }
}

/** 由 FakeClock 包装为 () => number 的时钟注入。 */
function clockOf(fake: FakeClock): () => number {
  return () => fake.now;
}

describe('单动作全决议分支', () => {
  it('dict 注入 accept：决议/来源/动作透传且无编辑内容', async () => {
    const ctx = new FakeCtx({ gate: { decision: DECISION_ACCEPT } });
    const decision = await approve_before_execute(ctx, 'gate', ACTION_WRITE);
    expect(decision.decision).toBe(DECISION_ACCEPT);
    expect(decision.source).toBe('inject');
    expect(decision.action).toEqual(ACTION_WRITE);
    expect(decision.edited_content).toBeNull();
  });

  it('edit 决议透传 edited_content', async () => {
    const ctx = new FakeCtx({ gate: { decision: DECISION_EDIT, edited_content: '替换后的正文' } });
    const decision = await approve_before_execute(ctx, 'gate', ACTION_WRITE);
    expect(decision.decision).toBe(DECISION_EDIT);
    expect(decision.edited_content).toBe('替换后的正文');
  });

  it('字符串简写注入 reject：reason 为 None', async () => {
    const ctx = new FakeCtx({ gate: DECISION_REJECT });
    const decision = await approve_before_execute(ctx, 'gate', ACTION_WRITE);
    expect(decision.decision).toBe(DECISION_REJECT);
    expect(decision.reason).toBeNull();
  });

  it('terminate 决议带 reason 透传', async () => {
    const ctx = new FakeCtx({ gate: { decision: DECISION_TERMINATE, reason: '用户取消' } });
    const decision = await approve_before_execute(ctx, 'gate', ACTION_WRITE);
    expect(decision.decision).toBe(DECISION_TERMINATE);
    expect(decision.reason).toBe('用户取消');
  });

  it('策略按 key 直过：决议 auto 且未挂起', async () => {
    const policy = new DefaultInterruptPolicy(new Set(['gate']));
    const ctx = new FakeCtx();
    const decision = await approve_before_execute(ctx, 'gate', ACTION_WRITE, null, policy);
    expect(decision.decision).toBe(DECISION_AUTO);
    expect(decision.source).toBe('policy');
    expect(ctx.hung).toBeNull();
  });

  it('策略按 tool 直过：决议 auto 且未挂起', async () => {
    const policy = new DefaultInterruptPolicy(new Set(), new Set(['write_file']));
    const ctx = new FakeCtx();
    const decision = await approve_before_execute(ctx, 'gate', ACTION_WRITE, null, policy);
    expect(decision.decision).toBe(DECISION_AUTO);
    expect(ctx.hung).toBeNull();
  });

  it('策略钩子可替换：宿主自定义 should_approve/timeout_for 生效', async () => {
    const reviewOnlyPolicy: InterruptPolicy = {
      should_approve: (_key, action) => action['tool'] !== 'read_file',
      timeout_for: () => null,
    };
    const read = await approve_before_execute(
      new FakeCtx({ gate: { decision: DECISION_ACCEPT } }),
      'gate',
      { tool: 'read_file' },
      null,
      reviewOnlyPolicy,
    );
    expect(read.decision).toBe(DECISION_AUTO);
    const writeCtx = new FakeCtx({ gate: { decision: DECISION_ACCEPT } });
    const write = await approve_before_execute(writeCtx, 'gate', ACTION_WRITE, null, reviewOnlyPolicy);
    expect(write.decision).toBe(DECISION_ACCEPT);
    expect(writeCtx.hung).not.toBeNull();
  });
});

describe('超时默认拒绝（fail-closed 兜底）', () => {
  it('审批窗口内晚批过期 → 一律 reject（source=expired）', async () => {
    const clock = new FakeClock();
    const policy = new DefaultInterruptPolicy(new Set(), new Set(), 30);
    const ctx = new FakeCtx(
      { gate: { decision: DECISION_ACCEPT } },
      () => clock.advance(31),
    );
    const decision = await approve_before_execute(ctx, 'gate', ACTION_WRITE, null, policy, {
      clock: clockOf(clock),
    });
    expect(decision.decision).toBe(DECISION_REJECT);
    expect(decision.source).toBe('expired');
    expect(decision.reason ?? '').toContain('超时');
  });

  it('窗口内审批（29 秒 < 30 秒）仍生效', async () => {
    const clock = new FakeClock();
    const policy = new DefaultInterruptPolicy(new Set(), new Set(), 30);
    const ctx = new FakeCtx(
      { gate: { decision: DECISION_ACCEPT } },
      () => clock.advance(29),
    );
    const decision = await approve_before_execute(ctx, 'gate', ACTION_WRITE, null, policy, {
      clock: clockOf(clock),
    });
    expect(decision.decision).toBe(DECISION_ACCEPT);
  });

  it('默认不限时：不写 expires_at', async () => {
    const ctx = new FakeCtx({ gate: { decision: DECISION_ACCEPT } });
    const decision = await approve_before_execute(ctx, 'gate', ACTION_WRITE);
    expect(decision.decision).toBe(DECISION_ACCEPT);
    expect(ctx.hung).not.toBeNull();
    expect(ctx.hung![1]).not.toHaveProperty('expires_at');
  });

  it('重入读回已挂卡 expires_at（不重算窗口）：晚批超时默认拒绝', async () => {
    const clock = new FakeClock();
    const policy = new DefaultInterruptPolicy(new Set(), new Set(), 30);
    // 首次挂起：expires_at = 1000 + 30 = 1030（随挂起卡持久化）
    const first = new FakeCtx();
    await expect(
      approve_before_execute(first, 'gate', ACTION_WRITE, null, policy, { clock: clockOf(clock) }),
    ).rejects.toBeInstanceOf(HungSignal);
    const savedCard = { ...first.hung![1] };
    // 重入：时钟已流逝 31 秒，读回 1030 → 过期默认拒绝（fail-closed 生效）
    const ctx = new FakeCtx({ gate: { decision: DECISION_ACCEPT } }, () => clock.advance(31), savedCard);
    const decision = await approve_before_execute(ctx, 'gate', ACTION_WRITE, null, policy, {
      clock: clockOf(clock),
    });
    expect(decision.decision).toBe(DECISION_REJECT);
    expect(decision.source).toBe('expired');
  });
});

describe('非法注入 fail-closed', () => {
  it('非法决议值一律回落 reject（source=invalid）', async () => {
    const bads: unknown[] = [
      { foo: 1 },
      { decision: 'maybe' },
      { decision: DECISION_AUTO },
      { decision: DECISION_EDIT },
      'edit',
      'auto',
      42,
    ];
    for (const bad of bads) {
      const ctx = new FakeCtx({ gate: bad });
      const decision = await approve_before_execute(ctx, 'gate', ACTION_WRITE);
      expect(decision.decision).toBe(DECISION_REJECT);
      expect(decision.source).toBe('invalid');
    }
  });
});

describe('gate 卡形态', () => {
  it('挂起卡为 gate 卡：tool 定位 + action/summary 预览', async () => {
    const ctx = new FakeCtx();
    await expect(approve_before_execute(ctx, 'gate', ACTION_WRITE)).rejects.toBeInstanceOf(HungSignal);
    expect(ctx.hung).not.toBeNull();
    const [key, card] = ctx.hung!;
    expect(key).toBe('gate');
    expect(card['review_type']).toBe('gate');
    expect(card['node_id']).toBe('write_file');
    expect(card['action']).toEqual(ACTION_WRITE);
    expect(card['output_preview']).toBe('写入 a.md');
  });

  it('宿主 payload 字段优先 + 超时写 expires_at', async () => {
    const clock = new FakeClock();
    const policy = new DefaultInterruptPolicy(new Set(), new Set(), 60);
    const payload: Record<string, unknown> = {
      node_id: 'custom_node',
      node_label: '自定义卡',
      diff: '宿主摘要',
    };
    const ctx = new FakeCtx();
    await expect(
      approve_before_execute(ctx, 'gate', ACTION_WRITE, payload, policy, { clock: clockOf(clock) }),
    ).rejects.toBeInstanceOf(HungSignal);
    expect(ctx.hung).not.toBeNull();
    const card = ctx.hung![1];
    expect(card['node_id']).toBe('custom_node');
    expect(card['review_type']).toBe('gate');
    expect(card['expires_at']).toBe(1060);
  });
});

describe('审批姿态（pose）语义', () => {
  const needsReview = new DefaultInterruptPolicy(); // 空名单：全量挂起

  it('pose=auto：需挂起调用免弹直过（auto，不挂起，source=pose）', async () => {
    const ctx = new FakeCtx(); // 无注入：挂起会抛 HungSignal——pose 直过不应触发
    const decision = await approve_before_execute(ctx, 'gate', ACTION_WRITE, null, needsReview, {
      pose: POSE_AUTO,
    });
    expect(decision.decision).toBe(DECISION_AUTO);
    expect(decision.source).toBe('pose');
    expect(ctx.hung).toBeNull();
  });

  it('pose=deny：需挂起调用免问直拒（reject，不挂起，source=pose）', async () => {
    const ctx = new FakeCtx();
    const decision = await approve_before_execute(ctx, 'gate', ACTION_WRITE, null, needsReview, {
      pose: POSE_DENY,
    });
    expect(decision.decision).toBe(DECISION_REJECT);
    expect(decision.source).toBe('pose');
    expect(decision.reason ?? '').toContain('deny');
    expect(ctx.hung).toBeNull();
  });

  it('pose=review（缺省/显式）：现状不变——policy 直过名单仍直过，其余挂起', async () => {
    // review 缺省：挂起卡原样抛 HungSignal
    const ctx = new FakeCtx();
    await expect(approve_before_execute(ctx, 'gate', ACTION_WRITE, null, needsReview)).rejects.toBeInstanceOf(HungSignal);
    expect(ctx.hung).not.toBeNull();
    // policy 直过名单（auto_approve_key）不受 pose=deny 收回
    const policy = new DefaultInterruptPolicy(new Set(['gate']));
    const denyCtx = new FakeCtx();
    const auto = await approve_before_execute(denyCtx, 'gate', ACTION_WRITE, null, policy, {
      pose: POSE_DENY,
    });
    expect(auto.decision).toBe(DECISION_AUTO);
    expect(auto.source).toBe('policy');
    expect(denyCtx.hung).toBeNull();
  });

  it('pose 非法值回落 review（fail-closed：挂起照旧）', async () => {
    const ctx = new FakeCtx();
    await expect(
      approve_before_execute(ctx, 'gate', ACTION_WRITE, null, needsReview, { pose: 'bogus' }),
    ).rejects.toBeInstanceOf(HungSignal);
    expect(ctx.hung).not.toBeNull();
  });

  it('approve_batch pose=auto：整批免弹直过不挂起', async () => {
    const ctx = new FakeCtx();
    const decisions = await approve_batch(ctx, 'gate', BATCH_ACTIONS, null, needsReview, {
      pose: POSE_AUTO,
    });
    expect(decisions).toHaveLength(BATCH_ACTIONS.length);
    for (const d of decisions) {
      expect(d.decision).toBe(DECISION_AUTO);
      expect(d.source).toBe('pose');
    }
    expect(ctx.hung).toBeNull();
  });

  it('approve_batch pose=deny：整批免问直拒不挂起', async () => {
    const ctx = new FakeCtx();
    const decisions = await approve_batch(ctx, 'gate', BATCH_ACTIONS, null, needsReview, {
      pose: POSE_DENY,
    });
    expect(decisions).toHaveLength(BATCH_ACTIONS.length);
    for (const d of decisions) {
      expect(d.decision).toBe(DECISION_REJECT);
      expect(d.source).toBe('pose');
    }
    expect(ctx.hung).toBeNull();
  });

  it('approve_batch 混合批次：policy 预授权动作不被 pose 收回/误标（逐动作语义）', async () => {
    const mixedPolicy: InterruptPolicy = {
      should_approve: (_key, action) => action['tool'] !== 'read_file',
      timeout_for: () => null,
    };
    const readAction = { tool: 'read_file', args: {} };
    const writeAction = { tool: 'write_file', args: {} };

    // deny 档：预授权 read 保持 policy 直过，仅需审批 write 被拒绝
    const denyDecisions = await approve_batch(
      new FakeCtx(),
      'gate',
      [readAction, writeAction],
      null,
      mixedPolicy,
      { pose: POSE_DENY },
    );
    expect(denyDecisions[0]).toMatchObject({ decision: DECISION_AUTO, source: 'policy' });
    expect(denyDecisions[1]).toMatchObject({ decision: DECISION_REJECT, source: 'pose' });

    // auto 档：预授权 read 保持 policy 直过，需审批 write 走 pose 直过
    const autoDecisions = await approve_batch(
      new FakeCtx(),
      'gate',
      [readAction, writeAction],
      null,
      mixedPolicy,
      { pose: POSE_AUTO },
    );
    expect(autoDecisions[0]).toMatchObject({ decision: DECISION_AUTO, source: 'policy' });
    expect(autoDecisions[1]).toMatchObject({ decision: DECISION_AUTO, source: 'pose' });
  });
});
