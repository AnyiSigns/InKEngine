/**
 * 来源视图（依据溯源时间线）。
 *
 * 依据来源视图重定位：不做账本/摘要链展示（内部管道，无产品意义），
 * 收敛为「依据溯源时间线」——数据 = 会话 sourceTraces（记忆召回/审查/
 * 调参/设备感知控制事件的落位留痕，由 eventIngest 维护）。
 * 按来源类型分组：记忆召回 / 审查 / 设备 / 调优；每条 = 标题 + 详情 + 时间。
 * 普通用户在主消息流已见内联依据卡，这里供深挖完整留痕（开发者入口）。
 */

import { Database, History, Monitor, ShieldCheck } from 'lucide-react';

import type { SourceTraceEntry } from '@/shared/session/types';

interface SourcesViewProps {
  /** 依据留痕快照（装配层从会话 hub 注入；无数据 = 空态）。 */
  traces?: SourceTraceEntry[];
}

interface SourceGroupMeta {
  key: SourceTraceEntry['sourceType'];
  label: string;
  icon: React.ReactNode;
}

const GROUP_META: SourceGroupMeta[] = [
  { key: 'memory', label: '记忆召回', icon: <Database size={13} strokeWidth={1.6} aria-hidden /> },
  { key: 'evidence', label: '审查与调优', icon: <ShieldCheck size={13} strokeWidth={1.6} aria-hidden /> },
  { key: 'device', label: '设备感知与控制', icon: <Monitor size={13} strokeWidth={1.6} aria-hidden /> },
  { key: 'retrieval', label: '检索', icon: <History size={13} strokeWidth={1.6} aria-hidden /> },
];

function timeLabel(at: number): string {
  if (!at) return '';
  const d = new Date(at);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

export function SourcesView({ traces = [] }: SourcesViewProps): JSX.Element {
  const grouped = GROUP_META.map((g) => ({
    meta: g,
    entries: traces.filter((t) => t.sourceType === g.key),
  })).filter((g) => g.entries.length > 0);

  if (traces.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center">
        <History size={26} strokeWidth={1.5} className="ink-text-faint" aria-hidden />
        <p className="text-[13px] ink-text-muted">暂无依据留痕</p>
        <p className="max-w-xs text-[11px] leading-relaxed ink-text-faint">
          会话运行后，记忆召回、工具审查、设备操作等依据会以时间线形式沉淀在这里
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-ui="sources_view">
      <div className="flex items-baseline gap-3 border-b ink-border px-4 py-3">
        <span className="text-[13px] font-medium">依据溯源</span>
        <span className="text-[11px] ink-text-faint">
          {traces.length} 条留痕 · 按来源类型分组
        </span>
      </div>
      <div className="ink-scroll-auto flex-1 overflow-y-auto px-4 py-4">
        <div className="space-y-6">
          {grouped.map(({ meta, entries }) => (
            <section key={meta.key} data-ui={`source_group_${meta.key}`}>
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium tracking-wide ink-text-muted">
                {meta.icon}
                {meta.label}
                <span className="text-[10px] ink-text-faint">{entries.length} 条</span>
              </div>
              <ol className="relative space-y-1 border-l ink-border pl-4">
                {entries.map((t) => (
                  <li key={t.id} className="group relative rounded-lg px-2 py-2 hover:bg-[var(--ink-bg-surface)]">
                    <span className="absolute -left-[22px] top-3 h-1.5 w-1.5 rounded-full bg-[var(--ink-text-faint)] transition-colors group-hover:bg-[var(--ink-text-muted)]" />
                    <div className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-[12px]">{t.title}</span>
                      <span className="shrink-0 text-[10px] tabular-nums ink-text-faint">{timeLabel(t.createdAt)}</span>
                    </div>
                    {t.detail && <p className="mt-0.5 text-[11px] leading-relaxed ink-text-faint">{t.detail}</p>}
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
