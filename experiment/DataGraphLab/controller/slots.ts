/**
 * 历史特征的追加式稳定槽位（编码不变式 I.2）。
 *
 * 用 `crc32(nid) % buckets` 做哈希桶在 22 个基础节点上约有 6 处碰撞，会丢失
 * “哪个算子用过”的信息；改为按基础顺序分配稳定下标：基础节点占 0..21，结构
 * 进化新增节点依次占 22…，容量内 dims 不变且零碰撞。`entry` 不参与候选/历史。
 */

import { ENTRY, NODES_BASE } from '../world/operators.js';

export const HIST_SLOTS = 32;

/** 按给定顺序给非 entry 节点分配槽位；超出容量即截断（不静默扩容）。 */
export function buildNodeSlots(
  nodes: readonly string[],
  capacity: number,
): ReadonlyMap<string, number> {
  const slots = new Map<string, number>();
  let i = 0;
  for (const nid of nodes) {
    if (nid === ENTRY) continue;
    if (i >= capacity) break;
    slots.set(nid, i);
    i++;
  }
  return slots;
}

/** 基础世界槽位表（冻结）：`NODES_BASE` 顺序即槽位顺序。 */
export const NODE_SLOT: ReadonlyMap<string, number> = buildNodeSlots(NODES_BASE, HIST_SLOTS);
