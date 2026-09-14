/**
 * 命令插件共享私有件（非插件：无 spec.json，生成器跳过；同 ports/_shared 先例）。
 * 本文件 = hosts/lib/src/bridge/memory.ts 原样迁入（S3 命令逻辑下沉，语义零改）：
 * memory.list/invalidate 两命令共享记忆条目宽松形态/召回判据/视图投影。
 */

/** 记忆条目宽松形态（引擎 MemoryEntry 存储记录字段子集；结构契约）。 */
export interface MemoryEntryLike {
  id: unknown;
  namespace: unknown;
  kind: unknown;
  title: unknown;
  content: unknown;
  source: unknown;
  weight: unknown;
  priority: unknown;
  expires_at: unknown;
  created_at: unknown;
  _deleted?: unknown;
}

export function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 召回排序键（与引擎 PriorityRecallPolicy 同判据：priority/created 降序）。 */
export function recallCompare(
  left: { priority: number; created_at: number },
  right: { priority: number; created_at: number },
): number {
  return right.priority - left.priority || right.created_at - left.created_at;
}

/** 记忆条目 → 视图（weight = credibility 口径沿用旧桥字段名）。 */
export function entryView(entry: MemoryEntryLike): {
  id: string;
  namespace: string;
  kind: string;
  title: string;
  content: string;
  source: string;
  credibility: number;
  expires_at: number | null;
  created_at: number;
} {
  return {
    id: typeof entry.id === 'string' ? entry.id : '',
    namespace: typeof entry.namespace === 'string' ? entry.namespace : '',
    kind: typeof entry.kind === 'string' ? entry.kind : '',
    title: typeof entry.title === 'string' ? entry.title : '',
    content: typeof entry.content === 'string' ? entry.content : '',
    source: typeof entry.source === 'string' ? entry.source : 'manual',
    credibility: num(entry.weight, 1),
    expires_at: typeof entry.expires_at === 'number' ? entry.expires_at : null,
    created_at: typeof entry.created_at === 'number' ? entry.created_at : 0,
  };
}
