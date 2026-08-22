/**
 * 输入框（对话主区底部）：发送/停止 + 底部一行小字挡位/模式档提示。
 *
 * 挡位 = 模型双挡位（main/router），模式档 = 会话模式
 * （default/observe/review/sandbox）；提示行数据来自 state.session 通道
 * （activeGear/modeTier），发送动作经 props 注入（宿主接线，组件无传输耦合）。
 *
 * 外壳：纸面渐变 + 聚焦光晕（ink-input-shell），发送钮朱砂？——否，
 * 发送为主模型动作（primary 墨/纸），朱砂仅审批/决策点。
 */

import { useRef, useState } from 'react';
import { Cpu, Send, Square } from 'lucide-react';

import type { GearTier, ModeTier } from '@/shared/session/types';

export interface AgentInputBindValue {
  streaming?: boolean;
  activeGear?: GearTier;
  modeTier?: ModeTier;
  roundId?: string | null;
}

const GEAR_LABELS: Record<GearTier, string> = {
  router: '制片人决策',
  main: '主模型',
};

const MODE_LABELS: Record<ModeTier, string> = {
  default: '默认',
  observe: '观察',
  review: '审批',
  sandbox: '沙箱',
};

interface AgentInputProps {
  bindValue?: unknown;
  placeholder?: string;
  onSend?: (text: string) => void;
  onAbort?: () => void;
}

export function AgentInput({ bindValue, placeholder = '向 InKling 提问，或观察你的领域', onSend, onAbort }: AgentInputProps) {
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const data = (bindValue as AgentInputBindValue | undefined) ?? {};
  const streaming = data.streaming === true;
  const gear = data.activeGear ?? 'main';
  const mode = data.modeTier ?? 'default';

  const canSend = draft.trim().length > 0 && !streaming;
  const submit = () => {
    const text = draft.trim();
    if (!text || streaming) return;
    setDraft('');
    onSend?.(text);
    textareaRef.current?.focus();
  };

  return (
    <div className="shrink-0 px-5 pb-4 pt-1">
      <div className="ink-input-shell mx-auto w-full max-w-3xl rounded-2xl border bg-[var(--ink-bg-surface)] transition-colors focus-within:border-[var(--ink-border-strong)]">
        <textarea
          ref={textareaRef}
          data-ui="agent_input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          rows={Math.min(Math.max(draft.split('\n').length, 1), 6)}
          placeholder={streaming ? '正在思考…' : placeholder}
          className="min-h-7 max-h-36 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[13px] leading-relaxed focus:outline-none placeholder:text-[var(--ink-text-faint)]"
        />
        <div className="flex items-center gap-1.5 px-3 pb-3 pt-1">
          <span className="ink-chip ink-text-muted">
            <Cpu size={9} strokeWidth={1.8} aria-hidden />
            挡位 {GEAR_LABELS[gear]}
          </span>
          <span className="ink-chip ink-text-muted">模式 {MODE_LABELS[mode]}</span>
          <span className="ml-auto" />
          {streaming ? (
            <button
              onClick={onAbort}
              title="停止生成"
              data-ui="btn_abort"
              className="ink-btn-secondary flex h-8 w-8 shrink-0 items-center justify-center rounded-full cursor-pointer"
            >
              <Square size={12} strokeWidth={1.8} aria-hidden />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!canSend}
              title="发送"
              data-ui="btn_send"
              className="ink-btn-primary flex h-8 w-8 shrink-0 items-center justify-center rounded-full cursor-pointer disabled:opacity-35"
            >
              <Send size={12} strokeWidth={1.8} aria-hidden />
            </button>
          )}
        </div>
      </div>
      <div className="mx-auto mt-2 w-full max-w-3xl px-1 font-mono text-[9px] tracking-wide ink-text-faint">
        挡位:{gear}({GEAR_LABELS[gear]}) · 模式:{mode}({MODE_LABELS[mode]})
      </div>
    </div>
  );
}
