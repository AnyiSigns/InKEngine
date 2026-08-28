/**
 * 设置「连接」节：MCP 服务连接管理入口。
 *
 * MCP 挂载唯一真路径 = MCP 市场（出厂零预挂；一键挂载走 vetting → 观察
 * → L2 审批转正 → 补丁链可回退），本节提供入口行，不做本地假挂载清单。
 * 网络白名单判定面归 OS 层沙箱（开发者模式 → OS 层），不在用户设置重复。
 */

import { ChevronRight, Server } from 'lucide-react';

import { SettingsActionsContext } from './advanced_section';
import { useContext } from 'react';

export function ConnectSection(): JSX.Element {
  const { onOpenView } = useContext(SettingsActionsContext);

  return (
    <div className="space-y-4">
      <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden">
        <button
          type="button"
          data-ui="connect_open_mcp_market"
          onClick={() => onOpenView('mcp_market')}
          className="flex w-full items-center gap-3 px-3.5 py-3 text-left hover:bg-[var(--ink-bg-surface)]"
        >
          <Server size={16} strokeWidth={1.6} className="shrink-0 ink-text-muted" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">MCP 服务</span>
            <span className="mt-0.5 block text-[11px] leading-relaxed ink-text-faint">
              浏览市场并挂载；出厂零预挂，挂载经审查后生效、可回退
            </span>
          </span>
          <ChevronRight size={15} strokeWidth={1.6} className="shrink-0 ink-text-faint" aria-hidden />
        </button>
      </div>
      <p className="text-[11px] leading-relaxed ink-text-faint">
        网络域名白名单与联网工具沙箱判定位于「开发者模式 → OS 层」。
      </p>
    </div>
  );
}
