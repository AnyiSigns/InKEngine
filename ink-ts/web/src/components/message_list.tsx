/**
 * 消息流（主界面对话主区核心组件）。
 *
 * 呈现规范（事件 → 渲染器一对一）：
 * - 每条消息 = 独立条目（不拼接/不批量折叠；默认展开，蓄力区
 *   [推理/规划] 默认收起——收起仅视觉，经可注入界面状态存储持久）；
 * - 三级视觉层：正文消息不透明 / 状态消息气泡半透明（alpha ≤ 0.5
 *   走透明组 token）/ 状态卡片透明（无实底填充，仅细描边与留白）；
 * - thinking 流式渲染（token 逐片追加、中途事件可见；绘制节流）；
 * - 长列表虚拟化（千条级不卡渲染）；乱序流按事件序（绑定值顺序）渲染。
 *
 * hover 操作（编辑重发/由此分支）经悬浮窗承载（回调注入，宿主接线）。
 */

import { useMemo, useRef, useState } from 'react';
import type { ComponentProps } from 'react';

import { Bot } from 'lucide-react';

import type { InkMessage } from '@/shared/session/types';
import { DEFAULT_STREAM_THROTTLE_MS } from './messages/streaming_throttle';
import { VirtualList } from './messages/virtual_list';
import { renderMessageEntry, type MessageHoverAction } from './messages/message_renderers';
import { MessageActionFloater } from './floaters/message_action_floater';

const TAIL_WINDOW = 200;

export interface MessageListProps {
  bindValue?: unknown;
  /** 长消息流尾部窗口（超出部分截断提示） */
  tailWindow?: number;
  /** 流式绘制节流间隔（ms；0 = 直绘） */
  throttleMs?: number;
  /** 虚拟化视口高（缺省实测回落 600；测试显式传入） */
  viewportHeight?: number;
  /** 虚拟化预估行高 */
  estimatedHeight?: number;
  /** 流式批处理信号（节流只压绘制，事件序/条目不合并） */
  streaming?: boolean;
  /** 编辑重发（宿主接线：新文本替换原消息并重发回合） */
  onResendMessage?: (messageId: string, newText: string) => void;
  /** 由此分支（宿主接线：以消息为起点开新分支） */
  onBranchFromMessage?: (messageId: string, branchLabel: string) => void;
}

/** 消息是否处于运行态（tool 行看 toolStatus，其余行看 status）。 */
function messageIsRunning(message: InkMessage): boolean {
  const statusFields = message as { toolStatus?: string; status?: string };
  const s = statusFields.toolStatus ?? statusFields.status;
  return s === 'running' || s === 'pending';
}

export function MessageList({
  bindValue,
  tailWindow = TAIL_WINDOW,
  throttleMs = DEFAULT_STREAM_THROTTLE_MS,
  viewportHeight,
  estimatedHeight,
  streaming = false,
  onResendMessage,
  onBranchFromMessage,
}: MessageListProps) {
  const messages = (bindValue as InkMessage[] | undefined) ?? [];
  const [hoverAction, setHoverAction] = useState<MessageHoverAction | null>(null);

  const tail = useMemo(
    () => (messages.length > tailWindow ? messages.slice(-tailWindow) : messages),
    [messages, tailWindow],
  );
  const truncated = messages.length - tail.length;

  // 入场动效只挂最新到的一条（会话切换/历史回填不触发全场动画）
  const lastId = tail.length > 0 ? tail[tail.length - 1].id : null;
  const lastIdRef = useRef<string | null>(null);
  const animateLast = lastId !== null && lastIdRef.current !== lastId;
  const previousLastRef = useRef(lastId);
  if (lastId !== previousLastRef.current) {
    previousLastRef.current = lastId;
    lastIdRef.current = lastId;
  }

  const onOpenAction = useMemo(() => {
    if (!onResendMessage && !onBranchFromMessage) return undefined;
    return (action: MessageHoverAction) => setHoverAction(action);
  }, [onResendMessage, onBranchFromMessage]);

  if (messages.length === 0) {
    return (
      <div className="ink-scroll-auto flex-1 p-5">
        <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center gap-3 text-center">
          <span className="ink-breathe ink-icon-chip h-11 w-11 rounded-full">
            <Bot size={19} strokeWidth={1.4} className="ink-text-faint" aria-hidden />
          </span>
          <div className="text-[var(--ink-font-sm)] tracking-wide ink-text-faint">消息流为空（等待回合事件）</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col px-5 py-5">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col min-h-0">
        {truncated > 0 && (
          <div className="shrink-0 pb-1 text-center text-[10px] ink-text-faint">
            仅显示最近 {tail.length} 条消息（共 {messages.length} 条）
          </div>
        )}
        <VirtualList
          items={tail}
          keyOf={(message) => message.id}
          estimatedHeight={estimatedHeight}
          viewportHeight={viewportHeight}
          followSignal={tail.length}
          className="min-h-0 flex-1"
          dataUi="message_list"
          emptyHint={
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <div className="text-[var(--ink-font-sm)] tracking-wide ink-text-faint">消息流为空（等待回合事件）</div>
            </div>
          }
          renderItem={(message, index, measure) => {
            const isLast = index === tail.length - 1;
            const live = isLast && animateLast && messageIsRunning(message);
            return (
              <div
                ref={(el) => {
                  if (el) measure(el.offsetHeight);
                }}
                className={isLast && animateLast ? 'ink-enter' : ''}
              >
                {renderMessageEntry(message, {
                  throttleMs,
                  live,
                  onOpenAction,
                })}
              </div>
            );
          }}
        />
        {streaming && <div className="shrink-0 pt-1 text-center text-[var(--ink-font-xs)] ink-shimmer">正在处理…</div>}
      </div>
      {hoverAction && onOpenAction && (
        <MessageActionFloater
          action={hoverAction}
          onResend={(newText) => {
            onResendMessage?.(hoverAction.message.id, newText);
            setHoverAction(null);
          }}
          onBranch={(label) => {
            onBranchFromMessage?.(hoverAction.message.id, label);
            setHoverAction(null);
          }}
          onClose={() => setHoverAction(null)}
        />
      )}
    </div>
  );
}

export type { MessageListProps as MessageListBoundProps };
export type MessageListComponentProps = ComponentProps<typeof MessageList>;
