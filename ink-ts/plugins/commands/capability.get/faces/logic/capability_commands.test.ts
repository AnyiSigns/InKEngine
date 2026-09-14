/**
 * capability 命令面测试（S3 随迁 plugins/commands/capability.get/put）：测的是
 * 「bridge 接线：get 缺省注入 + put 并入」——deps.capability 注入持久化 store，
 * 两命令工厂共享同一 deps 即共享同一 store（put→get 一致性）。
 */

import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createCapabilityStore } from '@ink-ts/host';
import createCapabilityGet from './index.js';
import createCapabilityPut from '../../../capability.put/faces/logic/index.js';

function tempDir(prefix: string): string {
  return path.join(tmpdir(), `${prefix}-${Math.random().toString(36).slice(2)}`);
}

describe('capability 命令面（bridge 接线）', () => {
  it('get 缺省注入不含 simulation_tier；put 后并入字段回显', async () => {
    const store = createCapabilityStore(tempDir('ink-capbridge-'));
    const deps = { capability: store } as never;
    const get = createCapabilityGet(deps);
    const put = createCapabilityPut(deps);
    const initial = (await get(null, { autoApprove: false })) as Record<string, unknown>;
    expect(initial['simulation_tier']).toBeUndefined();
    expect(initial['auto_approve_tools']).toEqual([]);

    await put({ auto_approve_all_review: false, auto_approve_tools: ['inspect_ui'] }, {
      autoApprove: false,
    });
    const after = (await get(null, { autoApprove: false })) as Record<string, unknown>;
    expect(after['auto_approve_tools']).toEqual(['inspect_ui']);
  });
});
