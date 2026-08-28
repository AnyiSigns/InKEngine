import { invokeOp } from '../shared/invokeOp';

export type MemorySource = 'round_liquid' | 'manual' | 'seed';

export interface MemoryEntry {
  id: string;
  namespace: string;
  kind: string;
  title: string;
  content: string;
  source: MemorySource;
  credibility: number;
  expires_at: number | null;
  invalid: boolean;
  created_at: number;
}

export interface MemoryNamespace {
  name: string;
  count: number;
}

export interface MemoryData {
  namespaces: MemoryNamespace[];
  entries: MemoryEntry[];
}

export interface MemoryOps {
  list(): Promise<MemoryData>;
  invalidate(id: string): Promise<void>;
  updateFrontmatter(id: string, frontmatter: Record<string, string>): Promise<void>;
}

export function createMemoryOps(): MemoryOps {
  return {
    list: async () => {
      const result = await invokeOp<MemoryData>('memory.list', {});
      return result ?? { namespaces: [], entries: [] };
    },
    invalidate: async (id: string) => {
      await invokeOp('memory.invalidate', { id });
    },
    updateFrontmatter: async (id: string, frontmatter: Record<string, string>) => {
      await invokeOp('memory.update_frontmatter', { id, frontmatter });
    },
  };
}

export function sourceLabel(source: MemorySource): string {
  switch (source) {
    case 'round_liquid': return 'round_liquid 提取';
    case 'manual': return '人工录入';
    case 'seed': return '种子数据';
    default: return source;
  }
}

export function kindLabel(kind: string): string {
  switch (kind) {
    case 'decision': return '决策';
    case 'domain_window': return '领域窗口';
    case 'self_reflection': return '自我反思';
    case 'user_preference': return '用户偏好';
    default: return kind;
  }
}
