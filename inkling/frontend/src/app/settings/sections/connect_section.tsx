/**
 * 设置「连接」节：网络白名单入口占位（详细归波 4）。
 *
 * 挂载清单（前端本地状态）+ 挂载向导入口 + 白名单占位。
 */

import { useState } from 'react';

import { PlugZap } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { Field, TextInput } from '@/shared/ui/Field';

export interface ConnectSectionValue {
  mcpMounted: string[];
  networkAllowlist: string;
}

const DEFAULT_CONNECT: ConnectSectionValue = {
  mcpMounted: [],
  networkAllowlist: '',
};

export function ConnectSection(): JSX.Element {
  const [value, setValue] = useState<ConnectSectionValue>(DEFAULT_CONNECT);
  const [manualMcp, setManualMcp] = useState('');

  const patch = (next: Partial<ConnectSectionValue>): void => {
    setValue((prev) => ({ ...prev, ...next }));
  };

  const mount = (name: string): void => {
    if (value.mcpMounted.includes(name)) return;
    patch({ mcpMounted: [...value.mcpMounted, name] });
  };

  return (
    <div className="space-y-4">
      <div className="ink-elevated space-y-3 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">MCP 挂载</div>
        <div className="flex items-center gap-2">
          <TextInput
            value={manualMcp}
            placeholder="手动添加：npx -y <pkg> 或 http(s)://<endpoint>"
            onChange={(e) => setManualMcp(e.target.value)}
            aria-label="手动添加 MCP"
          />
          <Button
            size="md"
            onClick={() => {
              const trimmed = manualMcp.trim();
              if (trimmed && !value.mcpMounted.includes(trimmed)) {
                mount(trimmed);
                setManualMcp('');
              }
            }}
          >
            添加
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" data-ui="mcp_wizard_open">
            <PlugZap size={11} strokeWidth={1.6} /> 挂载向导
          </Button>
          <p className="text-[10px] leading-relaxed ink-text-faint">mcp_market 市场（出厂零预挂，一键挂载走 vetting → 观察 → L2 审批转正）</p>
        </div>
        {value.mcpMounted.length > 0 && (
          <div className="ink-chip ink-text-muted">
            已挂载：{value.mcpMounted.join('、')}（可回退）
          </div>
        )}
      </div>

      <div className="ink-elevated space-y-3 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">网络白名单</div>
        <Field label="域名白名单" hint="允许联网工具访问的域名列表（逗号分隔）；未配置 = 禁止联网工具。">
          <TextInput
            value={value.networkAllowlist}
            placeholder="example.com, docs.example.org"
            onChange={(e) => patch({ networkAllowlist: e.target.value })}
            aria-label="域名白名单"
            className="font-mono text-[10px]"
          />
        </Field>
        <p className="text-[10px] ink-text-faint">网络越域提示：目标域名不在白名单时消息流内联警示行「目标域名 &lt;x&gt; 不在白名单」。</p>
      </div>
    </div>
  );
}
