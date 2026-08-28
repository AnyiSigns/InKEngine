/**
 * 输入行：模型选择器 + 回合模式选择器 + 附件 + 输入区 + 发送/中止。
 * 非实心形态：surface 半透明 ≤20% + hairline + 聚焦 --ink-border-strong（禁 accent）
 * + 圆角 12 + 高 44-56px + placeholder 墨灰 + 流式呼吸微动画。
 */

import { useState, useRef, useEffect } from 'react';
import { Send, Square, Paperclip, Settings2, Sparkles, Image, Video, FileText } from 'lucide-react';
import type { ModelArchiveSnapshot } from '@/shared/backend/backendAdapter';

interface AttachmentAsset {
  kind: 'image' | 'video' | 'document';
  url: string;
  name: string;
  size: number;
  mime: string;
}

export interface RoutePlanResult {
  chainLabel: string;
  quota: number;
  tier: string;
}

interface InputBarProps {
  disabled?: boolean;
  streaming?: boolean;
  models?: ModelArchiveSnapshot;
  routePlan?: RoutePlanResult;
  onSend: (text: string, attachments?: AttachmentAsset[]) => void;
  onAbort: () => void;
  onOpenSettings: () => void;
  onAttachments: (files: AttachmentAsset[]) => void;
}

export function InputBar({
  disabled,
  streaming,
  models,
  routePlan,
  onSend,
  onAbort,
  onOpenSettings,
  onAttachments,
}: InputBarProps) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<AttachmentAsset[]>([]);
  const [mode, setMode] = useState<'standard' | 'assembly'>('standard');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedModel = models?.profiles[0];
  const canSend = text.trim().length > 0 && !disabled && !streaming;

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = '0px';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
    }
  }, [text]);

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim(), attachments);
    setText('');
    setAttachments([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const handleFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    const mapped: AttachmentAsset[] = files.map((f) => ({
      kind: f.type.startsWith('image') ? 'image' : f.type.startsWith('video') ? 'video' : 'document',
      url: URL.createObjectURL(f),
      name: f.name,
      size: f.size,
      mime: f.type,
    }));
    setAttachments((prev) => [...prev, ...mapped]);
    onAttachments(mapped);
    e.target.value = '';
  };

  return (
    <div className="border-t ink-border bg-[var(--ink-bg-base)] p-3">
      <div className="mx-auto max-w-3xl space-y-2">
        {!selectedModel && (
          <div className="flex items-center justify-between rounded-lg border border-dashed ink-border px-3 py-2 text-xs ink-text-muted">
            <span>请先配置模型</span>
            <button type="button" onClick={onOpenSettings} className="flex items-center gap-1 text-[var(--ink-accent-approval)] hover:underline">
              <Settings2 size={12} strokeWidth={1.5} /> 前往设置
            </button>
          </div>
        )}

        {routePlan && (
          <div className="flex items-center gap-2 text-xs ink-text-faint">
            <span>将走 {routePlan.chainLabel} · 配额 {routePlan.quota} · 推演 {routePlan.tier}</span>
          </div>
        )}

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((a, i) => (
              <span key={i} className="ink-chip text-[10px]">
                {a.kind === 'image' && <Image size={10} strokeWidth={1.5} />}
                {a.kind === 'video' && <Video size={10} strokeWidth={1.5} />}
                {a.kind === 'document' && <FileText size={10} strokeWidth={1.5} />}
                {a.name}
                <button type="button" className="ml-1 ink-text-faint hover:text-[var(--ink-text-base)]" onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <div
          className={`flex items-end gap-2 rounded-xl border px-3 py-2 transition-all duration-150 ${
            streaming ? 'ink-border-strong ink-caret-muted' : 'ink-border'
          }`}
          style={{ background: 'color-mix(in srgb, var(--ink-text-base) 6%, transparent)', borderRadius: 12 }}
        >
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex h-7 w-7 items-center justify-center rounded-md ink-text-muted hover:text-[var(--ink-text-base)] hover:bg-[var(--ink-bg-elevated)]"
              title="附件"
            >
              <Paperclip size={16} strokeWidth={1.5} />
            </button>
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFiles} />
          </div>

          <textarea
            ref={textareaRef}
            rows={1}
            className="flex-1 resize-none bg-transparent py-1 text-sm outline-none placeholder:text-[var(--ink-text-faint)]"
            placeholder={selectedModel ? '输入消息…' : '请先配置模型'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled || !selectedModel}
          />

          <div className="flex items-center gap-1">
            {streaming ? (
              <button type="button" onClick={onAbort} className="flex h-8 w-8 items-center justify-center rounded-lg ink-text-muted hover:text-[var(--ink-accent-approval)]" title="中止">
                <Square size={16} strokeWidth={1.5} />
              </button>
            ) : (
              <button type="button" onClick={submit} disabled={!canSend} className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--ink-text-base)] text-[var(--ink-bg-base)] disabled:opacity-40" title="发送">
                <Send size={16} strokeWidth={1.5} />
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="ink-seg">
              <button type="button" data-active={mode === 'standard'} onClick={() => setMode('standard')} className="ink-seg-item" disabled={streaming}>
                标准
              </button>
              <button type="button" data-active={mode === 'assembly'} onClick={() => setMode('assembly')} className="ink-seg-item" disabled={streaming}>
                组装
              </button>
            </div>
            {selectedModel && (
              <span className="ink-chip text-[10px]">
                <Sparkles size={10} strokeWidth={1.5} />
                {selectedModel.name}
                <span className="ml-1 rounded-full bg-[var(--ink-bg-elevated)] px-1 text-[9px]">{selectedModel.tier}</span>
                {selectedModel.multimodal && <span className="ml-1 text-[9px]">多模态</span>}
              </span>
            )}
          </div>
          <span className="text-[10px] ink-text-faint">{text.length > 0 ? `${text.length} 字` : ''}</span>
        </div>
      </div>
    </div>
  );
}
