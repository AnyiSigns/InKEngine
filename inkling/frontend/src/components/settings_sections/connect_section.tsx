/**
 * 设置「连接」节（双栏设置页形态）：本地 MCP 服务清单 + 手动添加。
 *
 * 挂载向导已移除（此前为硬编码演示残留：vetting 无真实校验、挂载不持久化）；
 * 生产「连接」节走真实市场（app/settings/sections/connect_section：mcp_market
 * 状态 + 预览 + 添加/删除 + 一键挂载），此处仅保留本地演示清单形态。
 */

import { useState } from 'react';

import { Check, PlugZap } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { TextInput } from '@/shared/ui/Field';

export interface ConnectValue {
  mcpMounted: string[];
}

export const DEFAULT_CONNECT: ConnectValue = {
  mcpMounted: [],
};

interface ConnectSectionProps {
  value: ConnectValue;
  patch: (next: Partial<ConnectValue>) => void;
}

export function ConnectSection({ value, patch }: ConnectSectionProps) {
  const [manualMcp, setManualMcp] = useState('');

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-1.5 text-[10px] leading-relaxed ink-text-faint">
        <PlugZap size={11} strokeWidth={1.6} aria-hidden />
        连接服务管理：生产形态走「市场」节（mcp_market 真实清单）；此处为本地演示清单。
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
      {value.mcpMounted.length > 0 && (
        <div className="ink-chip ink-text-muted">
          <Check size={9} strokeWidth={2} aria-hidden />
          已挂载：{value.mcpMounted.join('、')}（可回退）
        </div>
      )}
    </div>
  );
}
