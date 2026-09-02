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
}

export interface KnowledgeData {
  entries: KnowledgeEntry[];
}

export interface KnowledgeOps {
  list(): Promise<KnowledgeData>;
  add(input: { title: string; content: string; kind: string; level: string }): Promise<void>;
  promote(id: string): Promise<void>;
  archive(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  export(id: string): Promise<void>;
  skillImport(source: string, preview?: boolean): Promise<ImportOutcome | null>;
  skillReimport(id: string): Promise<ImportOutcome | null>;
}

export interface ImportedEntry {
  id: string;
  kind: string;
  title: string;
}

export interface ImportOutcome {
  ok?: boolean;
  error?: string;
  source_type?: string;
  added?: ImportedEntry[];
  rejected?: Array<{ id: string; reason: string }>;
  changed?: boolean;
  note?: string;
}

export function createKnowledgeOps(): KnowledgeOps {
  const backend = createBackend();
  return {
    list: async () => {
      if (!backend.available) return { entries: [] };
      // 一次取全量（含归档）：面板"显示归档/隐藏归档"只做客户端过滤，
      // 归档条目由后端 includeArchived 透传（此前恒取活跃，归档不可达）
      const result = await backend.knowledgeList(true);
      return { entries: (Array.isArray(result.entries) ? result.entries : []) as KnowledgeEntry[] };
    },
    add: async (input) => {
      if (backend.available) await backend.knowledgeAdd(input);
    },
    promote: async (id: string) => {
      if (backend.available) await backend.knowledgePromote(id);
    },
    archive: async (id: string) => {
      if (backend.available) await backend.knowledgeArchive(id);
    },
    restore: async (id: string) => {
      if (backend.available) await backend.knowledgeRestore(id);
    },
    export: async (id: string) => {
      if (backend.available) await backend.knowledgeExport(id);
    },
    skillImport: async (source, preview = false) => {
      if (!backend.available) return null;
      return (await backend.skillImport(source, preview)) as ImportOutcome;
    },
    skillReimport: async (id: string) => {
      if (!backend.available) return null;
      return (await backend.skillReimport(id)) as ImportOutcome;
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
