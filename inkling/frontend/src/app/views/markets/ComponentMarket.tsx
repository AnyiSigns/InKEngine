/**
 * 组件市场浏览视图（W4.3）：从种子 components_market.json 驱动真实 3 条组件。
 *
 * 数据流：seed(出厂零预挂) → onMount → components_manifest（S1 产出）→
 * artifactLoader 动态注册 → AI 插件即插即显（挂载即生效可回退）。
 * 白名单拒绝：未注册组件 → 占位卡。ErrorBoundary 占位卡「组件渲染异常 · 回退」。
 * 空态「暂无可用组件」。
 */

import { useState } from 'react';
import { ShieldCheck, ShieldAlert, ShieldX, Copy } from 'lucide-react';

import type { AppBackend } from '../../backend';
import type { ComponentMarketEntry } from '../../types';
import { RISK_LABELS, MAINTENANCE_LABELS } from '../../types';

const RISK_TONES: Record<string, string> = {
  low: 'ink-text-muted',
  medium: 'ink-text-faint',
  high: 'ink-accent',
};

function RiskBadge({ risk }: { risk: string }) {
  const Icon = risk === 'high' ? ShieldX : risk === 'medium' ? ShieldAlert : ShieldCheck;
  return (
    <span className={`ink-chip flex items-center gap-0.5 font-mono text-[9px] ${RISK_TONES[risk] ?? 'ink-text-faint'}`} data-risk={risk}>
      <Icon size={9} strokeWidth={1.6} aria-hidden />
      {RISK_LABELS[risk] ?? risk}
    </span>
  );
}

function MaintenanceBadge({ maintenance }: { maintenance: string }) {
  const label = MAINTENANCE_LABELS[maintenance] ?? maintenance;
  return (
    <span className="ink-chip text-[9px] ink-text-faint" data-maintenance={maintenance}>
      {label}
    </span>
  );
}

interface ComponentDetailProps {
  entry: ComponentMarketEntry;
  onClose: () => void;
  onMount: (entry: ComponentMarketEntry) => void;
}

function ComponentDetail({ entry, onClose, onMount }: ComponentDetailProps) {
  const handleCopy = (): void => {
    void navigator.clipboard.writeText(entry.artifact_url);
  };

  return (
    <div className="fixed inset-0 z-[var(--ink-z-floater)] flex items-center justify-center bg-black/40" data-ui="component_detail_overlay">
      <div className="w-96 max-w-full rounded-lg border bg-[var(--ink-bg-surface)] p-4 shadow-[var(--ink-shadow-pop)]">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[13px] font-medium">{entry.name}</h3>
          <button
            type="button"
            data-ui="component_detail_close"
            onClick={onClose}
            className="text-[10px] ink-text-faint hover:text-[var(--ink-text-base)] cursor-pointer"
          >
            关闭
          </button>
        </div>
        <div className="space-y-2 text-[11px]">
          <div className="flex items-center gap-2">
            <span className="w-20 text-[10px] ink-text-muted">版本</span>
            <span className="font-mono text-[9px]">{entry.version}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-20 text-[10px] ink-text-muted">来源</span>
            <span className="text-[9px] break-words">{entry.source}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-20 text-[10px] ink-text-muted">风险</span>
            <RiskBadge risk={entry.risk} />
          </div>
          <div className="flex items-center gap-2">
            <span className="w-20 text-[10px] ink-text-muted">维护</span>
            <MaintenanceBadge maintenance={entry.maintenance} />
          </div>
          <div className="flex items-start gap-2">
            <span className="w-20 shrink-0 text-[10px] ink-text-muted">风险说明</span>
            <span className="text-[9px] leading-relaxed break-words">{entry.risk_note}</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="w-20 shrink-0 text-[10px] ink-text-muted">构件地址</span>
            <span className="font-mono text-[9px] break-all">{entry.artifact_url}</span>
          </div>
          {entry.test_manifest?.required?.length > 0 ? (
            <div className="flex items-start gap-2">
              <span className="w-20 shrink-0 text-[10px] ink-text-muted">门禁</span>
              <span className="text-[9px]">
                {entry.test_manifest.required.join('、')}
                <span className="block mt-0.5 leading-relaxed">{entry.test_manifest.note}</span>
              </span>
            </div>
          ) : null}
        </div>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            data-ui={`component_mount_${entry.id}`}
            onClick={() => onMount(entry)}
            className="flex-1 rounded-md bg-[var(--ink-accent)] px-3 py-1.5 text-[10px] font-medium text-[var(--ink-text-base)] hover:opacity-90 cursor-pointer"
          >
            挂载
          </button>
          <button
            type="button"
            data-ui={`component_copy_url_${entry.id}`}
            onClick={handleCopy}
            className="flex items-center gap-1 rounded-md border border-[var(--ink-border)] px-3 py-1.5 text-[10px] ink-text-muted hover:text-[var(--ink-text-base)] cursor-pointer bg-transparent"
          >
            <Copy size={10} strokeWidth={1.5} aria-hidden />
            复制
          </button>
        </div>
      </div>
    </div>
  );
}

interface ComponentMarketProps {
  backend: AppBackend;
  entries?: ComponentMarketEntry[];
  onMount?: (entry: ComponentMarketEntry) => void;
}

export function ComponentMarket({ backend, entries: externalEntries, onMount }: ComponentMarketProps) {
  const seedEntries = backend.getComponentMarket();
  const list: ComponentMarketEntry[] = externalEntries ?? seedEntries;

  const [detailEntry, setDetailEntry] = useState<ComponentMarketEntry | null>(null);

  const handleMount = (entry: ComponentMarketEntry): void => {
    onMount?.(entry);
  };

  return (
    <section className="ink-panel p-4" data-ui="component_market">
      <div className="flex items-center gap-2.5">
        <ShieldCheck size={14} strokeWidth={1.5} className="ink-text-faint" aria-hidden />
        <span className="text-[12px] font-semibold tracking-tight">组件市场</span>
        <span className="ml-auto text-[10px] ink-text-faint">
          {list.length} 个候选组件（出厂零预挂）
        </span>
      </div>

      {list.length === 0 ? (
        <div className="mt-3 rounded-xl border border-dashed px-3 py-6 text-center text-[11px] ink-border ink-text-faint">
          <ShieldCheck size={24} strokeWidth={1.5} className="mx-auto mb-2 ink-text-faint" aria-hidden />
          <p>暂无可用组件</p>
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {list.map((entry) => (
            <li key={entry.id} className="flex items-start gap-3" data-component={entry.id}>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-[var(--ink-font-xs)] font-medium">{entry.name}</span>
                  <span className="ink-chip font-mono text-[9px] ink-text-faint">{entry.version}</span>
                  <RiskBadge risk={entry.risk} />
                  <MaintenanceBadge maintenance={entry.maintenance} />
                </span>
                <span className="mt-0.5 block truncate text-[10px] ink-text-faint">{entry.source}</span>
                <span className="mt-0.5 block text-[9px] leading-relaxed ink-text-faint break-words">{entry.risk_note}</span>
                <span className="mt-0.5 block truncate font-mono text-[9px] ink-text-faint break-all">{entry.artifact_url}</span>
              </span>
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  data-ui={`component_detail_${entry.id}`}
                  onClick={() => setDetailEntry(entry)}
                  className="rounded-md px-2 py-1 text-[10px] ink-text-muted hover:text-[var(--ink-text-base)] cursor-pointer border border-[var(--ink-border)] bg-transparent"
                >
                  详情
                </button>
                <button
                  type="button"
                  data-ui={`component_mount_${entry.id}`}
                  onClick={() => handleMount(entry)}
                  className="rounded-md px-2 py-1 text-[10px] ink-text-muted hover:text-[var(--ink-text-base)] cursor-pointer border border-[var(--ink-border)] bg-transparent"
                >
                  挂载
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {detailEntry ? (
        <ComponentDetail
          entry={detailEntry}
          onClose={() => setDetailEntry(null)}
          onMount={handleMount}
        />
      ) : null}
    </section>
  );
}
