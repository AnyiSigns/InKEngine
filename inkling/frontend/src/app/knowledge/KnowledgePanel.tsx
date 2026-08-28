import { useEffect, useRef, useState } from 'react';
import { Archive, BookOpen, ChevronDown, ChevronRight, Plus, Search, Upload } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { TextInput } from '@/shared/ui/Field';
import { createKnowledgeOps, compareCredibility, credibilityClass, credibilityLabel, credibilityLevel, type KnowledgeData, type KnowledgeEntry, type KnowledgeOps } from './backend';

export function KnowledgePanel() {
  const opsRef = useRef<KnowledgeOps>(createKnowledgeOps());
  const [data, setData] = useState<KnowledgeData | null>(null);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newKind, setNewKind] = useState('rule');
  const [newLevel, setNewLevel] = useState('project');
  const [showArchived, setShowArchived] = useState(false);

  const load = async () => {
    const result = await opsRef.current.list();
    setData(result);
  };

  useEffect(() => {
    void load();
  }, []);

  const allEntries = data?.entries ?? [];
  const activeEntries = allEntries.filter((e) => showArchived ? e.archived : !e.archived);
  const filtered = activeEntries
    .filter((e) => e.title.includes(search) || e.tags.some((t) => t.includes(search)))
    .sort(compareCredibility);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleAdd = async () => {
    if (!newTitle.trim()) return;
    await opsRef.current.add({ title: newTitle, content: newContent, kind: newKind, level: newLevel });
    setNewTitle('');
    setNewContent('');
    setShowAdd(false);
    await load();
  };

  const handleArchive = async (id: string) => {
    await opsRef.current.archive(id);
    await load();
  };

  const handleRestore = async (id: string) => {
    await opsRef.current.restore(id);
    await load();
  };

  const handlePromote = async (id: string) => {
    await opsRef.current.promote(id);
    await load();
  };

  const handleExport = async (id: string) => {
    await opsRef.current.export(id);
  };

  return (
    <div data-ui="knowledge_panel" className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <BookOpen size={14} strokeWidth={1.6} className="text-[var(--ink-text-muted)]" />
        <h3 className="text-[13px] font-medium text-[var(--ink-text-base)]">知识库</h3>
        <Button size="xs" variant="secondary" onClick={() => setShowAdd(!showAdd)}>
          <Plus size={10} strokeWidth={1.6} />
          添加知识
        </Button>
      </div>

      {!data || allEntries.length === 0 ? (
        <div className="rounded border border-dashed border-[var(--ink-border)] px-3 py-8 text-center text-[12px] text-[var(--ink-text-faint)]">
          知识库为空
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search size={12} strokeWidth={1.6} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--ink-text-faint)]" />
              <TextInput
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索知识..."
                className="pl-6"
              />
            </div>
            <Button size="xs" variant="ghost" onClick={() => setShowArchived(!showArchived)}>
              <Archive size={10} strokeWidth={1.6} />
              {showArchived ? '隐藏归档' : '显示归档'}
            </Button>
          </div>

          {showAdd && (
            <div className="flex flex-col gap-2 rounded border border-[var(--ink-border)] p-3">
              <TextInput value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="标题" />
              <textarea
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                placeholder="内容"
                className="w-full rounded border border-[var(--ink-border)] p-2 text-[11px] text-[var(--ink-text-base)] bg-[var(--ink-bg-base)]"
                rows={3}
              />
              <div className="flex gap-2">
                <select value={newKind} onChange={(e) => setNewKind(e.target.value)} className="rounded border border-[var(--ink-border)] px-2 py-1 text-[11px] bg-[var(--ink-bg-base)]">
                  <option value="rule">规则</option>
                  <option value="template">模板</option>
                  <option value="tool_rule">工具规则</option>
                  <option value="weight">权重</option>
                </select>
                <select value={newLevel} onChange={(e) => setNewLevel(e.target.value)} className="rounded border border-[var(--ink-border)] px-2 py-1 text-[11px] bg-[var(--ink-bg-base)]">
                  <option value="work">工作</option>
                  <option value="project">项目</option>
                  <option value="user">用户</option>
                </select>
              </div>
              <div className="flex gap-1">
                <Button size="xs" variant="primary" onClick={() => void handleAdd()}>添加</Button>
                <Button size="xs" variant="ghost" onClick={() => setShowAdd(false)}>取消</Button>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            {filtered.map((entry) => (
              <KnowledgeRow
                key={entry.id}
                entry={entry}
                expanded={expanded.has(entry.id)}
                onToggle={() => toggleExpand(entry.id)}
                onArchive={() => handleArchive(entry.id)}
                onRestore={() => handleRestore(entry.id)}
                onPromote={() => handlePromote(entry.id)}
                onExport={() => handleExport(entry.id)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface KnowledgeRowProps {
  entry: KnowledgeEntry;
  expanded: boolean;
  onToggle: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onPromote: () => void;
  onExport: () => void;
}

function KnowledgeRow({ entry, expanded, onToggle, onArchive, onRestore, onPromote, onExport }: KnowledgeRowProps) {
  const level = credibilityLevel(entry.credibility);

  return (
    <div
      data-ui={`knowledge_entry_${entry.id}`}
      data-archived={entry.archived}
      className="flex flex-col gap-1 rounded border border-[var(--ink-border)] p-2"
    >
      <div className="flex items-center gap-2">
        <button type="button" onClick={onToggle} className="cursor-pointer">
          {expanded ? <ChevronDown size={12} strokeWidth={1.6} /> : <ChevronRight size={12} strokeWidth={1.6} />}
        </button>
        <span className="truncate text-[11px] font-medium text-[var(--ink-text-base)]">{entry.title}</span>
        <span className={`text-[9px] ${credibilityClass(level)}`}>
          {credibilityLabel(level)} ({entry.credibility.toFixed(2)})
        </span>
        {entry.archived && (
          <span className="rounded border border-[var(--ink-border)] px-1 py-0.5 text-[9px] text-[var(--ink-text-faint)]">
            已归档
          </span>
        )}
      </div>

      {expanded && (
        <div className="flex flex-col gap-1 pl-5">
          <div className="text-[11px] text-[var(--ink-text-muted)] whitespace-pre-wrap">{entry.content}</div>
          <div className="flex flex-wrap gap-1">
            {entry.tags.map((tag) => (
              <span key={tag} className="rounded border border-[var(--ink-border)] px-1 py-0.5 text-[9px] text-[var(--ink-text-faint)]">
                {tag}
              </span>
            ))}
          </div>
          {entry.usage_failures.length > 0 && (
            <div className="mt-1 flex flex-col gap-0.5">
              <div className="text-[10px] font-medium text-[var(--ink-text-muted)]">失败记录</div>
              {entry.usage_failures.map((f, i) => (
                <div key={i} className="text-[10px] text-[var(--ink-text-faint)]">
                  {new Date(f.at * 1000).toLocaleString()} · {f.reason}
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-1 mt-1">
            <Button size="xs" variant="ghost" onClick={onPromote}>提升</Button>
            <Button size="xs" variant="ghost" onClick={onExport}>
              <Upload size={10} strokeWidth={1.6} />
              导出
            </Button>
            {entry.archived ? (
              <Button size="xs" variant="ghost" onClick={onRestore}>恢复</Button>
            ) : (
              <Button size="xs" variant="ghost" onClick={onArchive}>
                <Archive size={10} strokeWidth={1.6} />
                归档
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
