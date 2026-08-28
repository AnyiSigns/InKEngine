/**
 * MCP 市场浏览视图（W5.1）：从种子 mcp_market.json 驱动真实 5 条 server。
 *
 * 展示形态：列表（类别/风险徽标/transport 图标）+ 条目详情抽屉
 * （transport/url/command/args/credentials/risk_note）。
 * 挂载向导步骤条：选 server → 风险知情确认 → 观察期徽标 → L2 审批 → 落链生效 → 回退入口。
 * 风险色：高=朱砂/中=警示/低=灰。空态「暂无可用服务」。
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Globe, Terminal, AlertTriangle, CheckCircle, XCircle, Copy } from 'lucide-react';

import type { AppBackend } from '../../backend';
import type { McpMarketEntry } from '../../types';
import { RISK_LABELS } from '../../types';

const TRANSPORT_ICONS: Record<string, ReactNode> = {
  http: <Globe size={14} strokeWidth={1.5} className="ink-text-faint" aria-hidden />,
  stdio: <Terminal size={14} strokeWidth={1.5} className="ink-text-faint" aria-hidden />,
};

const TRANSPORT_LABELS: Record<string, string> = {
  http: 'HTTP',
  stdio: 'stdio',
};

const RISK_TONES: Record<string, string> = {
  low: 'ink-text-muted',
  medium: 'ink-text-faint',
  high: 'ink-accent',
};

function RiskBadge({ risk }: { risk: string }) {
  const Icon = risk === 'high' ? XCircle : risk === 'medium' ? AlertTriangle : CheckCircle;
  return (
    <span className={`ink-chip flex items-center gap-0.5 font-mono text-[9px] ${RISK_TONES[risk] ?? 'ink-text-faint'}`} data-risk={risk}>
      <Icon size={9} strokeWidth={1.6} aria-hidden />
      {RISK_LABELS[risk] ?? risk}
    </span>
  );
}

interface McpServerDetailProps {
  entry: McpMarketEntry;
  onClose: () => void;
  onMount: (entry: McpMarketEntry) => void;
}

function McpServerDetail({ entry, onClose, onMount }: McpServerDetailProps) {
  const handleCopyConfig = (): void => {
    const config = JSON.stringify({ transport: entry.transport, url: entry.url, command: entry.command, args: entry.args }, null, 2);
    void navigator.clipboard.writeText(config);
  };

  return (
    <div className="fixed inset-0 z-[var(--ink-z-floater)] flex items-center justify-center bg-black/40" data-ui="mcp_detail_overlay">
      <div className="w-96 max-w-full rounded-lg border bg-[var(--ink-bg-surface)] p-4 shadow-[var(--ink-shadow-pop)]">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[13px] font-medium">{entry.name}</h3>
          <button
            type="button"
            data-ui="mcp_detail_close"
            onClick={onClose}
            className="text-[10px] ink-text-faint hover:text-[var(--ink-text-base)] cursor-pointer"
          >
            关闭
          </button>
        </div>
        <div className="space-y-2 text-[11px]">
          <div className="flex items-center gap-2">
            <span className="w-20 text-[10px] ink-text-muted">类别</span>
            <span className="ink-chip py-px text-[9px]">{entry.category}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-20 text-[10px] ink-text-muted">传输</span>
            <span className="flex items-center gap-1 font-mono text-[9px]">
              {TRANSPORT_ICONS[entry.transport] ?? <Terminal size={12} strokeWidth={1.5} />}
              {TRANSPORT_LABELS[entry.transport] ?? entry.transport}
            </span>
          </div>
          {entry.url ? (
            <div className="flex items-start gap-2">
              <span className="w-20 shrink-0 text-[10px] ink-text-muted">URL</span>
              <span className="font-mono text-[9px] break-all">{entry.url}</span>
            </div>
          ) : null}
          {entry.command ? (
            <div className="flex items-start gap-2">
              <span className="w-20 shrink-0 text-[10px] ink-text-muted">命令</span>
              <span className="font-mono text-[9px] break-all">{entry.command}</span>
            </div>
          ) : null}
          {entry.args.length > 0 ? (
            <div className="flex items-start gap-2">
              <span className="w-20 shrink-0 text-[10px] ink-text-muted">参数</span>
              <span className="font-mono text-[9px] break-all">{entry.args.join(' ')}</span>
            </div>
          ) : null}
          <div className="flex items-start gap-2">
            <span className="w-20 shrink-0 text-[10px] ink-text-muted">凭据</span>
            <span className="text-[9px]">
              {entry.credentials.required ? '需要凭据' : '无需凭据'} · {entry.credentials.note}
            </span>
          </div>
          <div className="flex items-start gap-2">
            <span className="w-20 shrink-0 text-[10px] ink-text-muted">风险</span>
            <span className="text-[9px] leading-relaxed break-words">{entry.risk_note}</span>
          </div>
        </div>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            data-ui={`mcp_mount_${entry.id}`}
            onClick={() => onMount(entry)}
            className="flex-1 rounded-md bg-[var(--ink-accent)] px-3 py-1.5 text-[10px] font-medium text-[var(--ink-text-base)] hover:opacity-90 cursor-pointer"
          >
            挂载
          </button>
          <button
            type="button"
            data-ui={`mcp_copy_config_${entry.id}`}
            onClick={handleCopyConfig}
            className="flex items-center gap-1 rounded-md border border-[var(--ink-border)] px-3 py-1.5 text-[10px] ink-text-muted hover:text-[var(--ink-text-base)] cursor-pointer bg-transparent"
          >
            <Copy size={10} strokeWidth={1.5} aria-hidden />
            复制配置
          </button>
        </div>
      </div>
    </div>
  );
}

interface McpMarketProps {
  backend: AppBackend;
  servers?: McpMarketEntry[];
  onMount?: (entry: McpMarketEntry) => void;
}

export function McpMarket({ backend, servers: externalServers, onMount }: McpMarketProps) {
  const seedServers = backend.getMcpMarket();
  const list: McpMarketEntry[] = externalServers ?? seedServers;

  const [detailEntry, setDetailEntry] = useState<McpMarketEntry | null>(null);

  const handleMount = (entry: McpMarketEntry): void => {
    onMount?.(entry);
  };

  return (
    <section className="ink-panel p-4" data-ui="mcp_market">
      <div className="flex items-center gap-2.5">
        <Terminal size={14} strokeWidth={1.5} className="ink-text-faint" aria-hidden />
        <span className="text-[12px] font-semibold tracking-tight">MCP 市场</span>
        <span className="ml-auto text-[10px] ink-text-faint">
          {list.length} 个服务（出厂零预挂）
        </span>
      </div>

      {list.length === 0 ? (
        <div className="mt-3 rounded-xl border border-dashed px-3 py-6 text-center text-[11px] ink-border ink-text-faint">
          <Terminal size={24} strokeWidth={1.5} className="mx-auto mb-2 ink-text-faint" aria-hidden />
          <p>暂无可用服务</p>
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {list.map((entry) => (
            <li key={entry.id} className="flex items-start gap-3" data-mcp-server={entry.id}>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-[var(--ink-font-xs)] font-medium">{entry.name}</span>
                  <span className="ink-chip py-px text-[9px] ink-text-faint">{TRANSPORT_LABELS[entry.transport] ?? entry.transport}</span>
                  <RiskBadge risk={entry.risk} />
                  <span className="ink-chip text-[9px] ink-text-faint" data-category={entry.category}>
                    {entry.category}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-[10px] ink-text-faint">{entry.source}</span>
                <span className="mt-0.5 block text-[9px] leading-relaxed ink-text-faint">{entry.risk_note}</span>
              </span>
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  data-ui={`mcp_detail_${entry.id}`}
                  onClick={() => setDetailEntry(entry)}
                  className="rounded-md px-2 py-1 text-[10px] ink-text-muted hover:text-[var(--ink-text-base)] cursor-pointer border border-[var(--ink-border)] bg-transparent"
                >
                  详情
                </button>
                <button
                  type="button"
                  data-ui={`mcp_mount_${entry.id}`}
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
        <McpServerDetail
          entry={detailEntry}
          onClose={() => setDetailEntry(null)}
          onMount={handleMount}
        />
      ) : null}
    </section>
  );
}
