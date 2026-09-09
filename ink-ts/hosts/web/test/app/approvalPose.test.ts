/**
 * 弹卡档位存储助手测试：测的是「默认回落 review + 会话覆盖优先」——
 * 档位语义（auto 直过/deny 直拒）属引擎侧 B3，本模块只测持久化与归并。
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  DEFAULT_APPROVAL_POSE,
  loadDefaultPose,
  saveDefaultPose,
  loadPoseOverrides,
  savePoseOverride,
  effectivePose,
  isApprovalPose,
} from '@app/state/approvalPose';
import type { ApprovalPose } from '@/shared/backend/backendAdapter';

function makeLocalStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => { map.delete(key); },
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
  };
}

describe('approvalPose 存储助手', () => {
  beforeEach(() => {
    globalThis.localStorage = makeLocalStorage();
  });

  it('未设置任何档位时默认回落 review', () => {
    expect(DEFAULT_APPROVAL_POSE).toBe('review');
    expect(loadDefaultPose()).toBe('review');
    expect(loadPoseOverrides()).toEqual({});
  });

  it('非法/损坏存储一律回落 review（fail-closed）', () => {
    globalThis.localStorage.setItem('ink.approvalPose.default', 'not-a-pose');
    globalThis.localStorage.setItem('ink.approvalPose.bySession', '{broken json');
    expect(loadDefaultPose()).toBe('review');
    expect(loadPoseOverrides()).toEqual({});
    expect(isApprovalPose('bogus')).toBe(false);
    expect(isApprovalPose('auto')).toBe(true);
  });

  it('宿主默认档可存可读', () => {
    saveDefaultPose('auto');
    expect(loadDefaultPose()).toBe('auto');
  });

  it('会话覆盖写入后 loadPoseOverrides 携带，非法 pose 条目被剔除', () => {
    savePoseOverride('s1', 'deny');
    savePoseOverride('s2', 'bogus' as ApprovalPose);
    const map = loadPoseOverrides();
    expect(map).toEqual({ s1: 'deny' });
  });

  it('生效档 = 会话覆盖优先，无覆盖用宿主默认', () => {
    const overrides = { s1: 'deny' as ApprovalPose };
    expect(effectivePose('review', overrides, 's1')).toBe('deny');
    expect(effectivePose('review', overrides, 's2')).toBe('review');
    expect(effectivePose('auto', {}, null)).toBe('auto');
  });
});
