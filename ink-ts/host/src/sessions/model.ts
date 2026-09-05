/**
 * 会话薄数据模型（宿主域服务的数据面；机制语义全在引擎，无二次台账）。
 *
 * 会话 = 引擎 checkpoint 链的宿主索引：thread_id 对应链归属，branch 树 =
 * 同链多叶形态（ChainLink 数据面推导，不落第二份）。记录存宿主命名空间
 * 集合 `host.sessions`（非引擎守卫集合，无旁路直写风险）。时间戳取 epoch
 * 秒（与链 checkpoint 口径一致），round 收尾簿记（round_count/last_round_id）
 * 随链数据派生，标题与 rename_count 属宿主簿记。
 */

/** 宿主会话记录集合键。 */
export const HOST_SESSIONS_COLLECTION = 'host.sessions';

/** 会话标题长度上限（与桌面壳标题口径一致：短标题便于列表展示）。 */
export const SESSION_TITLE_MAX = 32;

/** 会话标题候选触发消息数（不足不自动起标题）。 */
export const TITLE_TRIGGER_MESSAGES = 2;

/** 宿主会话记录（epoch 秒时间戳；引擎 checkpoint 链 + 宿主簿记合并形态）。 */
export interface HostSessionRecord {
  thread_id: string;
  title: string;
  /** 创建时间（epoch 秒）。 */
  created_at: number;
  /** 最近回合时间（epoch 秒）。 */
  updated_at: number;
  /** 链内消息数（回合收尾刷新时从最新 checkpoint 派生）。 */
  message_count: number;
  /** 当前分支叶（checkpoint_id；null = 尚无链）。 */
  current_leaf: number | null;
  /** 人工改名次数（0 = 从未改名，标题可被自动候选覆盖）。 */
  rename_count: number;
  /** 逻辑删除标记（列表/查询一律过滤）。 */
  deleted: boolean;
  /** 收尾簿记：本线程已跑回合数。 */
  round_count: number;
  /** 收尾簿记：最近一次回合 id。 */
  last_round_id: string | null;
  /** 收尾簿记：最近一次回合结局（ok/aborted/interrupted…）。 */
  last_outcome?: string;
}

/** 分支树单节点（派生自 ChainLink；leaf 恒为某叶 checkpoint）。 */
export interface SessionBranchNode {
  leaf: number;
  parent: number | null;
  reason: string | null;
}

/** 分支树（链多叶形态；current_leaf = 当前活跃叶）。 */
export interface SessionBranchTree {
  session_id: string;
  nodes: SessionBranchNode[];
  current_leaf: number | null;
}

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
  const nodes: SessionBranchNode[] = chain.map((link) => ({
    leaf: link.checkpoint_id,
    parent: link.parent_id,
    reason: link.reason ?? null,
  }));
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
