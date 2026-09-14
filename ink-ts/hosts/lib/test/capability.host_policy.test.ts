/**
 * 能力记录 → host 审批策略（活读面并入；S4 拆分：store 实现/行为测试随迁
 * 域插件 plugins/domains/capability，本装配侧测试留宿主，经 @ink-ts/host
 * 公共面构造 store + InkHost 断言策略并入语义）。
 */

import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { InkHost, resolve_host_config } from '../src/index.js';
import { createCapabilityStore } from '../../../plugins/domains/capability/faces/logic/index.js';

function tempDir(prefix: string): string {
  return path.join(tmpdir(), `${prefix}-${Math.random().toString(36).slice(2)}`);
}

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