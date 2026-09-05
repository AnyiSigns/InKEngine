import { createBackend } from '@/shared/backend/backendAdapter';

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
  const backend = createBackend();
  return {
    list: async () => {
      if (!backend.available) return { namespaces: [], entries: [] };
      const result = (await backend.memoryList()) as unknown as { namespaces?: unknown[]; entries?: unknown[] };
      return {
        namespaces: Array.isArray(result.namespaces) ? (result.namespaces as MemoryNamespace[]) : [],
        entries: Array.isArray(result.entries) ? (result.entries as MemoryEntry[]) : [],
      };
    },
    invalidate: async (id: string) => {
      if (backend.available) await backend.memoryInvalidate(id);
    },
    updateFrontmatter: async (id: string, frontmatter: Record<string, string>) => {
      if (backend.available) await backend.memoryUpdateFrontmatter(id, frontmatter);
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
