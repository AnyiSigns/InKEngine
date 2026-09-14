/**
 * 会话宿主薄服务域（S4 从 hosts/lib/src/sessions 迁入，语义零改）。
 *
 * 会话 = 引擎 checkpoint 链的宿主索引：thread_id 对应链归属，branch 树 =
 * 同链多叶形态（ChainLink 数据面推导，不落第二份）。记录存宿主命名空间
 * 集合 `host.sessions`（非引擎守卫集合，无旁路直写风险）。rounds 收尾
 * upsert 与 records.sessions 查询统一经此服务，无第二处直接写点。
 *
 * 值随插件（域逻辑唯一实现位）：装配契约类型（HostSessionRecord/
 * SessionBranchTree/StorageGetter…）从 @ink-ts/host 派生；命令面经插件包
 * import HostSessionStore 构造（storage getter 闭包由命令侧注入）。
 * 默认导出 = 域服务工厂（S0 装载契约；实例 = 会话域服务面）。
 */

import type { Storage } from '@ink-ts/engine';
import type {
  HostSessionRecord,
  SessionBranchTree,
  SessionTouchInput,
  StorageGetter,
} from '@ink-ts/host';

/** 宿主会话记录集合键。 */
export const HOST_SESSIONS_COLLECTION = 'host.sessions';

/** 会话标题长度上限（与桌面壳标题口径一致：短标题便于列表展示）。 */
export const SESSION_TITLE_MAX = 32;

/** 会话标题候选触发消息数（不足不自动起标题）。 */
export const TITLE_TRIGGER_MESSAGES = 2;

/** 会话标题候选触发消息数（不足不自动起标题）。 */
export type { HostSessionRecord, SessionBranchTree, SessionTouchInput, StorageGetter };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** 宽松解析已存记录（旧形态缺新字段 = 回落默认；thread_id 缺失视为非法）。 */
export function parse_session_record(data: unknown): HostSessionRecord | null {
  if (!isRecord(data)) return null;
  const thread_id = data['thread_id'];
  if (typeof thread_id !== 'string' || thread_id === '') return null;
  const now = Date.now() / 1000;
  return {
    thread_id,
    title: str(data['title'], ''),
    created_at: num(data['created_at'], now),
    updated_at: num(data['updated_at'], now),
    message_count: num(data['message_count'], 0),
    current_leaf: num(data['current_leaf'], -1) >= 0 ? num(data['current_leaf'], 0) : null,
    rename_count: num(data['rename_count'], 0),
    deleted: bool(data['deleted'], false),
    round_count: num(data['round_count'], 0),
    last_round_id: data['last_round_id'] === null || data['last_round_id'] === undefined
      ? null
      : String(data['last_round_id']),
    ...(data['last_outcome'] !== undefined && data['last_outcome'] !== null
      ? { last_outcome: str(data['last_outcome'], '') }
      : {}),
    ...(Array.isArray(data['display_messages']) ? { display_messages: data['display_messages'] } : {}),
  };
}

/** 新建会话记录（标题空；簿记清零）。 */
export function new_session_record(thread_id: string): HostSessionRecord {
  const now = Date.now() / 1000;
  return {
    thread_id,
    title: '',
    created_at: now,
    updated_at: now,
    message_count: 0,
    current_leaf: null,
    rename_count: 0,
    deleted: false,
    round_count: 0,
    last_round_id: null,
  };
}

/** 记录 → 存储形态（JSON 兼容；删除时间戳字段缺省不落）。 */
export function session_record_to_json(record: HostSessionRecord): Record<string, unknown> {
  const out: Record<string, unknown> = { ...record };
  if (out['last_outcome'] === undefined || out['last_outcome'] === '') {
    delete out['last_outcome'];
  }
  return out;
}

/** 时间戳回落标题（无模型自动起题的确定性兜底；%Y-%m-%d %H:%M）。 */
export function fallback_title(epochSecs: number): string {
  const d = new Date(epochSecs * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 标题归一：折叠空白 + 截断到上限；空/超长白名单输入拒绝（返回 null）。 */
export function normalize_title(title: string): string | null {
  const trimmed = title.replace(/\s+/g, ' ').trim();
  if (trimmed === '') return null;
  return trimmed.slice(0, SESSION_TITLE_MAX);
}

/** 记录 → 分支树（chain 叶子推导；current = 链尾最大 checkpoint_id）。 */
export function branch_tree_from_chain(
  thread_id: string,
  chain: ReadonlyArray<{ checkpoint_id: number; parent_id: number | null; reason?: string | null }>,
  current_leaf: number | null,
): SessionBranchTree {
  const nodes = chain.map((link) => ({
    leaf: link.checkpoint_id,
    parent: link.parent_id,
    reason: link.reason ?? null,
  })) as SessionBranchTree['nodes'];
  const childOf = new Set(nodes.map((node) => node.parent).filter((p): p is number => p !== null));
  const leaves = nodes.filter((node) => !childOf.has(node.leaf));
  const active =
    current_leaf !== null && nodes.some((node) => node.leaf === current_leaf)
      ? current_leaf
      : nodes.length === 0
        ? null
        : Math.max(...nodes.map((node) => node.leaf));
  return { session_id: thread_id, nodes: leaves, current_leaf: active };
}

/** 宿主会话服务错误（参数/状态问题；message 可回请求方）。 */
export class SessionServiceError extends Error {
  readonly code: string;
  constructor(message: string, code = 'session_error') {
    super(message);
    this.name = 'SessionServiceError';
    this.code = code;
  }
}

function shortId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 会话薄服务（一 host 实例一个；闭包持 storage 访问器）。 */
export class HostSessionStore {
  constructor(private readonly storage: StorageGetter) {}

  private requireStorage(): Storage {
    const storage = this.storage();
    if (storage === null) {
      throw new SessionServiceError('运行时存储未装配', 'runtime_unavailable');
    }
    return storage;
  }

  private async getRecord(thread_id: string): Promise<HostSessionRecord | null> {
    const storage = this.requireStorage();
    const data = await storage.get_record(HOST_SESSIONS_COLLECTION, thread_id).catch(() => null);
    return parse_session_record(data);
  }

  private async putRecord(record: HostSessionRecord): Promise<void> {
    const storage = this.requireStorage();
    await storage.put_record(HOST_SESSIONS_COLLECTION, record.thread_id, session_record_to_json(record));
  }

  /** 取全部非删除会话（updated_at 降序）。 */
  async list(): Promise<HostSessionRecord[]> {
    const storage = this.requireStorage();
    const records = await storage.list_records(HOST_SESSIONS_COLLECTION).catch(() => []);
    const sessions = records
      .map((raw) => parse_session_record(raw))
      .filter((record): record is HostSessionRecord => record !== null && !record.deleted);
    return sessions.sort((a, b) => b.updated_at - a.updated_at);
  }

  /** 按 thread_id 取会话（未建/已删 = null）。 */
  async get(thread_id: string): Promise<HostSessionRecord | null> {
    const record = await this.getRecord(thread_id);
    if (record === null || record.deleted) return null;
    return record;
  }

  /** 新建会话（thread_id 缺省自动生成；返回落库记录）。 */
  async create(thread_id?: string | null): Promise<HostSessionRecord> {
    const id = thread_id ?? shortId('t');
    const existing = await this.getRecord(id);
    if (existing !== null && !existing.deleted) return existing;
    const record = new_session_record(id);
    await this.putRecord(record);
    return record;
  }

  /** 改名（标题归一；非法标题抛 SessionServiceError）。 */
  async rename(thread_id: string, title: string): Promise<HostSessionRecord> {
    const normalized = normalize_title(title);
    if (normalized === null) {
      throw new SessionServiceError('标题不能为空（归一后为空串）', 'invalid_title');
    }
    const record = await this.getRecord(thread_id);
    if (record === null) {
      throw new SessionServiceError('会话不存在', 'session_not_found');
    }
    record.title = normalized;
    record.rename_count += 1;
    record.updated_at = Date.now() / 1000;
    await this.putRecord(record);
    return record;
  }

  /** 删除（逻辑删除 tombstone；链数据保留在引擎）。 */
  async remove(thread_id: string): Promise<void> {
    const record = await this.getRecord(thread_id);
    if (record === null) return;
    record.deleted = true;
    record.updated_at = Date.now() / 1000;
    await this.putRecord(record);
  }

  /** 回合收尾簿记刷新（rounds 收尾唯一写点：round_count/结局/时间戳）。 */
  async touch(
    thread_id: string,
    input: SessionTouchInput,
  ): Promise<HostSessionRecord> {
    const now = Date.now() / 1000;
    const existing = await this.getRecord(thread_id);
    const record: HostSessionRecord = existing ?? new_session_record(thread_id);
    record.updated_at = now;
    record.round_count += 1;
    record.last_round_id = input.round_id;
    record.last_outcome = input.outcome;
    if (input.checkpoint_id !== null && input.checkpoint_id !== undefined) {
      record.current_leaf = input.checkpoint_id;
    }
    await this.putRecord(record);
    return record;
  }

  /** 追加展示态消息流（会话级累积：历史 + 本轮；刷新据此恢复完整消息流）。 */
  async set_display_messages(thread_id: string, messages: unknown[]): Promise<HostSessionRecord> {
    const existing = await this.getRecord(thread_id);
    const record: HostSessionRecord = existing ?? new_session_record(thread_id);
    // 展示态跨轮累积：追加到既有历史之后（而非覆盖），多轮刷新仍完整。
    const history = Array.isArray(record.display_messages) ? record.display_messages : [];
    record.display_messages = [...history, ...messages];
    record.updated_at = Date.now() / 1000;
    await this.putRecord(record);
    return record;
  }

  /** 收尾整体刷新：消息数/当前叶派生 + 空标题自动起兜底标题。 */
  async refresh(thread_id: string): Promise<HostSessionRecord> {
    const storage = this.requireStorage();
    const checkpoint = await storage
      .get_latest_checkpoint(thread_id)
      .catch(() => null);
    const existing = await this.getRecord(thread_id);
    const record: HostSessionRecord = existing ?? new_session_record(thread_id);
    record.updated_at = Date.now() / 1000;
    if (checkpoint !== null && checkpoint !== undefined) {
      record.current_leaf = checkpoint.checkpoint_id;
      const messages = (checkpoint.state['messages'] ?? []) as unknown[];
      if (Array.isArray(messages)) {
        record.message_count = messages.filter(
          (entry) =>
            typeof entry === 'object' && entry !== null
            && (entry as { role?: unknown }).role === 'user',
        ).length;
      }
      if (record.title === '' && record.message_count >= 2) {
        record.title = fallback_title(checkpoint.created_at);
      }
    }
    await this.putRecord(record);
    return record;
  }

  /** 分支树（链多叶数据面推导；不落第二份台账）。 */
  async branch_tree(thread_id: string): Promise<SessionBranchTree> {
    const storage = this.requireStorage();
    const chain = await storage.chain_index(thread_id).catch(() => []);
    const record = await this.getRecord(thread_id);
    return branch_tree_from_chain(
      thread_id,
      chain as Array<{ checkpoint_id: number; parent_id: number | null; reason?: string | null }>,
      record?.current_leaf ?? null,
    );
  }
}

/** S4 域服务工厂（S0 装载契约）：返回会话域服务面。 */
export default function createSessionsDomain(): {
  HostSessionStore: typeof HostSessionStore;
  SessionServiceError: typeof SessionServiceError;
  HOST_SESSIONS_COLLECTION: string;
} {
  return {
    HostSessionStore,
    SessionServiceError,
    HOST_SESSIONS_COLLECTION,
  };
}