/**
 * 审批卡（居中弹层，朱砂 accent，任何视图可弹）。
 *
 * 数据源：events.review_card 通道（最近一次审批卡事件）；事件到达即弹层。
 * accent 语义槽纪律：朱砂（accent.approval token）只出现在审批/决策点——
 * 本组件是唯一使用 ink-accent* 语义类的大面组件。
 *
 * 决议（accept/reject/edit/terminate）经 onResolve 注入（宿主接线，
 * 集成期对接引擎 resume 管线）；无宿主回调时本地关闭并留痕，不崩。
 */

import { useEffect, useState } from 'react';
import { Check, Pencil, X } from 'lucide-react';

import type { HubEvent } from '@/shared/session/channelHub';

export type ReviewResolution = 'accept' | 'reject' | 'edit' | 'terminate';

export interface ReviewCardProps {
  bindValue?: unknown;
  onResolve?: (resolution: ReviewResolution, editedContent?: string) => void;
}

interface ReviewData {
  title?: string;
  reason?: string;
  kind?: string;
  level?: string;
  tool?: string;
  content?: string;
}

/** 从事件负载中提取审批卡展示面（脏数据防御：逐字段收敛）。 */
function extractReview(data: Record<string, unknown>): ReviewData {
  const title = typeof data.title === 'string' ? data.title : undefined;
  const reason = typeof data.reason === 'string' ? data.reason : undefined;
  const kind = typeof data.kind === 'string' ? data.kind : undefined;
  const level = typeof data.level === 'string' ? data.level : undefined;
  const tool = typeof data.tool === 'string' ? data.tool : undefined;
  const content = typeof data.content === 'string' ? data.content : undefined;
  return { title, reason, kind, level, tool, content };
}

export function ReviewCard({ bindValue, onResolve }: ReviewCardProps) {
  const event = bindValue as HubEvent | undefined;
  const [visible, setVisible] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');

  // 新审批卡事件到达 → 弹层（任何视图下均弹出）
  useEffect(() => {
    if (event) {
      setVisible(true);
      setEditing(false);
      setEditText('');
    }
  }, [event]);

  if (!visible) return null;

  const data = extractReview((event?.payload ?? {}) as Record<string, unknown>);
  const title = data.title ?? '审批请求';
  const reason = data.reason ?? '';

  const resolve = (resolution: ReviewResolution, editedContent?: string) => {
    setVisible(false);
    onResolve?.(resolution, editedContent);
  };

  return (
    <div className="ink-modal-mask" data-ui="review_modal">
      <div
        role="dialog"
        aria-label="审批卡"
        className="ink-accent-bg w-[420px] max-w-[90vw] p-4"
      >
        <div className="flex items-center gap-2">
          <span className="ink-accent text-xs font-semibold">{title}</span>
          {data.kind ? (
            <span className="border border-[var(--ink-accent-border)] px-1.5 py-px text-[9px] ink-accent">{data.kind}</span>
          ) : null}
          {data.level ? <span className="text-[9px] ink-text-faint">审批档 {data.level}</span> : null}
          {data.tool ? (
            <span className="ml-auto text-[10px] ink-text-faint">工具：{data.tool}</span>
          ) : (
            <button
              onClick={() => resolve('terminate')}
              title="关闭"
              data-ui="review_close"
              className="ml-auto flex h-5 w-5 items-center justify-center ink-text-faint hover:bg-[var(--ink-bg-elevated)] cursor-pointer bg-transparent border-none"
            >
              <X size={11} strokeWidth={1.6} aria-hidden />
            </button>
          )}
        </div>

        {reason && <div className="mt-2 text-[11px] leading-relaxed ink-text-muted">{reason}</div>}

        {editing ? (
          <div className="mt-3 space-y-2">
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              rows={5}
              data-ui="review_edit"
              className="h-28 w-full resize-none border p-2 text-[11px] ink-panel focus:outline-none focus:border-[var(--ink-border-strong)]"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setEditing(false)} className="ink-btn-secondary h-6 px-2 text-[11px] cursor-pointer">
                取消
              </button>
              <button
                onClick={() => resolve('edit', editText)}
                disabled={!editText.trim()}
                data-ui="review_edit_submit"
                className="ink-btn-primary h-6 px-2 text-[11px] cursor-pointer disabled:opacity-40"
              >
                提交修改
              </button>
            </div>
          </div>
        ) : (
          <>
            {data.content && (
              <div className="mt-3 max-h-40 overflow-y-auto border px-2.5 py-2 text-[11px] whitespace-pre-wrap ink-border">
                {data.content}
              </div>
            )}
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => resolve('accept')}
                data-ui="review_accept"
                className="ink-btn-primary flex h-7 flex-1 items-center justify-center gap-1 text-[11px] cursor-pointer"
              >
                <Check size={11} strokeWidth={1.8} aria-hidden /> 确认
              </button>
              <button
                onClick={() => resolve('reject')}
                data-ui="review_reject"
                className="flex h-7 flex-1 items-center justify-center gap-1 border border-[var(--ink-accent-border)] text-[11px] ink-accent cursor-pointer"
              >
                <X size={11} strokeWidth={1.8} aria-hidden /> 拒绝
              </button>
              <button
                onClick={() => {
                  setEditing(true);
                  setEditText(data.content ?? reason);
                }}
                data-ui="review_edit_start"
                className="ink-btn-secondary flex h-7 flex-1 items-center justify-center gap-1 text-[11px] cursor-pointer"
              >
                <Pencil size={11} strokeWidth={1.8} aria-hidden /> 编辑
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
