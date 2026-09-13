/**
 * agent 图节点插件声明层测试：faces/logic/index.ts 默认导出 = 节点注册声明
 * （与 spec.data.node 镜像；S0 装载契约静态成分）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import declaration from './index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('graph_node 插件 agent 声明层', () => {
  it('默认导出 = 节点注册声明，与 spec.data.node 镜像', () => {
    const spec = JSON.parse(readFileSync(join(HERE, '..', '..', 'spec.json'), 'utf8'));
    const node = spec.data.node;
    const decl = declaration as { type: string; executor: string; contract: { safety_tier: number; version: number } };
    expect(decl.type).toBe(node.type);
    expect(decl.type).toBe('agent');
    expect(decl.executor).toBe(node.executor);
    expect(decl.contract.safety_tier).toBe(node.contract.safety_tier);
    expect(decl.contract.version).toBe(node.contract.version);
  });
});