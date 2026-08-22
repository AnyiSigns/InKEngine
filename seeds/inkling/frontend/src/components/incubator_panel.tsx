/**
 * 孵化面板（演化视图）：信号 → 蒸馏 → 闸门 流水。
 *
 * 数据源：state.incubation 通道（信号观察/蒸馏产物/闸门判定事件落位）。
 * 流水呈现三阶段：信号（signal）→ 蒸馏（distilling/distilled）→
 * 闸门（gating/passed/blocked），未命中阶段字段时按顺序推导显示。
 *
 * 纯渲染组件：数据 props 注入（bindValue），无领域耦合、无写入通道。
 */

import { ArrowDown, FlaskConical } from 'lucide-react';

import { cn } from '@/shared/cn';
import type { IncubationEntry } from '@/shared/session/types';

interface IncubatorPanelProps {
  bindValue?: unknown;
}

const STAGE_LABELS: Record<IncubationEntry['stage'], string> = {
  signal: '信号',
  distilling: '蒸馏中',
  distilled: '已蒸馏',
  gating: '闸门判定',
  passed: '放行',
  blocked: '拦截',
};

const SIGNAL_TYPE_LABELS: Record<string, string> = {
  pitfall: '坑',
  user_correction: '用户纠偏',
  insight: '洞见',
  gap: '缺口',
  repeated_root_cause: '反复根因',
  mutation: '变异',
};

export function IncubatorPanel({ bindValue }: IncubatorPanelProps) {
  const entries = (bindValue as IncubationEntry[] | undefined) ?? [];

  return (
    <section className="ink-panel p-4">
      <div className="flex items-center gap-2.5">
        <span className="ink-icon-chip">
          <FlaskConical size={12} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
        </span>
        <span className="text-[12px] font-semibold tracking-tight">孵化面板</span>
        <span className="ml-auto text-[10px] ink-text-faint">信号 → 蒸馏 → 闸门</span>
      </div>

      {entries.length === 0 ? (
        <div className="mt-3 rounded-xl border border-dashed px-3 py-5 text-center text-[11px] leading-relaxed ink-border ink-text-faint">
          暂无孵化信号（使用中积累的行为信号会在此沉淀）
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {entries.map((entry) => (
            <IncubatorRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </section>
  );
}

function IncubatorRow({ entry }: { entry: IncubationEntry }) {
  const signalLabel = SIGNAL_TYPE_LABELS[entry.signalType] ?? entry.signalType;
  const stage = STAGE_LABELS[entry.stage];
  const tone =
    entry.stage === 'blocked'
      ? 'ink-accent-bg ink-accent'
      : entry.stage === 'passed'
        ? 'ink-panel'
        : 'ink-text-faint';

  return (
    <div className="ink-elevated px-3.5 py-2.5">
      <div className="flex items-center gap-2">
        <span className={cn('rounded-md px-1.5 py-px text-[9px]', tone)}>
          {signalLabel} · {stage}
        </span>
        {entry.gateLevel ? <span className="text-[9px] ink-text-faint">闸门 {entry.gateLevel}</span> : null}
        <span className="ml-auto text-[9px] ink-text-faint">
          {new Date(entry.createdAt).toLocaleTimeString()}
        </span>
      </div>
      <div className="mt-1.5 text-[11px] leading-relaxed">{entry.signal}</div>
      {entry.distilled && (
        <div className="mt-1.5 flex items-start gap-1.5 text-[10px] leading-relaxed ink-text-muted">
          <ArrowDown size={10} strokeWidth={1.6} className="mt-0.5 shrink-0" aria-hidden />
          <span className="min-w-0">{entry.distilled}</span>
        </div>
      )}
      {entry.verdict && (
        <div className={cn('mt-1.5 text-[10px]', entry.stage === 'blocked' ? 'ink-accent' : 'ink-text-muted')}>
          判定：{entry.verdict}
        </div>
      )}
    </div>
  );
}
