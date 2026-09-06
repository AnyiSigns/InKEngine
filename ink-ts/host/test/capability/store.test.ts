/**
 * 能力记录域测试：持久化并入语义 + 推演档位语义已移除（历史键丢弃）+
 * bridge 缺省注入 + host 审批策略并入（auto_approve_tools /
 * auto_approve_all_review 活读面）。
 */

import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createCapabilityStore } from '../../src/capability/store.js';
import { parseRecord } from '../../src/capability/store.js';
import { buildCapabilityHandlers } from '../../src/bridge/capability.js';
import { InkHost, resolve_host_config } from '../../src/index.js';

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
});

describe('capability 命令面（bridge 接线）', () => {
  it('get 缺省注入不含 simulation_tier；put 后并入字段回显', async () => {
    const handlers = buildCapabilityHandlers({
      capability: createCapabilityStore(tempDir('ink-capbridge-')),
    } as never);
    const get = handlers.get('capability.get')!;
    const put = handlers.get('capability.put')!;
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

describe('能力记录 → host 审批策略（活读面并入）', () => {
  it('auto_approve_tools 命中直过；未列工具仍全量挂起', () => {
    const dir = tempDir('ink-policy-');
    const store = createCapabilityStore(dir);
    const config = resolve_host_config({ data_dir: dir, autoApprove: false });
    const host = new InkHost(config, () => store.get());
    const policy = host.interrupt_policy();
    store.put({ auto_approve_tools: ['inspect_graph'] });
    expect(policy.should_approve('gate:tool', { tool: 'inspect_graph' })).toBe(false);
    expect(policy.should_approve('gate:tool', { tool: 'other_tool' })).toBe(true);
  });

  it('auto_approve_all_review = 全量直过；autoApprove 显式 true 亦直过', () => {
    const dir = tempDir('ink-policy2-');
    const store = createCapabilityStore(dir);
    const config = resolve_host_config({ data_dir: dir, autoApprove: false });
    const host = new InkHost(config, () => store.get());
    const policy = host.interrupt_policy();
    store.put({ auto_approve_all_review: true });
    expect(policy.should_approve('patch:apply', { tool: 'anything' })).toBe(false);
    expect(policy.timeout_for('patch:apply', { tool: 'anything' })).toBeNull();

    const configAuto = resolve_host_config({ data_dir: dir, autoApprove: true });
    const hostAuto = new InkHost(configAuto, () => store.get());
    expect(hostAuto.interrupt_policy().should_approve('x', { tool: 'y' })).toBe(false);
  });
});
