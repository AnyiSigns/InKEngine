/**
 * 轨迹页（主区「轨迹」页签）：当前回合步骤时间线。
 *
 * 数据 = state.round_steps 通道快照（与消息流阶段胶囊同源）；
 * 面向用户的呈现：步骤名 + 状态 + 耗时/token，不展示 stepId/type 原文
 * （诊断细节归开发者模式下的「来源」视图）。
 */

import { CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react';

import type { RoundStep } from '@/shared/session/types';

interface TrajectoryViewProps {
  steps: RoundStep[];
}

function statusIcon(status?: string): JSX.Element {
  switch (status) {
    case 'done':
    case 'ok':
    case 'success':
      return <CheckCircle2 size={15} strokeWidth={1.6} className="ink-text-muted" />;
    case 'failed':
    case 'error':
      return <XCircle size={15} strokeWidth={1.6} className="ink-accent" />;
    case 'running':
    case 'active':
      return <Loader2 size={15} strokeWidth={1.6} className="animate-spin ink-text-muted" />;
    default:
      return <Circle size={14} strokeWidth={1.6} className="ink-text-faint" />;
  }
}

function statusLabel(status?: string): string {
  switch (status) {
    case 'done':
    case 'ok':
    case 'success':
      return '完成';
    case 'failed':
    case 'error':
      return '失败';
    case 'running':
    case 'active':
      return '进行中';
    default:
      return '等待';
  }
}

export function TrajectoryView({ steps }: TrajectoryViewProps): JSX.Element {
  if (steps.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-[12px] ink-text-faint">
        <p>本回合还没有轨迹</p>
        <p className="text-[11px]">发送消息后，这里会展示执行步骤时间线</p>
      </div>
    );
  }

  const totalMs = steps.reduce((acc, s) => acc + (s.elapsedMs ?? 0), 0);
  const totalTokens = steps.reduce((acc, s) => acc + (s.tokens ?? 0), 0);

  return (
    <div className="ink-scroll-auto flex-1 overflow-y-auto px-4 py-5">
      <div className="mx-auto max-w-2xl">
        <div className="mb-4 flex items-baseline gap-3">
          <span className="text-[13px] font-medium">本回合轨迹</span>
          <span className="text-[11px] ink-text-faint">
            {steps.length} 步{totalMs > 0 ? ` · ${(totalMs / 1000).toFixed(1)}s` : ''}{totalTokens > 0 ? ` · ${totalTokens} tokens` : ''}
          </span>
        </div>
        <ol className="relative space-y-1 border-l ink-border pl-5">
          {steps.map((step) => (
            <li key={step.stepId} className="relative flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-[var(--ink-bg-surface)]">
              <span className="absolute -left-[26px] top-2.5 flex h-4 w-4 items-center justify-center bg-[var(--ink-bg-base)]">
                {statusIcon(step.status)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px]">{step.label || '步骤'}</span>
                  <span className="shrink-0 text-[11px] ink-text-faint">{statusLabel(step.status)}</span>
                </div>
                {step.note && <p className="mt-0.5 text-[11px] leading-relaxed ink-text-muted">{step.note}</p>}
              </div>
              <span className="shrink-0 text-[11px] tabular-nums ink-text-faint">
                {step.elapsedMs != null ? `${(step.elapsedMs / 1000).toFixed(1)}s` : ''}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
