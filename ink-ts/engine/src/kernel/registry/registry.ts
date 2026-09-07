/**
 * 机制件注册表密封（装配闭集校验）：对契约集做依赖图校验并给出装配序。
 *
 * - 契约 id 全局唯一（注册表键与目录同名）；
 * - depends 引用的 id 必须是注册表内另一契约，或外部名单放行的机制端口
 *   （如 rounds.port——引擎导出端口是机制件的可依赖契约面）；
 * - depends 形成 DAG：自环/循环拒绝（fail-closed），装配序按 depends 拓扑
 *   （被依赖者先装配）——boot 组密封前调用一次，密封后不可变。
 */

import type { MechanismContract, SealedMechanismRegistry } from './contract_types.js';

/** 注册表违规：rule 区分重复 id / 未知依赖 / 自环 / 循环依赖。 */
export interface RegistryViolation {
  rule: 'duplicate-id' | 'unknown-dep' | 'self-dep' | 'cycle';
  id: string;
  dep?: string;
  message: string;
}

/** 契约集装配校验（纯函数）：返回违规清单（空 = 通过）。 */
export function validate_mechanism_registry(
  contracts: readonly MechanismContract[],
  externalDeps: readonly string[] = [],
): RegistryViolation[] {
  const violations: RegistryViolation[] = [];
  const byId = new Map<string, MechanismContract>();
  for (const c of contracts) {
    if (byId.has(c.id)) {
      violations.push({
        rule: 'duplicate-id',
        id: c.id,
        message: `契约 id 重复: ${c.id}`,
      });
    }
    byId.set(c.id, c);
  }
  const external = new Set(externalDeps);
  const depCount = new Map<string, number>();
  for (const c of contracts) {
    for (const dep of c.depends) {
      if (dep === c.id) {
        violations.push({
          rule: 'self-dep',
          id: c.id,
          dep,
          message: `契约自环依赖: ${c.id} -> ${dep}`,
        });
        continue;
      }
      if (byId.has(dep)) continue;
      if (external.has(dep)) continue;
      violations.push({
        rule: 'unknown-dep',
        id: c.id,
        dep,
        message: `契约依赖未登记: ${c.id} -> ${dep}`,
      });
    }
    depCount.set(c.id, c.depends.length);
  }
  if (violations.length > 0) return violations;
  // 循环检测：Kahn 拓扑；仍剩结点 = 环（环内结点逐一上报）。
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const c of contracts) {
    indegree.set(c.id, 0);
    outgoing.set(c.id, []);
  }
  for (const c of contracts) {
    for (const dep of c.depends) {
      if (!byId.has(dep)) continue; // 外部端口不参与拓扑
      outgoing.set(dep, [...(outgoing.get(dep) ?? []), c.id]);
      indegree.set(c.id, (indegree.get(c.id) ?? 0) + 1);
    }
  }
  const queue: string[] = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) queue.push(id);
  }
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited.add(id);
    for (const next of outgoing.get(id) ?? []) {
      const deg = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }
  for (const [id, deg] of indegree) {
    if (deg !== 0 && !visited.has(id)) {
      violations.push({
        rule: 'cycle',
        id,
        message: `契约循环依赖涉及: ${id}`,
      });
    }
  }
  return violations;
}

/** 密封机制注册表：校验通过后返回契约表 + 拓扑装配序；违规 = 抛错（fail-closed）。 */
export function seal_mechanism_registry(
  contracts: readonly MechanismContract[],
  externalDeps: readonly string[] = [],
): SealedMechanismRegistry {
  const violations = validate_mechanism_registry(contracts, externalDeps);
  if (violations.length > 0) {
    const detail = violations.map((v) => `[${v.rule}] ${v.message}`).join('; ');
    throw new Error(`机制注册表密封失败: ${detail}`);
  }
  const byId = new Map<string, MechanismContract>();
  for (const c of contracts) byId.set(c.id, c);
  const order = topo_order(contracts);
  return { contracts: byId, order };
}

/** 依赖拓扑装配序（被依赖者先；纯函数，供密封与 verify 复用）。 */
export function topo_order(contracts: readonly MechanismContract[]): string[] {
  const byId = new Map<string, MechanismContract>();
  for (const c of contracts) byId.set(c.id, c);
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const c of contracts) {
    indegree.set(c.id, 0);
    outgoing.set(c.id, []);
  }
  for (const c of contracts) {
    for (const dep of c.depends) {
      if (!byId.has(dep)) continue;
      outgoing.set(dep, [...(outgoing.get(dep) ?? []), c.id]);
      indegree.set(c.id, (indegree.get(c.id) ?? 0) + 1);
    }
  }
  const queue: string[] = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) queue.push(id);
  }
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const deg = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }
  return order;
}
