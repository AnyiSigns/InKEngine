import { createBackend } from '@/shared/backend/backendAdapter';

export type KnowledgeCredibility = 'high' | 'medium' | 'low';

export interface KnowledgeEntry {
  id: string;
  level: string;
  kind: string;
  title: string;
  content: string;
  source: string;
  credibility: number;
  tags: string[];
  archived: boolean;
  usage_failures: Array<{ at: number | null; reason: string }>;
  created_at: number;
  updated_at: number;
}

export interface KnowledgeData {
  entries: KnowledgeEntry[];
}

/** 知识集只读面（写操作不提供；面板无写按钮）。 */
export interface KnowledgeOps {
  list(includeArchived?: boolean): Promise<KnowledgeData>;
  /** 知识 JSON 导出串（无 kind = 全量补丁链可移植）。 */
  exportJson(kind?: string): Promise<string | null>;
}

export function createKnowledgeOps(): KnowledgeOps {
  const backend = createBackend();
  return {
    list: async (includeArchived = false) => {
      if (!backend.available) return { entries: [] };
      const result = await backend.knowledgeList(includeArchived);
      return { entries: (Array.isArray(result.entries) ? result.entries : []) as KnowledgeEntry[] };
    },
    exportJson: async (kind) => {
      if (!backend.available) return null;
      try {
        return await backend.knowledgeExport(kind);
      } catch {
        return null;
      }
    },
  };
}

export function credibilityLevel(credibility: number): KnowledgeCredibility {
  if (credibility >= 0.8) return 'high';
  if (credibility >= 0.5) return 'medium';
  return 'low';
}

export function credibilityLabel(level: KnowledgeCredibility): string {
  switch (level) {
    case 'high': return '高';
    case 'medium': return '中';
    case 'low': return '低';
  }
}

export function credibilityClass(level: KnowledgeCredibility): string {
  switch (level) {
    case 'high': return 'text-[var(--ink-text-base)]';
    case 'medium': return 'ink-text-muted';
    case 'low': return 'text-[var(--ink-text-faint)]';
  }
}

export function compareCredibility(a: KnowledgeEntry, b: KnowledgeEntry): number {
  return b.credibility - a.credibility;
}
