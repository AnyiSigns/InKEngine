/**
 * 推理（thinking）条目——推理/工具分区：推理区为独立折叠块，
 * 工具调用不混入推理文本。
 *
 * 折叠策略：推理/规划属「蓄力区」（长内容，默认收起，头部与状态
 * 实时可见）；其余条目默认展开、可收起且收起仅视觉。标题为「思考」
 * 双面表达 + 状态芯片「推理中」（运行）/「已完成」（停），规划条目
 * 对应「规划中」。内容为推理正文，蛇形 token 经中文化替换展示
 * （原始链可折叠展开查看）。
 */

import { memo, useState } from 'react';

import { Cpu, Eye, EyeOff } from 'lucide-react';

import { cn } from '@/shared/cn';
import type { InkThinkingMessage } from '@/shared/session/types';
import { extractSnakeTokens, replaceSnakeTokens } from '@/shared/labels/toolLabels';
import { EntryFrame } from './entry_frame';
import { useThrottledValue } from './streaming_throttle';

interface ThinkingEntryProps {
  message: InkThinkingMessage;
  throttleMs: number;
  live: boolean;
}

function ThinkingBody({ content, running }: { content: string; running: boolean }) {
  const [showOriginal, setShowOriginal] = useState(false);
  const snakeTokens = extractSnakeTokens(content);
  const body = showOriginal ? content : replaceSnakeTokens(content);
  return (
    <div className="space-y-1.5 border-t px-3 py-2.5 border-[var(--ink-status-card-edge)] text-[11px] leading-[1.7] whitespace-pre-wrap break-words">
      <div className="ink-text-muted">{body || '（推理中…）'}</div>
      {snakeTokens.length > 0 && (
        <button
          data-ui="thinking_raw_toggle"
          onClick={() => setShowOriginal((v) => !v)}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] cursor-pointer ink-text-faint hover:text-[var(--ink-text-base)] bg-transparent border-none hover:bg-[var(--ink-bg-elevated)]"
        >
          {showOriginal ? <EyeOff size={10} strokeWidth={1.8} /> : <Eye size={10} strokeWidth={1.8} />}
          {showOriginal ? '显示中文替换' : '查看原始链'}
        </button>
      )}
      {running && <span className="ink-caret-muted" aria-hidden />}
    </div>
  );
}

export const ThinkingEntry = memo(function ThinkingEntry({ message, throttleMs, live }: ThinkingEntryProps) {
  const running = message.status === 'running';
  const content = useThrottledValue(message.content, throttleMs);
  return (
    <EntryFrame
      id={message.id}
      visual="card"
      collapsible
      defaultCollapsed
      header={
        <>
          <span className="ink-icon-chip h-5 w-5">
            <Cpu size={10} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
          </span>
          <span className="text-[var(--ink-font-xs)] font-medium">思考</span>
          <span className={cn('ink-chip py-px text-[9px]', running ? 'ink-text-muted' : 'ink-text-faint')} data-ui="thinking_state">
            {running ? (
              <>
                {live && <span className="ink-live-dot" aria-hidden />}
                推理中
              </>
            ) : (
              '已完成'
            )}
          </span>
        </>
      }
      body={<ThinkingBody content={content} running={running} />}
    />
  );
});
