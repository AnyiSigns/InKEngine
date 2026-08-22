/**
 * 会话列表（三栏布局右栏，可收缩）：新建会话 + 搜索 + 今日/历史分组。
 *
 * 纯展示组件：会话数据经 props 注入（夹具/集成期由宿主数据源提供），
 * 不持有会话存储。收起/展开为组件本地 UI 状态。
 * 轨道：ink-rail 光泽 + hairline 分隔；选中态 = 抬升面 + 左侧墨条。
 */

import { useState } from 'react';
import { ChevronLeft, ChevronRight, History, MessageSquare, Plus, Search } from 'lucide-react';

import { cn } from '@/shared/cn';

export interface SessionItem {
  id: string;
  title: string;
  time: string;
  bucket: 'today' | 'history';
}

const DEMO_SESSIONS: SessionItem[] = [
  { id: 's-1', title: '喂资料：领域术语表整理', time: '14:02', bucket: 'today' },
  { id: 's-2', title: '研究：引用质量校验规则', time: '10:31', bucket: 'today' },
  { id: 's-3', title: '孵化：蒸馏产物长度阈值', time: '昨天', bucket: 'history' },
  { id: 's-4', title: '推演：分支选择对比', time: '周二', bucket: 'history' },
];

interface SessionListProps {
  collapsible?: boolean;
  sessions?: SessionItem[];
  activeSessionId?: string;
}

export function SessionList({ collapsible = false, sessions = DEMO_SESSIONS, activeSessionId = '' }: SessionListProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState('');

  if (collapsed) {
    return (
      <div className="flex w-10 shrink-0 flex-col items-center border-l py-2 ink-border">
        <button
          data-ui="btn_session_expand"
          title="展开会话列表"
          onClick={() => setCollapsed(false)}
          className="flex h-7 w-7 items-center justify-center rounded-lg ink-text-faint hover:bg-[var(--ink-bg-elevated)] cursor-pointer"
        >
          <ChevronLeft size={13} strokeWidth={1.6} />
        </button>
      </div>
    );
  }

  const filtered = query
    ? sessions.filter((s) => s.title.includes(query))
    : sessions;
  const today = filtered.filter((s) => s.bucket === 'today');
  const history = filtered.filter((s) => s.bucket === 'history');

  return (
    <div className="ink-rail flex w-60 shrink-0 flex-col border-l ink-border">
      <div className="flex items-center gap-1.5 p-2.5">
        {collapsible && (
          <button
            data-ui="btn_session_collapse"
            title="收起会话列表"
            onClick={() => setCollapsed(true)}
            className="flex h-7 w-6 shrink-0 items-center justify-center rounded-lg ink-text-faint hover:bg-[var(--ink-bg-elevated)] cursor-pointer"
          >
            <ChevronRight size={13} strokeWidth={1.6} />
          </button>
        )}
        <button
          data-ui="btn_new_session"
          className="ink-btn-secondary flex h-7 flex-1 items-center justify-center gap-1.5 text-[12px] font-medium bg-[var(--ink-bg-base)] ink-shadow-soft cursor-pointer"
        >
          <Plus size={12} strokeWidth={2} aria-hidden />
          新会话
        </button>
      </div>
      <div className="px-2.5 pb-2">
        <div className="ink-input flex h-7 w-full items-center gap-1.5 rounded-lg px-2 text-[11px]">
          <Search size={11} strokeWidth={1.6} className="shrink-0 ink-text-faint" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索会话"
            aria-label="搜索会话"
            className="h-full w-full bg-transparent text-[11px] outline-none placeholder:text-[var(--ink-text-faint)]"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1">
        {filtered.length === 0 && (
          <div className="px-2 py-3 text-center text-[10px] ink-text-faint">无匹配会话</div>
        )}
        {today.length > 0 && (
          <>
            <div className="px-2 pb-1 pt-1.5 text-[9px] font-medium tracking-[0.14em] uppercase ink-text-faint">今日</div>
            {today.map((s) => <SessionRow key={s.id} item={s} active={s.id === activeSessionId} />)}
          </>
        )}
        {history.length > 0 && (
          <>
            <div className="px-2 pb-1 pt-2 text-[9px] font-medium tracking-[0.14em] uppercase ink-text-faint">历史</div>
            {history.map((s) => <SessionRow key={s.id} item={s} active={s.id === activeSessionId} />)}
          </>
        )}
      </div>
      <div className="flex h-8 items-center justify-between border-t px-3 ink-border">
        <span className="font-mono text-[9px] ink-text-faint">~/inkling</span>
        <span className="font-mono text-[9px] ink-text-faint">v0.1.0</span>
      </div>
    </div>
  );
}

function SessionRow({ item, active }: { item: SessionItem; active: boolean }) {
  const Icon = item.bucket === 'today' ? MessageSquare : History;
  return (
    <button
      data-ui={`session_${item.id}`}
      className={cn(
        'relative flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left cursor-pointer',
        active
          ? 'bg-[var(--ink-bg-elevated)]'
          : 'bg-transparent hover:bg-[var(--ink-bg-elevated)]',
      )}
    >
      {active && <span className="ink-active-bar" aria-hidden />}
      <Icon size={10} strokeWidth={1.6} className={cn('shrink-0', active ? '' : 'ink-text-faint')} aria-hidden />
      <span className={cn('min-w-0 flex-1 truncate text-[11px]', active && 'font-medium')}>{item.title}</span>
      <span className="shrink-0 font-mono text-[9px] ink-text-faint">{item.time}</span>
    </button>
  );
}
