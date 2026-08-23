/**
 * 输入框（对话主区底部）：发送/停止 + 「选择文件」附件入口 + 模式提示。
 *
 * 附件管线：可注入文件拾取器 → 媒体策略分发（图片/视频/文档 → 资产，
 * 其余拒绝并提示）→ onAttachments 回调（宿主落位消息流）。
 * 禁联真实 IPC：一律经可注入接口 + 夹具；发送动作经 props 注入。
 * 草稿经可注入界面状态存储持久（主题/视图切换不丢上下文）。
 */

import { useRef, useState } from 'react';

import { Cpu, Paperclip, Send, Square } from 'lucide-react';

import type { GearTier, ModeTier } from '@/shared/session/types';
import type { AttachmentAsset } from '@/shared/session/eventIngest';
import type { FilePicker } from '@/shared/media/filePicker';
import { createDomFilePicker } from '@/shared/media/filePicker';
import { classifyMediaAsset } from '@/shared/media/mediaPolicy';
import { useUiState } from '@/shared/ui/uiStateStore';

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
  /** 附件回调（宿主接线：资产落位消息流） */
  onAttachments?: (assets: AttachmentAsset[]) => void;
  /** 可注入文件拾取器（缺省 DOM 实现；null = 隐藏入口） */
  filePicker?: FilePicker | null;
  /** 会话键（草稿持久化作用域） */
  sessionKey?: string;
}

const defaultPicker = createDomFilePicker();

export function AgentInput({
  bindValue,
  placeholder = '向 InKling 提问，或观察你的领域',
  onSend,
  onAbort,
  onAttachments,
  filePicker = defaultPicker,
  sessionKey = 'default',
}: AgentInputProps) {
  const [draft, setDraft] = useUiState<string>(`agent_input.draft.${sessionKey}`, '');
  const [attachNote, setAttachNote] = useState<{ text: string; phase: 'success' | 'fail' } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const data = (bindValue as AgentInputBindValue | undefined) ?? {};
  const streaming = data.streaming === true;
  const gear = data.activeGear ?? 'main';
  const mode = data.modeTier ?? 'default';

  const canSend = draft.trim().length > 0 && !streaming;
  const submit = (): void => {
    const text = draft.trim();
    if (!text || streaming) return;
    setDraft('');
    onSend?.(text);
    textareaRef.current?.focus();
  };

  const pickAssets = async (): Promise<void> => {
    if (!filePicker) return;
    const picked = await filePicker.pick();
    if (picked.length === 0) return;
    const assets: AttachmentAsset[] = [];
    const rejected: string[] = [];
    for (const file of picked) {
      const verdict = classifyMediaAsset(file);
      if (!verdict.ok) {
        rejected.push(file.name);
        continue;
      }
      if (verdict.kind === 'other') {
        rejected.push(file.name);
        continue;
      }
      assets.push({
        kind: verdict.kind,
        name: file.name,
        mime: file.mime ?? '',
        size: file.size ?? 0,
        url: file.path ?? file.name,
      });
    }
    if (assets.length > 0) onAttachments?.(assets);
    setAttachNote(
      rejected.length > 0
        ? { text: `已拒绝 ${rejected.length} 个文件（${rejected.join('、')} 超限/类型/路径白名单）`, phase: 'fail' }
        : { text: `已发送 ${assets.length} 个文件`, phase: 'success' },
    );
    setTimeout(() => setAttachNote(null), 2600);
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
          className="min-h-7 max-h-36 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[var(--ink-font-sm)] leading-relaxed focus:outline-none placeholder:text-[var(--ink-text-faint)]"
        />
        <div className="flex items-center gap-1.5 px-3 pb-3 pt-1">
          {filePicker && (
            <button
              onClick={() => void pickAssets()}
              title="选择文件"
              data-ui="btn_attach"
              className="ink-btn-secondary flex h-8 w-8 shrink-0 items-center justify-center rounded-full cursor-pointer"
            >
              <Paperclip size={12} strokeWidth={1.8} aria-hidden />
            </button>
          )}
          <span className="ink-chip ink-text-muted">
            <Cpu size={9} strokeWidth={1.8} aria-hidden />
            挡位 {GEAR_LABELS[gear]}
          </span>
          <span className="ink-chip ink-text-muted">模式 {MODE_LABELS[mode]}</span>
          {attachNote && (
            <span
              data-ui="attach_note"
              data-phase={attachNote.phase}
              className={`text-[9px] ${attachNote.phase === 'fail' ? 'ink-accent' : 'ink-text-faint'}`}
            >
              {attachNote.text}
            </span>
          )}
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
