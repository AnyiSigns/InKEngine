/**
 * 自指层提案协议数据面单测：补丁类型声明 + 提案序列化往返 + 非法形态拒绝。
 *
 * 覆盖：
 * - SelfProposal 序列化往返（kind/payload/base_version/rationale/meta）；
 * - 非法形态拒绝（payload 非 dict / 基准版本 < 1 / 未知补丁类型构造）。
 *
 *  deferred（引擎执行器集成面另行覆盖）：
 * - 引擎执行器集成用例（propose_patch → apply_patch → 审批分级 → 补丁链
 *   落链，经执行器跑完整回路）对应 Python test_self_application.py 集成面，
 *   待 self_application 迁入 ink-ts 后补测；本目录只覆盖提案协议本身
 *   （纯 ProposalValidator 校验语义，零执行器依赖）。
 */

import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/core/errors.js';
import {
  PatchKind,
  SelfProposal,
} from '../../../src/core/self_proposal/index.js';

function _proposal(
  kind: PatchKind,
  payload: Record<string, unknown>,
  base_version = 1,
): SelfProposal {
  return new SelfProposal({
    kind,
    payload,
    base_version,
    rationale: '测试提案',
    meta: { round_id: 'r1' },
  });
}

describe('SelfProposal 提案数据形态', () => {
  it('proposal round-trip（序列化往返无损）', () => {
    const proposal = _proposal(PatchKind.THEME, { tokens: { bg: '#000' } }, 3);
    const restored = SelfProposal.from_dict(proposal.to_dict());
    expect(restored.kind).toBe(PatchKind.THEME);
    expect(restored.base_version).toBe(3);
    expect(restored.rationale).toBe('测试提案');
    expect(restored.meta).toEqual({ round_id: 'r1' });
    expect(restored.payload).toEqual({ tokens: { bg: '#000' } });
  });

  it('非法形态拒绝（payload 非 dict / 基准版本 < 1 / 未知类型构造）', () => {
    expect(() =>
      new SelfProposal({
        kind: PatchKind.UI,
        payload: [] as unknown as Record<string, unknown>,
        base_version: 1,
      }),
    ).toThrow(/payload 须为 dict/);
    expect(() =>
      new SelfProposal({ kind: PatchKind.UI, payload: {}, base_version: 0 }),
    ).toThrow(/基准版本非法/);
    expect(() =>
      new SelfProposal({
        kind: 'mystery' as PatchKind,
        payload: {},
        base_version: 1,
      }),
    ).toThrow(/补丁类型非法/);
    expect(() => SelfProposal.from_dict({ kind: 'nope', payload: {} })).toThrow(
      /补丁类型非法/,
    );
  });

  it('未知补丁类型在构造/反序列化处拒绝（GraphDefinitionError）', () => {
    expect(() =>
      new SelfProposal({
        kind: 'mystery' as PatchKind,
        payload: {},
        base_version: 1,
      }),
    ).toThrow(GraphDefinitionError);
    expect(() => SelfProposal.from_dict({ kind: 'nope', payload: {} })).toThrow(
      GraphDefinitionError,
    );
  });
});
