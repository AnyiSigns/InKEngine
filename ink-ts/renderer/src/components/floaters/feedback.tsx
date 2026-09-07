/**
 * 三态反馈（loading / success / failed）：异步动作状态可见化。
 *
 * 纪律：无静默变化——动作执行中显示旋转指示，成功/失败除指示外
 * 输出明确文案；idle 不占位。色彩全部经语义类（单强调色朱砂仅用于
 * 审批/决策点，此处反馈走文本色体系）。
 */

import { CheckCircle2, XCircle } from 'lucide-react';

import { cn } from '@/shared/cn';

export type FeedbackPhase = 'idle' | 'loading' | 'success' | 'fail';

interface FeedbackProps {
  phase: FeedbackPhase;
  okText: string;
  failText: string;
  className?: string;
}

export function Feedback({ phase, okText, failText, className }: FeedbackProps) {
  if (phase === 'idle') return <span className={className} />;
  if (phase === 'loading') {
    return (
      <span className={cn('flex items-center gap-1.5 text-[10px] ink-text-muted', className)} data-ui="feedback" data-phase="loading">
        <span className="ink-spinner" aria-hidden />
        处理中…
      </span>
    );
  }
  if (phase === 'success') {
    return (
      <span className={cn('flex items-center gap-1.5 text-[10px] ink-feedback-ok', className)} data-ui="feedback" data-phase="success">
        <CheckCircle2 size={11} strokeWidth={1.8} aria-hidden />
        {okText}
      </span>
    );
  }
  return (
    <span className={cn('flex items-center gap-1.5 text-[10px] ink-feedback-fail', className)} data-ui="feedback" data-phase="fail">
      <XCircle size={11} strokeWidth={1.8} aria-hidden />
      {failText}
    </span>
  );
}
