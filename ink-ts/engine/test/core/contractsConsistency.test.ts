/**
 * engine 枚举 ↔ contracts generated 一致性（数据面单源集成断言）。
 *
 * engine 各机制的数据面枚举/注册表（端点名/补丁类型/审批分级/守卫集合/
 * 前缀/审计状态）唯一真源 = @ink-ts/contracts generated；模块内已挂
 * 编译期集合相等绑定（值集合双向精确 → 类型错误），本文件对每个消费模块
 * 调用导出的 assert_* 运行时兜底，并对守卫集合/前缀做逐项遍历比对。
 */
import { describe, expect, it } from 'vitest';

import {
  APPROVAL_LEVELS,
  AUDIT_STATUSES,
  BUILTIN_ENDPOINT_NAMES,
  GUARDED_COLLECTIONS,
  GUARDED_PREFIXES,
  PATCH_KINDS,
} from '@ink-ts/contracts';
import { assert_endpoint_contract } from '../../src/core/declarative_tools/endpoint_types.js';
import { EndpointType } from '../../src/core/declarative_tools/index.js';
import { assert_patch_kinds_contract } from '../../src/core/self_proposal/self_proposal.js';
import { PatchKind } from '../../src/core/self_proposal/index.js';
import {
  AUDIT_STATUS_APPLIED,
  AUDIT_STATUS_CONFLICT,
  AUDIT_STATUS_INVALID,
  AUDIT_STATUS_REJECTED,
  AUDIT_STATUS_REVERTED,
  AUDIT_STATUS_REVERTED_NOTIFY_FAILED,
  assert_constants_contract,
  _GUARDED_COLLECTIONS,
  _GUARDED_PREFIXES,
} from '../../src/core/self_application/constants.js';
import {
  ApprovalLevel,
  assert_approval_levels_contract,
} from '../../src/core/self_application/approval_level.js';

describe('engine 枚举 ↔ contracts generated 一致性', () => {
  it('各数据面 assert_* 一致函数通过（运行时兜底）', () => {
    expect(() => assert_endpoint_contract()).not.toThrow();
    expect(() => assert_patch_kinds_contract()).not.toThrow();
    expect(() => assert_approval_levels_contract()).not.toThrow();
    expect(() => assert_constants_contract()).not.toThrow();
  });

  it('端点名：EndpointType 值 ↔ BUILTIN_ENDPOINT_NAMES 双向一致', () => {
    expect(Object.values(EndpointType).sort()).toEqual([...BUILTIN_ENDPOINT_NAMES].sort());
  });

  it('补丁类型：PatchKind 值 ↔ PATCH_KINDS 双向一致', () => {
    expect(Object.values(PatchKind).sort()).toEqual([...PATCH_KINDS].sort());
  });

  it('审批分级：ApprovalLevel 值 ↔ APPROVAL_LEVELS 双向一致', () => {
    expect(Object.values(ApprovalLevel).sort()).toEqual([...APPROVAL_LEVELS].sort());
  });

  it('守卫集合与前缀逐项遍历比对一致', () => {
    expect([..._GUARDED_COLLECTIONS].sort()).toEqual([...GUARDED_COLLECTIONS].sort());
    expect([..._GUARDED_PREFIXES]).toEqual([...GUARDED_PREFIXES]);
  });

  it('审计状态声明序与 AUDIT_STATUSES 一致', () => {
    const statuses = [
      AUDIT_STATUS_APPLIED,
      AUDIT_STATUS_REJECTED,
      AUDIT_STATUS_CONFLICT,
      AUDIT_STATUS_INVALID,
      AUDIT_STATUS_REVERTED,
      AUDIT_STATUS_REVERTED_NOTIFY_FAILED,
    ];
    expect(statuses).toEqual([...AUDIT_STATUSES]);
  });
});
