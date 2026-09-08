// gate: 超限(383 行) - 输入胶囊单一渲染面（文本/附件/模型选择联动同一输入态）
/**
 * 输入胶囊（会话主输入面）。
 *
 * 形态（参考桌面 agent 产品空态）：居中 max-w-4xl 大胶囊（近白实底 + 柔发
 * 阴影 + focus-within 光晕抬升），文本区单行起步自适应伸展，控件全部收进
 * 胶囊底排——圆形附件 +、模型/推理档位下拉、右侧大号
 * 圆形发送钮；胶囊下方居中「N 轮 · M 步」回合计数。
 * route_plan 发送前预览置于胶囊上方（已落定语义，不抢占胶囊内空间）。
 * 回合恒为组装：每轮回合 = 从数据组装出本轮执行图再执行（双档切换已取消）。
 */

import { useState, useRef, useEffect } from 'react';
import { ArrowUp, Brain, ChevronDown, Plus, Route, Sparkles, Square, Image, Video, FileText } from 'lucide-react';
import type { ModelArchiveRow, ModelArchiveSnapshot, ModelSelection } from '@/shared/backend/backendAdapter';
import { useT } from '@/i18n/useT';
import { fileToDataUrl, uploadThenAsset } from '@/shared/upload/fileAsset';
import type { RoutePlanResult } from '@/app/shell/shellContracts';

/** 多模态三态归一（壳侧档案标注 true/'true'/unknown）。 */
function isMultimodal(m: ModelArchiveRow): boolean {
  return m.multimodal === true || m.multimodal === 'true';
}

/** 推理档位取值（发送携带；'auto' 仅 UI 用 = 不注入，跟随模型默认）。 */
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';
const REASONING_LEVELS: Array<'auto' | ReasoningEffort> = ['auto', 'off', 'low', 'medium', 'high'];

// 推理能力启发式门控：名字命中以下标记/前缀即视为推理模型（可后续扩展
// 为档案能力标注）。非推理模型不显示档位 chip，避免给不支持端点发多余参数。
const REASONING_ID_MARKERS = [
  'reasoner',
  'reasoning',
  'qwq',
  'qwen3',
  'kimi-thinking',
  'kimi-k2',
  'thinking',
  'glm-z1',
  'glm-4.6',
  'minimax-m1',
  'doubao-thinking',
  'deepseek-r1',
  'gpt-5',
];
function isReasoningModel(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  if (REASONING_ID_MARKERS.some((m) => id.includes(m))) return true;
  return /^(o1|o3|o4)-/.test(id) || /claude-(3-7|sonnet-4|opus-4)/.test(id) || /gemini-2\.5/.test(id);
}

function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
}

interface AttachmentAsset {
  kind: 'image' | 'video' | 'document';
  url: string;
  name: string;
  size: number;
  mime: string;
  /** 服务端落盘路径（serve /upload 回填；宿主 doc.parse/工具取用）。 */
  path?: string;
}

interface InputBarProps {
  disabled?: boolean;
  streaming?: boolean;
  models?: ModelArchiveSnapshot;
  routePlan?: RoutePlanResult;
  /** 会话累计轮数与当前回合步数（胶囊下方居中计数行）。 */
  roundCount?: number;
  stepCount?: number;
  onSend: (text: string, attachments: AttachmentAsset[], model?: ModelSelection) => void;
  onAbort: () => void;
  onAttachments: (files: AttachmentAsset[]) => void;
  /** 发送前路线预览（route_plan 壳命令真调用由装配层执行）。 */
  onRoutePlanPreview?: (text: string) => void;
  /** 当前生效 agent（对话主模型）id（引擎 agent_pick；null = 未配置）。 */
  agentModelId?: string | null;
  /** 输入框改选 agent 模型（装配层写 agent_pick → 引擎重建后刷新本组件）。 */
  onAgentModelSelect?: (modelId: string, providerId?: string) => void;
}

export function InputBar({
  disabled,
  streaming,
  models,
  routePlan,
  onSend,
  onAbort,
  onAttachments,
  onRoutePlanPreview,
  agentModelId,
  onAgentModelSelect,
}: InputBarProps) {
  const { t } = useT();
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<AttachmentAsset[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [reasoningEffort, setReasoningEffort] = useState<'auto' | ReasoningEffort>('auto');
  const reasoningRef = useRef<HTMLDivElement>(null);
  const [reasoningMenuOpen, setReasoningMenuOpen] = useState(false);

  const archives = models?.archives ?? [];
  // 输入框 = agent（对话主模型）槽选择：展示引擎当前 agent_pick，改选即
  // 经 onAgentModelSelect 写 agent_pick（模型须在已添加清单）
  const activeAgent = agentModelId
    ? archives.find((m) => m.model_id === agentModelId) ?? null
    : null;
  const selectedModel =
    activeAgent ?? archives.find((m) => m.model_id === selectedModelId) ?? archives[0];
  const canSend = text.trim().length > 0 && !disabled && !streaming;

  // agent_pick 异步到达/改选后同步选中态（模型档案晚于输入框渲染）
  useEffect(() => {
    if (agentModelId) setSelectedModelId(agentModelId);
  }, [agentModelId]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [modelMenuOpen]);

  useEffect(() => {
    if (!reasoningMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (reasoningRef.current && !reasoningRef.current.contains(e.target as Node)) setReasoningMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [reasoningMenuOpen]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = '0px';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 240)}px`;
    }
  }, [text]);

  const submit = () => {
    if (!canSend) return;
    // 回合恒为组装：发送即从数据组装出本轮执行图再执行（双档切换已取消，
    // 无模式参数）。选定的 agent 模型随发送携带（无默认、无档位——选什么
    // 跑什么；provider 缺省 = 当前唯一连接，宿主 resolve_model_llm fail-open；
    // 推理档位仅显式选择时携带，'auto' = 不注入跟随模型默认）
    onSend(
      text.trim(),
      attachments,
      selectedModel
        ? {
            model_id: selectedModel.model_id,
            ...(reasoningEffort !== 'auto' ? { reasoning_effort: reasoningEffort } : {}),
          }
        : undefined,
    );
    setText('');
    setAttachments([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  /**
   * 附件入载荷：
   * - 图片：FileReader.readAsDataURL → url=data:image/... 直发（对齐引擎
   *   Attachment image_url 段；远端端点不支持多模态时由上层降级文本引用）；
   * - 文档/视频：先经 serve 通道 /upload 落白名单目录，回填可解析的
   *   url/path（宿主 doc.parse 提取文本注入 round）；无 serve URL 时保持
   *   既有占位（blob object URL，仅预览面）。
   */
  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    const mapped: AttachmentAsset[] = [];
    for (const f of files) {
      const kind = f.type.startsWith('image') ? 'image' : f.type.startsWith('video') ? 'video' : 'document';
      const base = { name: f.name, size: f.size, mime: f.type };
      if (kind === 'image') {
        const dataUrl = await fileToDataUrl(f).catch(() => null);
        if (dataUrl !== null) {
          mapped.push({ ...base, kind, url: dataUrl });
          continue;
        }
      }
      const receipt = await uploadThenAsset(f).catch(() => null);
      if (receipt !== null) {
        mapped.push({ ...base, kind, url: receipt.url, path: receipt.path });
      } else {
        mapped.push({ ...base, kind, url: URL.createObjectURL(f) });
      }
    }
    setAttachments((prev) => [...prev, ...mapped]);
    onAttachments(mapped);
    e.target.value = '';
  };

  return (
    <div className="px-5 pb-4 pt-2">
      <div className="mx-auto max-w-4xl">
        {routePlan && (
          <div
            className="mb-2 inline-flex items-center gap-2 rounded-lg border ink-border bg-[var(--ink-bg-surface)] px-2.5 py-1.5 text-[12px] ink-text-muted"
            data-ui="route_plan_preview"
          >
            <Route size={12} strokeWidth={1.6} className="shrink-0 ink-text-faint" />
            <span>{interpolate(t('input.route_plan'), { label: routePlan.chainLabel, quota: routePlan.quota, tier: routePlan.tier })}</span>
          </div>
        )}

        {/* 输入胶囊：附件行 + 文本区 + 底排控件（无内分割线，控件悬浮底排） */}
        <div className="ink-composer pl-4 pr-2.5 pb-2.5 pt-3.5" data-streaming={streaming || undefined}>
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-1 pb-2.5">
              {attachments.map((a, i) => (
                <span key={i} className="ink-chip px-2 py-1 text-[11px]">
                  {a.kind === 'image' && <Image size={11} strokeWidth={1.6} />}
                  {a.kind === 'video' && <Video size={11} strokeWidth={1.6} />}
                  {a.kind === 'document' && <FileText size={11} strokeWidth={1.6} />}
                  {a.name}
                  <button type="button" aria-label={t('input.remove_attachment')} className="ml-0.5 ink-text-faint hover:text-[var(--ink-text-base)]" onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            rows={1}
            className="min-h-[44px] w-full resize-none bg-transparent px-1.5 pb-2 text-[15px] leading-relaxed outline-none placeholder:text-[var(--ink-text-faint)]"
            placeholder={t('input.placeholder')}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              onRoutePlanPreview?.(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            data-ui="input_textarea"
          />

          {/* 底排：附件 + 模型/推理档位（紧凑精致）… 大号圆形发送钮 */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ink-border ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)]"
              title={t('input.add_attachment')}
              data-ui="input_attach"
            >
              <Plus size={15} strokeWidth={1.8} />
            </button>
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFiles} />

            {selectedModel && (
              <div className="relative" ref={modelRef}>
                <button
                  type="button"
                  onClick={() => setModelMenuOpen((v) => !v)}
                  aria-haspopup="menu"
                  aria-expanded={modelMenuOpen}
                  data-ui="input_model_chip"
                  className="flex h-7 items-center gap-1 rounded-lg border ink-border px-2 text-[11px] ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)]"
                >
                  <Sparkles size={12} strokeWidth={1.6} />
                  <span className="max-w-[9rem] truncate">{selectedModel.model_id}</span>
                  {isMultimodal(selectedModel) && <span className="ink-text-faint">{t('input.multimodal')}</span>}
                  <ChevronDown size={12} strokeWidth={1.6} className={`text-[var(--ink-text-faint)] transition-transform ${modelMenuOpen ? 'rotate-180' : ''}`} />
                </button>
                {modelMenuOpen && (
                  <div className="ink-menu-pop ink-menu-pop-left ink-menu-pop-up" role="menu" aria-label={t('input.model_menu')}>
                    {archives.map((m) => (
                      <button
                        key={m.model_id}
                        type="button"
                        role="menuitem"
                        data-active={m.model_id === selectedModel?.model_id}
                        onClick={() => {
                          setSelectedModelId(m.model_id);
                          setReasoningEffort('auto');
                          setReasoningMenuOpen(false);
                          setModelMenuOpen(false);
                          onAgentModelSelect?.(m.model_id, m.provider_id);
                        }}
                        className="ink-menu-item"
                      >
                        <span className="flex-1 truncate">{m.model_id}</span>
                        {isMultimodal(m) && <span className="ink-text-faint">{t('input.multimodal')}</span>}
                        {typeof m.context_window === 'number' && (
                          <span className="ml-2 shrink-0 text-[10px] tabular-nums ink-text-faint">{Math.round(m.context_window / 1024)}k</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {selectedModel && isReasoningModel(selectedModel.model_id) && (
              <div className="relative" ref={reasoningRef}>
                <button
                  type="button"
                  onClick={() => setReasoningMenuOpen((v) => !v)}
                  aria-haspopup="menu"
                  aria-expanded={reasoningMenuOpen}
                  aria-label={t('input.reasoning')}
                  title={t('input.reasoning')}
                  data-ui="input_reasoning_chip"
                  className="flex h-7 items-center gap-1 rounded-lg border ink-border px-2 text-[11px] ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)]"
                >
                  <Brain size={12} strokeWidth={1.6} />
                  <span>{t(`input.reasoning_${reasoningEffort}`)}</span>
                  <ChevronDown size={12} strokeWidth={1.6} className={`text-[var(--ink-text-faint)] transition-transform ${reasoningMenuOpen ? 'rotate-180' : ''}`} />
                </button>
                {reasoningMenuOpen && (
                  <div className="ink-menu-pop ink-menu-pop-left ink-menu-pop-up" role="menu" aria-label={t('input.reasoning')}>
                    {REASONING_LEVELS.map((level) => (
                      <button
                        key={level}
                        type="button"
                        role="menuitem"
                        data-active={level === reasoningEffort}
                        onClick={() => { setReasoningEffort(level); setReasoningMenuOpen(false); }}
                        className="ink-menu-item"
                      >
                        {t(`input.reasoning_${level}`)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <span className="ml-auto flex items-center gap-2.5">
              {text.length > 0 && <span className="text-[11px] tabular-nums ink-text-faint">{interpolate(t('input.char_count'), { n: text.length })}</span>}
              {streaming ? (
                <button
                  type="button"
                  onClick={onAbort}
                  className="flex h-9 w-9 items-center justify-center rounded-full border ink-border ink-text-muted hover:border-[var(--ink-border-strong)] hover:text-[var(--ink-accent-approval)]"
                  title={t('input.abort')}
                  data-ui="input_abort"
                >
                  <Square size={14} strokeWidth={1.8} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={submit}
                  disabled={!canSend}
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--ink-text-base)] text-[var(--ink-bg-base)] shadow-[var(--ink-elev-1)] transition-all hover:-translate-y-px hover:shadow-[var(--ink-elev-2)] disabled:translate-y-0 disabled:opacity-30 disabled:shadow-none"
                  title={t('input.send')}
                  data-ui="input_send"
                >
                  <ArrowUp size={17} strokeWidth={2} />
                </button>
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
