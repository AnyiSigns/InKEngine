/**
 * 管理台工具注册表：按工具族分组展示（OS 控制 / 文件 / 网络 / 研究自指 /
 * MCP 连接 / 通用）+ description 全文。
 *
 * 数据 = inspect_tools 快照（bind 注入）；分组键经工具族判定
 * （shared/labels/toolLabels），权限档中文展示。纯展示组件。
 */

import { Wrench } from 'lucide-react';

import type { ToolsSnapshot } from '@/shared/session/inspectTypes';
import type { ToolFamily } from '@/shared/labels/toolLabels';
import { classifyToolFamily, permissionLabel } from '@/shared/labels/toolLabels';

/** 分组展示名（研究 + 自指归并为「研究自指」）。 */
export const TOOL_GROUP_LABELS: Record<string, string> = {
  os: 'OS 控制',
  file: '文件',
  network: '网络',
  research: '研究自指',
  mcp: 'MCP 连接',
  generic: '通用',
};

function groupKeyOf(family: ToolFamily): string {
  if (family === 'self') return 'research';
  return family;
}

interface AdminToolsProps {
  bindValue?: unknown;
}

export function AdminTools({ bindValue }: AdminToolsProps) {
  const snapshot = bindValue as ToolsSnapshot | undefined;
  if (!snapshot || snapshot.tools.length === 0) {
    return (
      <div className="ink-status-card px-3 py-2 text-[10px] ink-text-faint" data-ui="admin_tools_empty">
        暂无工具表快照（等待 inspect_tools）
      </div>
    );
  }

  const groups = new Map<string, Array<(typeof snapshot.tools)[number]>>();
  for (const tool of snapshot.tools) {
    const key = groupKeyOf(classifyToolFamily(tool.name));
    const bucket = groups.get(key);
    if (bucket) bucket.push(tool);
    else groups.set(key, [tool]);
  }

  return (
    <div className="space-y-4">
      {[...groups.entries()].map(([group, tools]) => (
        <section key={group} data-ui={`admin_tools_group_${group}`}>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="ink-chip py-px text-[9px]">{TOOL_GROUP_LABELS[group] ?? group}</span>
            <span className="text-[10px] ink-text-faint">{tools.length} 个工具</span>
          </div>
          <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden">
            {tools.map((tool) => (
              <div key={tool.name} className="px-3.5 py-2" data-ui={`admin_tool_${tool.name}`}>
                <div className="flex items-center gap-2">
                  <span className="ink-icon-chip h-5 w-5">
                    <Wrench size={10} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
                  </span>
                  <span className="font-mono text-[11px] font-medium">{tool.name}</span>
                  <span className="ink-chip py-px text-[9px]">{permissionLabel(tool.permission)}</span>
                  <span className="ml-auto font-mono text-[9px] ink-text-faint">{tool.endpoint}</span>
                </div>
                {tool.description && (
                  <div className="px-7 pt-0.5 text-[10px] leading-[1.6] ink-text-muted">{tool.description}</div>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
