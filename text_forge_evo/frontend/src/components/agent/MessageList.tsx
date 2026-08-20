/**
 * 对话消息区：消息列表渲染（MessageItem 组件映射，含思考/节点/工具
 * 等状态卡）、回合分组（同回合紧凑、跨回合分隔）、空状态引导。
 */

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

import type { AgentStepMessage } from '@/features/agent/agentStore';
import { useAgentStore } from '@/features/agent/agentStore';
import { cn } from '@/shared/cn';

import { MessageItem } from './MessageItem';

interface MessageListProps {
  messages: AgentStepMessage[];
  agentStreaming: boolean;
  onReviewAction: (
    action: 'accept' | 'reject' | 'edit' | 'terminate',
    editedContent?: string,
    chapterId?: number,
  ) => void;
  onSendMessage: (msg: string) => void;
  onPickSuggestion: (suggestion: string) => void;
  onCopy: (text: string) => void;
  /** user 消息行内编辑确认：带 roundId 的历史消息 → 重新生成；否则发送新回合 */
  onInlineEditSend: (text: string, roundId?: string) => void;
  onUnlockAndRetry: (retryMessage: string) => void;
  messagesEndRef: React.RefObject<HTMLDivElement>;
}

/** 消息流是否存在进行中状态（思考/规划/节点/工具/正文流任一 running）。
 *  流式期间且无任何进行中状态卡时显示「正在处理」占位行。 */
export function hasRunningActivity(messages: AgentStepMessage[]): boolean {
  return messages.some((m) => {
    if (m.type === 'streaming') return true;
    if (m.type === 'thinking' || m.type === 'plan') return m.status !== 'completed';
    if (m.type === 'node') return m.nodeStatus === 'running';
    if (m.type === 'tool') return m.toolStatus === 'running' || m.toolStatus === 'pending';
    return false;
  });
}

const SUGGESTIONS = [
  '介绍一下你自己',
  '看看当前工具表里有什么',
  '调用 inspect_tools 观察你的能力清单',
  '分析当前产品形态',
];

export function MessageList(props: MessageListProps) {
  const {
    messages,
    agentStreaming,
    onReviewAction,
    onSendMessage,
    onPickSuggestion,
    onCopy,
    onInlineEditSend,
    onUnlockAndRetry,
    messagesEndRef,
  } = props;
  // T6 失效区：重新生成后目标回合及其后回合（regenerated_from 事件标记）
  const invalidRounds = useAgentStore((s) => s.invalidRounds);
  const [invalidExpanded, setInvalidExpanded] = useState(false);

  const showProcessingPlaceholder = agentStreaming && !hasRunningActivity(messages);

  // 失效区：按 roundId ∈ invalidRounds 将消息流分段——失效回合可能出现于
  // 多个连续段（多次重新生成 / 无 roundId 消息插在失效与有效轮之间），
  // 逐段渲染为独立折叠块，非单一连续段假设。
  const isInvalid = (m: AgentStepMessage): boolean =>
    Boolean(m.roundId && invalidRounds.has(m.roundId));
  const segments: Array<{ invalid: boolean; items: AgentStepMessage[] }> = [];
  for (const m of messages) {
    const invalid = isInvalid(m);
    const last = segments[segments.length - 1];
    if (last && last.invalid === invalid) last.items.push(m);
    else segments.push({ invalid, items: [m] });
  }

  const renderRound = (list: AgentStepMessage[], withGap = true) =>
    list.map((msg, idx) => {
      const prev = list[idx - 1];
      const isRoundBoundary = prev !== undefined && msg.roundId !== prev.roundId;
      return (
        <div
          key={msg.id || `i-${idx}`}
          className={isRoundBoundary ? (withGap ? 'mt-5' : 'mt-2.5') : idx === 0 ? '' : 'mt-2.5'}
        >
          {isRoundBoundary && withGap && (
            <div className="mb-2 flex items-center gap-2">
              <div className="h-px flex-1 bg-foreground/[0.06]" />
              <span className="text-[9px] uppercase tracking-wider text-foreground/25 select-none">回合</span>
              <div className="h-px flex-1 bg-foreground/[0.06]" />
            </div>
          )}
          <MessageItem
            msg={msg}
            index={idx}
            agentStreaming={agentStreaming}
            onReviewAction={onReviewAction}
            onCopy={onCopy}
            onInlineEditSend={onInlineEditSend}
            onUnlockAndRetry={onUnlockAndRetry}
          />
        </div>
      );
    });

  return (
    <div className="flex-1 overflow-y-auto ide-agent-body">
      {messages.length === 0 && (
        <div className="flex flex-col items-center gap-4 mt-12 px-4">
          <div className="text-xs text-muted-foreground text-center">
            Forge：站在 AI 上的 AI——先观察自身，再回答你的问题
          </div>
          <div className="flex flex-wrap justify-center gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => {
                  if (s.startsWith('调用')) {
                    void onSendMessage(s.replace('调用', '请调用'));
                  } else {
                    onPickSuggestion(s);
                  }
                }}
                className="text-[11px] px-2.5 py-1 rounded-full border border-border bg-transparent text-muted-foreground hover:text-foreground hover:border-foreground/30 cursor-pointer transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {segments.map((seg, segIdx) =>
        seg.invalid ? (
          <div
            key={`invalid-${segIdx}`}
            className="mt-5 rounded-md border border-dashed border-foreground/15 overflow-hidden"
          >
            <button
              onClick={() => setInvalidExpanded((e) => !e)}
              className="w-full flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground/60 bg-foreground/[0.02] hover:bg-foreground/[0.04] cursor-pointer bg-transparent border-none text-left"
            >
              <ChevronDown
                size={11}
                strokeWidth={1.5}
                className={cn('shrink-0 text-foreground/30 transition-transform', invalidExpanded && 'rotate-180')}
              />
              <span className="text-foreground/50">
                已作废 · {seg.items.length} 条消息（重新生成前的历史，可展开对比）
              </span>
            </button>
            {invalidExpanded && (
              <div className="opacity-50 select-none pointer-events-none px-1 pb-1">
                {renderRound(seg.items, false)}
              </div>
            )}
          </div>
        ) : (
          <div key={`valid-${segIdx}`}>{renderRound(seg.items)}</div>
        ),
      )}
      {showProcessingPlaceholder && (
        <div className="flex justify-start">
          <div className="w-full rounded-md border border-foreground/10 bg-foreground/[0.03] px-3 py-1.5 text-[11px]">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400/70 inline-block shrink-0" />
              <span className="thinking-shimmer-text">正在处理</span>
              <span className="ml-auto inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-foreground/30 border-t-foreground/70" />
            </div>
          </div>
        </div>
      )}
      <div ref={messagesEndRef} />
    </div>
  );
}
