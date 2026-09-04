/**
 * 子图恢复锚点回溯：沿版本链收集各级恢复锚点（collect_resume_anchors，
 * recovery.py 移植）。
 *
 * 遍历实现：整链索引一次取回（Storage.chain_index，轻量行无快照负载），
 * 内存内按 parent_id 回溯——避免逐跳 get_checkpoint 的 O(链长) 次串行
 * DB 往返；链级 rebase 压缩后链长有界（窗口内），回溯自然停在归档链头
 * （parent_id=null）。
 */

import { ChainLink } from '../storage/storage_records.js';
import type { CheckpointRecord } from '../storage/storage_records.js';
import type { Storage } from '../storage/storage.js';
import type { ResumeMap } from './recovery_types.js';

/** resume_map 键编码：graph_path 的 JSON 序列化（单射编码，见 recovery_types）。 */
function pathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

/**
 * 沿版本链回溯收集恢复锚点（顶层中断 checkpoint 的父链含各级子链锚点）。
 *
 * - 非空路径节点：仅收未完成/中断锚点（reason 为 null 的节点快照或
 *   interrupted 挂起轮）——reply/stop/error 终态 = 已完成子链的陈旧
 *   结果，作恢复锚点会让子链直接收尾回流旧状态；
 * - 空路径节点：最近的顶层锚点（本级恢复起点）。
 *
 * 返回 [top_anchor, resume_map]：顶层锚点 checkpoint_id（null = 图入口
 * 即子链，本级无顶层锚点）+ 子链锚点表（沿用传入表，逐级补录）。
 *
 * tail 为 null（首轮执行/无 checkpoint）时无回溯可言，直接返回原表。
 */
export async function collect_resume_anchors(
  storage: Storage,
  tail: CheckpointRecord | null,
  resume_map: ResumeMap,
): Promise<[number | null, ResumeMap]> {
  if (tail === null) {
    return [null, resume_map];
  }
  const links = await storage.chain_index(tail.thread_id);
  const by_id = new Map<number, ChainLink>();
  for (const link of links) by_id.set(link.checkpoint_id, link);
  let cp: ChainLink | null = by_id.get(tail.checkpoint_id) ?? null;
  if (cp === null) {
    // 防御：锚点不在索引（异常状态）仍可沿传入记录回溯一步
    cp = new ChainLink({
      checkpoint_id: tail.checkpoint_id,
      parent_id: tail.parent_id,
      event_seq: tail.event_seq,
      graph_path: tail.graph_path,
      reason: tail.reason,
    });
  }
  let top_anchor: number | null = null;
  while (cp !== null) {
    const path = cp.graph_path;
    if (path.length > 0) {
      if (cp.reason === null || cp.reason === 'interrupted') {
        // setdefault 语义：仅未登记路径补录，后续节点不覆盖先走锚点
        const key = pathKey(path);
        if (!resume_map.has(key)) resume_map.set(key, cp.checkpoint_id);
      }
    } else if (top_anchor === null) {
      top_anchor = cp.checkpoint_id; // 最近的顶层锚点
    }
    // 继续沿父链回溯：顶层中断 checkpoint 的父链含子图层锚点
    cp = cp.parent_id !== null ? (by_id.get(cp.parent_id) ?? null) : null;
  }
  return [top_anchor, resume_map];
}