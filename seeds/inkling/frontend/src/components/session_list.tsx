/**
 * 会话列表（主界面窄左栏，可收起）：今日/历史/搜索。
 *
 * 纯展示组件：会话数据经 props 注入（夹具/集成期由宿主数据源提供），
 * 不持有会话存储。收起/展开为组件本地 UI 状态。
 */

import { useState } from 'react';
import { ChevronLeft, ChevronRight, History, MessageSquare, Search } from 'lucide-react';

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
      <div className="flex w-8 shrink-0 flex-col items-center border-r py-2 ink-border">
        <button
          data-ui="btn_session_expand"
          title="展开会话列表"
          onClick={() => setCollapsed(false)}
          className="flex h-6 w-6 items-center justify-center rounded ink-text-faint hover:bg-[var(--ink-bg-elevated)] cursor-pointer"
        >
          <ChevronRight size={12} strokeWidth={1.6} />
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
    <div className="flex w-44 shrink-0 flex-col border-r ink-border">
      <div className="flex items-center gap-1 border-b px-2 py-1.5 ink-border">
        <Search size={11} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索会话"
          className="h-5 w-full bg-transparent text-[11px] outline-none placeholder:text-[var(--ink-text-faint)]"
        />
        {collapsible && (
          <button
            data-ui="btn_session_collapse"
            title="收起会话列表"
            onClick={() => setCollapsed(true)}
            className="flex h-5 w-5 items-center justify-center rounded ink-text-faint hover:bg-[var(--ink-bg-elevated)] cursor-pointer"
          >
            <ChevronLeft size={11} strokeWidth={1.6} />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {filtered.length === 0 && (
          <div className="px-2 py-3 text-center text-[10px] ink-text-faint">无匹配会话</div>
        )}
        {today.length > 0 && (
          <>
            <div className="px-2 py-1 text-[9px] uppercase tracking-wider ink-text-faint">今日</div>
            {today.map((s) => <SessionRow key={s.id} item={s} active={s.id === activeSessionId} />)}
          </>
        )}
        {history.length > 0 && (
          <>
            <div className="px-2 py-1 text-[9px] uppercase tracking-wider ink-text-faint">历史</div>
            {history.map((s) => <SessionRow key={s.id} item={s} active={s.id === activeSessionId} />)}
          </>
        )}
      </div>
    </div>
  );
}

function SessionRow({ item, active }: { item: SessionItem; active: boolean }) {
  const Icon = item.bucket === 'today' ? MessageSquare : History;
  return (
    <button
      data-ui={`session_${item.id}`}
      className={`flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left cursor-pointer ${
        active
          ? 'bg-[var(--ink-bg-elevated)]'
          : 'hover:bg-[var(--ink-bg-elevated)]'
      }`}
    >
      <Icon size={11} strokeWidth={1.6} className="shrink-0 ink-text-faint" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-[11px]">{item.title}</span>
      <span className="shrink-0 text-[9px] ink-text-faint">{item.time}</span>
    </button>
  );
}
