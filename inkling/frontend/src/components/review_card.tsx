/**
 * 审批卡（悬浮窗承载，朱砂 accent，任何视图可弹）。
 *
 * 数据源：events.review_card 通道（最近一次审批卡事件）；事件到达即弹出。
 * 弹窗容器 = 悬浮窗工厂（可拖拽/可缩放/可关闭）；朱砂语义槽只出现在
 * 审批/决策点——本组件是唯一使用 ink-accent* 大面语义的组件。
 * 决议（accept/reject/edit/terminate）经 onResolve 注入（宿主接线，
 * 集成期对接引擎 resume 管线）；无宿主回调时本地关闭并留痕，不崩。
 */

import { useEffect, useState } from 'react';
import { Check, Pencil, X } from 'lucide-react';

import type { HubEvent } from '@/shared/session/channelHub';
import { Button } from '@/shared/ui/Button';
import { FloaterWindow } from '@/components/floaters/floater_window';

export type ReviewResolution = 'accept' | 'reject' | 'edit' | 'terminate';

export interface ReviewCardProps {
  bindValue?: unknown;
  onResolve?: (
    resolution: ReviewResolution,
    editedContent?: string,
  ) => void;
}

interface ReviewData {
  title?: string;
  reason?: string;
  kind?: string;
  level?: string;
  tool?: string;
  content?: string;
  action?: Record<string, unknown>;
}

/** 从事件负载中提取审批卡展示面（脏数据防御：逐字段收敛）。 */
function extractReview(data: Record<string, unknown>): ReviewData {
  const title = typeof data.title === 'string' ? data.title : undefined;
  const reason = typeof data.reason === 'string' ? data.reason : undefined;
  const kind = typeof data.kind === 'string' ? data.kind : undefined;
  const level = typeof data.level === 'string' ? data.level : undefined;
  const action =
    data.action && typeof data.action === 'object'
      ? (data.action as Record<string, unknown>)
      : undefined;
  const tool =
    typeof data.tool === 'string'
      ? data.tool
      : typeof action?.tool === 'string'
        ? action.tool
        : undefined;
  const content = typeof data.content === 'string' ? data.content : undefined;
  return { title, reason, kind, level, tool, content, action };
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

  const resolve = (resolution: ReviewResolution, editedContent?: string): void => {
    setVisible(false);
    onResolve?.(resolution, editedContent);
  };

  return (
    <FloaterWindow
      title={title}
      floaterKey="review_card"
      onClose={() => resolve('terminate')}
      initialRect={{ x: 160, y: 110, width: 440, height: 300 }}
      className="ink-accent-bg"
      dataUi="review_modal"
    >
      <div className="flex h-full flex-col p-4">
          <div className="flex items-center gap-2.5">
            <span className="ink-live-dot ink-accent" aria-hidden />
            {data.kind ? (
              <span className="rounded-md border border-[var(--ink-accent-border)] px-1.5 py-px text-[9px] ink-accent">{data.kind}</span>
            ) : null}
            {data.level ? <span className="text-[9px] ink-text-faint">审批档 {data.level}</span> : null}
            {data.tool ? (
              <span className="ml-auto text-[10px] ink-text-faint">工具：{data.tool}</span>
            ) : (
              <button
                data-ui="review_close"
                title="关闭"
                onClick={() => resolve('terminate')}
                className="ml-auto flex h-5 w-5 items-center justify-center rounded-md bg-transparent border-none cursor-pointer ink-text-faint hover:bg-[var(--ink-bg-elevated)]"
              >
                <X size={11} strokeWidth={1.6} aria-hidden />
              </button>
            )}
          </div>

          {reason && <div className="mt-2.5 text-[11px] leading-relaxed ink-text-muted">{reason}</div>}

          {editing ? (
            <div className="mt-3 flex min-h-0 flex-1 flex-col space-y-2.5">
              <textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                rows={5}
                data-ui="review_edit"
                className="ink-input min-h-20 w-full flex-1 resize-none py-2 leading-relaxed"
              />
              <div className="flex justify-end gap-2">
                <Button size="xs" variant="secondary" onClick={() => setEditing(false)}>取消</Button>
                <Button
                  size="xs"
                  variant="primary"
                  onClick={() => resolve('edit', editText)}
                  disabled={!editText.trim()}
                  data-ui="review_edit_submit"
                >
                  提交修改
                </Button>
              </div>
            </div>
          ) : (
            <>
              {data.content && (
                <div className="mt-3 max-h-36 flex-1 overflow-y-auto rounded-xl border bg-[var(--ink-bg-base)] px-3 py-2.5 text-[11px] leading-relaxed whitespace-pre-wrap ink-border">
                  {data.content}
                </div>
              )}
              <div className="mt-4 flex gap-2">
                <Button
                  size="md"
                  variant="accent"
                  className="flex-1"
                  onClick={() => resolve('accept')}
                  data-ui="review_accept"
                >
                  <Check size={12} strokeWidth={1.8} aria-hidden /> 确认
                </Button>
                <Button
                  size="md"
                  className="flex-1"
                  onClick={() => resolve('reject')}
                  data-ui="review_reject"
                >
                  <X size={12} strokeWidth={1.8} aria-hidden /> 拒绝
                </Button>
                <Button
                  size="md"
                  variant="secondary"
                  className="flex-1"
                  onClick={() => {
                    setEditing(true);
                    setEditText(data.content ?? reason);
                  }}
                  data-ui="review_edit_start"
                >
                  <Pencil size={12} strokeWidth={1.8} aria-hidden /> 编辑
                </Button>
              </div>
            </>
          )}
        </div>
      </FloaterWindow>
  );
}
