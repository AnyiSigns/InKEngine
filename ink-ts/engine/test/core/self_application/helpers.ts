/**
 * 自指应用管线测试共用装置（内存假存储 + 假审批节点上下文 + 提案构造）。
 *
 * 引擎 core 零 IO：Storage seam 以注入内存假存储（records/checkpoint/事件
 * 日志三通道全量实现）驱动，纯机制语义与 Python create_storage("memory://")
 * 等价；真实存储后端（memory:// sqlite/postgres 宿主实现）与 asyncio 宿主
 * IO 属宿主装配面，不在引擎 core 单测范围。FakeCtx 为鸭子类型节点上下文
 * （模拟挂起/注入消费/重入读回已挂卡），与 Python 侧同构。
 */

import type { EngineEvent } from '../../../src/core/events/events.js';
import type { ApprovalInterruptContext } from '../../../src/core/approval/approval.js';
import { ProposalValidator, SelfProposal } from '../../../src/core/self_proposal/index.js';
import type { PatchKind } from '../../../src/core/self_proposal/index.js';
import type {
  ChainLink,
  CheckpointRecord,
} from '../../../src/core/storage/storage_records.js';
import type { Storage } from '../../../src/core/storage/storage.js';
import type {
  ApprovalLevel,
  L2VettingHook,
  SelfApplicationPipelineInit,
} from '../../../src/core/self_application/index.js';
import { SelfApplicationPipeline } from '../../../src/core/self_application/index.js';

/** 内存假存储：records/事件日志三原语 + checkpoint 惰性通道全量实现。 */
export class MemStorage implements Storage {
  readonly records = new Map<string, Map<string, Record<string, unknown>>>();
  readonly events = new Map<string, { seq: number; event: EngineEvent }[]>();
  readonly snapshot_capable = false;

  async get_record(collection: string, key: string): Promise<Record<string, unknown> | null> {
    return this.records.get(collection)?.get(key) ?? null;
  }

  async put_record(collection: string, key: string, data: Record<string, unknown>): Promise<void> {
    if (!this.records.has(collection)) this.records.set(collection, new Map());
    this.records.get(collection)!.set(
      key,
      JSON.parse(JSON.stringify(data)) as Record<string, unknown>,
    );
  }

  async list_records(collection: string): Promise<Record<string, unknown>[]> {
    return [...(this.records.get(collection)?.values() ?? [])];
  }

  async delete_collection(collection: string): Promise<number> {
    const table = this.records.get(collection);
    if (!table) return 0;
    this.records.delete(collection);
    return table.size;
  }

  async append_event(thread_id: string, event: EngineEvent): Promise<number> {
    const list = this.events.get(thread_id) ?? [];
    const seq = list.length + 1;
    list.push({ seq, event });
    this.events.set(thread_id, list);
    return seq;
  }

  async events_after(thread_id: string, seq: number): Promise<EngineEvent[]> {
    return (this.events.get(thread_id) ?? [])
      .filter((item) => item.seq > seq)
      .sort((a, b) => a.seq - b.seq)
      .map((item) => item.event);
  }

  async latest_event_seq(thread_id: string): Promise<number> {
    return this.events.get(thread_id)?.length ?? 0;
  }

  async truncate_events(thread_id: string, after_seq: number): Promise<void> {
    const list = this.events.get(thread_id) ?? [];
    this.events.set(thread_id, list.filter((item) => item.seq <= after_seq));
  }

  async trim_events(thread_id: string, before_seq: number): Promise<number> {
    const list = this.events.get(thread_id) ?? [];
    const keep = list.filter((item) => item.seq >= before_seq);
    this.events.set(thread_id, keep);
    return list.length - keep.length;
  }

  async get_checkpoint(checkpoint_id: number): Promise<CheckpointRecord | null> {
    return null;
  }

  async get_latest_checkpoint(thread_id: string): Promise<CheckpointRecord | null> {
    return null;
  }

  async put_checkpoint(record: CheckpointRecord): Promise<CheckpointRecord> {
    return record;
  }

  async list_checkpoints(thread_id: string): Promise<CheckpointRecord[]> {
    return [];
  }

  async chain_index(thread_id: string): Promise<ChainLink[]> {
    return [];
  }

  async delete_checkpoints(thread_id: string, ids: readonly number[]): Promise<number> {
    return 0;
  }

  async set_checkpoint_parent(
    thread_id: string,
    checkpoint_id: number,
    parent_id: number | null,
  ): Promise<number> {
    return 0;
  }

  async snapshot(dest: string): Promise<void> {
    throw new Error('内存假存储不支持快照');
  }

  async restore(src: string): Promise<void> {
    throw new Error('内存假存储不支持还原');
  }

  async close(): Promise<void> {}
}

/** 记录通道读取助手（测试断言用）。 */
export function recordOf(
  storage: Storage,
  collection: string,
  key: string,
): Record<string, unknown> | null {
  const mem = storage as MemStorage;
  return mem.records.get(collection)?.get(key) ?? null;
}

/** 挂卡审批的假节点上下文：预设注入值，未预设 = 显式报错。 */
export class FakeCtx implements ApprovalInterruptContext {
  private readonly injects: Map<string, unknown> = new Map<string, unknown>();
  readonly cards: { key: string; payload: Record<string, unknown> }[] = [];

  async interrupt(key: string, payload: Record<string, unknown>): Promise<unknown> {
    this.cards.push({ key, payload });
    if (!this.injects.has(key)) {
      throw new Error(`未预设注入值: ${key}`);
    }
    const value = this.injects.get(key);
    this.injects.delete(key);
    return value;
  }

  async get_interrupt_payload(): Promise<unknown> {
    return null;
  }

  preset(key: string, value: unknown): void {
    this.injects.set(key, value);
  }
}

/** 主题补丁（默认合法：bg ∈ 白名单）。 */
export function _theme_proposal(
  payload: Record<string, unknown> = { tokens: { bg: '#111' } },
  base_version = 1,
  rationale = '换主题',
): SelfProposal {
  return new SelfProposal({ kind: 'theme', payload, base_version, rationale });
}

/** 工具补丁（默认合法声明形态；L1 弹卡档位）。 */
export function _tool_proposal(
  name: string,
  base_version = 1,
): SelfProposal {
  return new SelfProposal({
    kind: 'tool',
    payload: {
      name,
      description: 'x',
      permissions: ['filesystem:read:/workspace'],
      endpoint: 'file_ops',
      endpoint_config: { root: '/workspace' },
    },
    base_version,
  });
}

/** 产物补丁（默认合法声明形态；L2 沙箱验证档位）。 */
export function _artifact_proposal(base_version = 1): SelfProposal {
  return new SelfProposal({
    kind: 'artifact',
    payload: {
      artifact_id: 'a-1',
      kind: 'js_bundle',
      hashes: { 'index.js': 'a'.repeat(64) },
    },
    base_version,
  });
}

/** 默认装配（镜像 Python fixture：ui/theme 白名单）。 */
export function _validator(): ProposalValidator {
  return new ProposalValidator({
    allowed_components: ['column'],
    allowed_channels: ['state'],
    allowed_theme_tokens: ['bg'],
  });
}

/** 构造管线（storage 缺省新建内存假存储）。 */
export function _pipeline(
  storage: Storage = new MemStorage(),
  options: Omit<SelfApplicationPipelineInit, 'storage' | 'validator'> & {
    validator?: ProposalValidator | null;
  } = {},
): SelfApplicationPipeline {
  const { validator, ...rest } = options;
  return new SelfApplicationPipeline({
    storage,
    validator: validator ?? _validator(),
    ...rest,
  });
}

export type { ApprovalLevel, L2VettingHook, PatchKind };
