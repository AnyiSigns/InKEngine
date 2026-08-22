/**
 * 消息流（主界面对话主区核心组件）。
 *
 * 机制内联形态（单行不展开）：
 * - 流式正文（streaming/assistant，流式中带朱砂光标）；
 * - 思考（thinking，可折叠）；规划/子任务（plan/spawn）；
 * - 工具调用内联行：图标托 + 工具名 · 权限判定 · 结果摘要 + 状态胶囊；
 * - 设备留痕内联行、审批卡（历史只读）、建议、错误、折叠兜底；
 * - 状态胶囊：running 带呼吸点（生命感），done 静默灰。
 *
 * 性能：行组件 memo 化；长消息流增量渲染（尾部 200 条）。
 * 入场动效：ink-enter（先入先动，流式不打扰）。
 *
 * 纯渲染组件：数据 = bindValue（state.messages 通道注入），零领域耦合。
 */

import { memo, useEffect, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import { AlertTriangle, Beaker, Bot, ChevronDown, ChevronRight, Cpu, GitBranch, ListChecks, User, Wrench } from 'lucide-react';

import { cn } from '@/shared/cn';
import { statusTone } from '@/shared/ui/statusTone';
import type { InkMessage } from '@/shared/session/types';

const TAIL_WINDOW = 200;

interface MessageListProps {
  bindValue?: unknown;
  tailWindow?: number;
  streaming?: boolean;
}

const KIND_ICON: Record<string, typeof Bot> = {
  user: User,
  text: Bot,
  thinking: Cpu,
  plan: ListChecks,
  tool: Wrench,
  spawn: GitBranch,
  device: Cpu,
  knowledge_hit: Beaker,
  error: AlertTriangle,
};

/** 消息是否处于运行态（tool 行看 toolStatus，其余行看 status；等价类型收缩）。 */
function messageIsRunning(message: InkMessage): boolean {
  const statusFields = message as { toolStatus?: string; status?: string };
  const s = statusFields.toolStatus ?? statusFields.status;
  return s === 'running' || s === 'pending';
}

/** 状态胶囊：运行态带呼吸点（生命感），终态静默灰。
 *  live=true 仅在最新一条运行中消息上生效——无限 ping 有源、有其范围。 */
function StatusPill({ status, live = false }: { status: string; live?: boolean }) {
  const running = status === 'running' || status === 'pending';
  return (
    <span className={cn('ink-chip shrink-0 py-px text-[9px]', statusTone(status))}>
      {running &&
        (live ? (
          <span className="ink-live-dot" aria-hidden />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
        ))}
      {status}
    </span>
  );
}

/** 行组件：memo 化，仅当消息引用变化时重渲（增量渲染的落点）。 */
const MessageRow = memo(function MessageRow({ message, live = false }: { message: InkMessage; live?: boolean }) {
  switch (message.kind) {
    case 'text':
      return message.role === 'user' ? (
        <div className="flex justify-end">
          <div className="ink-bubble-user max-w-[85%] px-4 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap break-words">
            {message.content}
          </div>
        </div>
      ) : (
        <div className="whitespace-pre-wrap break-words text-[13px] leading-[1.75]">{message.content}</div>
      );
    case 'streaming':
      return (
        <div className="whitespace-pre-wrap break-words text-[13px] leading-[1.75]">
          {message.content}
          <span className="ink-caret" aria-hidden />
        </div>
      );
    case 'thinking':
      return <CollapsibleRow label="思考" status={message.status === 'running' ? '进行中' : '完成'} body={message.content} icon={KIND_ICON.thinking} shimmer={message.status === 'running'} />;
    case 'plan':
      return <CollapsibleRow label={`规划${message.workflow ? ` · ${message.workflow}` : ''}`} status={message.status === 'running' ? '进行中' : '完成'} body={message.content} icon={KIND_ICON.plan} shimmer={message.status === 'running'} />;
    case 'spawn':
      return <InlineRow icon={KIND_ICON.spawn} text={`子任务：${message.label ?? message.nodeId ?? ''}`} status={message.status} live={live} />;
    case 'tool':
      return <InlineRow icon={KIND_ICON.tool} text={`${message.tool}${message.permission ? ` · ${message.permission}` : ''}`} detail={message.summary} status={message.toolStatus} live={live} />;
    case 'device':
      return <InlineRow icon={KIND_ICON.device} text={`设备：${message.action}`} detail={message.detail} status="done" live={live} />;
    case 'knowledge_hit':
      return (
        <div className="ink-panel-flat px-3.5 py-2.5">
          <div className="flex items-center gap-1.5 text-[10px] ink-text-faint">
            <Beaker size={10} strokeWidth={1.6} aria-hidden />
            检索命中
          </div>
          {message.hits.map((hit) => (
            <div key={hit.id} className="mt-1.5 flex items-center gap-2 text-[11px]">
              <span className="min-w-0 truncate font-medium">{hit.title}</span>
              <span className="min-w-0 flex-1 truncate text-[10px] ink-text-faint">{hit.snippet}</span>
            </div>
          ))}
        </div>
      );
    case 'review_card':
      return (
        <div className="ink-accent-bg rounded-xl px-3.5 py-2.5">
          <div className="text-[12px] font-medium">审批卡已弹出（历史回放只读）</div>
          <div className="mt-0.5 truncate text-[10px] ink-text-faint">
            {String(message.payload.reason ?? message.payload.title ?? '')}
          </div>
        </div>
      );
    case 'suggestions':
      return (
        <div className="flex flex-wrap gap-1.5">
          {message.items.map((item) => (
            <span
              key={item}
              className="ink-chip cursor-pointer ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)] transition-colors"
            >
              #{item}
            </span>
          ))}
        </div>
      );
    case 'error':
      return <InlineRow icon={KIND_ICON.error} text={message.content || '发生错误'} status="error" live={live} />;
    case 'unknown':
      return (
        <div className="rounded-lg border border-dashed px-3 py-2 text-[11px] ink-border ink-text-faint">
          未登记事件（折叠展示）：{message.token}
        </div>
      );
    default:
      return null;
  }
});

function InlineRow({ icon: Icon, text, detail, status, live = false }: { icon: typeof Bot; text: string; detail?: string; status: string; live?: boolean }) {
  return (
    <div className="group flex items-center gap-2.5 text-[11px] ink-text-muted">
      <span className="ink-icon-chip h-5 w-5 group-hover:bg-[var(--ink-bg-base)]">
        <Icon size={10} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
      </span>
      <span className={cn('min-w-0', detail ? 'flex-1 truncate' : 'flex-1 truncate')}>{text}</span>
      {detail && <span className="truncate text-[10px] ink-text-faint">{detail}</span>}
      <StatusPill status={status} live={live} />
    </div>
  );
}

function CollapsibleRow({ label, status, body, icon: Icon, shimmer = false }: { label: string; status: string; body: string; icon: typeof Bot; shimmer?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ink-panel-flat overflow-hidden">
      <button
        data-ui={`row_${label}`}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left cursor-pointer bg-transparent border-none hover:bg-[var(--ink-bg-surface)]"
      >
        <span className="ink-icon-chip h-5 w-5">
          <Icon size={10} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
        </span>
        <span className="text-[11px] font-medium">{label}</span>
        <StatusPill status={status} />
        {open ? (
          <ChevronDown size={12} strokeWidth={1.6} className="ml-auto ink-text-faint transition-transform" aria-hidden />
        ) : (
          <ChevronRight size={12} strokeWidth={1.6} className="ml-auto ink-text-faint transition-transform" aria-hidden />
        )}
      </button>
      {open && (
        <div className={cn('ink-feed border-t px-3.5 py-2.5 text-[11px] leading-[1.7] whitespace-pre-wrap ink-border', shimmer && 'ink-shimmer')}>
          {body || '（空）'}
        </div>
      )}
    </div>
  );
}

export function MessageList({ bindValue, tailWindow = TAIL_WINDOW, streaming = false }: MessageListProps) {
  const messages = (bindValue as InkMessage[] | undefined) ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [userScrolledUp, setUserScrolledUp] = useState(false);

  // 滚动跟随：贴近底部时自动跟随，用户上翻不打断（流式体验 + 审计回看并存）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
      pinnedRef.current = pinned;
      setUserScrolledUp(!pinned);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    // 滚动跟随：环境未实现 scrollTo（如 jsdom）时静默跳过，不崩
    const el = scrollRef.current;
    if (!el || typeof el.scrollTo !== 'function') return;
    if (pinnedRef.current) {
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [messages, streaming]);

  const tail = messages.length > tailWindow ? messages.slice(-tailWindow) : messages;
  const truncated = messages.length - tail.length;

  // 入场动效只挂最新到的一条消息（会话切换/历史回填不触发全场 200 行动画）
  const lastId = tail.length > 0 ? tail[tail.length - 1].id : null;
  const lastIdRef = useRef<string | null>(null);
  const animateLast = lastId !== null && lastIdRef.current !== lastId;
  useEffect(() => {
    lastIdRef.current = lastId;
  }, [lastId]);

  if (messages.length === 0) {
    return (
      <div className="ink-scroll-auto flex-1 p-5">
        <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center gap-3 text-center">
          <span className="ink-breathe ink-icon-chip h-11 w-11 rounded-full">
            <Bot size={19} strokeWidth={1.4} className="ink-text-faint" aria-hidden />
          </span>
          <div className="text-[13px] tracking-wide ink-text-faint">消息流为空（等待回合事件）</div>
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="ink-scroll-auto flex-1 px-5 py-5">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3.5">
        {truncated > 0 && (
          <div className="text-center text-[10px] ink-text-faint">
            仅显示最近 {tail.length} 条消息（共 {messages.length} 条）
          </div>
        )}
        {tail.map((message, index) => {
          const isLast = index === tail.length - 1;
          // 呼吸点只给最新一条仍在运行的消息（无限 ping 有界）
          const live = isLast && animateLast && messageIsRunning(message);
          return (
            <div
              key={message.id}
              className={cn(
                isLast && animateLast && 'ink-enter',
                message.kind === 'text' && message.role !== 'user' && 'px-0.5',
              )}
            >
              <MessageRow message={message} live={live} />
            </div>
          );
        })}
        {streaming && <span className="ink-shimmer text-[12px]">正在处理…</span>}
        {userScrolledUp && messages.length > 0 && (
          <div className="text-center text-[10px] ink-text-faint">已暂停自动跟随（上滑查看历史）</div>
        )}
      </div>
    </div>
  );
}

export type { MessageListProps as MessageListBoundProps };
export type MessageListComponentProps = ComponentProps<typeof MessageList>;
