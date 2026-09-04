import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/core/errors.js';
import {
  EdgeConditionRegistry,
  GraphRegistries,
  NodeTypeRegistry,
} from '../../../src/core/registry/registry.js';
import type { NodeContract, NodeFactory } from '../../../src/core/registry/registry.js';

/**
 * 按配置构造节点执行函数：记录入参配置，返回其值（验证参数透传）。
 * 类型名对注册表是不透明字符串——测试里的 "write"/"audit" 只是示意键，
 * 注册表本身不解释任何类型语义（机制中立性的直接体现）。
 */
function countingFactory(tag: string): NodeFactory {
  return (config: Record<string, unknown>) => {
    const raw = config['value'];
    const value = typeof raw === 'number' ? raw : 0;
    return async () => ({ value, tag });
  };
}

describe('节点类型注册表：注册/按名解析/构造参数透传/拒绝', () => {
  it('登记后按类型名可创建节点执行函数', () => {
    const registry = new NodeTypeRegistry();
    registry.register('write', countingFactory('write'));
    const fn = registry.create('write', { value: 7 });
    expect(fn).not.toBeNull();
    expect(typeof fn).toBe('function');
  });

  it('未知类型实例化被拒绝（GraphDefinitionError）', () => {
    const registry = new NodeTypeRegistry();
    expect(() => registry.create('missing', {})).toThrow(GraphDefinitionError);
    expect(() => registry.create('missing', {})).toThrow('未知节点类型: missing');
  });

  it('重复登记同类型被拒绝（防静默覆盖）', () => {
    const registry = new NodeTypeRegistry();
    registry.register('write', countingFactory('a'));
    expect(() => registry.register('write', countingFactory('b'))).toThrow(
      GraphDefinitionError,
    );
    expect(() => registry.register('write', countingFactory('b'))).toThrow(
      '节点类型重复注册: write',
    );
  });

  it('同类型不同配置实例化互不干扰的节点', async () => {
    const registry = new NodeTypeRegistry();
    registry.register('write', countingFactory('write'));
    const fn_a = registry.create('write', { value: 1 });
    const fn_b = registry.create('write', { value: 2 });
    expect(fn_a).not.toBe(fn_b);
    expect(await fn_a({})).toEqual({ value: 1, tag: 'write' });
    expect(await fn_b({})).toEqual({ value: 2, tag: 'write' });
  });

  it('配置经拷贝透传：建图后改写原配置不影响既有节点', async () => {
    const registry = new NodeTypeRegistry();
    registry.register('snapshot', countingFactory('snapshot'));
    const cfg: Record<string, unknown> = { value: 1 };
    const fn = registry.create('snapshot', cfg);
    cfg['value'] = 99;
    expect(await fn({})).toEqual({ value: 1, tag: 'snapshot' });
  });

  it('has/types/size 反映已登记类型', () => {
    const registry = new NodeTypeRegistry();
    expect(registry.has('write')).toBe(false);
    registry.register('write', countingFactory('w'));
    registry.register('audit', countingFactory('a'));
    expect(registry.has('write')).toBe(true);
    expect(registry.has('router')).toBe(false);
    expect(registry.types()).toEqual(['write', 'audit']);
    expect(registry.size).toBe(2);
  });
});

describe('契约登记（可选扩展：旧调用形态零破坏）', () => {
  const contractV2: NodeContract = { safety_tier: 1, version: 2 };
  const plainContract: NodeContract = { safety_tier: 0, version: 1 };

  it('register 携带契约：契约随类型登记，可查询/可判版本', () => {
    const registry = new NodeTypeRegistry();
    registry.register('write', countingFactory('w'), contractV2);
    expect(registry.contract_for('write')).toBe(contractV2);
    expect(registry.contract_versions('write')).toEqual(new Set([2]));
    expect(registry.has_contract('write')).toBe(true);
  });

  it('无契约登记保持旧调用形态：契约查询为空、实例化不受影响', () => {
    const registry = new NodeTypeRegistry();
    registry.register('write', countingFactory('w'));
    expect(registry.contract_for('write')).toBeUndefined();
    expect(registry.contract_versions('write')).toEqual(new Set());
    expect(registry.has_contract('write')).toBe(false);
    expect(registry.contract_for('missing')).toBeUndefined();
    expect(registry.contract_versions('missing')).toEqual(new Set());
    const fn = registry.create('write', { value: 1 });
    expect(typeof fn).toBe('function');
  });

  it('契约不参与实例化：执行体仍是工厂产出的函数', async () => {
    const registry = new NodeTypeRegistry();
    registry.register('write', countingFactory('w'), plainContract);
    const fn = registry.create('write', { value: 7 });
    expect(typeof fn).toBe('function');
    expect(await fn({})).toEqual({ value: 7, tag: 'w' });
  });

  it('携带契约的重复登记同样拒绝（防静默覆盖语义不变）', () => {
    const registry = new NodeTypeRegistry();
    registry.register('write', countingFactory('a'), plainContract);
    expect(() =>
      registry.register('write', countingFactory('b'), contractV2),
    ).toThrow(GraphDefinitionError);
    expect(() =>
      registry.register('write', countingFactory('b'), contractV2),
    ).toThrow('节点类型重复注册: write');
  });
});

describe('条件边注册表：条件名 → 判定函数按名解析', () => {
  const alwaysTrue = async (): Promise<boolean> => true;

  it('登记后按条件名取回同一判定函数', async () => {
    const registry = new EdgeConditionRegistry();
    registry.register('always', alwaysTrue);
    expect(registry.has('always')).toBe(true);
    expect(registry.names()).toEqual(['always']);
    expect(registry.size).toBe(1);
    const condition = registry.create('always');
    expect(condition).toBe(alwaysTrue);
    expect(await condition({})).toBe(true);
  });

  it('条件名重复登记被拒；未知条件建图期拒绝', () => {
    const registry = new EdgeConditionRegistry();
    registry.register('always', alwaysTrue);
    expect(() => registry.register('always', alwaysTrue)).toThrow(
      '条件名重复注册: always',
    );
    expect(() => registry.create('missing')).toThrow(GraphDefinitionError);
    expect(() => registry.create('missing')).toThrow('未知条件: missing');
  });
});

describe('建图注册表捆绑（GraphRegistries 依赖注入）', () => {
  it('缺省各建空表且每次构造相互独立', () => {
    const first = new GraphRegistries();
    const second = new GraphRegistries();
    expect(first.nodes.size).toBe(0);
    expect(first.edges.size).toBe(0);
    first.nodes.register('write', countingFactory('w'));
    expect(first.nodes.has('write')).toBe(true);
    expect(second.nodes.has('write')).toBe(false);
  });

  it('注入的节点/条件表同源聚合', () => {
    const nodes = new NodeTypeRegistry();
    const edges = new EdgeConditionRegistry();
    const registries = new GraphRegistries(nodes, edges);
    expect(registries.nodes).toBe(nodes);
    expect(registries.edges).toBe(edges);
    registries.nodes.register('audit', countingFactory('a'));
    registries.edges.register('always', async () => true);
    expect(nodes.size).toBe(1);
    expect(edges.size).toBe(1);
    expect(registries.nodes.create('audit')).toBeTypeOf('function');
    expect(typeof registries.edges.create('always')).toBe('function');
  });
});
