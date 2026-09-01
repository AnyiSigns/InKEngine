/**
 * MCP 市场浏览视图（W5.1 多市场形态）：从宿主 mcp_market_status 驱动
 * 用户添加的真实市场注册表（内置示例目录已移出），按市场分组展示服务；
 * 挂载/取消挂载经宿主命令（手动挂载，免审批卡）。
 *
 * 展示形态：市场分组列表（类别/风险徽标/transport 图标）+ 条目详情抽屉
 * （transport/url/command/args/credentials/risk_note）。已挂载服务标
 * 「已挂载」并提供「取消挂载」。
 */

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Globe, Terminal, AlertTriangle, CheckCircle, XCircle, Copy } from 'lucide-react';

import type { AppBackend } from '../../backend';
import type {
  McpMarketEntrySummary,
  McpMountOutcome,
  McpMountStatus,
} from '../../../shared/backend/backendAdapter';
import { RISK_LABELS } from '../../types';
import { logger } from '../../../shared/logger';

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
  entry: McpMarketEntrySummary;
  mounted: boolean;
  onClose: () => void;
  onMount: () => void;
  onUnmount: () => void;
}

function McpServerDetail({ entry, mounted, onClose, onMount, onUnmount }: McpServerDetailProps) {
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
            <span className="ink-chip py-px text-[9px]">{entry.category || '—'}</span>
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
          {mounted ? (
            <button
              type="button"
              data-ui={`mcp_unmount_${entry.id}`}
              onClick={onUnmount}
              className="flex-1 rounded-md border border-[var(--ink-border)] px-3 py-1.5 text-[10px] font-medium ink-text-muted hover:text-[var(--ink-text-base)] cursor-pointer bg-transparent"
            >
              取消挂载
            </button>
          ) : (
            <button
              type="button"
              data-ui={`mcp_mount_${entry.id}`}
              onClick={onMount}
              className="flex-1 rounded-md bg-[var(--ink-accent)] px-3 py-1.5 text-[10px] font-medium text-[var(--ink-text-base)] hover:opacity-90 cursor-pointer"
            >
              挂载
            </button>
          )}
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
  onMount?: (entry: McpMarketEntrySummary) => Promise<McpMountOutcome>;
  onUnmount?: (entry: McpMarketEntrySummary) => Promise<McpMountOutcome>;
}

export function McpMarket({ backend, onMount, onUnmount }: McpMarketProps) {
  const [status, setStatus] = useState<McpMountStatus | null>(null);
  const [detailEntry, setDetailEntry] = useState<McpMarketEntrySummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    const next = await backend.getMcpMarketStatus();
    setStatus(next);
  };

  useEffect(() => {
    void refresh();
  }, [backend]);

  const handleMount = async (entry: McpMarketEntrySummary): Promise<void> => {
    setBusyId(entry.id);
    setNotice(null);
    try {
      const outcome = await onMount?.(entry);
      if (outcome && outcome.ok === false) {
        setNotice(outcome.error ?? '挂载失败，请查看宿主日志');
        return;
      }
      await refresh();
    } catch (err) {
      logger.error('market', 'MCP 挂载失败', { serverId: entry.id, err: String(err) });
      setNotice('挂载失败，请稍后重试');
    } finally {
      setBusyId(null);
    }
  };

  const handleUnmount = async (entry: McpMarketEntrySummary): Promise<void> => {
    setBusyId(entry.id);
    setNotice(null);
    try {
      const outcome = await onUnmount?.(entry);
      if (outcome && outcome.ok === false) {
        setNotice(outcome.error ?? '取消挂载失败，请查看宿主日志');
        return;
      }
      await refresh();
    } catch (err) {
      logger.error('market', 'MCP 取消挂载失败', { serverId: entry.id, err: String(err) });
      setNotice('取消挂载失败，请稍后重试');
    } finally {
      setBusyId(null);
    }
  };

  const visibleMarkets = useMemo(
    () => (status?.markets ?? []).filter((m) => !m.builtin),
    [status],
  );
  const serverCount = visibleMarkets.reduce((n, m) => n + m.servers.length, 0);
  const mountedIds = new Set(Object.keys(status?.mounted ?? {}));

  return (
    <section className="ink-panel p-4" data-ui="mcp_market">
      <div className="flex items-center gap-2.5">
        <Terminal size={14} strokeWidth={1.5} className="ink-text-faint" aria-hidden />
        <span className="text-[12px] font-semibold tracking-tight">MCP 市场</span>
        <span className="ml-auto text-[10px] ink-text-faint">
          {status ? `${serverCount} 个服务（出厂零预挂）` : '加载中…'}
        </span>
      </div>

      {notice ? (
        <p className="mt-2 rounded-lg px-3 py-2 text-[11px] ink-feedback-fail" data-ui="mcp_market_notice">
          {notice}
        </p>
      ) : null}

      {!status || serverCount === 0 ? (
        <div className="mt-3 rounded-xl border border-dashed px-3 py-6 text-center text-[11px] ink-border ink-text-faint">
          <Terminal size={24} strokeWidth={1.5} className="mx-auto mb-2 ink-text-faint" aria-hidden />
          <p>暂无市场</p>
          <p className="mt-1 text-[10px] leading-relaxed">
            出厂零预挂：内置示例目录已移出，本页只展示用户添加的市场。
            可在设置 → 连接 添加市场链接（http(s)://… 或本地目录路径）后浏览挂载。
          </p>
        </div>
      ) : (
        visibleMarkets.map((market) => (
          <div key={market.id} className="mt-3" data-mcp-market={market.id}>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-[11px] font-medium">{market.name}</span>
              <span className="ink-chip py-px text-[9px] ink-text-faint">用户添加</span>
              <span className="ml-auto text-[10px] ink-text-faint">{market.servers.length} 个服务</span>
            </div>
            <ul className="space-y-2">
              {market.servers.map((entry) => {
                const mounted = mountedIds.has(entry.id);
                return (
                  <li key={entry.id} className="flex items-start gap-3" data-mcp-server={entry.id}>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-[var(--ink-font-xs)] font-medium">{entry.name}</span>
                        <span className="ink-chip py-px text-[9px] ink-text-faint">{TRANSPORT_LABELS[entry.transport] ?? entry.transport}</span>
                        <RiskBadge risk={entry.risk} />
                        <span className="ink-chip text-[9px] ink-text-faint" data-category={entry.category}>
                          {entry.category}
                        </span>
                        {mounted ? <span className="ink-chip py-px text-[9px] ink-feedback-ok" data-mounted="true">已挂载</span> : null}
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
                      {mounted ? (
                        <button
                          type="button"
                          data-ui={`mcp_unmount_${entry.id}`}
                          onClick={() => void handleUnmount(entry)}
                          disabled={busyId === entry.id}
                          className="rounded-md px-2 py-1 text-[10px] ink-text-muted hover:text-[var(--ink-text-base)] cursor-pointer border border-[var(--ink-border)] bg-transparent disabled:opacity-50"
                        >
                          {busyId === entry.id ? '卸载中…' : '取消挂载'}
                        </button>
                      ) : (
                        <button
                          type="button"
                          data-ui={`mcp_mount_${entry.id}`}
                          onClick={() => void handleMount(entry)}
                          disabled={busyId === entry.id}
                          className="rounded-md px-2 py-1 text-[10px] ink-text-muted hover:text-[var(--ink-text-base)] cursor-pointer border border-[var(--ink-border)] bg-transparent disabled:opacity-50"
                        >
                          {busyId === entry.id ? '挂载中…' : '挂载'}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}

      {detailEntry ? (
        <McpServerDetail
          entry={detailEntry}
          mounted={mountedIds.has(detailEntry.id)}
          onClose={() => setDetailEntry(null)}
          onMount={() => void handleMount(detailEntry)}
          onUnmount={() => void handleUnmount(detailEntry)}
        />
      ) : null}
    </section>
  );
}
