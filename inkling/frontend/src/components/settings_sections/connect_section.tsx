/**
 * 设置「连接」节：MCP 市场（出厂零预挂）与挂载向导入口。
 *
 * 单步轻交互（挂载/卸载列表项）内联；多步挂载走悬浮窗向导。
 * 挂载结果回调宿主（已挂载清单即时同步列表）。
 */

import { useState } from 'react';

import { Check, PlugZap } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { TextInput } from '@/shared/ui/Field';
import { MountWizardFloater } from '@/components/floaters/mount_wizard_floater';
import type { McpMarketEntry } from '@/components/floaters/mount_wizard_floater';
import { MCP_MARKET_DEFAULT } from '@/components/floaters/mount_wizard_floater';

export interface ConnectValue {
  mcpMounted: string[];
}

export const DEFAULT_CONNECT: ConnectValue = {
  mcpMounted: [],
};

interface ConnectSectionProps {
  value: ConnectValue;
  patch: (next: Partial<ConnectValue>) => void;
  market?: McpMarketEntry[];
}

export function ConnectSection({ value, patch, market = MCP_MARKET_DEFAULT }: ConnectSectionProps) {
  const [wizardOpen, setWizardOpen] = useState(false);
  const [manualMcp, setManualMcp] = useState('');

  const mount = (name: string): void => {
    if (value.mcpMounted.includes(name)) return;
    patch({ mcpMounted: [...value.mcpMounted, name] });
  };

  return (
    <div className="space-y-2.5">
      <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden">
        {market.map((entry) => {
          const mounted = value.mcpMounted.includes(entry.name);
          return (
            <div key={entry.name} className="flex items-center gap-3 px-3.5 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[var(--ink-font-xs)] font-medium">{entry.name}</span>
                  <span className="ink-chip font-mono text-[9px] ink-text-faint">{entry.risk}</span>
                </span>
                <span className="mt-0.5 block truncate font-mono text-[9px] ink-text-faint">{entry.endpoint}</span>
              </span>
              <Button
                size="xs"
                variant={mounted ? 'secondary' : 'accent'}
                data-ui={`mcp_mount_${entry.name}`}
                onClick={() => (mounted ? patch({ mcpMounted: value.mcpMounted.filter((n) => n !== entry.name) }) : mount(entry.name))}
              >
                {mounted ? '卸载' : '挂载'}
              </Button>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <TextInput
          value={manualMcp}
          placeholder="手动添加：npx -y <pkg> 或 http(s)://<endpoint>"
          onChange={(e) => setManualMcp(e.target.value)}
          aria-label="手动添加 MCP"
        />
        <Button
          size="md"
          data-ui="mcp_manual_add"
          onClick={() => {
            const trimmed = manualMcp.trim();
            if (trimmed && !value.mcpMounted.includes(trimmed)) {
              patch({ mcpMounted: [...value.mcpMounted, trimmed] });
              setManualMcp('');
            }
          }}
        >
          添加
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" data-ui="mcp_wizard_open" onClick={() => setWizardOpen(true)}>
          <PlugZap size={11} strokeWidth={1.6} /> 挂载向导
        </Button>
        <p className="text-[10px] leading-relaxed ink-text-faint">mcp_market 市场（出厂零预挂，一键挂载走 vetting → 观察 → L2 审批转正）</p>
      </div>
      {value.mcpMounted.length > 0 && (
        <div className="ink-chip ink-text-muted">
          <Check size={9} strokeWidth={2} aria-hidden />
          已挂载：{value.mcpMounted.join('、')}（可回退）
        </div>
      )}
      {wizardOpen && (
        <MountWizardFloater
          onClose={() => setWizardOpen(false)}
          market={market}
          onMounted={(entry) => mount(entry.name)}
        />
      )}
    </div>
  );
}
