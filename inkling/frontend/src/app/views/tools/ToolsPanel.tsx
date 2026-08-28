/**
 * agent 工具面板（W5.2）：工具注册表视图。
 *
 * 数据源：tools_snapshot 真实数据；执行反馈接 tool_pipeline 事件（归波 1 工具卡）。
 * ⚠️防接错：仅接 tools_snapshot，不接 collect_specs（混8）。
 *
 * 功能：四层标签筛选（声明式/自指/内省/动态）+ research 域 6 工具
 * 独立分组展示 + auto_approvable 标记 + 搜索；详情=行为手册
 * （description 原文/参数 schema/权限档/端点——机器术语豁免层）。
 * 工具 tier 标签（main/router/audit）。
 * 48 工具不摊饼（分组 + 搜索）。
 */

import { useState, useMemo, useEffect } from 'react';
import { Wrench, Search, BookOpen, Shield } from 'lucide-react';

import type { AppBackend } from '../../backend';
import type { ToolDetail, ToolLayer } from '../../types';
import { TOOL_LAYER_LABELS, RESEARCH_TOOLS } from '../../types';
import { resolveToolLabel, permissionLabel } from '@/shared/labels/toolLabels';
import { classifyToolFamily, FAMILY_LABELS } from '@/shared/labels/toolLabels';

/** 工具层分类判定（与 seed_data/tools.json meta.domain 同源）。 */
function classifyToolLayer(tool: ToolDetail): ToolLayer {
  const family = classifyToolFamily(tool.name);
  if (tool.meta?.domain === 'self' || family === 'self') return 'self_referential';
  if (tool.meta?.domain === 'os' || /inspect_/.test(tool.name)) return 'introspective';
  if (tool.meta?.domain === 'research' || family === 'research') return 'declarative';
  if (tool.meta?.sensor !== undefined || tool.meta?.control !== undefined) return 'introspective';
  return family === 'mcp' ? 'introspective' : 'dynamic';
}

function ToolTierBadge({ tier }: { tier?: string }) {
  if (!tier) return null;
  const label = tier === 'main' ? 'main' : tier === 'router' ? 'router' : tier;
  return (
    <span className="ink-chip py-px text-[8px] font-mono ink-text-faint" data-tier={tier}>
      {label}
    </span>
  );
}

function AutoApprovableBadge({ autoApprovable }: { autoApprovable?: boolean }) {
  if (!autoApprovable) return null;
  return (
    <span className="ink-chip py-px text-[8px] ink-text-faint" data-auto-approvable>
      自动审批
    </span>
  );
}

interface ToolDetailDrawerProps {
  tool: ToolDetail;
  onClose: () => void;
}

function ToolDetailDrawer({ tool, onClose }: ToolDetailDrawerProps) {
  const props = (tool.parameters as Record<string, unknown> | undefined) ?? {};
  const paramKeys = Object.keys(props);

  return (
    <div className="fixed inset-0 z-[var(--ink-z-floater)] flex items-center justify-center bg-black/40" data-ui="tool_detail_overlay">
      <div className="w-[640px] max-w-[calc(100vw-32px)] rounded-lg border bg-[var(--ink-bg-surface)] p-4 shadow-[var(--ink-shadow-pop)]">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[13px] font-medium font-mono">{tool.name}</h3>
          <button
            type="button"
            data-ui="tool_detail_close"
            onClick={onClose}
            className="text-[10px] ink-text-faint hover:text-[var(--ink-text-base)] cursor-pointer"
          >
            关闭
          </button>
        </div>
        <div className="space-y-3 text-[11px]">
          <div>
            <span className="block text-[10px] ink-text-muted">行为手册（description 原文）</span>
            <div className="mt-1 text-[9px] leading-relaxed whitespace-pre-wrap ink-text-muted">
              {tool.description || '（无描述）'}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="flex items-center gap-1 font-mono text-[9px]">
              <Shield size={10} strokeWidth={1.5} className="ink-text-faint" aria-hidden />
              权限档：{permissionLabel(tool.approval ?? 'allow')}
            </span>
            <span className="flex items-center gap-1 font-mono text-[9px]">
              端点：{tool.endpoint ?? '—'}
            </span>
            {tool.meta?.tier ? <ToolTierBadge tier={tool.meta.tier} /> : null}
            {tool.meta?.auto_approvable ? <AutoApprovableBadge autoApprovable={tool.meta.auto_approvable} /> : null}
          </div>
          {paramKeys.length > 0 ? (
            <div>
              <span className="block text-[10px] ink-text-muted mb-1">参数 schema</span>
              <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden rounded">
                {paramKeys.map((key) => {
                  const def = props[key] as Record<string, unknown> | undefined;
                  const required = Array.isArray(def?.required) && def.required.includes(key);
                  return (
                    <div key={key} className="px-2.5 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[9px]">{key}</span>
                        {required ? <span className="ink-chip py-px text-[7px] ink-text-faint">必填</span> : null}
                        <span className="text-[9px] ink-text-faint">{(def?.type as string) ?? 'unknown'}</span>
                      </div>
                      {typeof def?.description === 'string' && def.description ? (
                        <span className="block mt-0.5 text-[8px] leading-relaxed ink-text-faint">{def.description}</span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface ToolsPanelProps {
  backend: AppBackend;
  tools?: ToolDetail[];
}

export function ToolsPanel({ backend, tools: externalTools }: ToolsPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedLayer, setSelectedLayer] = useState<ToolLayer | 'all'>('all');
  const [detailToolName, setDetailToolName] = useState<string | null>(null);

  const [snapshot, setSnapshot] = useState<ToolDetail[] | null>(externalTools ?? null);
  const [loading, setLoading] = useState(!externalTools);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (externalTools) return;
    let cancelled = false;
    try {
      const data = backend.getToolDetails();
      if (!cancelled) {
        setSnapshot(data);
        setLoading(false);
      }
    } catch (err: unknown) {
      if (!cancelled) {
        setError(String(err));
        setLoading(false);
      }
    }
    return () => {
      cancelled = true;
    };
  }, [backend, externalTools]);

  const items = snapshot ?? [];

  const { researchTools, otherGroups } = useMemo(() => {
    let filtered = items;
    if (selectedLayer !== 'all') {
      filtered = filtered.filter((tool) => classifyToolLayer(tool) === selectedLayer);
    }
    if (searchQuery.trim() !== '') {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (tool) => tool.name.toLowerCase().includes(q) || resolveToolLabel({ tool: tool.name }).toLowerCase().includes(q),
      );
    }

    const research = filtered.filter((t) => RESEARCH_TOOLS.includes(t.name as (typeof RESEARCH_TOOLS)[number]));
    const others = filtered.filter((t) => !RESEARCH_TOOLS.includes(t.name as (typeof RESEARCH_TOOLS)[number]));

    const groups = new Map<string, ToolDetail[]>();
    for (const tool of others) {
      const family = classifyToolFamily(tool.name);
      const label = FAMILY_LABELS[family] ?? family;
      const bucket = groups.get(label);
      if (bucket) bucket.push(tool);
      else groups.set(label, [tool]);
    }
    return { researchTools: research, otherGroups: Array.from(groups.entries()) };
  }, [items, selectedLayer, searchQuery]);

  const layerOptions: Array<{ value: ToolLayer | 'all'; label: string }> = [
    { value: 'all', label: '全部' },
    { value: 'declarative', label: TOOL_LAYER_LABELS.declarative },
    { value: 'self_referential', label: TOOL_LAYER_LABELS.self_referential },
    { value: 'introspective', label: TOOL_LAYER_LABELS.introspective },
    { value: 'dynamic', label: TOOL_LAYER_LABELS.dynamic },
  ];

  return (
    <section className="ink-panel p-4" data-ui="tools_panel">
      <div className="mb-3 flex items-center gap-2.5">
        <Wrench size={14} strokeWidth={1.5} className="ink-text-faint" aria-hidden />
        <span className="text-[12px] font-semibold tracking-tight">工具注册表</span>
        <span className="ml-auto text-[10px] ink-text-faint">{items.length} 个工具</span>
      </div>

      <div className="mb-3 flex gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            placeholder="搜索工具（名称/中文标签）"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="ink-input w-full pl-7 text-[11px]"
            data-ui="tools_search"
          />
          <Search size={12} strokeWidth={1.5} className="absolute left-2 top-1/2 -translate-y-1/2 ink-text-faint" aria-hidden />
        </div>
        <select
          value={selectedLayer}
          onChange={(e) => setSelectedLayer(e.target.value as ToolLayer | 'all')}
          className="ink-input text-[11px]"
          data-ui="tools_layer_filter"
        >
          {layerOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="py-6 text-center text-[11px] ink-text-faint">加载工具快照中…</div>
      ) : error ? (
        <div className="py-4 text-center text-[11px] ink-accent">工具快照加载失败：{error}</div>
      ) : items.length === 0 ? (
        <div className="py-6 text-center text-[11px] ink-text-faint">暂无工具</div>
      ) : (
        <div className="space-y-4">
          {researchTools.length > 0 ? (
            <section data-ui="tools_group_research">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="ink-chip py-px text-[9px]">研究链</span>
                <span className="text-[10px] ink-text-faint">{researchTools.length} 个工具</span>
              </div>
              <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden rounded">
                {researchTools.map((tool) => (
                  <ToolRow key={tool.name} tool={tool} onOpenDetail={setDetailToolName} />
                ))}
              </div>
            </section>
          ) : null}

          {otherGroups.map(([label, groupTools]) => (
            <section key={label} data-ui={`tools_group_${label}`}>
              <div className="mb-1.5 flex items-center gap-2">
                <span className="ink-chip py-px text-[9px]">{label}</span>
                <span className="text-[10px] ink-text-faint">{groupTools.length} 个工具</span>
              </div>
              <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden rounded">
                {groupTools.map((tool) => (
                  <ToolRow key={tool.name} tool={tool} onOpenDetail={setDetailToolName} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {detailToolName ? (
        <ToolDetailDrawer
          tool={items.find((t) => t.name === detailToolName)!}
          onClose={() => setDetailToolName(null)}
        />
      ) : null}
    </section>
  );
}

interface ToolRowProps {
  tool: ToolDetail;
  onOpenDetail: (name: string) => void;
}

function ToolRow({ tool, onOpenDetail }: ToolRowProps) {
  const label = resolveToolLabel({ tool: tool.name });
  const layer = classifyToolLayer(tool);
  const tier = tool.meta?.tier;
  const autoApprovable = tool.meta?.auto_approvable;

  return (
    <div className="px-3 py-2" data-tool={tool.name}>
      <div className="flex items-center gap-2">
        <span className="ink-icon-chip h-5 w-5 flex-shrink-0">
          <Wrench size={10} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 font-mono text-[11px] font-medium truncate">{tool.name}</span>
        <span className="shrink-0 text-[9px] ink-text-muted">{label}</span>
        <span className="shrink-0 ink-chip py-px text-[8px] ink-text-faint font-mono">{TOOL_LAYER_LABELS[layer]}</span>
        {tier ? <ToolTierBadge tier={tier} /> : null}
        {autoApprovable ? <AutoApprovableBadge autoApprovable={autoApprovable} /> : null}
        <span className="shrink-0 ink-chip py-px text-[8px] ink-text-faint">{permissionLabel(tool.approval ?? 'allow')}</span>
        <button
          type="button"
          data-ui={`tool_detail_open_${tool.name}`}
          onClick={() => onOpenDetail(tool.name)}
          className="shrink-0 rounded-md p-1 text-[9px] ink-text-muted hover:text-[var(--ink-text-base)] cursor-pointer"
          title="查看行为手册"
        >
          <BookOpen size={9} strokeWidth={1.6} aria-hidden />
        </button>
      </div>
    </div>
  );
}
