/**
 * 对话输入框：Enter 发送（Shift+Enter 换行），流式中切换为「停止」。
 */

import { useRef, useState } from 'react';
import { Send, Square } from 'lucide-react';

import { cn } from '@/shared/cn';

interface AgentInputProps {
  streaming: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
  /** 外部聚焦句柄（唤起协议：Cmd+K 聚焦输入框） */
  inputRef?: React.RefObject<HTMLTextAreaElement>;
}

export function AgentInput({ streaming, onSend, onAbort, inputRef }: AgentInputProps) {
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canSend = draft.trim().length > 0 && !streaming;
  const submit = () => {
    const text = draft.trim();
    if (!text || streaming) return;
    setDraft('');
    onSend(text);
  };

  return (
    <div className="border-t border-border/60 px-3 py-2.5">
      <div className="flex items-end gap-2 rounded-lg border border-border bg-card px-3 py-2 focus-within:border-foreground/30">
        <textarea
          ref={inputRef ?? textareaRef}
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
          placeholder={streaming ? '正在思考…' : '向 Forge 提问，或让我观察自身（如「调用 inspect_tools 看看你能做什么」）'}
          className="min-h-[36px] max-h-36 flex-1 resize-none bg-transparent text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/50"
        />
        {streaming ? (
          <button
            onClick={onAbort}
            title="停止生成"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted-foreground hover:text-destructive hover:border-destructive/40 cursor-pointer transition-colors"
          >
            <Square size={11} strokeWidth={1.8} />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!canSend}
            title="发送"
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-foreground/15 bg-foreground/10 text-foreground transition-colors cursor-pointer',
              'disabled:opacity-40 disabled:cursor-default',
            )}
          >
            <Send size={11} strokeWidth={1.8} />
          </button>
        )}
      </div>
    </div>
  );
}
