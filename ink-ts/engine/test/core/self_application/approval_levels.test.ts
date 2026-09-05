/**
 * 审批分级表空表语义（对齐 Python ``approval_levels or DEFAULT``）。
 *
 * - 空对象/未提供 → 默认分级表整体生效（theme/ui 等 L0 直过键存在）；
 * - 部分非空表 → 原样整体替换（不合并默认），仅提供项生效。
 *
 * 拍板背景：此前 ``{}`` 经空展开得空分级表 → L0 直过名单为空，低风险
 * 主题/界面补丁不再自动直过——与 Python falsy 回落语义分叉。
 */

import { describe, expect, it } from 'vitest';

import {
  APPROVAL_LEVELS,
  DEFAULT_APPROVAL_LEVELS as CONTRACT_DEFAULT_APPROVAL_LEVELS,
} from '@ink-ts/contracts';
import {
  ApprovalLevel,
  DEFAULT_APPROVAL_LEVELS,
  assert_approval_levels_contract,
} from '../../../src/core/self_application/approval_level.js';
import type { PatchKind } from '../../../src/core/self_proposal/index.js';
import { MemStorage, _pipeline } from './helpers.js';

function levelOf(
  pipeline: { _levels: Readonly<Partial<Record<PatchKind, string>>> },
  kind: PatchKind,
): string | undefined {
  return pipeline._levels[kind];
}

describe('approval_levels 空表语义（对齐 Python falsy 回落）', () => {
  it('engine 分级 ↔ contracts generated 一致（数据面单源断言）', () => {
    expect(() => assert_approval_levels_contract()).not.toThrow();
    expect(Object.values(ApprovalLevel)).toEqual([...APPROVAL_LEVELS]);
    expect(DEFAULT_APPROVAL_LEVELS).toEqual(CONTRACT_DEFAULT_APPROVAL_LEVELS);
  });

  it('空对象 → 默认分级整体生效（theme/ui L0 直过键存在）', () => {
    const p = _pipeline(new MemStorage(), { approval_levels: {} });
    expect(levelOf(p, 'theme')).toBe(ApprovalLevel.L0);
    expect(levelOf(p, 'ui')).toBe(ApprovalLevel.L0);
    expect(levelOf(p, 'artifact')).toBe(ApprovalLevel.L2);
    expect(levelOf(p, 'theme')).toBe(DEFAULT_APPROVAL_LEVELS['theme']);
  });

  it('未提供（undefined/null）与空对象同语义', () => {
    const p1 = _pipeline();
    const p2 = _pipeline(undefined, { approval_levels: null as never });
    expect(levelOf(p1, 'ui')).toBe(ApprovalLevel.L0);
    expect(levelOf(p2, 'ui')).toBe(ApprovalLevel.L0);
  });

  it('部分非空表 → 整体替换不合并，仅提供项生效', () => {
    const p = _pipeline(undefined, {
      approval_levels: { theme: ApprovalLevel.L1 },
    });
    expect(levelOf(p, 'theme')).toBe(ApprovalLevel.L1);
    // 未提供项不回落默认（部分表 = 显式整体替换语义）
    expect(levelOf(p, 'ui')).toBeUndefined();
    expect(levelOf(p, 'artifact')).toBeUndefined();
  });
});
