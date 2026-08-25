/**
 * 正文条目（user / assistant / system / streaming）。
 *
 * 视觉层 = opaque（不透明）：用户侧实底气泡（深色渐变 + 软影），
 * 助手/系统侧纸面正文（Markdown 消毒渲染）。流式正文带呼吸光标 +
 * 节流绘制（token 逐片追加，节流只压重绘频率不动内容）。
 * hover 操作菜单：编辑重发 / 由此分支（放悬浮窗，单步动作内联）。
 */

import { memo } from 'react';

import { FileText, GitBranch, Image as ImageIcon, MessageSquarePlus } from 'lucide-react';

import type { InkStreamingMessage, InkTextMessage } from '@/shared/session/types';
import { isAttachmentPreviewUrl } from '@/shared/media/mediaPolicy';
import { MarkdownText } from './markdown_text';
import { useThrottledValue } from './streaming_throttle';
import type { MessageHoverAction } from './message_renderers';

interface TextEntryProps {
  message: InkTextMessage;
  onOpenAction?: (action: MessageHoverAction) => void;
}

/** 用户消息内的附件内联展示（图片缩略 / 文档名芯片；危险协议回落占位）。 */
function InlineAttachments({ attachments }: { attachments: NonNullable<InkTextMessage['attachments']> }) {
  return (
    <div data-ui="msg_attachments" className="mt-2 flex flex-wrap gap-1.5">
      {attachments.map((att, index) => {
        const displayable = isAttachmentPreviewUrl(att.url);
        if (att.kind === 'image') {
          return displayable ? (
            <img
              key={`${att.url}-${index}`}
              src={att.url}
              alt={att.alt ?? att.name ?? '附件图片'}
              data-ui="msg_attachment_image"
              className="max-h-32 max-w-[12rem] rounded-[var(--ink-radius-md)] border border-[var(--ink-border)] object-cover"
            />
          ) : (
            <span key={`${att.url}-${index}`} data-ui="msg_attachment_rejected" className="ink-chip ink-text-faint">
              <ImageIcon size={10} strokeWidth={1.8} aria-hidden /> 图片地址协议不在白名单内
            </span>
          );
        }
        return (
          <span key={`${att.url}-${index}`} data-ui="msg_attachment_doc" className="ink-chip flex items-center gap-1.5 ink-text-muted">
            <FileText size={10} strokeWidth={1.8} aria-hidden />
            <span className="max-w-[10rem] truncate text-[9px]">{att.name ?? att.url}</span>
          </span>
        );
      })}
    </div>
  );
}

export const TextEntry = memo(function TextEntry({ message, onOpenAction }: TextEntryProps) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="group relative max-w-[85%]">
          <div className="ink-bubble-user px-4 py-2.5 text-[var(--ink-font-sm)] leading-[var(--ink-lh-body)] whitespace-pre-wrap break-words">
            {message.content}
            {message.attachments && message.attachments.length > 0 && <InlineAttachments attachments={message.attachments} />}
          </div>
          <HoverActions message={message} onOpenAction={onOpenAction} />
        </div>
      </div>
    );
  }
  return (
    <div className="group relative px-0.5">
      <MarkdownText
        text={message.content}
        className="text-[var(--ink-font-sm)] leading-[1.75] break-words"
      />
      <HoverActions message={message} onOpenAction={onOpenAction} />
    </div>
  );
});

function HoverActions({ message, onOpenAction }: { message: InkTextMessage; onOpenAction?: (action: MessageHoverAction) => void }) {
  if (!onOpenAction) return null;
  return (
    <div className="pointer-events-none absolute top-0 right-0 flex translate-y-0.5 gap-1 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100">
      <button
        title="编辑重发"
        data-ui="msg_action_resend"
        onClick={() => onOpenAction({ kind: 'resend', message })}
        className="ink-chip cursor-pointer ink-text-muted hover:text-[var(--ink-text-base)]"
      >
        <MessageSquarePlus size={10} strokeWidth={1.8} aria-hidden /> 编辑重发
      </button>
      <button
        title="由此分支"
        data-ui="msg_action_branch"
        onClick={() => onOpenAction({ kind: 'branch', message })}
        className="ink-chip cursor-pointer ink-text-muted hover:text-[var(--ink-text-base)]"
      >
        <GitBranch size={10} strokeWidth={1.8} aria-hidden /> 由此分支
      </button>
    </div>
  );
}

interface StreamingEntryProps {
  message: InkStreamingMessage;
  throttleMs: number;
}

/** 流式正文条目：节流绘制 + 朱砂呼吸光标（进行中生命感）。 */
export const StreamingEntry = memo(function StreamingEntry({ message, throttleMs }: StreamingEntryProps) {
  const content = useThrottledValue(message.content, throttleMs);
  return (
    <div className="px-0.5 text-[var(--ink-font-sm)] leading-[1.75] whitespace-pre-wrap break-words">
      {content}
      <span className="ink-caret-muted" aria-hidden />
    </div>
  );
});
