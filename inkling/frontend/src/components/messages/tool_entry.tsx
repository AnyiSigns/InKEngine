/**
 * 工具条目（tool）——工具行独立区块（不混入推理文本；可展开原始参数）。
 *
 * 头部：工具图标 + 中文标签（四层兜底）+ 权限档中文芯片 + 状态胶囊；
 * 原始标识行：机器名 · 权限码（标识面，便于对账/测试）；
 * 语义面：按工具族渲染（OS=动作+目标+结果 / 文件=路径+操作+摘要 /
 * 网络=域+结果 / 研究=步骤+指标 / MCP=描述+权限档 / 通用=标签+权限档）；
 * 原始参数：可展开（标签页式折叠），不裸 JSON 平铺。
 */

import { memo, useState } from 'react';

import { ChevronRight, Wrench } from 'lucide-react';

import { cn } from '@/shared/cn';
import type { InkToolMessage } from '@/shared/session/types';
import { describeToolSemantics, permissionLabel } from '@/shared/labels/toolLabels';
import { EntryFrame, StatusPill } from './entry_frame';

interface ToolEntryProps {
  message: InkToolMessage;
  live: boolean;
}

export const ToolEntry = memo(function ToolEntry({ message, live }: ToolEntryProps) {
  const [argsOpen, setArgsOpen] = useState(false);
  const semantics = describeToolSemantics(message);
  return (
    <EntryFrame
      id={message.id}
      visual="bubble"
      collapsible
      header={
        <>
          <span className="ink-icon-chip h-5 w-5">
            <Wrench size={10} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
          </span>
          <span className="min-w-0 truncate text-[var(--ink-font-xs)] font-medium">{semantics.action}</span>
          <span className="ink-chip shrink-0 py-px text-[9px] ink-text-faint" data-ui="tool_permission">
            {permissionLabel(message.permission)}
          </span>
          <StatusPill status={message.toolStatus} live={live} />
        </>
      }
      body={
        <div className="mt-0.5 space-y-1">
          <div className="flex items-center gap-2 font-mono text-[10px] ink-text-faint" data-ui="tool_raw_identity">
            <span>{message.tool} · {message.permission}</span>
          </div>
          {semantics.lines.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-0.5">
              {semantics.lines.map((line) => (
                <span key={line.key} className="flex items-center gap-1 text-[10px]">
                  <span className="ink-text-faint">{line.key}</span>
                  <span className="ink-text-muted">{line.value}</span>
                </span>
              ))}
            </div>
          )}
          {message.args && message.args.trim() !== '' && (
            <button
              data-ui="tool_args_toggle"
              onClick={() => setArgsOpen((v) => !v)}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] cursor-pointer ink-text-faint hover:text-[var(--ink-text-base)] bg-transparent border-none hover:bg-[var(--ink-bg-elevated)]"
            >
              <ChevronRight size={10} strokeWidth={1.8} className={cn('transition-transform', argsOpen && 'rotate-90')} aria-hidden />
              {argsOpen ? '收起原始参数' : '原始参数'}
            </button>
          )}
          {argsOpen && message.args && (
            <pre className="ink-feed rounded-[var(--ink-radius-sm)] border border-[var(--ink-border)] bg-[var(--ink-bg-base)] px-2.5 py-2 font-mono text-[10px] leading-[1.6] whitespace-pre-wrap break-words ink-text-muted">
              {message.args}
            </pre>
          )}
        </div>
      }
    />
  );
});
