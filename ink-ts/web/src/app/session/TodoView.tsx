/**
 * 待办清单页（主区「待办」临时标签）：task_manager 持久化清单只读展示。
 *
 * 数据 = 宿主后端 todo_get（todo:<thread_id> 集合）。agent 建好清单后
 * 顶栏临时出现「待办」标签，本页展示条目状态/优先级/验收标准/证据。
 * 清单的写操作（create/update/complete/delete）由 agent 经 task_manager
 * 工具维护；本页只读 + 刷新（宿主不可用 = 空态提示）。
 */

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Circle, Loader2, ListTodo, RefreshCw } from 'lucide-react';

import type { BackendAdapter, TodoEntry, TodoList } from '@/shared/backend/backendAdapter';

const STATUS_META: Record<TodoEntry['status'], { label: string; cls: string }> = {
  pending: { label: '待办', cls: 'ink-text-muted' },
  doing: { label: '进行中', cls: 'ink-accent' },
  done: { label: '已完成', cls: 'ink-text-ok' },
  cancelled: { label: '已取消', cls: 'ink-text-faint' },
  blocked: { label: '受阻', cls: 'ink-text-warn' },
};

const PRIORITY_META: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

function fmtTime(ts?: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function TodoView({ backend, threadId }: { backend: BackendAdapter | null; threadId: string }) {
  const [todo, setTodo] = useState<TodoList | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'fail'>('loading');

  const load = useCallback(() => {
    if (!backend?.available || !threadId) {
      setTodo({ thread_id: threadId, entries: [], total: 0 });
      setPhase('ready');
      return;
    }
    setPhase('loading');
    backend
      .todoGet(threadId)
      .then((data) => {
        setTodo(data);
        setPhase('ready');
      })
      .catch(() => setPhase('fail'));
  }, [backend, threadId]);

  useEffect(() => {
    load();
  }, [load, threadId]);

  if (!backend?.available) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-[12px] ink-text-faint">
        <p>待办清单仅在宿主运行时可用</p>
        <p className="text-[11px]">请经桌面壳启动后查看 agent 维护的任务清单</p>
      </div>
    );
  }

  if (phase === 'fail') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[12px] ink-text-faint">
        <p>待办清单读取失败</p>
        <button type="button" className="ink-link text-[11px]" onClick={load}>
          重试
        </button>
      </div>
    );
  }

  const entries = (todo?.entries ?? []).slice().sort((a, b) => {
    const prio = { high: 0, medium: 1, low: 2 } as Record<string, number>;
    return (prio[a.priority] ?? 1) - (prio[b.priority] ?? 1) || a.order - b.order;
  });
  const pendingCount = entries.filter((e) => !['done', 'cancelled'].includes(e.status)).length;
  const doneCount = entries.filter((e) => e.status === 'done').length;

  return (
    <div className="ink-scroll-auto flex-1 overflow-y-auto px-4 py-5">
      <div className="mx-auto max-w-2xl">
        <div className="mb-4 flex items-baseline gap-3">
          <span className="text-[13px] font-medium">待办清单</span>
          <span className="text-[11px] ink-text-faint">
            {todo === null ? '读取中…' : `${entries.length} 项 · ${pendingCount} 待办 · ${doneCount} 完成`}
          </span>
          <button
            type="button"
            className="ml-auto flex items-center gap-1 text-[11px] ink-text-muted hover:opacity-80"
            onClick={load}
          >
            <RefreshCw size={11} strokeWidth={1.6} /> 刷新
          </button>
        </div>

        {todo === null ? (
          <div className="flex items-center gap-2 text-[11px] ink-text-faint">
            <Loader2 size={12} strokeWidth={1.6} className="animate-spin" /> 读取清单…
          </div>
        ) : entries.length === 0 ? (
          <div className="rounded-lg border ink-border px-4 py-6 text-center text-[11px] ink-text-faint">
            <ListTodo size={18} strokeWidth={1.5} className="mx-auto mb-2" aria-hidden />
            暂无待办 —— agent 用 task_manager 建好清单后，顶栏会出现「待办」标签
          </div>
        ) : (
          <ol className="space-y-1.5">
            {entries.map((e) => {
              const meta = STATUS_META[e.status] ?? STATUS_META.pending;
              return (
                <li key={e.id} className="flex items-start gap-2.5 rounded-lg border ink-border px-3 py-2">
                  <span className={`mt-0.5 shrink-0 ${e.status === 'done' ? 'ink-text-ok' : 'ink-text-faint'}`}>
                    {e.status === 'done' ? (
                      <CheckCircle2 size={15} strokeWidth={1.6} aria-hidden />
                    ) : (
                      <Circle size={15} strokeWidth={1.6} aria-hidden />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className={`text-[12px] ${e.status === 'done' ? 'ink-text-faint line-through' : ''}`}>
                        {e.title}
                      </span>
                      <span className={`text-[10px] ${meta.cls}`}>{meta.label}</span>
                      <span className="text-[10px] ink-text-faint">{PRIORITY_META[e.priority] ?? ''}</span>
                      <span className="ml-auto text-[9px] ink-text-faint">#{e.id}</span>
                    </div>
                    {e.detail && <p className="mt-0.5 text-[10px] ink-text-muted">{e.detail}</p>}
                    {e.evidence && (
                      <p className="mt-0.5 truncate text-[10px] ink-text-faint" title={e.evidence}>
                        证据：{e.evidence}
                      </p>
                    )}
                    <p className="mt-0.5 text-[9px] ink-text-faint">
                      创建 {fmtTime(e.created_at)} · 更新 {fmtTime(e.updated_at)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
