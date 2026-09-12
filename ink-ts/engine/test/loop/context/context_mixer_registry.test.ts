/**
 * core/context 测试：FusionRegistry 注册表与 ContextMixer 融合/回退语义
 * （含 1:1 移植自 test_context.py 的 mix 入口各场景）。
 */

import { describe, expect, it } from 'vitest';

import { ContextSource } from '../../../src/core/context/context_types.js';
import {
  ContextMixer,
  FusionHook,
  FusionRegistry,
} from '../../../src/core/context/context_mixer.js';

function _src(type = 'chapter', content = '内容'): ContextSource {
  return new ContextSource(type, content);
}

/** 假融合钩子：可返回固定值/可调用值/抛错。 */
class FakeFusionHook implements FusionHook {
  result: unknown;
  calls = 0;

  constructor(result: unknown) {
    this.result = result;
  }

  async fuse(): Promise<string | null> {
    this.calls += 1;
    if (typeof this.result === 'function') {
      const r = (this.result as () => unknown)();
      return r as string | null;
    }
    return this.result as string | null;
  }
}

describe('TestFusionRegistry：注册表', () => {
  it('test_register_get_names：register/get/names', () => {
    const registry = new FusionRegistry();
    const hook = new FakeFusionHook('ok');
    registry.register('novel', hook);
    expect(registry.get('novel')).toBe(hook);
    expect(registry.names).toEqual(['novel']);
    expect(registry.get('missing')).toBeNull();
  });

  it('test_register_overwrites_same_name：同名重复注册 = 覆盖', () => {
    const registry = new FusionRegistry();
    registry.register('k', new FakeFusionHook('a'));
    registry.register('k', new FakeFusionHook('b'));
    expect(registry.names).toEqual(['k']);
  });

  it('test_empty_name_rejected：空名拒绝', () => {
    expect(() => new FusionRegistry().register('', new FakeFusionHook('a'))).toThrow(RangeError);
  });
});

describe('TestContextMixer：融合/回退', () => {
  it('test_no_hook_deterministic：无钩子 = 纯确定性组装', async () => {
    const mixer = new ContextMixer();
    const result = await mixer.mix([_src('c', '正文')], { total_chars: 100 });
    expect(result.text).toBe('正文');
    expect(result.fused).toBe(false);
  });

  it('test_fusion_hook_result_used：融合产物作为最终文本', async () => {
    const hook = new FakeFusionHook('融合产物');
    const mixer = new ContextMixer({ fusion_hook: hook, fusion_instruction: '深度融合' });
    const result = await mixer.mix([_src('c', '正文')], { total_chars: 1000 });
    expect(result.text).toBe('融合产物');
    expect(result.fused).toBe(true);
    expect(hook.calls).toBe(1);
  });

  it('test_fusion_none_falls_back：融合返回 null → 回退确定性组装', async () => {
    const mixer = new ContextMixer({ fusion_hook: new FakeFusionHook(null) });
    const result = await mixer.mix([_src('c', '正文')], { total_chars: 100 });
    expect(result.text).toBe('正文');
    expect(result.fused).toBe(false);
  });

  it('test_fusion_error_falls_back：融合抛错 → 回退确定性组装', async () => {
    const mixer = new ContextMixer({
      fusion_hook: new FakeFusionHook(() => {
        throw new Error('融合器故障');
      }),
    });
    const result = await mixer.mix([_src('c', '正文')], { total_chars: 100 });
    expect(result.text).toBe('正文');
    expect(result.fused).toBe(false);
  });

  it('test_mixer_consumes_fusion_registry：注册表接入 mixer', async () => {
    const registry = new FusionRegistry();
    const hook = new FakeFusionHook('注册表融合');
    registry.register('novel', hook);
    registry.register('other', new FakeFusionHook('另一个'));
    const mixer = new ContextMixer({
      fusion_registry: registry,
      fusion_hook_name: 'novel',
    });
    const result = await mixer.mix([_src('c', '正文')], { total_chars: 1000 });
    expect(result.text).toBe('注册表融合');
    expect(result.fused).toBe(true);
    expect(hook.calls).toBe(1);

    // 注册表未注册该名 → 回退确定性组装
    const mixer2 = new ContextMixer({
      fusion_registry: registry,
      fusion_hook_name: 'missing',
    });
    const result2 = await mixer2.mix([_src('c', '正文')], { total_chars: 100 });
    expect(result2.text).toBe('正文');
    expect(result2.fused).toBe(false);

    // 直接注入钩子优先于注册表
    const direct = new FakeFusionHook('直接');
    const mixer3 = new ContextMixer({
      fusion_registry: registry,
      fusion_hook_name: 'novel',
      fusion_hook: direct,
    });
    const result3 = await mixer3.mix([_src('c', '正文')], { total_chars: 100 });
    expect(result3.text).toBe('直接');
  });

  it('test_fused_text_hard_capped：融合产物按 total_chars 硬截断', async () => {
    const mixer = new ContextMixer({ fusion_hook: new FakeFusionHook('长'.repeat(5000)) });
    const result = await mixer.mix([_src()], { total_chars: 100 });
    expect(result.text).toBe('长'.repeat(100));
  });

  it('test_attach_fusion_at_runtime：运行期 attach_fusion 替换钩子', async () => {
    const mixer = new ContextMixer();
    mixer.attach_fusion(new FakeFusionHook('后挂载'), '候选融合');
    const result = await mixer.mix([_src()], { total_chars: 100 });
    expect(result.text).toBe('后挂载');
  });
});