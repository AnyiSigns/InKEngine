/**
 * Node-registry-backed governance write target (A3 R3 landing).
 *
 * 池治理裁决反写登记数据（替代实体注册表 seam——治理候选 = 结点类型登记行）：
 * - list(): 活跃登记类型名（可见清单，裁决目标须在列）；
 * - archive(id): disable 登记行（受控回写：status=disabled + 审计，见 store
 *   disable）并卸载执行体（unregister 回调）；幂等 = 缺失/非 active no-op；
 * - evict(id): 同 archive（软归档淘汰；登记行保留可追溯，不做物理删）；
 * - merge(keep_id, drop_ids): 近重复修复建议——suggestion 字段留在 drop 登记行
 *   （merge_into=keep_id），不擅自 disable（replace/merge 由人/agent 走提案
 *   路径确认）。
 *
 * 池不变式守卫：archive/evict 不得移除**最后一个 active 终态候选**（登记行
 * flags.terminal=true 且池内 active 终态候选 ≤1 = 不可被治理淘汰；口径与
 * pool_governance_rules 死结点淘汰保护分支一致，P2 规则层已保护自动淘汰路径，
 * 本守卫封堵显式治理写 seam）——命中即抛 GraphDefinitionError 拒绝。
 *
 * 所有写都经 store 受控写通道（GuardedStorage 豁免 + EvolutionWriter 补丁链 +
 * set_audit 审计），与 entity_registry_governance_target 范式一致；执行体卸载
 * 回调由装配面注入（NodeTypeRegistry.unregister）。治理只回写登记数据，不改
 * 执行体代码。
 */

import type { GovernanceWriteTarget } from '../../kernel/settle/review.js';
import { GraphDefinitionError } from '../errors.js';
import type { NodeRegistryStore } from './store.js';

/** 登记 store 治理 seam 构造面。 */
export interface NodeRegistryGovernanceOptions {
  /** 执行体卸载回调（登记行 disable/archive 后从运行时注册表移除执行体）。 */
  unregister(type_name: string): void;
}

/**
 * 池不变式守卫：目标登记行为 active 终态候选（flags.terminal=true）且是池内
 * 最后一个 active 终态候选时拒绝治理写（与 pool_governance_rules 死结点淘汰
 * 的保护分支同口径；终态候选 = store.active() 中 flags.terminal===true 行）。
 * 返回拒绝原因（null = 允许治理写）。
 */
function _last_terminal_reject_reason(
  store: NodeRegistryStore,
  id: string,
): string | null {
  const existing = store.get(id);
  if (existing === null || !existing.is_active()) return null;
  if (existing.flags?.terminal !== true) return null;
  let activeTerminals = 0;
  for (const reg of store.active()) {
    if (reg.flags?.terminal === true) activeTerminals += 1;
  }
  if (activeTerminals > 1) return null;
  return `不能归档最后一个 active 终态候选: ${id}（终态候选 ≤1 不可被治理淘汰）`;
}

/**
 * Pool governance write target over the node type registration store.
 * Writes go through the store's controlled write seam; live executor registry is
 * kept in sync through the unregister callback; missing/inactive objects are
 * idempotent no-ops (registration + audit already recorded on the settle side).
 */
export function node_registry_governance_target(
  store: NodeRegistryStore,
  opts: NodeRegistryGovernanceOptions,
): GovernanceWriteTarget {
  return {
    async list(): Promise<string[]> {
      return store.active_type_names();
    },

    async archive(id, o): Promise<void> {
      const existing = store.get(id);
      if (existing === null || !existing.is_active()) return;
      const rejectReason = _last_terminal_reject_reason(store, id);
      if (rejectReason !== null) {
        throw new GraphDefinitionError(rejectReason);
      }
      await store.disable(id, o.reason, 'pool_governance_archive');
      opts.unregister(id);
    },

    async evict(id, o): Promise<void> {
      const existing = store.get(id);
      if (existing === null || !existing.is_active()) return;
      const rejectReason = _last_terminal_reject_reason(store, id);
      if (rejectReason !== null) {
        throw new GraphDefinitionError(rejectReason);
      }
      await store.archive(id, o.reason, 'pool_governance_evict');
      opts.unregister(id);
    },

    async merge(keep_id, drop_ids, o): Promise<void> {
      for (const drop of drop_ids) {
        const existing = store.get(drop);
        if (existing === null || !existing.is_active()) continue;
        await store.suggest(
          drop,
          {
            kind: 'merge',
            merge_into: keep_id,
            reason: o.reason,
          },
          'pool_governance_merge_suggestion',
        );
      }
    },
  };
}
