/**
 * 集补丁链单测（对标 Python test_self_application.py SetPatchChain 用例段）：
 * 链版本/组装/回退边界、乐观版本校验（CAS）、链尾单步回退在存储层强制。
 *
 *  deferred（引擎执行器集成面另行覆盖）：propose_patch → apply_patch →
 *  审批分级 → 补丁链落链的引擎执行器完整回路用例（含真实存储后端/中断
 *  checkpoint 持久化的超时判定）对应 Python 集成面，待宿主装配面迁入后
 *  补测；本文件以内存假存储驱动纯机制语义，零执行器依赖。
 */

import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/core/errors.js';
import { SetPatchChain } from '../../../src/core/self_application/index.js';
import type { Patch } from '../../../src/core/patch/patchChain.js';

import { MemStorage } from './helpers.js';

/** 内容替换补丁（镜像 ``Patch(op=PatchOp.REPLACE, path=..., value=...)``）。 */
function _replace(path: (string | number)[], value: unknown): Patch {
  return { op: 'replace', path, value: value as never };
}

function _chain(): { storage: MemStorage; chain: SetPatchChain } {
  const storage = new MemStorage();
  return { storage, chain: new SetPatchChain(storage) };
}

describe('SetPatchChain 链版本与组装', () => {
  it('版本 = 补丁数 + 1；组装产物即集状态全量', async () => {
    const { chain } = _chain();
    expect(await chain.current_version()).toBe(1);
    expect(await chain.assemble()).toEqual({});
    await chain.append(_replace(['theme'], { bg: '#000' }));
    expect(await chain.current_version()).toBe(2);
    const state = await chain.assemble();
    expect(state['theme']).toEqual({ bg: '#000' });
    // 版本化取用：版本 1 = 空基线（组装不丢历史）
    expect(await chain.assemble(1)).toEqual({});
    await expect(chain.assemble(99)).rejects.toThrow(/越界/);
  });

  it('并发冲突/落链失败语义不变（load 空记录 = 空链）', async () => {
    const { chain, storage } = _chain();
    // 直接往存储写入链记录后重新加载（组装/版本取权威链）
    await storage.put_record('set_patch_chain', 'chain', {
      base: {},
      patches: [{ op: 'replace', path: ['theme'], value: { bg: '#000' } }],
    });
    expect(await chain.current_version()).toBe(2);
    expect((await chain.assemble())['theme']).toEqual({ bg: '#000' });
  });
});

describe('SetPatchChain 回退边界（链级操作）', () => {
  it('回退到目标版本为新的 base、清空补丁；链尾单步限制', async () => {
    const { chain } = _chain();
    await chain.append(_replace(['theme'], { bg: '#000' }));
    await chain.append(_replace(['theme'], { bg: '#111' }));
    expect(await chain.current_version()).toBe(3);
    await expect(chain.revert_to(3)).rejects.toThrow(/回退目标须低于当前版本/);
    const state = await chain.revert_to(2);
    expect(state['theme']).toEqual({ bg: '#000' });
    // 回退后新链从目标形态起步（版本回到 1，历史在审计中保留）
    expect(await chain.current_version()).toBe(1);
    expect(await chain.assemble()).toEqual({ theme: { bg: '#000' } });
  });

  it('链完整性在存储层强制：跳过链尾回退（一次回退多步）被拒绝', async () => {
    const { chain } = _chain();
    await chain.append(_replace(['theme'], { bg: '#000' }));
    await chain.append(_replace(['theme'], { bg: '#111' }));
    await chain.append(_replace(['theme'], { bg: '#222' }));
    expect(await chain.current_version()).toBe(4);
    await expect(chain.revert_to(2)).rejects.toThrow(/仅允许回退链尾补丁/);
    // 链尾单步回退仍可用（版本 4 → 3）
    const state = await chain.revert_to(3);
    expect(state['theme']).toEqual({ bg: '#111' });
  });
});

describe('SetPatchChain 乐观版本校验（ENG1-8 CAS）', () => {
  it('append：基准版本过期 = 并发冲突拒绝，不传 = 向后兼容', async () => {
    const { chain } = _chain();
    const patch = _replace(['theme'], { bg: '#000' });
    await expect(chain.append(patch, 5)).rejects.toThrow(/并发冲突/);
    expect(await chain.current_version()).toBe(1); // 未落链
    expect(await chain.append(patch, 1)).toBe(2); // 版本匹配
    // 落链后过期基准再试 = 冲突
    await expect(chain.append(patch, 1)).rejects.toThrow(/并发冲突/);
    // 不传 expected_version = 向后兼容（无校验）
    expect(await chain.append(patch)).toBe(3);
  });

  it('revert_to：审批挂起窗口后链前进 = 冲突拒绝，不误回退新补丁', async () => {
    const { chain } = _chain();
    const patch = _replace(['theme'], { bg: '#000' });
    await chain.append(patch);
    await chain.append(patch);
    expect(await chain.current_version()).toBe(3);
    // 调用方基准过期（2，实际 3）：回退冲突拒绝，不误回退新补丁
    await expect(chain.revert_to(1, 2)).rejects.toThrow(/回退冲突/);
    // 正确基准（当前 3，回退目标 2）通过
    const state = await chain.revert_to(2, 3);
    expect(state['theme']).toEqual({ bg: '#000' });
  });
});
