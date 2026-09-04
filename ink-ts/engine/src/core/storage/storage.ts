/**
 * 存储服务 seam：Storage 接口（checkpoint 版本链 + 事件日志 +
 * structured records + 快照/恢复能力）+ validate_chain 纯校验。
 *
 * seam 仅声明语义：实现由宿主注入（memory/sqlite/postgres 均为宿主侧
 * IO，core 不落）。校验函数消费 seam 的 chain_index + get_checkpoint
 * 两个原语，校验器与后端解耦——可对任意 Storage 实现做存量坏链巡检。
 *
 * validate_chain 镜像 Python 行为：整链一次取回（避免逐跳重查询的
 * O(链长) 次串行 DB 往返）→ 内存内沿 parent_id 回溯 → 遇坏链报告
 * 违规并停止（环检测立即终止，不触发遍历超限）。悬挂/跨线程父指针
 * 单次跨索引查询区分：先看本线程 by_id，缺失再回退 get_checkpoint
 * 判定悬挂或跨线程。
 *
 * 错误映射（与 Python 等价）：值类（参数越界）→ RangeError；类型类
 * → TypeError；其他异常 → new Error。CheckpointConflictError 仍由实现
 * 侧抛（写入端不变量），校验器不涉及。
 */

import type { EngineEvent } from '../events/events.js';

import { ChainLink, CheckpointRecord } from './storage_records.js';
import { DEFAULT_CHAIN_WALK_LIMIT, DEFAULT_LIST_CHECKPOINTS_LIMIT } from './storage_constants.js';

/** 通用存储服务 seam（接口层，宿主侧注入实现）。 */
export interface Storage {
  // ── checkpoint 版本链 ──
  get_checkpoint(checkpoint_id: number): Promise<CheckpointRecord | null>;
  get_latest_checkpoint(thread_id: string): Promise<CheckpointRecord | null>;
  put_checkpoint(
    record: CheckpointRecord,
    opts?: { expected_version?: number | null; fork?: boolean },
  ): Promise<CheckpointRecord>;
  list_checkpoints(
    thread_id: string,
    opts?: { limit?: number },
  ): Promise<CheckpointRecord[]>;
  chain_index(thread_id: string): Promise<ChainLink[]>;
  delete_checkpoints(thread_id: string, ids: readonly number[]): Promise<number>;
  set_checkpoint_parent(
    thread_id: string,
    checkpoint_id: number,
    parent_id: number | null,
  ): Promise<number>;

  // ── 执行事件日志（append-only） ──
  append_event(thread_id: string, event: EngineEvent): Promise<number>;
  events_after(thread_id: string, seq: number): Promise<EngineEvent[]>;
  truncate_events(thread_id: string, after_seq: number): Promise<void>;
  trim_events(thread_id: string, before_seq: number): Promise<number>;
  latest_event_seq(thread_id: string): Promise<number>;

  // ── structured records（回合记录/记忆等宿主结构化数据共用） ──
  put_record(collection: string, key: string, data: Record<string, unknown>): Promise<void>;
  get_record(collection: string, key: string): Promise<Record<string, unknown> | null>;
  list_records(collection: string): Promise<Record<string, unknown>[]>;
  delete_collection(collection: string): Promise<number>;

  // ── 全量快照（备份/迁移/归档） ──
  readonly snapshot_capable: boolean;
  snapshot(dest: string): Promise<void>;
  restore(src: string): Promise<void>;

  close(): Promise<void>;
}

/** validate_chain 选项。 */
export interface ValidateChainOptions {
  /** 回溯步数上限（防意外成环死循环；超限报违规并停止）。 */
  max_walk?: number;
  /** 是否校验 event_seq 单调性（分叉链豁免场景置 false）。 */
  check_event_seq?: boolean;
}

/**
 * 版本链一致性校验：沿 parent_id 回溯，断言父引用存在且归属同线程、
 * checkpoint_id 严格递减、event_seq 单调不减。
 *
 * 实现要点：单次 chain_index 取回整链（轻量行），内存内按 parent_id
 * 回溯。悬挂/跨线程父指针单次跨索引查询区分（看本线程 by_id 是否
 * 命中；不命中回退 get_checkpoint 判定——悬挂或跨线程）。环/自引用
 * 立即终止回溯（继续走无意义且死循环）。
 */
export async function validate_chain(
  storage: Storage,
  thread_id: string,
  options: ValidateChainOptions = {},
): Promise<string[]> {
  const max_walk = options.max_walk ?? DEFAULT_CHAIN_WALK_LIMIT;
  const check_event_seq = options.check_event_seq ?? true;
  const violations: string[] = [];
  const links = await storage.chain_index(thread_id);
  if (links.length === 0) return violations;

  const by_id = new Map<number, ChainLink>();
  for (const link of links) by_id.set(link.checkpoint_id, link);

  let node: ChainLink | null = links[0] ?? null; // chain_index 按 id 降序
  let walked = 0;
  while (node !== null) {
    walked += 1;
    if (walked > max_walk) {
      violations.push(
        `链遍历超限（>${max_walk} 节点，疑似成环）: 停于 #${node.checkpoint_id}`,
      );
      break;
    }
    const parent =
      node.parent_id !== null && node.parent_id !== undefined
        ? by_id.get(node.parent_id) ?? null
        : null;
    if (node.parent_id !== null && node.parent_id !== undefined && parent === null) {
      const cross = await storage.get_checkpoint(node.parent_id);
      if (cross === null) {
        violations.push(
          `悬挂父指针: #${node.checkpoint_id} -> parent #${node.parent_id} 不存在`,
        );
      } else {
        violations.push(
          `跨线程父指针: #${node.checkpoint_id}(thread=${thread_id}) -> #${cross.checkpoint_id}(thread=${cross.thread_id})`,
        );
      }
      break;
    }
    if (parent !== null) {
      if (parent.checkpoint_id >= node.checkpoint_id) {
        violations.push(
          `父链非递减（环/自引用）: #${node.checkpoint_id} -> #${parent.checkpoint_id}`,
        );
        break;
      }
      if (check_event_seq && parent.event_seq > node.event_seq) {
        violations.push(
          `event_seq 回退: #${node.checkpoint_id} event_seq=${node.event_seq} < 父 #${parent.checkpoint_id} event_seq=${parent.event_seq}`,
        );
      }
    }
    node = parent;
  }
  return violations;
}
