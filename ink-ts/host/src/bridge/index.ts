/**
 * host bridge 命令面装配（buildBridge）：首批方法集按域分组注册——
 * rounds（send/abort/resume）、records（sessions/链记录）、approval（卡
 * 查询/裁决）、audit（导出）。与 cli 现有 host.ping/host.info 并存不冲突
 * （命名空间独立；S4 由 cli 注入本表）。
 *
 * 方法增删纪律（AGENTS 纪律 3）：本文件是 bridge 方法表单一事实源——
 * 增删方法须同步修改 CODING.md §9 命令面清单。
 */

import type { BridgeHandler, HostBridgeDeps } from './_types.js';
import { buildApprovalHandlers } from './approval.js';
import { buildAuditHandlers } from './audit.js';
import { buildRecordsHandlers } from './records.js';
import { buildRoundsHandlers } from './rounds.js';

/** bridge 命令面（域分组方法名清单；声明/文档同步的单一事实源）。 */
export const BRIDGE_METHODS = [
  // rounds：回合驱动
  'rounds.send',
  'rounds.abort',
  'rounds.resume',
  // records：会话/链记录查询
  'records.sessions',
  'records.chain',
  // approval：审批卡查询/裁决
  'approval.list',
  'approval.resolve',
  // audit：审计导出
  'audit.export',
] as const;

export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

/**
 * 装配 host bridge 方法表（每 host 实例一次；方法实现闭包持有该 host 的
 * runtime/事件文件传输/会话索引）。缺省组只含已实现方法——新增组先实现
 * 再登记清单。
 */
export function buildBridge(deps: HostBridgeDeps): ReadonlyMap<string, BridgeHandler> {
  const groups = [
    buildRoundsHandlers(deps),
    buildRecordsHandlers(deps),
    buildApprovalHandlers(deps),
    buildAuditHandlers(deps),
  ];
  const methods = new Map<string, BridgeHandler>();
  for (const group of groups) {
    for (const [name, handler] of group) {
      if (methods.has(name)) {
        throw new Error(`bridge 方法重复注册: ${name}`);
      }
      methods.set(name, handler);
    }
  }
  const declared = new Set<string>(BRIDGE_METHODS);
  for (const name of methods.keys()) {
    if (!declared.has(name)) {
      throw new Error(`bridge 方法未登记 BRIDGE_METHODS: ${name}`);
    }
  }
  for (const name of BRIDGE_METHODS) {
    if (!methods.has(name)) {
      throw new Error(`BRIDGE_METHODS 已声明但未实现: ${name}`);
    }
  }
  return methods;
}
