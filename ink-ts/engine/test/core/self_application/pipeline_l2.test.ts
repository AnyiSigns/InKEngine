/**
 * 应用管线 L2 沙箱验证单测（对标 Python test_self_application.py L2 用例段）：
 * vetting 违规拒绝、vetting 通过后进入人工弹卡、vetting 钩子未装配
 * fail-closed（不静默降级 L1）。
 */

import { describe, expect, it } from 'vitest';

import {
  ApprovalLevel,
  SelfApplicationPipeline,
} from '../../../src/core/self_application/index.js';
import type { L2VettingHook } from '../../../src/core/self_application/index.js';
import { PatchKind, ProposalValidator } from '../../../src/core/self_proposal/index.js';

import { FakeCtx, MemStorage, _artifact_proposal, _validator } from './helpers.js';

function _l2_pipeline(options: {
  approval_levels?: Partial<Record<PatchKind, ApprovalLevel>>;
  l2_vetting?: L2VettingHook | null;
} = {}): SelfApplicationPipeline {
  return new SelfApplicationPipeline({
    storage: new MemStorage(),
    validator: _validator(),
    approval_levels: options.approval_levels ?? { artifact: ApprovalLevel.L2 },
    l2_vetting: options.l2_vetting ?? null,
  });
}

describe('SelfApplicationPipeline.apply L2 沙箱验证', () => {
  it('vetting 违规 → 拒绝（未挂卡、未落链）', async () => {
    const pipeline = _l2_pipeline({
      l2_vetting: () => ['产物包含可疑符号'],
    });
    const ctx = new FakeCtx();
    const outcome = await pipeline.apply(ctx, _artifact_proposal());
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toContain('L2 沙箱验证未通过');
    expect(ctx.cards).toEqual([]);
  });

  it('vetting 通过 → 进入人工弹卡（accept 后落链）', async () => {
    const pipeline = _l2_pipeline({
      l2_vetting: () => [],
    });
    const ctx = new FakeCtx();
    ctx.preset('patch:artifact', { decision: 'accept' });
    const outcome = await pipeline.apply(ctx, _artifact_proposal());
    expect(outcome.applied).toBe(true);
    expect(ctx.cards.length).toBe(1);
    const state = await pipeline.chain.assemble();
    const artifacts = state['artifacts'] as Record<string, unknown>;
    expect(artifacts['a-1']).toBeDefined();
  });

  it('L2 类型未装配沙箱验证钩子 = 显式拒绝（fail-closed，不静默降级 L1）', async () => {
    const pipeline = new SelfApplicationPipeline({
      storage: new MemStorage(),
      validator: new ProposalValidator(),
      approval_levels: { artifact: ApprovalLevel.L2 },
    });
    const ctx = new FakeCtx();
    const outcome = await pipeline.apply(ctx, _artifact_proposal());
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toContain('沙箱验证未装配');
    expect(ctx.cards).toEqual([]); // 未挂卡（闸门口拒绝）
    expect(await pipeline.chain.current_version()).toBe(1);
  });
});
