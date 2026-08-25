/**
 * 输入框（对话主区底部）：发送/停止 + 「选择文件/粘贴图片」附件入口 + 模式提示。
 *
 * 附件管线：可注入文件拾取器（或粘贴板图片）→ 媒体策略分发（图片/视频/文档
 * → 资产，其余拒绝并提示）→ 暂存预览（不立即落位，待发送随消息载荷同行）→
 * 发送时按当前模型多模态能力决定走向：
 *   · 多模态模型：附件以引擎 Attachment 契约形态随消息载荷直发；
 *   · 非多模态模型：降级为文本引用（列出附件名/地址），并提示需切多模态模型，
 *     结构化附件不入载荷（避免引擎以非多模态形态误吞二进制）。
 * 禁联真实 IPC：一律经可注入接口 + 夹具；发送动作与模型档案均经 props 注入。
 * 草稿经可注入界面状态存储持久（主题/视图切换不丢上下文）；暂存附件随会话键清理。
 */

import { useEffect, useRef, useState, type ClipboardEvent } from 'react';

import { Cpu, FileText, Image as ImageIcon, Paperclip, Send, Square } from 'lucide-react';

import type { GearTier, ModeTier } from '@/shared/session/types';
import type { AttachmentAsset } from '@/shared/session/eventIngest';
import type { ModelProfile } from '@/shared/backend/backendAdapter';
import type { FilePicker, PickedFile } from '@/shared/media/filePicker';
import { createDomFilePicker } from '@/shared/media/filePicker';
import { classifyMediaAsset, formatByteSize, isAttachmentPreviewUrl } from '@/shared/media/mediaPolicy';
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
  /** 发送（文本 + 随附附件；非多模态模型下调为文本引用，附件为空） */
  onSend?: (text: string, attachments?: AttachmentAsset[]) => void;
  onAbort?: () => void;
  /** 附件回调（宿主接线：资产经媒体策略分发后的盘面通知，不负责落位） */
  onAttachments?: (assets: AttachmentAsset[]) => void;
  /** 可注入文件拾取器（缺省 DOM 实现；null = 隐藏入口） */
  filePicker?: FilePicker | null;
  /** 会话键（草稿持久化作用域） */
  sessionKey?: string;
  /** 模型档案清单（按挡位分组；缺省回落假数据） */
  models?: ModelProfile[];
  /** 预设选中模型 id */
  selectedModel?: string;
  /** 切换回调（宿主接线：占用/上限联动） */
  onModelSelect?: (id: string) => void;
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
  models,
  selectedModel,
  onModelSelect,
}: AgentInputProps) {
  const [draft, setDraft] = useUiState<string>(`agent_input.draft.${sessionKey}`, '');
  const [attachNote, setAttachNote] = useState<{ text: string; phase: 'success' | 'fail' } | null>(null);
  const [staged, setStaged] = useState<AttachmentAsset[]>([]);
  const [degradeHint, setDegradeHint] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const data = (bindValue as AgentInputBindValue | undefined) ?? {};
  const streaming = data.streaming === true;
  const gear = data.activeGear ?? 'main';
  const mode = data.modeTier ?? 'default';

  // 暂存附件提示是轻量瞬时态：组件卸载（含测试拆卸）时清掉待触发的定时器，
  // 避免环境回收后回调落到已销毁的 jsdom 上（window 引用缺失的未捕获异常）。
  useEffect(() => () => {
    if (noteTimer.current) clearTimeout(noteTimer.current);
  }, []);

  // 模型选择器：档案清单按挡位分组；无宿主数据回落假数据
  const FALLBACK_MODELS: ModelProfile[] = [
    { id: 'main-pro', name: '主模型·专业', tier: 'main', occupancy: 3, limit: 10 },
    { id: 'main-lite', name: '主模型·轻量', tier: 'main', occupancy: 1, limit: 10 },
    { id: 'router-fast', name: '制片人·快', tier: 'router', occupancy: 0, limit: 5 },
  ];
  const modelList = models ?? FALLBACK_MODELS;
  const [modelId, setModelId] = useState<string>(selectedModel ?? modelList[0]?.id ?? '');
  const selectedModelObj = modelList.find((m) => m.id === modelId);
  const tierGroups = new Map<string, ModelProfile[]>();
  for (const m of modelList) {
    const group = tierGroups.get(m.tier) ?? [];
    group.push(m);
    tierGroups.set(m.tier, group);
  }
  const onModelChange = (id: string): void => {
    setModelId(id);
    onModelSelect?.(id);
  };

  const canSend = (draft.trim().length > 0 || staged.length > 0) && !streaming;

  const submit = (): void => {
    const text = draft.trim();
    if ((!text && staged.length === 0) || streaming) return;
    const multimodal = selectedModelObj?.multimodal === true;
    // 非多模态模型接附件 → 降级：文本引用 + 提示；结构化附件不入载荷。
    if (!multimodal && staged.length > 0) {
      const refs = staged.map((a) => `[附件·${a.kind}] ${a.name}（${a.url ?? '无引用'}）`).join('\n');
      const degraded = text ? `${text}\n${refs}` : refs;
      setDraft('');
      setStaged([]);
      setDegradeHint('当前模型非多模态，附件已转为文本引用；切换到多模态模型以直发原附件');
      onSend?.(degraded, []);
      textareaRef.current?.focus();
      return;
    }
    // 多模态（或无附件）：直发，附件以引擎 Attachment 契约形态随载荷同行。
    setDraft('');
    onSend?.(text, staged);
    setStaged([]);
    setDegradeHint(null);
    textareaRef.current?.focus();
  };

  const stageAssets = (files: PickedFile[]): void => {
    if (files.length === 0) return;
    const assets: AttachmentAsset[] = [];
    const rejected: string[] = [];
    for (const file of files) {
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
    if (assets.length > 0) setStaged((prev) => [...prev, ...assets]);
    if (assets.length > 0) onAttachments?.(assets);
    setAttachNote(
      rejected.length > 0
        ? { text: `已拒绝 ${rejected.length} 个文件（${rejected.join('、')} 超限/类型/路径白名单）`, phase: 'fail' }
        : assets.length > 0
          ? { text: `已暂存 ${assets.length} 个文件（随发送同行）`, phase: 'success' }
          : null,
    );
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setAttachNote(null), 2600);
  };

  const pickAssets = async (): Promise<void> => {
    if (!filePicker) return;
    const picked = await filePicker.pick();
    stageAssets(picked);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = event.clipboardData?.files;
    if (!items || items.length === 0) return;
    const files: PickedFile[] = Array.from(items).map((file, index) => {
      const name = file.name || `粘贴图片-${index + 1}.png`;
      const url = typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(file) : name;
      return { name, mime: file.type || 'image/png', size: file.size, path: url };
    });
    stageAssets(files);
  };

  const removeStaged = (name: string): void => {
    setStaged((prev) => prev.filter((a) => a.name !== name));
  };

  return (
    <div className="shrink-0 px-5 pb-4 pt-1">
      <div className="ink-input-shell mx-auto w-full max-w-3xl rounded-2xl border bg-[var(--ink-bg-surface)] transition-colors focus-within:border-[var(--ink-border-strong)]">
        <textarea
          ref={textareaRef}
          data-ui="agent_input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={handlePaste}
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
        {staged.length > 0 && (
          <div data-ui="attach_preview" className="flex flex-wrap gap-1.5 px-4 pb-2">
            {staged.map((asset) => (
              <span
                key={`${asset.name}-${asset.url}`}
                data-ui="attach_preview_item"
                data-kind={asset.kind}
                className="ink-chip flex items-center gap-1.5 ink-text-muted"
              >
                {asset.kind === 'image' && isAttachmentPreviewUrl(asset.url ?? '') ? (
                  <img src={asset.url} alt={asset.name} className="h-4 w-4 rounded object-cover" />
                ) : asset.kind === 'image' ? (
                  <ImageIcon size={10} strokeWidth={1.8} aria-hidden />
                ) : (
                  <FileText size={10} strokeWidth={1.8} aria-hidden />
                )}
                <span className="max-w-[10rem] truncate text-[9px]">{asset.name}</span>
                {asset.size !== undefined && asset.kind !== 'image' && (
                  <span className="font-mono text-[8px] ink-text-faint">{formatByteSize(asset.size)}</span>
                )}
                <button
                  type="button"
                  title="移除附件"
                  data-ui="attach_remove"
                  onClick={() => removeStaged(asset.name)}
                  className="cursor-pointer ink-text-faint hover:text-[var(--ink-text-base)]"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
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
          <span className="ink-chip ink-text-muted" data-ui="model_selector">
            <select
              aria-label="模型选择"
              data-ui="model_select"
              value={modelId}
              onChange={(e) => onModelChange(e.target.value)}
              className="bg-transparent text-[9px] outline-none ink-text-muted"
            >
              {[...tierGroups.entries()].map(([tier, list]) => (
                <optgroup key={tier} label={`挡位 ${tier}`}>
                  {list.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </span>
          {selectedModelObj ? (
            <span className="ink-chip ink-text-faint" data-ui="model_occupancy">
              占用 {selectedModelObj.occupancy}/{selectedModelObj.limit}
            </span>
          ) : null}
          {attachNote && (
            <span
              data-ui="attach_note"
              data-phase={attachNote.phase}
              className={`text-[9px] ${attachNote.phase === 'fail' ? 'ink-accent' : 'ink-text-faint'}`}
            >
              {attachNote.text}
            </span>
          )}
          {degradeHint && (
            <span
              data-ui="attach_hint"
              data-mode="degraded"
              className="text-[9px] ink-accent"
            >
              {degradeHint}
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
