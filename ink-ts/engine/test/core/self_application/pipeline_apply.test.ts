/**
 * 应用管线分级审批/决议语义单测（对标 Python test_self_application.py
 * pipeline.apply 用例段）：L0 直过 / L1 挂卡 / 拒绝 / 编辑重新校验 /
 * 并发冲突 / 非法拒绝 / 活跃态目标钩子 / 守卫令牌透传 / 超时过期拒绝。
 *
 *  deferred（引擎执行器集成面另行覆盖）：经执行器跑完整回路的集成用例
 *  （中断 checkpoint 持久化的超时判定/真实存储后端）对应 Python 集成面，
 *  待宿主装配面迁入后补测；本文件以内存假存储 + 假节点上下文驱动纯机制
 *  语义，零执行器依赖。
 */

import { describe, expect, it } from 'vitest';

import { DECISION_ACCEPT, DECISION_AUTO, DECISION_REJECT } from '../../../src/core/approval/approval.js';
import {
  AUDIT_STATUS_CONFLICT,
  AUDIT_STATUS_INVALID,
  AUDIT_STATUS_REJECTED,
  GuardedStorage,
  SelfApplicationPipeline,
  SetPatchChain,
} from '../../../src/core/self_application/index.js';
import type { PatchKind } from '../../../src/core/self_proposal/index.js';
import { SelfProposal } from '../../../src/core/self_proposal/index.js';
import { GraphDefinitionError } from '../../../src/core/errors.js';

import { FakeCtx, MemStorage, _pipeline, _theme_proposal, _tool_proposal, _validator } from './helpers.js';

function _sp(kind: PatchKind, payload: Record<string, unknown>, base_version = 1): SelfProposal {
  return new SelfProposal({ kind, payload, base_version });
}

describe('SelfApplicationPipeline.apply L0/L1 分级', () => {
  it('L0 直过（theme/ui = auto_approve_keys 白名单）：未挂卡自动落链', async () => {
    const pipeline = _pipeline();
    const ctx = new FakeCtx();
    const outcome = await pipeline.apply(ctx, _theme_proposal());
    expect(outcome.applied).toBe(true);
    expect(outcome.decision).toBe(DECISION_AUTO);
    expect(outcome.patch_id).toBe(2);
    expect(ctx.cards).toEqual([]); // L0 直过：未挂卡
    const state = await pipeline.chain.assemble();
    expect(state['theme']).toEqual({ bg: '#111' });
  });

  it('L1 弹卡（tool）：审批 accept 后落链', async () => {
    const pipeline = _pipeline();
    const ctx = new FakeCtx();
    ctx.preset('patch:tool', { decision: 'accept' });
    const proposal = _tool_proposal('listfiles');
    const outcome = await pipeline.apply(ctx, proposal);
    expect(outcome.applied).toBe(true);
    expect(outcome.decision).toBe(DECISION_ACCEPT);
    expect(ctx.cards.length).toBe(1);
    const card = ctx.cards[0]!.payload;
    expect(card['review_type']).toBe('gate');
    const patchField = card['patch'] as Record<string, unknown>;
    expect(patchField['kind']).toBe('tool');
    const state = await pipeline.chain.assemble();
    const tools = state['tools'] as Record<string, Record<string, unknown>>;
    expect(tools['listfiles']!['name']).toBe('listfiles');
  });

  it('reject 决议：拒绝并留痕，不落链', async () => {
    const pipeline = _pipeline();
    const ctx = new FakeCtx();
    ctx.preset('patch:tool', { decision: 'reject', reason: '权限过大' });
    const outcome = await pipeline.apply(ctx, _tool_proposal('t'));
    expect(outcome.applied).toBe(false);
    expect(outcome.decision).toBe(DECISION_REJECT);
    expect(outcome.status).toBe(AUDIT_STATUS_REJECTED);
    expect(await pipeline.chain.current_version()).toBe(1); // 未落链
  });
});

describe('SelfApplicationPipeline.apply 编辑决议（重新校验）', () => {
  it('编辑为合法内容 → 重新过校验后落链新内容', async () => {
    const pipeline = _pipeline();
    const ctx = new FakeCtx();
    ctx.preset('patch:tool', {
      decision: 'edit',
      edited_content: {
        name: 'fixedtool',
        description: 'x',
        permissions: ['filesystem:read:/workspace'],
        endpoint: 'file_ops',
        endpoint_config: { root: '/workspace' },
      },
    });
    const outcome = await pipeline.apply(ctx, _tool_proposal('origtool'));
    expect(outcome.applied).toBe(true);
    const state = await pipeline.chain.assemble();
    const tools = state['tools'] as Record<string, unknown>;
    expect(tools['fixedtool']).toBeDefined();
    expect(tools['origtool']).toBeUndefined();
  });

  it('编辑为非法内容 → 重新校验失败，拒绝落链', async () => {
    const pipeline = _pipeline();
    const ctx = new FakeCtx();
    ctx.preset('patch:tool', { decision: 'edit', edited_content: { name: 'bad' } });
    const outcome = await pipeline.apply(ctx, _tool_proposal('origtool'));
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toContain('重新校验未通过');
    expect(await pipeline.chain.current_version()).toBe(1);
  });
});

describe('SelfApplicationPipeline.apply 冲突/非法闸门', () => {
  it('基准版本过期（链已前进）→ 并发冲突拒绝并要求重提', async () => {
    const pipeline = _pipeline();
    const ctx = new FakeCtx();
    await pipeline.apply(ctx, _theme_proposal());
    const stale = _sp('theme', { tokens: { bg: '#222' } }, 1);
    const outcome = await pipeline.apply(ctx, stale);
    expect(outcome.status).toBe(AUDIT_STATUS_CONFLICT);
    expect(outcome.reason).toContain('并发冲突');
    expect(await pipeline.chain.current_version()).toBe(2);
  });

  it('非法 payload（token 不在白名单）→ 闸门口拒绝，不落链', async () => {
    const pipeline = _pipeline();
    const ctx = new FakeCtx();
    const outcome = await pipeline.apply(
      ctx,
      _sp('theme', { tokens: { evil: '#000' } }, 1),
    );
    expect(outcome.status).toBe(AUDIT_STATUS_INVALID);
    expect(await pipeline.chain.current_version()).toBe(1);
  });

  it('活跃态应用目标钩子：落链后按类型触发（payload + patch_id）', async () => {
    const applied: [Record<string, unknown>, number][] = [];
    const pipeline = _pipeline();
    pipeline.register_target('theme', {
      name: 'theme',
      apply: async (payload: Record<string, unknown>, patchId: number) => {
        applied.push([payload, patchId]);
      },
    });
    const ctx = new FakeCtx();
    const outcome = await pipeline.apply(ctx, _theme_proposal());
    expect(outcome.applied).toBe(true);
    expect(applied).toEqual([[{ tokens: { bg: '#111' } }, 2]]);
  });
});

describe('守卫令牌透传（ENG1-7）', () => {
  it('令牌 + 非 GuardedStorage 后端不抛 TypeError；GuardedStorage 层仍正确消费令牌', async () => {
    const chain = new SetPatchChain(new MemStorage(), { guard_token: 'tok-1' });
    const version = await chain.append({ op: 'replace', path: ['theme'], value: { bg: '#000' } as never });
    expect(version).toBe(2);
    expect((await chain.assemble())['theme']).toEqual({ bg: '#000' });
    // 管线审计写入同样不炸（内存后端 + 令牌）
    const plainPipeline = _pipeline(new MemStorage(), { guard_token: 'tok-2' });
    const outcome = await plainPipeline.apply(new FakeCtx(), _theme_proposal());
    expect(outcome.applied).toBe(true);
    // GuardedStorage 包装层仍正确消费令牌（令牌透传路径保留）
    const raw = new MemStorage();
    const guarded = new GuardedStorage(raw, { guard_token: 'tok-3' });
    const guardedPipeline = new SelfApplicationPipeline({
      storage: guarded,
      guard_token: 'tok-3',
      validator: _validator(),
    });
    const out = await guardedPipeline.apply(new FakeCtx(), _theme_proposal());
    expect(out.applied).toBe(true);
    expect(await guarded.get_record('set_patch_chain', 'chain')).not.toBeNull();
  });
});

describe('审批超时过期拒绝（fail-closed）', () => {
  it('卡已过期（expires_at 早于当前）→ 重入一律拒绝并留痕', async () => {
    class ExpiredCtx extends FakeCtx {
      override async get_interrupt_payload(): Promise<unknown> {
        return { expires_at: -1 }; // 早已过期（TS approval 缺省时钟 = 0）
      }
    }
    const pipeline = _pipeline();
    const ctx = new ExpiredCtx();
    ctx.preset('patch:tool', { decision: 'accept' });
    const outcome = await pipeline.apply(ctx, _tool_proposal('t'));
    expect(outcome.applied).toBe(false);
    expect(outcome.decision).toBe(DECISION_REJECT);
    expect(outcome.reason).toContain('超时');
    expect(await pipeline.chain.current_version()).toBe(1);
  });
});
