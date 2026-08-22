/**
 * 消息流（主界面对话主区核心组件）。
 *
 * 机制内联形态（单行不展开）：
 * - 流式正文（streaming/assistant，流式中带朱砂光标）；
 * - 思考（thinking，可折叠）；
 * - 规划/子任务（plan/spawn）；
 * - 工具调用内联行：工具名 · 权限判定 · 结果摘要；
 * - 设备留痕内联行、审批卡（历史只读）、建议、错误、折叠兜底。
 *
 * 性能：行组件 memo 化；长消息流增量渲染——仅渲染窗口尾部（默认 200 条）
 * 并在超出时给出提示；滚动贴近底部时自动跟随，用户上翻不打断。
 *
 * 纯渲染组件：数据 = bindValue（state.messages 通道注入），零领域耦合。
 */

import { memo, useEffect, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import { AlertTriangle, Beaker, Bot, ChevronDown, ChevronRight, Cpu, GitBranch, ListChecks, User, Wrench } from 'lucide-react';

import { cn } from '@/shared/cn';
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

/** 行组件：memo 化，仅当消息引用变化时重渲（增量渲染的落点）。 */
const MessageRow = memo(function MessageRow({ message }: { message: InkMessage }) {
  switch (message.kind) {
    case 'text':
      return message.role === 'user' ? (
        <div className="flex justify-end">
          <div className="ink-bubble-user max-w-[85%] px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap break-words">
            {message.content}
          </div>
        </div>
      ) : (
        <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{message.content}</div>
      );
    case 'streaming':
      return (
        <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">
          {message.content}
          <span className="ink-caret" aria-hidden />
        </div>
      );
    case 'thinking':
      return <CollapsibleRow label="思考" status={message.status === 'running' ? '进行中' : '完成'} body={message.content} icon={KIND_ICON.thinking} shimmer={message.status === 'running'} />;
    case 'plan':
      return <CollapsibleRow label={`规划${message.workflow ? ` · ${message.workflow}` : ''}`} status={message.status === 'running' ? '进行中' : '完成'} body={message.content} icon={KIND_ICON.plan} shimmer={message.status === 'running'} />;
    case 'spawn':
      return <InlineRow icon={KIND_ICON.spawn} text={`子任务：${message.label ?? message.nodeId ?? ''}`} status={message.status} />;
    case 'tool':
      return <InlineRow icon={KIND_ICON.tool} text={`${message.tool}${message.permission ? ` · ${message.permission}` : ''}${message.summary ? ` · ${message.summary}` : ''}`} status={message.toolStatus} />;
    case 'device':
      return <InlineRow icon={KIND_ICON.device} text={`设备：${message.action}${message.detail ? ` · ${message.detail}` : ''}`} status="done" />;
    case 'knowledge_hit':
      return (
        <div className="ink-panel px-3 py-2">
          <div className="text-[10px] ink-text-faint">检索命中</div>
          {message.hits.map((hit) => (
            <div key={hit.id} className="mt-1 flex items-center gap-2 text-[11px]">
              <span className="truncate">{hit.title}</span>
              <span className="truncate text-[10px] ink-text-faint">{hit.snippet}</span>
            </div>
          ))}
        </div>
      );
    case 'review_card':
      return (
        <div className="ink-accent-bg rounded-lg px-3 py-2">
          <div className="text-[12px]">审批卡已弹出（历史回放只读）</div>
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
              className="cursor-pointer rounded-full border px-2.5 py-0.5 text-[10px] ink-border ink-text-muted hover:bg-[var(--ink-bg-elevated)]"
            >
              #{item}
            </span>
          ))}
        </div>
      );
    case 'error':
      return <InlineRow icon={KIND_ICON.error} text={message.content || '发生错误'} status="error" />;
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

function statusTone(status: string): string {
  if (status === 'error' || status === 'failed' || status === 'blocked') return 'ink-accent';
  if (status === 'running' || status === 'pending') return 'ink-text-muted';
  return 'ink-text-faint';
}

function InlineRow({ icon: Icon, text, status }: { icon: typeof Bot; text: string; status: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px] ink-text-muted">
      <Icon size={11} strokeWidth={1.6} className="shrink-0 ink-text-faint" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <span className={cn('shrink-0 text-[10px]', statusTone(status))}>· {status}</span>
    </div>
  );
}

function CollapsibleRow({ label, status, body, icon: Icon, shimmer }: { label: string; status: string; body: string; icon: typeof Bot; shimmer?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ink-panel overflow-hidden">
      <button
        data-ui={`row_${label}`}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left cursor-pointer bg-transparent border-none"
      >
        <Icon size={11} strokeWidth={1.6} className="shrink-0 ink-text-faint" aria-hidden />
        <span className="text-[11px]">{label}</span>
        <span className="text-[10px] ink-text-faint">· {status}</span>
        {open ? <ChevronDown size={12} strokeWidth={1.6} className="ml-auto ink-text-faint" /> : <ChevronRight size={12} strokeWidth={1.6} className="ml-auto ink-text-faint" />}
      </button>
      {open && (
        <div className={cn('border-t px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap ink-border', shimmer && 'ink-shimmer')}>
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

  if (messages.length === 0) {
    return (
      <div className="ink-scroll-auto flex-1 p-4">
        <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center gap-2.5 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--ink-bg-elevated)]">
            <Bot size={18} strokeWidth={1.4} className="ink-text-faint" aria-hidden />
          </div>
          <div className="text-[13px] tracking-wide ink-text-faint">消息流为空（等待回合事件）</div>
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="ink-scroll-auto flex-1 px-4 py-4">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
        {truncated > 0 && (
          <div className="text-center text-[10px] ink-text-faint">
            仅显示最近 {tail.length} 条消息（共 {messages.length} 条）
          </div>
        )}
        {tail.map((message) => (
          <MessageRow key={message.id} message={message} />
        ))}
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
