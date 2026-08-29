/**
 * 杂项条目（spawn/device/error/suggestions/knowledge_hit/review 事件/unknown）
 * ——每类事件独立条目渲染器（一对一映射），不共享拼接行。
 *
 * 视觉层：spawn/device/suggestions/error = 状态气泡（半透明）；
 * knowledge_hit/review 事件回放/unknown = 状态卡片（透明底细描边）。
 */

import { AlertTriangle, Beaker, GitBranch, Cpu, ShieldCheck } from 'lucide-react';

import type {
  InkDeviceMessage,
  InkErrorMessage,
  InkKnowledgeHitMessage,
  InkReviewCardMessage,
  InkVettingMessage,
  InkSpawnMessage,
  InkSuggestionsMessage,
  InkUnknownMessage,
} from '@/shared/session/types';
import { EntryFrame, StatusPill } from './entry_frame';
import { useDevMode } from '@/shared/ui/devMode';

interface RowProps {
  id: string;
  live: boolean;
}

export function SpawnEntry({ message, live }: { message: InkSpawnMessage } & RowProps) {
  const status = message.status === 'running' ? 'running' : 'done';
  return (
    <EntryFrame
      id={message.id}
      visual="bubble"
      header={
        <>
          <span className="ink-icon-chip h-5 w-5">
            <GitBranch size={10} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
          </span>
          <span className="min-w-0 flex-1 truncate text-[var(--ink-font-xs)]">
            子任务：{message.label ?? message.nodeId ?? ''}
          </span>
          <StatusPill status={status} live={live} />
        </>
      }
    />
  );
}

export function DeviceEntry({ message, live }: { message: InkDeviceMessage } & RowProps) {
  return (
    <EntryFrame
      id={message.id}
      visual="bubble"
      header={
        <>
          <span className="ink-icon-chip h-5 w-5">
            <Cpu size={10} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
          </span>
          <span className="min-w-0 flex-1 truncate text-[var(--ink-font-xs)]">设备：{message.action}</span>
          {message.detail && <span className="shrink-0 max-w-1/2 truncate text-[10px] ink-text-faint">{message.detail}</span>}
          <StatusPill status="done" live={live} />
        </>
      }
    />
  );
}

export function ErrorEntry({ message, live }: { message: InkErrorMessage } & RowProps) {
  return (
    <EntryFrame
      id={message.id}
      visual="bubble"
      header={
        <>
          <span className="ink-icon-chip h-5 w-5">
            <AlertTriangle size={10} strokeWidth={1.6} className="ink-accent" aria-hidden />
          </span>
          <span className="min-w-0 flex-1 truncate text-[var(--ink-font-xs)]">{message.content || '发生错误'}</span>
          <StatusPill status="error" live={live} />
        </>
      }
    />
  );
}

export function SuggestionsEntry({ message }: { message: InkSuggestionsMessage } & RowProps) {
  return (
    <EntryFrame
      id={message.id}
      visual="bubble"
      header={
        <div className="flex flex-wrap gap-1.5">
          {message.items.map((item) => (
            <span
              key={item}
              className="ink-chip cursor-pointer ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)] transition-colors"
            >
              #{item}
            </span>
          ))}
        </div>
      }
    />
  );
}

export function KnowledgeHitEntry({ message }: { message: InkKnowledgeHitMessage } & RowProps) {
  return (
    <EntryFrame
      id={message.id}
      visual="card"
      header={
        <div className="flex items-center gap-1.5 text-[10px] ink-text-faint">
          <Beaker size={10} strokeWidth={1.6} aria-hidden />
          检索命中
        </div>
      }
      body={
        <div className="space-y-1.5">
          {message.hits.map((hit) => (
            <div key={hit.id} className="flex items-center gap-2 text-[11px]">
              <span className="min-w-0 truncate font-medium">{hit.title}</span>
              <span className="min-w-0 flex-1 truncate text-[10px] ink-text-faint">{hit.snippet}</span>
            </div>
          ))}
        </div>
      }
    />
  );
}

export function ReviewEventEntry({ message }: { message: InkReviewCardMessage } & RowProps) {
  const payload = message.payload as Record<string, unknown>;
  const title = typeof payload.title === 'string' ? payload.title : '';
  const reason = typeof payload.reason === 'string' ? payload.reason : '';
  return (
    <EntryFrame
      id={message.id}
      visual="card"
      header={
        <div className="flex items-center gap-1.5 text-[var(--ink-font-xs)] font-medium">
          <span className="ink-live-dot ink-accent" aria-hidden />
          <span>审批卡已弹出（历史回放只读）</span>
          {title && <span className="truncate ink-text-faint">· {title}</span>}
        </div>
      }
      body={reason ? <div className="mt-0.5 text-[10px] ink-text-faint">{reason}</div> : undefined}
    />
  );
}

export function UnknownEntry({ message }: { message: InkUnknownMessage } & RowProps) {
  const [devMode] = useDevMode();
  // 未登记事件负载属诊断信息，仅开发者模式展示
  if (!devMode) return null;
  return (
    <EntryFrame
      id={message.id}
      visual="card"
      header={<div className="text-[10px] ink-text-faint">未登记事件（折叠展示）：{message.token}</div>}
    />
  );
}

/** 审查留痕（vetting_result：pass/fail/review 三态，与消息流一致）。 */
export function VettingEntry({ message }: { message: InkVettingMessage } & RowProps) {
  const isFail = message.verdict === 'fail';
  const isReview = message.verdict === 'review';
  return (
    <EntryFrame
      id={message.id}
      visual="card"
      header={
        <div className="flex min-w-0 items-center gap-1.5 text-[var(--ink-font-xs)]">
          {isFail ? (
            <AlertTriangle size={10} strokeWidth={1.6} className="shrink-0 ink-accent" aria-hidden />
          ) : (
            <ShieldCheck size={10} strokeWidth={1.6} className="shrink-0 ink-text-faint" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate font-medium">{message.tool || '工具'}</span>
          <span className="ml-1.5 ink-text-muted">
            {isFail ? '审查未通过' : isReview ? '审查需人工复核' : '已通过审查'}
          </span>
          {isReview && <span className="shrink-0 ink-chip text-[10px] ink-text-muted">待复核</span>}
        </div>
      }
      body={message.reason ? <div className="mt-0.5 text-[10px] ink-text-faint">{message.reason}</div> : undefined}
    />
  );
}
