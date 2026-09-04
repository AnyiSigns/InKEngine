/**
 * 回退与审计单测（对标 Python test_self_application.py revert/audit 用例段）：
 * 回退须审批且仅链尾、回退后审计留痕、重复回退拒绝、审计 append-only。
 */

import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/core/errors.js';
import {
  AUDIT_STATUS_APPLIED,
  AUDIT_STATUS_REJECTED,
  AUDIT_STATUS_REVERTED,
} from '../../../src/core/self_application/index.js';

import { FakeCtx, MemStorage, _pipeline, _theme_proposal, _tool_proposal } from './helpers.js';

describe('SelfApplicationPipeline.revert（链尾限定 + 审批）', () => {
  it('回退非链尾补丁拒绝；链尾补丁审批后落地并留痕', async () => {
    const pipeline = _pipeline(new MemStorage());
    const ctx = new FakeCtx();
    await pipeline.apply(ctx, _theme_proposal());
    await pipeline.apply(ctx, _theme_proposal({ tokens: { bg: '#111' } }, 2));
    // 回退非链尾补丁（#2，其上还有 #3）→ 拒绝（保持链完整性）
    await expect(pipeline.revert(ctx, 2)).rejects.toThrow(GraphDefinitionError);
    await expect(pipeline.revert(ctx, 2)).rejects.toThrow(/仅允许回退链尾补丁/);
    // 回退链尾 #3：审批后落地
    ctx.preset('revert:3', { decision: 'accept' });
    const outcome = await pipeline.revert(ctx, 3, { reason: '换回旧主题' });
    expect(outcome.status).toBe(AUDIT_STATUS_REVERTED);
    const state = await pipeline.chain.assemble();
    expect(state['theme']).toEqual({ bg: '#111' });
    // 审计保留回退记录（历史不撒谎）
    const log = await pipeline.audit_log();
    expect(log.some((entry) => entry['status'] === AUDIT_STATUS_REVERTED)).toBe(true);
  });

  it('回退审批被拒 → 拒绝（不落回退、不落审计新记录）', async () => {
    const pipeline = _pipeline(new MemStorage());
    const ctx = new FakeCtx();
    await pipeline.apply(ctx, _theme_proposal());
    ctx.preset('revert:2', { decision: 'reject', reason: '暂不回退' });
    const outcome = await pipeline.revert(ctx, 2, { reason: '试试' });
    expect(outcome.applied).toBe(false);
    expect(outcome.status).toBe(AUDIT_STATUS_REJECTED);
    expect(await pipeline.chain.current_version()).toBe(2);
  });

  it('重复回退拒绝（回退后链版本复位，再次回退同一补丁 = 越界）', async () => {
    const pipeline = _pipeline(new MemStorage());
    const ctx = new FakeCtx();
    await pipeline.apply(ctx, _theme_proposal());
    ctx.preset('revert:2', { decision: 'accept' });
    const outcome = await pipeline.revert(ctx, 2, { reason: '换回' });
    expect(outcome.status).toBe(AUDIT_STATUS_REVERTED);
    expect(await pipeline.chain.current_version()).toBe(1);
    await expect(pipeline.revert(ctx, 2, { reason: '再次回退' })).rejects.toThrow(
      /仅允许回退链尾补丁/,
    );
  });

  it('回退后通知钩子失败：审计记 reverted_with_notify_error（outcome 同步携带）', async () => {
    const pipeline = _pipeline(new MemStorage(), {
      on_reverted: () => {
        throw new Error('活跃态回滚失败');
      },
    });
    const ctx = new FakeCtx();
    await pipeline.apply(ctx, _theme_proposal());
    ctx.preset('revert:2', { decision: 'accept' });
    const outcome = await pipeline.revert(ctx, 2, { reason: '换回' });
    expect(outcome.status).toBe('reverted_with_notify_error');
    expect(outcome.reason).toContain('活跃态回滚失败');
    expect(await pipeline.chain.current_version()).toBe(1);
  });
});

describe('集演化审计（append-only，历史不撒谎）', () => {
  it('审计按落库顺序追加：applied 在前、rejected 在后，payload 全量留痕', async () => {
    const pipeline = _pipeline(new MemStorage());
    const ctx = new FakeCtx();
    await pipeline.apply(ctx, _theme_proposal());
    // 第二条走 L1 挂卡并拒绝（theme 是 L0 直过，用 tool 补丁验证拒绝留痕）
    ctx.preset('patch:tool', { decision: 'reject', reason: '不注册' });
    const outcome = await pipeline.apply(ctx, _tool_proposal('t', 2));
    expect(outcome.status).toBe(AUDIT_STATUS_REJECTED);
    const log = await pipeline.audit_log();
    const statuses = log.map((entry) => entry['status']);
    expect(statuses).toEqual([AUDIT_STATUS_APPLIED, AUDIT_STATUS_REJECTED]);
    expect(log.every((entry) => entry['payload'] !== null && entry['payload'] !== undefined)).toBe(true);
  });
});
