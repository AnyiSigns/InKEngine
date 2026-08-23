/**
 * 消息 hover 操作悬浮窗（编辑重发 / 由此分支）。
 *
 * 「编辑重发」= 悬浮窗内编辑原文并重发（回调注入宿主接线）；
 * 「由此分支」= 分支数据经可注入接口创建（默认 fixture 实现，集成期
 * 换引擎 branch 入口）。多步承载于悬浮窗，单步动作（发送/关闭）内联。
 */

import { useState } from 'react';

import { GitBranch, MessageSquarePlus } from 'lucide-react';

import type { MessageHoverAction } from '../messages/message_renderers';
import { FloaterWindow } from './floater_window';
import { Button } from '@/shared/ui/Button';
import { TextInput } from '@/shared/ui/Field';
import { Feedback } from './feedback';

/** 分支创建接口（可注入；默认 fixture 实现，集成期接引擎分支入口）。 */
export interface BranchWorkflow {
  create(fromMessageId: string, label: string, note?: string): Promise<{ branchId: string }>;
}

export const fixtureBranchWorkflow: BranchWorkflow = {
  async create(fromMessageId) {
    return { branchId: `branch-${Date.now()}-${fromMessageId.slice(-6)}` };
  },
};

interface MessageActionFloaterProps {
  action: MessageHoverAction;
  onResend?: (newText: string) => void;
  onBranch?: (label: string, note?: string) => void;
  onClose: () => void;
  branchWorkflow?: BranchWorkflow;
}

export function MessageActionFloater({
  action,
  onResend,
  onBranch,
  onClose,
  branchWorkflow = fixtureBranchWorkflow,
}: MessageActionFloaterProps) {
  const isResend = action.kind === 'resend';
  const [draft, setDraft] = useState(isResend ? action.message.content : '');
  const [branchName, setBranchName] = useState('');
  const [branchNote, setBranchNote] = useState('');
  const [phase, setPhase] = useState<'idle' | 'loading' | 'success' | 'fail'>('idle');

  const submit = async (): Promise<void> => {
    if (isResend) {
      if (!draft.trim()) return;
      onResend?.(draft);
      onClose();
      return;
    }
    const label = (branchName.trim() || '未命名分支').slice(0, 24);
    setPhase('loading');
    try {
      await branchWorkflow.create(action.message.id, label, branchNote.trim() || undefined);
      setPhase('success');
      onBranch?.(label, branchNote.trim() || undefined);
      onClose();
    } catch {
      setPhase('fail');
    }
  };

  return (
    <FloaterWindow
      title={isResend ? '编辑重发' : '由此分支'}
      floaterKey={`message-action-${action.kind}-${action.message.id}`}
      icon={isResend ? <MessageSquarePlus size={12} strokeWidth={1.6} /> : <GitBranch size={12} strokeWidth={1.6} />}
      onClose={onClose}
      initialRect={{ x: 240, y: 120, width: 400, height: 300 }}
      dataUi="message_action_floater"
    >
      <div className="flex h-full flex-col gap-2.5 p-3.5">
        {isResend ? (
          <>
            <textarea
              data-ui="resend_draft"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={6}
              className="ink-input h-full min-h-24 w-full resize-none py-2 leading-[var(--ink-lh-body)] whitespace-pre-wrap"
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={onClose}>取消</Button>
              <Button size="sm" variant="primary" disabled={!draft.trim()} data-ui="resend_submit" onClick={() => void submit()}>
                重发
              </Button>
            </div>
          </>
        ) : (
          <>
            <label className="space-y-1">
              <span className="block text-[11px] font-medium tracking-wide ink-text-muted">分支名（≤24 字）</span>
              <TextInput
                data-ui="branch_name"
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                placeholder="例如：换评分权重再试"
              />
            </label>
            <label className="space-y-1">
              <span className="block text-[11px] font-medium tracking-wide ink-text-muted">说明（可选）</span>
              <textarea
                data-ui="branch_note"
                value={branchNote}
                onChange={(e) => setBranchNote(e.target.value)}
                rows={3}
                className="ink-input w-full resize-none py-2 leading-[var(--ink-lh-body)]"
              />
            </label>
            <div className="flex items-center justify-between gap-2">
              <Feedback phase={phase} failText="分支创建失败" okText="分支已创建" />
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={onClose}>取消</Button>
                <Button size="sm" variant="primary" disabled={phase === 'loading'} data-ui="branch_submit" onClick={() => void submit()}>
                  创建分支
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </FloaterWindow>
  );
}
