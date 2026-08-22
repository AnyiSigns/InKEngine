/**
 * 输入框（对话主区底部）：发送/停止 + 底部一行小字挡位/模式档提示。
 *
 * 挡位 = 模型四挡位（router/tool/main/audit），模式档 = 会话模式
 * （default/observe/review/sandbox）；提示行数据来自 state.session 通道
 * （activeGear/modeTier），发送动作经 props 注入（宿主接线，组件无传输耦合）。
 */

import { useRef, useState } from 'react';
import { Send, Square } from 'lucide-react';

import type { GearTier, ModeTier } from '@/shared/session/types';

export interface AgentInputBindValue {
  streaming?: boolean;
  activeGear?: GearTier;
  modeTier?: ModeTier;
  roundId?: string | null;
}

const GEAR_LABELS: Record<GearTier, string> = {
  router: '制片人决策',
  tool: '工具挡',
  main: '主模型',
  audit: '质量校验',
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
  };

  return (
    <div className="shrink-0 border-t px-3 pb-2.5 pt-2 ink-border">
      <div className="mx-auto flex w-full max-w-3xl items-end gap-2 border px-3 py-1.5 ink-border">
        <span className="select-none pb-2 text-[12px] leading-none ink-text-faint" aria-hidden>
          ❯
        </span>
        <textarea
          ref={textareaRef}
          data-ui="agent_input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={Math.min(Math.max(draft.split('\n').length, 1), 6)}
          placeholder={streaming ? '正在思考…' : placeholder}
          className="min-h-5 max-h-36 flex-1 resize-none bg-transparent text-[12px] leading-relaxed outline-none placeholder:text-[var(--ink-text-faint)]"
        />
        {streaming ? (
          <button
            onClick={onAbort}
            title="停止生成"
            data-ui="btn_abort"
            className="flex h-6 w-6 shrink-0 items-center justify-center border ink-btn-secondary cursor-pointer"
          >
            <Square size={10} strokeWidth={1.8} aria-hidden />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!canSend}
            title="发送"
            data-ui="btn_send"
            className="ink-btn-primary flex h-6 w-6 shrink-0 items-center justify-center cursor-pointer disabled:opacity-40"
          >
            <Send size={10} strokeWidth={1.8} aria-hidden />
          </button>
        )}
      </div>
      <div className="mx-auto mt-1 w-full max-w-3xl px-0.5 font-mono text-[9px] tracking-wide ink-text-faint">
        挡位:{gear}({GEAR_LABELS[gear]}) · 模式:{mode}({MODE_LABELS[mode]})
      </div>
    </div>
  );
}
