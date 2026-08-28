import { useEffect, useRef, useState } from 'react';
import { Brain, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { createMemoryOps, type MemoryData, type MemoryEntry, type MemoryOps, sourceLabel, kindLabel } from './backend';

export function MemoryView() {
  const opsRef = useRef<MemoryOps>(createMemoryOps());
  const [data, setData] = useState<MemoryData | null>(null);
  const [selectedNs, setSelectedNs] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');

  const load = async () => {
    const result = await opsRef.current.list();
    setData(result);
    if (result.namespaces.length > 0 && selectedNs === null) {
      setSelectedNs(result.namespaces[0].name);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const entries = data?.entries?.filter((e) => e.namespace === selectedNs) ?? [];

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleInvalidate = async (id: string) => {
    await opsRef.current.invalidate(id);
    await load();
  };

  const handleSaveContent = async (id: string) => {
    await opsRef.current.updateFrontmatter(id, { content: editContent });
    setEditing(null);
    await load();
  };

  return (
    <div data-ui="memory_view" className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Brain size={14} strokeWidth={1.6} className="text-[var(--ink-text-muted)]" />
        <h3 className="text-[13px] font-medium text-[var(--ink-text-base)]">记忆</h3>
      </div>

      {!data || data.entries.length === 0 ? (
        <div className="rounded border border-dashed border-[var(--ink-border)] px-3 py-8 text-center text-[12px] text-[var(--ink-text-faint)]">
          尚无记忆，使用后会逐渐积累
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1">
            {data.namespaces.map((ns) => (
              <button
                key={ns.name}
                type="button"
                data-ui={`memory_ns_${ns.name}`}
                onClick={() => setSelectedNs(ns.name)}
                className={`rounded border px-2 py-1 text-[10px] cursor-pointer ${
                  selectedNs === ns.name
                    ? 'border-[var(--ink-border-strong)] text-[var(--ink-text-base)]'
                    : 'border-[var(--ink-border)] text-[var(--ink-text-muted)]'
                }`}
              >
                {ns.name} ({ns.count})
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            {entries.map((entry) => (
              <MemoryRow
                key={entry.id}
                entry={entry}
                expanded={expanded.has(entry.id)}
                editing={editing === entry.id}
                editContent={editContent}
                onToggle={() => toggleExpand(entry.id)}
                onEdit={() => {
                  setEditing(entry.id);
                  setEditContent(entry.content);
                }}
                onSave={() => handleSaveContent(entry.id)}
                onCancel={() => setEditing(null)}
                onInvalidate={() => handleInvalidate(entry.id)}
                onEditContentChange={setEditContent}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface MemoryRowProps {
  entry: MemoryEntry;
  expanded: boolean;
  editing: boolean;
  editContent: string;
  onToggle: () => void;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onInvalidate: () => void;
  onEditContentChange: (v: string) => void;
}

function MemoryRow({ entry, expanded, editing, editContent, onToggle, onEdit, onSave, onCancel, onInvalidate, onEditContentChange }: MemoryRowProps) {
  return (
    <div
      data-ui={`memory_entry_${entry.id}`}
      data-invalid={entry.invalid}
      className="flex flex-col gap-1 rounded border border-[var(--ink-border)] p-2"
    >
      <div className="flex items-center gap-2">
        <button type="button" onClick={onToggle} className="cursor-pointer">
          {expanded ? <ChevronDown size={12} strokeWidth={1.6} /> : <ChevronRight size={12} strokeWidth={1.6} />}
        </button>
        <span className="truncate text-[11px] font-medium text-[var(--ink-text-base)]">{entry.title}</span>
        <span className="rounded border border-[var(--ink-border)] px-1 py-0.5 text-[9px] text-[var(--ink-text-faint)]">
          {kindLabel(entry.kind)}
        </span>
        {entry.invalid && (
          <span className="rounded border border-[var(--ink-border)] px-1 py-0.5 text-[9px] text-[var(--ink-text-faint)]">
            已失效
          </span>
        )}
        <span className="ml-auto text-[9px] text-[var(--ink-text-faint)]">
          {sourceLabel(entry.source)}
        </span>
      </div>

      {expanded && (
        <div className="flex flex-col gap-1 pl-5">
          {editing ? (
            <>
              <textarea
                value={editContent}
                onChange={(e) => onEditContentChange(e.target.value)}
                className="w-full rounded border border-[var(--ink-border)] p-2 text-[11px] text-[var(--ink-text-base)] bg-[var(--ink-bg-base)]"
                rows={4}
              />
              <div className="flex gap-1">
                <Button size="xs" variant="primary" onClick={onSave}>保存</Button>
                <Button size="xs" variant="ghost" onClick={onCancel}>取消</Button>
              </div>
            </>
          ) : (
            <>
              <div className="text-[11px] text-[var(--ink-text-muted)] whitespace-pre-wrap">{entry.content}</div>
              <div className="flex gap-1">
                <Button size="xs" variant="ghost" onClick={onEdit}>编辑</Button>
                {!entry.invalid && (
                  <Button size="xs" variant="ghost" onClick={onInvalidate}>
                    <Trash2 size={10} strokeWidth={1.6} />
                    标失效
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
