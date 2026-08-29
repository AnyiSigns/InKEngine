import { invokeOp } from '../shared/invokeOp';

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
  archived_at: number | null;
  usage_failures: Array<{ at: number; reason: string }>;
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
  return {
    list: async () => {
      const result = await invokeOp<KnowledgeData>('knowledge.list', {});
      return result ?? { entries: [] };
    },
    add: async (input) => {
      await invokeOp('knowledge.add', input);
    },
    promote: async (id: string) => {
      await invokeOp('knowledge.promote', { id });
    },
    archive: async (id: string) => {
      await invokeOp('knowledge.archive', { id });
    },
    restore: async (id: string) => {
      await invokeOp('knowledge.restore', { id });
    },
    export: async (id: string) => {
      await invokeOp('knowledge.export', { id });
    },
    skillImport: async (source, preview = false) => {
      return await invokeOp<ImportOutcome>('knowledge.skill_import', { source, preview });
    },
    skillReimport: async (id: string) => {
      return await invokeOp<ImportOutcome>('knowledge.skill_reimport', { id });
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
    case 'high': return 'text-emerald-600';
    case 'medium': return 'text-amber-600';
    case 'low': return 'text-[var(--ink-text-faint)]';
  }
}

export function compareCredibility(a: KnowledgeEntry, b: KnowledgeEntry): number {
  return b.credibility - a.credibility;
}
