/**
 * 能力记录域测试（S4 随迁域插件同住）：持久化并入语义 + 推演档位语义已移除
 * （历史键丢弃）。宿主审批策略并入（InkHost 活读面）仍由 hosts/lib 装配测试
 * 覆盖（capability.host_policy.test.ts）。
 */

import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createCapabilityStore, parseRecord } from './index.js';

function tempDir(prefix: string): string {
  return path.join(tmpdir(), `${prefix}-${Math.random().toString(36).slice(2)}`);
}

describe('能力记录域（capability.json 持久化 + 档位语义移除）', () => {
  it('put 单字段并入 + get 缺省注入（auto 出厂空集）', () => {
    const store = createCapabilityStore(tempDir('ink-capability-'));
    const defaults = store.get();
    expect(defaults.auto_approve_tools).toEqual([]);
    expect(defaults.auto_approve_all_review).toBe(false);
    expect('simulation_tier' in defaults).toBe(false);

    store.put({ auto_approve_tools: ['introspection_query', 'inspect_graph'] });
    const after = store.get();
    expect(after.auto_approve_tools).toEqual(['introspection_query', 'inspect_graph']);
    expect(after.auto_approve_all_review).toBe(false);
  });

  it('max_tool_rounds 装配位：写入合法整数并回读', () => {
    const store = createCapabilityStore(tempDir('ink-capmax-'));
    store.put({ max_tool_rounds: 12 });
    expect(store.get().max_tool_rounds).toBe(12);
  });

  it('历史 simulation_tier 键读档丢弃（不回显、不落盘）', () => {
    const store = createCapabilityStore(tempDir('ink-capdep-'));
    const record = parseRecord({
      simulation_tier: 'full',
      auto_approve_all_review: true,
      legacy: 'x',
    });
    expect('simulation_tier' in record).toBe(false);
    expect(record['legacy']).toBe('x');
    expect(record.auto_approve_all_review).toBe(true);
    // put 走同一解析链：旧档位键写入即丢弃
    store.put({ simulation_tier: 'full', max_tool_rounds: 5 });
    const after = store.get();
    expect('simulation_tier' in after).toBe(false);
    expect(after.max_tool_rounds).toBe(5);
  });

  it('reset 恢复出厂记录（透传键一并清空；B6 恢复设置默认逃生）', () => {
    const dir = tempDir('ink-capreset-');
    const store = createCapabilityStore(dir);
    store.put({
      auto_approve_tools: ['introspection_query'],
      auto_approve_all_review: true,
      max_tool_rounds: 24,
      tier_overrides: { file_write: 'review' },
      mcp_plugins_enabled: ['market.web_fetch'],
      mcp_plugins_extra: { ext: { transport: 'http', url: 'https://x' } },
    });
    store.reset();
    const after = store.get();
    expect(after.auto_approve_tools).toEqual([]);
    expect(after.auto_approve_all_review).toBe(false);
    expect('max_tool_rounds' in after).toBe(false);
    expect('tier_overrides' in after).toBe(false);
    expect('mcp_plugins_enabled' in after).toBe(false);
    expect('mcp_plugins_extra' in after).toBe(false);
    // 持久化落盘（同目录重读 = 出厂记录）
    const reread = createCapabilityStore(dir);
    expect(reread.get().auto_approve_tools).toEqual([]);
    expect('mcp_plugins_extra' in reread.get()).toBe(false);
  });
});