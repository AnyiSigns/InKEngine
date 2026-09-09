// gate: 超限(383 行) - 输入胶囊单一渲染面（文本/附件/模型选择联动同一输入态）
/**
 * 输入胶囊（会话主输入面）。
 *
 * 形态（参考桌面 agent 产品空态）：居中 max-w-4xl 大胶囊（近白实底 + 柔发
 * 阴影 + focus-within 光晕抬升），文本区单行起步自适应伸展，控件全部收进
 * 胶囊底排——圆形附件 +、模型/推理档位下拉、右侧大号
 * 圆形发送钮；胶囊下方居中「N 轮 · M 步」回合计数。
 * 回合恒为组装：每轮回合 = 从数据组装出本轮执行图再执行（双档切换已取消）。
 */

import { useState, useRef, useEffect, useMemo } from 'react';
import { ArrowUp, Brain, ChevronDown, Plus, ShieldCheck, Square, Image, Video, FileText, Zap, ShieldX } from 'lucide-react';
import type { ModelArchiveRow, ModelArchiveSnapshot, ModelSelection } from '@/shared/backend/backendAdapter';
import type { ApprovalPose } from '@/shared/backend/backendAdapter';
import { useT } from '@/i18n/useT';
import { fileToDataUrl, uploadThenAsset } from '@/shared/upload/fileAsset';

/** 多模态三态归一（壳侧档案标注 true/'true'/unknown）。 */
function isMultimodal(m: ModelArchiveRow): boolean {
  return m.multimodal === true || m.multimodal === 'true';
}

/** 推理档位取值（发送携带；原样字符串，含 xhigh/max/minimal 等非标准档）。
 *  'auto' 仅 UI 哨兵 = 不注入，跟随模型默认。 */
export type ReasoningEffort = string;

/** 弹卡档位（输入框三档，统一治理需确认调用；review = 宿主默认）。 */
const POSE_OPTIONS: readonly ApprovalPose[] = ['review', 'auto', 'deny'];
const POSE_ICONS = { review: ShieldCheck, auto: Zap, deny: ShieldX } as const;

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
  /** 会话累计轮数与当前回合步数（胶囊下方居中计数行）。 */
  roundCount?: number;
  stepCount?: number;
  onSend: (text: string, attachments: AttachmentAsset[], model?: ModelSelection) => void;
  onAbort: () => void;
  onAttachments: (files: AttachmentAsset[]) => void;
  /** 当前生效 agent（对话主模型）id（引擎 agent_pick；null = 未配置）。 */
  agentModelId?: string | null;
  /** 输入框改选 agent 模型（装配层写 agent_pick → 引擎重建后刷新本组件）。 */
  onAgentModelSelect?: (modelId: string, providerId?: string) => void;
  /** 当前会话生效弹卡档位（宿主持有：会话覆盖 ?? 默认 review）。 */
  approvalPose?: ApprovalPose;
  /** 弹卡档位切换（宿主写会话覆盖/默认并持久化）。 */
  onApprovalPoseChange?: (pose: ApprovalPose) => void;
}

export function InputBar({
  disabled,
  streaming,
  models,
  onSend,
  onAbort,
  onAttachments,
  agentModelId,
  onAgentModelSelect,
  approvalPose = 'review',
  onApprovalPoseChange,
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
  const [enableThinking, setEnableThinking] = useState<boolean | null>(null);
  const [thinkingBudget, setThinkingBudget] = useState<number | null>(null);
  const reasoningRef = useRef<HTMLDivElement>(null);
  const [reasoningMenuOpen, setReasoningMenuOpen] = useState(false);
  const poseRef = useRef<HTMLDivElement>(null);
  const [poseMenuOpen, setPoseMenuOpen] = useState(false);

  const archives = models?.archives ?? [];
  // 输入框 = agent（对话主模型）槽选择：展示引擎当前 agent_pick，改选即
  // 经 onAgentModelSelect 写 agent_pick（模型须在已添加清单）
  const activeAgent = agentModelId
    ? archives.find((m) => m.model_id === agentModelId) ?? null
    : null;
  const selectedModel =
    activeAgent ?? archives.find((m) => m.model_id === selectedModelId) ?? archives[0];
  const CurrentPoseIcon = POSE_ICONS[approvalPose];

  // 推理控件按模型能力渲染（reasoning_style 四分法，来自档案/元数据/目录）：
  //   effort → 档位下拉（reasoning_efforts 或引擎标准四档；不伪造）
  //   boolean → enable_thinking 开关；budget → token 预算下拉（reasoning_budget）
  //   none/未知 → 不渲染。档位/预算全部来自模型声明，无全局写死档位。
  const reasoningStyle = selectedModel?.reasoning_style;
  const reasoningEffortOptions: Array<'auto' | ReasoningEffort> = useMemo(() => {
    if (reasoningStyle !== 'effort') return [];
    const efforts = selectedModel?.reasoning_efforts?.length
      ? selectedModel.reasoning_efforts
      : (['off', 'low', 'medium', 'high'] as const);
    return ['auto', ...efforts] as Array<'auto' | ReasoningEffort>;
  }, [selectedModel, reasoningStyle]);
  const reasoningBudgetOptions = useMemo(
    () => (reasoningStyle === 'budget' ? (selectedModel?.reasoning_budget ?? []) : []),
    [selectedModel, reasoningStyle],
  );
  const showReasoningCtl =
    selectedModel?.reasoning === true &&
    (reasoningStyle === 'effort' ||
      reasoningStyle === 'boolean' ||
      (reasoningStyle === 'budget' && reasoningBudgetOptions.length > 0));
  const reasoningLabel =
    reasoningStyle === 'boolean'
      ? enableThinking === null
        ? t('input.reasoning_auto')
        : enableThinking
          ? t('input.reasoning_on')
          : t('input.reasoning_off')
      : reasoningStyle === 'budget'
        ? thinkingBudget === null
          ? t('input.reasoning_auto')
          : interpolate(t('input.reasoning_budget'), { n: Math.round(thinkingBudget / 1024) })
        : reasoningEffort !== 'auto'
          ? reasoningEffort
          : t('input.reasoning_auto');
  const canSend = text.trim().length > 0 && !disabled && !streaming;

  // agent_pick 异步到达/改选后同步选中态（模型档案晚于输入框渲染）
  const resetReasoningSelection = () => {
    setReasoningEffort('auto');
    setEnableThinking(null);
    setThinkingBudget(null);
  };
  useEffect(() => {
    if (agentModelId) {
      setSelectedModelId(agentModelId);
      resetReasoningSelection();
    }
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
    if (!poseMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (poseRef.current && !poseRef.current.contains(e.target as Node)) setPoseMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [poseMenuOpen]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = '0px';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 240)}px`;
    }
  }, [text]);

  const submit = () => {
    if (!canSend) return;
    // 回合恒为组装：发送即从数据组装出本轮执行图再执行（双档切换已取消，
    // 无模式参数）。选定的 agent 模型随发送携带；推理控制按模型 reasoning_style
    // 映射 payload（effort→reasoning_effort / boolean→enable_thinking /
    // budget→thinking_budget；未显式选择 = 不注入跟随模型默认）。
    let modelSel: ModelSelection | undefined;
    if (selectedModel) {
      modelSel = { model_id: selectedModel.model_id };
      if (reasoningStyle === 'effort' && reasoningEffort !== 'auto') {
        modelSel.reasoning_effort = reasoningEffort;
      } else if (reasoningStyle === 'boolean' && enableThinking !== null) {
        modelSel.enable_thinking = enableThinking;
      } else if (reasoningStyle === 'budget' && thinkingBudget !== null) {
        modelSel.thinking_budget = thinkingBudget;
      }
    }
    onSend(text.trim(), attachments, modelSel);
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
      <div className="mx-auto max-w-3xl [zoom:0.9]">
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
            onChange={(e) => setText(e.target.value)}
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

            {/* 模型选择（左侧；下拉仅列出，去掉搜索图标/搜索框） */}
            {selectedModel && (
              <div className="relative" ref={modelRef}>
                <button
                  type="button"
                  onClick={() => setModelMenuOpen((v) => !v)}
                  aria-haspopup="listbox"
                  aria-expanded={modelMenuOpen}
                  aria-label={t('input.model_menu')}
                  data-ui="input_model_select"
                  className="flex h-7 items-center gap-1 rounded-md border ink-border px-2 text-[11px] ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)]"
                >
                  <span className="min-w-0 max-w-[9rem] truncate text-left">{selectedModel.model_id}</span>
                  {isMultimodal(selectedModel) && <span className="shrink-0 ink-text-faint">{t('input.multimodal')}</span>}
                  <ChevronDown size={12} strokeWidth={1.6} className={`shrink-0 text-[var(--ink-text-faint)] transition-transform ${modelMenuOpen ? 'rotate-180' : ''}`} />
                </button>
                {modelMenuOpen && (
                  <div className="ink-menu-pop ink-menu-pop-up" role="listbox" aria-label={t('input.model_menu')}>
                    <div className="max-h-56 overflow-y-auto">
                      {archives.map((m) => (
                        <button
                          key={m.model_id}
                          type="button"
                          role="option"
                          aria-selected={m.model_id === selectedModel?.model_id}
                          data-active={m.model_id === selectedModel?.model_id || undefined}
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
                  </div>
                )}
              </div>
            )}

            <span className="ml-auto flex items-center gap-2">
              <div className="relative" ref={poseRef}>
                <button
                  type="button"
                  onClick={() => setPoseMenuOpen((v) => !v)}
                  aria-haspopup="listbox"
                  aria-expanded={poseMenuOpen}
                  aria-label={t('input.pose')}
                  title={t('input.pose_hint')}
                  data-ui="input_pose_filter"
                  className="flex h-7 items-center gap-1 rounded-md border ink-border px-2 text-[11px] ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)]"
                >
                  <CurrentPoseIcon size={12} strokeWidth={1.8} className="shrink-0 ink-text-faint" />
                  <span className="whitespace-nowrap">{t(`input.pose_${approvalPose}`)}</span>
                  <ChevronDown size={12} strokeWidth={1.6} className={`shrink-0 text-[var(--ink-text-faint)] transition-transform ${poseMenuOpen ? 'rotate-180' : ''}`} />
                </button>
                {poseMenuOpen && (
                  <div className="ink-menu-pop ink-menu-pop-up" role="listbox" aria-label={t('input.pose')}>
                    {POSE_OPTIONS.map((pose) => {
                      const OptionIcon = POSE_ICONS[pose];
                      const active = pose === approvalPose;
                      return (
                        <button
                          key={pose}
                          type="button"
                          role="option"
                          aria-selected={active}
                          data-active={active || undefined}
                          onClick={() => {
                            if (!active) onApprovalPoseChange?.(pose);
                            setPoseMenuOpen(false);
                          }}
                          className="ink-menu-item"
                        >
                          <OptionIcon size={12} strokeWidth={1.8} className="shrink-0 ink-text-faint" />
                          <span className="flex-1 text-left">{t(`input.pose_${pose}`)}</span>
                          {active && <span className="shrink-0 ink-text-faint">✓</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {showReasoningCtl && (
                <div className="relative" ref={reasoningRef}>
                  <button
                    type="button"
                    onClick={() => setReasoningMenuOpen((v) => !v)}
                    aria-haspopup="menu"
                    aria-expanded={reasoningMenuOpen}
                    aria-label={t('input.reasoning')}
                    title={t('input.reasoning')}
                    data-ui="input_reasoning_select"
                    className="flex h-7 items-center gap-1 rounded-md border ink-border px-2 text-[11px] ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)]"
                  >
                    <Brain size={12} strokeWidth={1.6} />
                    <span className="whitespace-nowrap">{reasoningLabel}</span>
                    <ChevronDown size={12} strokeWidth={1.6} className={`shrink-0 text-[var(--ink-text-faint)] transition-transform ${reasoningMenuOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {reasoningMenuOpen && (
                    <div className="ink-menu-pop ink-menu-pop-up" role="menu" aria-label={t('input.reasoning')}>
                      {reasoningStyle === 'effort' &&
                        reasoningEffortOptions.map((level) => (
                          <button
                            key={level}
                            type="button"
                            role="menuitem"
                            data-active={level === reasoningEffort}
                            onClick={() => { setReasoningEffort(level); setReasoningMenuOpen(false); }}
                            className="ink-menu-item"
                          >
                            {level === 'auto' ? t('input.reasoning_auto') : level}
                          </button>
                        ))}
                      {reasoningStyle === 'boolean' && (
                        <>
                          <button
                            type="button"
                            role="menuitem"
                            data-active={enableThinking === true}
                            onClick={() => { setEnableThinking(true); setReasoningMenuOpen(false); }}
                            className="ink-menu-item"
                          >
                            {t('input.reasoning_on')}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            data-active={enableThinking === false}
                            onClick={() => { setEnableThinking(false); setReasoningMenuOpen(false); }}
                            className="ink-menu-item"
                          >
                            {t('input.reasoning_off')}
                          </button>
                        </>
                      )}
                      {reasoningStyle === 'budget' && (
                        <>
                          <button
                            type="button"
                            role="menuitem"
                            data-active={thinkingBudget === null}
                            onClick={() => { setThinkingBudget(null); setReasoningMenuOpen(false); }}
                            className="ink-menu-item"
                          >
                            {t('input.reasoning_auto')}
                          </button>
                          {reasoningBudgetOptions.map((budget) => (
                            <button
                              key={budget}
                              type="button"
                              role="menuitem"
                              data-active={thinkingBudget === budget}
                              onClick={() => { setThinkingBudget(budget); setReasoningMenuOpen(false); }}
                              className="ink-menu-item"
                            >
                              {interpolate(t('input.reasoning_budget'), { n: Math.round(budget / 1024) })}
                            </button>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

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
