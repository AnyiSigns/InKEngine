/**
 * MCP 市场浏览视图：从宿主 mcp.market 驱动（seed 单源市场 + 每 server
 * mounted 连接态）；挂载前提供 config 表单（stdio = command/args 可编辑，
 * http = url 直挂），经 mcp.mount 连接 + 工具导入；卸载经 mcp.unmount。
 * preview/add/remove 无真源不提供（外部市场摄入入口已删除）。
 */

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle, Globe, Terminal, XCircle } from 'lucide-react';

import type { AppBackend } from '@app/backend';
import type { McpMarketServerView, McpMountOutcome } from '@/shared/backend/backendAdapter';
import { RISK_LABELS } from '@app/types';

const TRANSPORT_ICONS: Record<string, ReactNode> = {
  http: <Globe size={13} strokeWidth={1.5} className="ink-text-faint" aria-hidden />,
  stdio: <Terminal size={13} strokeWidth={1.5} className="ink-text-faint" aria-hidden />,
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

interface McpMarketProps {
  backend: AppBackend;
}

export function McpMarket({ backend }: McpMarketProps) {
  const [status, setStatus] = useState<{ servers: McpMarketServerView[] } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 挂载 config 表单（选中的 server + 用户 command 覆盖）
  const [mounting, setMounting] = useState<McpMarketServerView | null>(null);
  const [commandDraft, setCommandDraft] = useState('');
  const [argsDraft, setArgsDraft] = useState('');

  const refresh = async (): Promise<void> => {
    setStatus(await backend.getMcpMarket());
  };

  useEffect(() => {
    void refresh();
  }, [backend]);

  const mountedIds = useMemo(
    () => new Set((status?.servers ?? []).filter((s) => s.mounted).map((s) => s.id)),
    [status],
  );

  const beginMount = (entry: McpMarketServerView): void => {
    setMounting(entry);
    setCommandDraft(entry.command ?? '');
    setArgsDraft(entry.args.join(' '));
    setNotice(null);
  };

  const handleMount = async (): Promise<void> => {
    if (!mounting) return;
    setBusyId(mounting.id);
    setNotice(null);
    const args = argsDraft
      .split(/\s+/)
      .map((a) => a.trim())
      .filter(Boolean);
    const outcome: McpMountOutcome = await backend.mountMcp({
      id: mounting.id,
      transport: mounting.transport,
      command: commandDraft.trim() || null,
      url: mounting.url,
      args,
    });
    setBusyId(null);
    if (outcome.ok === false) {
      setNotice(outcome.error ?? '挂载失败，请查看宿主日志');
      return;
    }
    setMounting(null);
    await refresh();
  };

  const handleUnmount = async (entry: McpMarketServerView): Promise<void> => {
    setBusyId(entry.id);
    setNotice(null);
    const outcome = await backend.unmountMcp(entry.id);
    setBusyId(null);
    if (outcome.ok === false) {
      setNotice(outcome.error ?? '取消挂载失败，请查看宿主日志');
      return;
    }
    await refresh();
  };

  const servers = status?.servers ?? [];

  return (
    <section className="ink-panel p-4" data-ui="mcp_market">
      <div className="flex items-center gap-2.5">
        <Terminal size={14} strokeWidth={1.5} className="ink-text-faint" aria-hidden />
        <span className="text-[12px] font-semibold tracking-tight">MCP 市场</span>
        <span className="ml-auto text-[10px] ink-text-faint">
          {status ? `${servers.length} 个服务 · 已挂载 ${mountedIds.size} 个` : '加载中…'}
        </span>
      </div>

      {notice ? (
        <p className="mt-2 rounded-lg px-3 py-2 text-[11px] ink-feedback-fail" data-ui="mcp_market_notice">
          {notice}
        </p>
      ) : null}

      {!status || servers.length === 0 ? (
        <div className="mt-3 rounded-xl border border-dashed px-3 py-6 text-center text-[11px] ink-border ink-text-faint">
          <Terminal size={24} strokeWidth={1.5} className="mx-auto mb-2 ink-text-faint" aria-hidden />
          <p>暂无市场服务（seed 市场不可用或宿主未装配）</p>
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {servers.map((entry) => {
            const mounted = mountedIds.has(entry.id);
            return (
              <li key={entry.id} className="flex items-start gap-3 rounded-lg border ink-border px-3 py-2" data-mcp-server={entry.id}>
                <span className="mt-0.5 shrink-0">{TRANSPORT_ICONS[entry.transport] ?? <Terminal size={13} strokeWidth={1.5} />}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="truncate text-[12px] font-medium">{entry.name}</span>
                    <span className="ink-chip py-px text-[9px] ink-text-faint">{TRANSPORT_LABELS[entry.transport] ?? entry.transport}</span>
                    {entry.risk ? <RiskBadge risk={entry.risk} /> : null}
                    {entry.category ? (
                      <span className="ink-chip text-[9px] ink-text-faint" data-category={entry.category}>{entry.category}</span>
                    ) : null}
                    {mounted ? <span className="ink-chip py-px text-[9px] ink-feedback-ok" data-mounted="true">已挂载</span> : null}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-[9px] ink-text-faint">
                    {entry.command ? `${entry.command} ${entry.args.join(' ')}`.trim() : (entry.url ?? entry.source)}
                  </span>
                  <span className="mt-0.5 block text-[9px] leading-relaxed ink-text-faint">{entry.risk_note}</span>
                </span>
                <div className="flex shrink-0 gap-1">
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
                      onClick={() => beginMount(entry)}
                      disabled={busyId === entry.id}
                      className="rounded-md bg-[var(--ink-accent)] px-2 py-1 text-[10px] font-medium text-[var(--ink-text-base)] hover:opacity-90 cursor-pointer disabled:opacity-50"
                    >
                      {busyId === entry.id ? '挂载中…' : '挂载'}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {mounting ? (
        <div className="fixed inset-0 z-[var(--ink-z-floater)] flex items-center justify-center bg-black/40" data-ui="mcp_mount_form_overlay">
          <div className="w-96 max-w-full rounded-lg border bg-[var(--ink-bg-surface)] p-4 shadow-[var(--ink-shadow-pop)]">
            <h3 className="mb-3 text-[13px] font-medium">挂载 {mounting.name}</h3>
            <div className="space-y-2 text-[11px]">
              {mounting.transport === 'stdio' ? (
                <>
                  <label className="block">
                    <span className="text-[10px] ink-text-muted">command（启动命令）</span>
                    <input
                      value={commandDraft}
                      onChange={(e) => setCommandDraft(e.target.value)}
                      className="ink-input mt-1 w-full text-[11px] font-mono"
                      data-ui="mcp_mount_command"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[10px] ink-text-muted">args（空格分隔）</span>
                    <input
                      value={argsDraft}
                      onChange={(e) => setArgsDraft(e.target.value)}
                      className="ink-input mt-1 w-full text-[11px] font-mono"
                      data-ui="mcp_mount_args"
                    />
                  </label>
                </>
              ) : (
                <p className="text-[10px] leading-relaxed ink-text-faint">
                  将以 HTTP 端点连接：<span className="font-mono break-all">{mounting.url}</span>
                </p>
              )}
              <p className="text-[9px] leading-relaxed ink-text-faint">
                挂载 = 连接 + 工具导入（vetting 静态钩子核对后可用）；失败 fail-closed。
              </p>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                data-ui="mcp_mount_form_cancel"
                onClick={() => setMounting(null)}
                className="rounded-md border border-[var(--ink-border)] px-3 py-1.5 text-[10px] ink-text-muted cursor-pointer bg-transparent"
              >
                取消
              </button>
              <button
                type="button"
                data-ui="mcp_mount_confirm"
                onClick={() => void handleMount()}
                disabled={busyId === mounting.id}
                className="rounded-md bg-[var(--ink-accent)] px-3 py-1.5 text-[10px] font-medium cursor-pointer disabled:opacity-50"
              >
                {busyId === mounting.id ? '挂载中…' : '确认挂载'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
