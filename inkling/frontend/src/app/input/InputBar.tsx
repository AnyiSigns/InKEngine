/**
 * 输入胶囊（会话主输入面）。
 *
 * 形态：居中 max-w-3xl 单颗胶囊（surface 实底 + hairline + focus-within
 * 抬升），控件全部收进胶囊底排——附件 +、标准|组装分段、模型 chip、
 * 圆形发送钮；胶囊下方居中「N 轮 · M 步」回合计数。
 * route_plan 发送前预览置于胶囊上方（已落定语义，不抢占胶囊内空间）。
 */

import { useState, useRef, useEffect } from 'react';
import { ArrowUp, Loader2, Mic, Plus, Square, Settings2, Sparkles, Image, Video, FileText } from 'lucide-react';
import type { ModelArchiveSnapshot } from '@/shared/backend/backendAdapter';
import { createTauriInvoker } from '@/shared/backend/tauriBridge';

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
  /** 会话累计轮数与当前回合步数（胶囊下方居中计数行）。 */
  roundCount?: number;
  stepCount?: number;
  onSend: (text: string, attachments: AttachmentAsset[], mode: 'standard' | 'assembly') => void;
  onAbort: () => void;
  onOpenSettings: () => void;
  onAttachments: (files: AttachmentAsset[]) => void;
  /** 回合模式切换（组装=path.set_assembler_enabled 真透传由装配层执行）。 */
  onModeChange?: (mode: 'standard' | 'assembly') => void;
  /** 发送前路线预览（route_plan 壳命令真调用由装配层执行）。 */
  onRoutePlanPreview?: (text: string) => void;
}

export function InputBar({
  disabled,
  streaming,
  models,
  routePlan,
  roundCount = 0,
  stepCount = 0,
  onSend,
  onAbort,
  onOpenSettings,
  onAttachments,
  onModeChange,
  onRoutePlanPreview,
}: InputBarProps) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<AttachmentAsset[]>([]);
  const [mode, setMode] = useState<'standard' | 'assembly'>('standard');
  // 语音输入：capability=可用性探测；recording/transcribing=进行中态
  const [voiceCapable, setVoiceCapable] = useState(false);
  const [voicePhase, setVoicePhase] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedModel = models?.profiles[0];
  const canSend = text.trim().length > 0 && !disabled && !streaming;

  useEffect(() => {
    const tauri = createTauriInvoker();
    if (!tauri) return;
    void tauri
      .invoke('voice_status', {})
      .then((s) => {
        const status = s as { mic?: boolean; stt?: boolean };
        setVoiceCapable(Boolean(status.mic && status.stt));
      })
      .catch(() => setVoiceCapable(false));
  }, []);

  /** 语音输入：录音（定长 5s）→ 转写 → 文本入输入框（直发 AI 的入口在胶囊而非管理台）。 */
  const handleVoice = () => {
    const tauri = createTauriInvoker();
    if (!tauri || voicePhase !== 'idle') return;
    setVoicePhase('recording');
    void (async () => {
      try {
        const audio = (await tauri.invoke('voice_record', { durationMs: 5000 })) as number[];
        setVoicePhase('transcribing');
        const result = (await tauri.invoke('voice_transcribe', { audio })) as { text?: string };
        const spoken = (result.text ?? '').trim();
        if (spoken) {
          setText((prev) => (prev.trim() ? `${prev.trimEnd()} ${spoken}` : spoken));
          onRoutePlanPreview?.(spoken);
        }
      } catch {
        // 录音/转写失败：回落静默（语音能力状态在设置「应用能力」可见）
      } finally {
        setVoicePhase('idle');
      }
    })();
  };

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = '0px';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
    }
  }, [text]);

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim(), attachments, mode);
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

  const switchMode = (next: 'standard' | 'assembly') => {
    setMode(next);
    onModeChange?.(next);
  };

  return (
    <div className="bg-[var(--ink-bg-base)] px-4 pb-3 pt-2">
      <div className="mx-auto max-w-3xl">
        {!selectedModel && (
          <div className="mb-2 flex items-center justify-between rounded-xl border border-dashed ink-border px-3.5 py-2 text-[12px] ink-text-muted">
            <span>请先配置模型</span>
            <button type="button" onClick={onOpenSettings} className="flex items-center gap-1 font-medium hover:underline" data-ui="input_goto_settings">
              <Settings2 size={12} strokeWidth={1.6} /> 前往设置
            </button>
          </div>
        )}

        {routePlan && (
          <div className="mb-1.5 flex items-center gap-2 px-1 text-[11px] ink-text-faint" data-ui="route_plan_preview">
            <span>将走 {routePlan.chainLabel} · 配额 {routePlan.quota} · 推演 {routePlan.tier}</span>
          </div>
        )}

        {/* 输入胶囊：附件行 + 文本区 + 底排控件 */}
        <div className="ink-composer px-3 pb-2 pt-2.5" data-streaming={streaming || undefined}>
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-1 pb-2">
              {attachments.map((a, i) => (
                <span key={i} className="ink-chip text-[11px]">
                  {a.kind === 'image' && <Image size={11} strokeWidth={1.6} />}
                  {a.kind === 'video' && <Video size={11} strokeWidth={1.6} />}
                  {a.kind === 'document' && <FileText size={11} strokeWidth={1.6} />}
                  {a.name}
                  <button type="button" aria-label="移除附件" className="ml-0.5 ink-text-faint hover:text-[var(--ink-text-base)]" onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            rows={1}
            className="w-full resize-none bg-transparent px-1 pb-1.5 text-[14px] leading-relaxed outline-none placeholder:text-[var(--ink-text-faint)]"
            placeholder={selectedModel ? '给智能体发消息' : '请先配置模型'}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              onRoutePlanPreview?.(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            disabled={disabled || !selectedModel}
            data-ui="input_textarea"
          />

          {/* 底排：附件 + 模式分段 + 模型 chip … 发送钮 */}
          <div className="flex items-center gap-2 border-t border-[var(--ink-border)] pt-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)]"
              title="添加附件"
              data-ui="input_attach"
            >
              <Plus size={17} strokeWidth={1.8} />
            </button>
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFiles} />

            {voiceCapable && (
              <button
                type="button"
                onClick={handleVoice}
                disabled={voicePhase !== 'idle' || disabled}
                className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors ${
                  voicePhase === 'recording'
                    ? 'text-[var(--ink-accent-approval)]'
                    : 'ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)]'
                }`}
                title={voicePhase === 'recording' ? '录音中（5s）…' : voicePhase === 'transcribing' ? '转写中…' : '语音输入'}
                data-ui="input_voice"
                data-phase={voicePhase}
              >
                {voicePhase === 'transcribing' ? (
                  <Loader2 size={16} strokeWidth={1.8} className="animate-spin" />
                ) : (
                  <Mic size={16} strokeWidth={1.8} />
                )}
                {voicePhase === 'recording' && (
                  <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--ink-accent-approval)] animate-ping" />
                )}
              </button>
            )}

            <div className="ink-seg" role="radiogroup" aria-label="回合模式">
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'standard'}
                data-active={mode === 'standard'}
                data-ui="mode_standard"
                onClick={() => switchMode('standard')}
                className="ink-seg-item"
                disabled={streaming}
              >
                标准
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'assembly'}
                data-active={mode === 'assembly'}
                data-ui="mode_assembly"
                onClick={() => switchMode('assembly')}
                className="ink-seg-item"
                disabled={streaming}
              >
                组装
              </button>
            </div>

            {selectedModel && (
              <span className="ink-chip text-[11px]" data-ui="input_model_chip">
                <Sparkles size={11} strokeWidth={1.6} />
                {selectedModel.name}
                {selectedModel.multimodal && <span className="ink-text-faint">多模态</span>}
              </span>
            )}

            <span className="ml-auto flex items-center gap-2">
              {text.length > 0 && <span className="text-[11px] tabular-nums ink-text-faint">{text.length} 字</span>}
              {streaming ? (
                <button
                  type="button"
                  onClick={onAbort}
                  className="flex h-8 w-8 items-center justify-center rounded-full border ink-border ink-text-muted hover:text-[var(--ink-accent-approval)]"
                  title="中止"
                  data-ui="input_abort"
                >
                  <Square size={14} strokeWidth={1.8} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={submit}
                  disabled={!canSend}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--ink-text-base)] text-[var(--ink-bg-base)] transition-all hover:opacity-90 disabled:opacity-30"
                  title="发送"
                  data-ui="input_send"
                >
                  <ArrowUp size={16} strokeWidth={2} />
                </button>
              )}
            </span>
          </div>
        </div>

        {/* 回合计数行（胶囊下方居中） */}
        <div className="pt-1.5 text-center text-[11px] tabular-nums ink-text-faint" data-ui="round_step_counter">
          {roundCount} 轮 · {stepCount} 步
        </div>
      </div>
    </div>
  );
}
