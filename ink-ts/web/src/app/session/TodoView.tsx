/**
 * 待办清单页（主区「待办」临时标签）：rounds.todos 只读投影。
 *
 * 数据 = 宿主后端（rounds.todos）：最新 checkpoint 计划未完成步骤 + 链尾
 * 挂起审批卡的只读投影；agent 建好计划/卡后顶栏临时出现「待办」标签。
 * 清单的写操作由 agent 经 task_manager/审批决议维护；本页只读 + 刷新。
 */

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Circle, ListTodo, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';

import type { BackendAdapter, RoundTodoRow } from '@/shared/backend/backendAdapter';

function fmtLabel(row: RoundTodoRow): { label: string; kind: string } {
  if (row.kind === 'approval') {
    return { label: row.label.replace(/^审批待裁决:\s*/, '审批待裁决 · ') || '审批待裁决', kind: 'approval' };
  }
  return { label: row.label || '待定步骤', kind: row.kind };
}

export function TodoView({ backend, threadId }: { backend: BackendAdapter | null; threadId: string }) {
  const [todo, setTodo] = useState<RoundTodoRow[] | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'fail'>('loading');

  const load = useCallback(() => {
    if (!backend?.available || !threadId) {
      setTodo([]);
      setPhase('ready');
      return;
    }
    setPhase('loading');
    backend
      .todoGet(threadId)
      .then((data) => {
        setTodo(data.todo ?? []);
        setPhase('ready');
      })
      .catch(() => setPhase('fail'));
  }, [backend, threadId]);

  useEffect(() => {
    setTodo(null);
    load();
  }, [load, threadId]);

  if (!backend?.available) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-[12px] ink-text-faint">
        <p>待办清单仅在宿主运行时可用</p>
        <p className="text-[11px]">请经桌面壳启动后查看回合计划待办</p>
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

  const rows = todo ?? [];
  const pendingCount = rows.filter((r) => r.status !== 'done' && r.status !== 'cancelled').length;
  const approvalCount = rows.filter((r) => r.kind === 'approval').length;

  return (
    <div className="ink-scroll-auto flex-1 overflow-y-auto px-4 py-5">
      <div className="mx-auto max-w-2xl">
        <div className="mb-4 flex items-baseline gap-3">
          <span className="text-[13px] font-medium">待办清单</span>
          <span className="text-[11px] ink-text-faint">
            {todo === null ? '读取中…' : `${rows.length} 项 · ${pendingCount} 待办`}
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
        ) : rows.length === 0 ? (
          <div className="rounded-lg border ink-border px-4 py-6 text-center text-[11px] ink-text-faint">
            <ListTodo size={18} strokeWidth={1.5} className="mx-auto mb-2" aria-hidden />
            暂无待办 —— 回合计划启动后，未完成步骤与挂起审批卡会出现在这里
          </div>
        ) : (
          <ol className="space-y-1.5">
            {rows.map((row) => {
              const { label, kind } = fmtLabel(row);
              return (
                <li key={`${row.kind}-${row.id}`} className="flex items-start gap-2.5 rounded-lg border ink-border px-3 py-2">
                  <span className={`mt-0.5 shrink-0 ${kind === 'approval' ? 'ink-accent' : 'ink-text-faint'}`}>
                    {kind === 'approval' ? (
                      <ShieldAlert size={15} strokeWidth={1.6} aria-hidden />
                    ) : row.status === 'done' ? (
                      <CheckCircle2 size={15} strokeWidth={1.6} className="ink-text-ok" aria-hidden />
                    ) : (
                      <Circle size={15} strokeWidth={1.6} aria-hidden />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="text-[12px] leading-relaxed">{label}</span>
                    <span className="ml-2 text-[9px] ink-text-faint">
                      {kind === 'approval' ? '审批待裁决' : `计划步骤 · #${row.id}`}
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        {approvalCount > 0 && (
          <p className="mt-3 text-[10px] ink-text-muted">
            含 {approvalCount} 条挂起审批卡 —— 在主对话审批弹卡中裁决后自动续跑回合。
          </p>
        )}
      </div>
    </div>
  );
}
