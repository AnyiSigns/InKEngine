/**
 * 知识集（合并视图）：生产闭环状态头 + 统一条目管理 + 外部技能导入。
 *
 * 单一容器（知识集）的不同读法：
 * - 状态头：成长状态（孵化中信号/闸门通过率/知识集规模 + kind 分布）——只读；
 * - 条目列表：统一 kind（rule/template/insight/weight/tool_rule/path/script），
 *   按 kind 筛选、按可信度排序，管理（晋升/归档/恢复/导出/重导入）；
 * - 添加知识：人工录入声明类条目（含 script）；
 * - 导入外部技能：SKILL.md 多形态源（url:/git:/npm:/file:/text:）→ 预览 → 过闸门落位。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, BookOpen, ChevronDown, ChevronRight, Download, Plus, RefreshCw, Search, Upload } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { TextInput } from '@/shared/ui/Field';
import { createTauriInvoker } from '@/shared/backend/tauriBridge';
import {
  compareCredibility,
  createKnowledgeOps,
  credibilityClass,
  credibilityLabel,
  credibilityLevel,
  type ImportedEntry,
  type KnowledgeData,
  type KnowledgeEntry,
  type KnowledgeOps,
} from './backend';

interface GrowthStatus {
  enabled?: boolean;
  incubating_signals?: number;
  knowledge_count?: number;
  gate_checked?: number;
  gate_passed?: number;
  gate_pass_rate?: number;
  landed?: number;
  last_flush_note?: string;
}

const KIND_LABELS: Record<string, string> = {
  rule: '规则',
  template: '模板',
  insight: '洞见',
  weight: '权重',
  tool_rule: '工具规则',
  path: '技能',
  script: '脚本',
};

const KIND_FILTERS = ['', 'rule', 'template', 'insight', 'path', 'script', 'weight', 'tool_rule'] as const;

export function KnowledgePanel(): JSX.Element {
  const opsRef = useRef<KnowledgeOps>(createKnowledgeOps());
  const [data, setData] = useState<KnowledgeData | null>(null);
  const [growth, setGrowth] = useState<GrowthStatus | null>(null);
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<string>('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newKind, setNewKind] = useState('rule');
  const [newLevel, setNewLevel] = useState('project');
  const [showArchived, setShowArchived] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importSource, setImportSource] = useState('');
  const [importPreview, setImportPreview] = useState<ImportedEntry[] | null>(null);
  const [importRejected, setImportRejected] = useState<Array<{ id: string; reason: string }>>([]);
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);

  const load = async () => {
    const result = await opsRef.current.list();
    setData(result);
  };

  const loadGrowth = async () => {
    const tauri = createTauriInvoker();
    if (!tauri) return;
    try {
      const result = (await tauri.invoke('growth_report', {})) as {
        growth?: GrowthStatus;
        knowledge_count?: number;
      };
      setGrowth({
        ...(result?.growth ?? {}),
        knowledge_count: result?.growth?.knowledge_count ?? result?.knowledge_count ?? 0,
      });
    } catch {
      // 宿主未就绪 = 空态说明（只读状态不阻断条目管理）
    }
  };

  useEffect(() => {
    void load();
    void loadGrowth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allEntries = data?.entries ?? [];
  const activeEntries = allEntries.filter((e) => (showArchived ? e.archived : !e.archived));
  const kindCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of activeEntries) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    return counts;
  }, [activeEntries]);

  const filtered = activeEntries
    .filter((e) => !kindFilter || e.kind === kindFilter)
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

  const handleReimport = async (id: string) => {
    const outcome = await opsRef.current.skillReimport(id);
    if (outcome?.ok) {
      await load();
    }
  };

  const handleImportPreview = async () => {
    if (!importSource.trim()) return;
    setImporting(true);
    setImportError('');
    const outcome = await opsRef.current.skillImport(importSource, true);
    setImporting(false);
    if (!outcome || outcome.ok === false) {
      setImportError(outcome?.error ?? '预览失败');
      setImportPreview(null);
      setImportRejected([]);
      return;
    }
    setImportPreview(outcome.added ?? []);
    setImportRejected(outcome.rejected ?? []);
  };

  const handleImport = async () => {
    if (!importSource.trim()) return;
    setImporting(true);
    setImportError('');
    const outcome = await opsRef.current.skillImport(importSource, false);
    setImporting(false);
    if (!outcome || outcome.ok === false) {
      setImportError(outcome?.error ?? '导入失败');
      return;
    }
    setImportPreview(null);
    setImportRejected([]);
    setImportSource('');
    setShowImport(false);
    await load();
    await loadGrowth();
  };

  const passRate = growth?.gate_pass_rate !== undefined ? Math.round(growth.gate_pass_rate * 100) : null;

  return (
    <div data-ui="knowledge_panel" className="flex flex-col gap-3">
      {/* ── 状态头：成长状态（生产端只读）── */}
      <div className="ink-elevated space-y-2 px-3.5 py-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] ink-text-faint">自学习管线（孵化闭环）</span>
          <span
            className="ink-chip"
            data-ui="growth_enabled"
            data-active={growth?.enabled ?? true}
          >
            {growth?.enabled === false ? '停用' : '默认开启'}
          </span>
        </div>
        <div className="grid grid-cols-4 gap-2">
          <div data-ui="growth_incubating">
            <div className="text-[9px] ink-text-faint">孵化中信号</div>
            <div className="text-[var(--ink-font-md)] font-semibold">{growth?.incubating_signals ?? 0}</div>
          </div>
          <div data-ui="growth_knowledge">
            <div className="text-[9px] ink-text-faint">知识集规模</div>
            <div className="text-[var(--ink-font-md)] font-semibold">{growth?.knowledge_count ?? 0}</div>
          </div>
          <div data-ui="growth_gate_rate">
            <div className="text-[9px] ink-text-faint">闸门通过率</div>
            <div className="text-[var(--ink-font-md)] font-semibold">
              {passRate !== null ? `${passRate}%` : '—'}
            </div>
          </div>
          <div>
            <div className="text-[9px] ink-text-faint">已落位</div>
            <div className="text-[var(--ink-font-md)] font-semibold">{growth?.landed ?? 0}</div>
          </div>
        </div>
        <p className="text-[9px] ink-text-faint" data-ui="growth_flush_note">
          {growth?.last_flush_note ?? '自学习管线就绪（回合收尾按需蒸馏）'}
        </p>
      </div>

      {/* ── 工具行 ── */}
      <div className="flex items-center gap-2">
        <BookOpen size={14} strokeWidth={1.6} className="text-[var(--ink-text-muted)]" aria-hidden />
        <h3 className="text-[13px] font-medium text-[var(--ink-text-base)]">知识集</h3>
        <div className="flex-1" />
        <Button size="xs" variant="secondary" onClick={() => setShowImport(!showImport)}>
          <Download size={10} strokeWidth={1.6} aria-hidden />
          导入外部技能
        </Button>
        <Button size="xs" variant="secondary" onClick={() => setShowAdd(!showAdd)}>
          <Plus size={10} strokeWidth={1.6} aria-hidden />
          添加知识
        </Button>
      </div>

      {/* ── 导入外部技能 ── */}
      {showImport && (
        <div className="flex flex-col gap-2 rounded border border-[var(--ink-border)] p-3">
          <div className="flex items-center gap-2">
            <TextInput
              value={importSource}
              onChange={(e) => setImportSource(e.target.value)}
              placeholder="url:https://…/SKILL.md / git:owner/repo / npm:pkg / file:路径 / text:内联内容"
              className="flex-1"
              aria-label="外部技能来源"
            />
            <Button size="xs" variant="secondary" onClick={() => void handleImportPreview()} disabled={importing}>
              预览
            </Button>
            <Button size="xs" variant="primary" onClick={() => void handleImport()} disabled={importing}>
              {importing ? '处理中…' : '导入'}
            </Button>
          </div>
          <p className="text-[9px] ink-text-faint">
            外部 SKILL.md 不直接挂载——拆解转换为统一条目（指令→模板、脚本→脚本），过闸门 + 来源分级后落知识集；provenance 留痕支持重导入同步。
          </p>
          {importError && (
            <p className="rounded border border-[var(--ink-border)] px-2 py-1.5 text-[10px] text-red-600" data-ui="import_error">
              {importError}
            </p>
          )}
          {importPreview && (
            <div className="flex flex-col gap-1 rounded border border-[var(--ink-border)] px-2 py-1.5">
              <div className="text-[10px] font-medium ink-text-muted">将导入 {importPreview.length} 条</div>
              {importPreview.map((e) => (
                <div key={e.id} className="flex items-center gap-2 text-[11px]">
                  <span className="ink-chip">{KIND_LABELS[e.kind] ?? e.kind}</span>
                  <span className="truncate">{e.title}</span>
                </div>
              ))}
              {importRejected.map((r) => (
                <div key={r.id} className="text-[10px] text-amber-600">
                  拒绝：{r.reason}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!data || allEntries.length === 0 ? (
        <div className="rounded border border-dashed border-[var(--ink-border)] px-3 py-8 text-center text-[12px] text-[var(--ink-text-faint)]">
          知识集为空
        </div>
      ) : (
        <>
          {/* ── kind 筛选 + 搜索 ── */}
          <div className="flex items-center gap-2">
            <div className="flex flex-wrap gap-1">
              {KIND_FILTERS.map((kind) => (
                <button
                  key={kind || 'all'}
                  type="button"
                  data-ui={`kind_filter_${kind || 'all'}`}
                  onClick={() => setKindFilter(kind)}
                  className={`rounded-md px-2 py-1 text-[10px] ${
                    kindFilter === kind
                      ? 'bg-[var(--ink-accent)] text-white'
                      : 'ink-text-muted hover:bg-[var(--ink-bg-elevated)]'
                  }`}
                >
                  {kind ? `${KIND_LABELS[kind] ?? kind} ${kindCounts[kind] ?? 0}` : `全部 ${activeEntries.length}`}
                </button>
              ))}
            </div>
            <div className="relative flex-1 min-w-32">
              <Search size={12} strokeWidth={1.6} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--ink-text-faint)]" aria-hidden />
              <TextInput
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索知识..."
                className="pl-6"
              />
            </div>
            <Button size="xs" variant="ghost" onClick={() => setShowArchived(!showArchived)}>
              <Archive size={10} strokeWidth={1.6} aria-hidden />
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
                <select
                  value={newKind}
                  onChange={(e) => setNewKind(e.target.value)}
                  className="rounded border border-[var(--ink-border)] px-2 py-1 text-[11px] bg-[var(--ink-bg-base)]"
                >
                  {Object.entries(KIND_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
                <select
                  value={newLevel}
                  onChange={(e) => setNewLevel(e.target.value)}
                  className="rounded border border-[var(--ink-border)] px-2 py-1 text-[11px] bg-[var(--ink-bg-base)]"
                >
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
                onReimport={() => handleReimport(entry.id)}
              />
            ))}
            {filtered.length === 0 && (
              <div className="rounded border border-dashed border-[var(--ink-border)] px-3 py-6 text-center text-[11px] text-[var(--ink-text-faint)]">
                无匹配条目
              </div>
            )}
          </div>
        </>
      )}

      <div className="flex items-center justify-between px-1">
        <p className="text-[9px] ink-text-faint">统一条目容器（补丁链版本化 · 回退可溯 · 外部导入 provenance 留痕）</p>
        <button
          type="button"
          onClick={() => { void load(); void loadGrowth(); }}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] ink-text-muted hover:bg-[var(--ink-bg-elevated)] cursor-pointer bg-transparent border-none"
          data-ui="knowledge_refresh"
        >
          <RefreshCw size={10} strokeWidth={1.6} aria-hidden /> 刷新
        </button>
      </div>
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
  onReimport: () => void;
}

function KnowledgeRow({ entry, expanded, onToggle, onArchive, onRestore, onPromote, onExport, onReimport }: KnowledgeRowProps): JSX.Element {
  const level = credibilityLevel(entry.credibility);

  return (
    <div
      data-ui={`knowledge_entry_${entry.id}`}
      data-archived={entry.archived}
      className="flex flex-col gap-1 rounded border border-[var(--ink-border)] p-2"
    >
      <div className="flex items-center gap-2">
        <button type="button" onClick={onToggle} className="cursor-pointer" aria-label="展开">
          {expanded ? <ChevronDown size={12} strokeWidth={1.6} aria-hidden /> : <ChevronRight size={12} strokeWidth={1.6} aria-hidden />}
        </button>
        <span className="ink-chip">{KIND_LABELS[entry.kind] ?? entry.kind}</span>
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
          <div className="flex flex-wrap gap-1 mt-1">
            <Button size="xs" variant="ghost" onClick={onPromote}>提升</Button>
            <Button size="xs" variant="ghost" onClick={onExport}>
              <Upload size={10} strokeWidth={1.6} aria-hidden />
              导出
            </Button>
            {entry.kind === 'template' && (
              <Button size="xs" variant="ghost" onClick={onReimport}>
                <Download size={10} strokeWidth={1.6} aria-hidden />
                同步
              </Button>
            )}
            {entry.archived ? (
              <Button size="xs" variant="ghost" onClick={onRestore}>恢复</Button>
            ) : (
              <Button size="xs" variant="ghost" onClick={onArchive}>
                <Archive size={10} strokeWidth={1.6} aria-hidden />
                归档
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
