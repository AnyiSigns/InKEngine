/**
 * boot 生产 context_window 闭包单测（W6 收口 A 留缝的接线面）：
 * boot 构造 HostExecutionService 时注入 resolveScopeContextWindow——查
 * inkHost.config.model_config.providers 的模型档案 context_window，供白板裁切
 * 按模型 cw 生效。
 *
 * 测什么：
 * - 同厂商两模型不同 cw → 解析结果不同（32000 vs 128000）；
 * - 引用不带 provider → 用户清单内首个含该 model_id 的厂商命中（与
 *   resolve_scope_model 解析序一致）；
 * - 无档案（字符串清单命中但无 context_window 字段）= null（不猜）；
 * - 未指派厂商/未知模型/null model = null 兜底（引擎回落 200k 缺省）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createHost } from '../src/index.js';

describe('boot resolveScopeContextWindow 生产闭包', () => {
  it('两模型不同 cw 注入不同；无档案/未命中 = null 不猜', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ink-boot-cw-'));
    const handle = await createHost({
      data_dir: dir,
      events_dir: path.join(dir, 'events'),
    });
    // 厂商清单经运行期 models.config 通道入档（providers 透传键，同产品设置面）
    await handle.host.apply_model_config({
      providers: [
        {
          provider_id: 'p1',
          base_url: 'http://127.0.0.1:1',
          adapter: 'openai_compatible',
          models: [
            { model_id: 'model-a', context_window: 32000 },
            { model_id: 'model-b', context_window: 128000 },
            'model-c',
          ],
        },
        {
          provider_id: 'p2',
          base_url: 'http://127.0.0.1:2',
          adapter: 'openai_compatible',
          models: [{ model_id: 'model-a' }],
        },
      ],
    });
    try {
      const svc = handle.execution;
      expect(svc.resolveScopeContextWindow({ provider: 'p1', model_id: 'model-a' })).toBe(32000);
      expect(svc.resolveScopeContextWindow({ provider: 'p1', model_id: 'model-b' })).toBe(128000);
      // 不带 provider：首个含该 model_id 的厂商（p1）命中其档案
      expect(svc.resolveScopeContextWindow({ model_id: 'model-b' })).toBe(128000);
      // 字符串清单命中但无档案 = 不猜
      expect(svc.resolveScopeContextWindow({ provider: 'p1', model_id: 'model-c' })).toBeNull();
      // p2 的 model-a 条目无 context_window 字段 → null（不回落 p1）
      expect(svc.resolveScopeContextWindow({ provider: 'p2', model_id: 'model-a' })).toBeNull();
      expect(svc.resolveScopeContextWindow({ provider: 'ghost', model_id: 'model-a' })).toBeNull();
      expect(svc.resolveScopeContextWindow({ provider: 'p1', model_id: 'ghost' })).toBeNull();
      expect(svc.resolveScopeContextWindow(null)).toBeNull();
    } finally {
      await handle.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
