/**
 * 设置「成长状态」节（devOnly，只读诊断）：自学习管线（孵化闭环）状态展示。
 *
 * 只读展示、无可操作项：孵化中信号数 / 知识集规模 / 闸门通过率 / 最近
 * 蒸馏说明。数据面 = report.growth op（壳命令 growth_report 转发）。
 * 宿主不可用 = 空态说明（无夹具回落）。
 */

import { useEffect, useState } from 'react';

import { Activity, Database, RefreshCw, ShieldCheck } from 'lucide-react';

import { createTauriInvoker } from '@/shared/backend/tauriBridge';

export interface GrowthStatus {
  enabled?: boolean;
  incubating_signals?: number;
  collected_total?: number;
  knowledge_count?: number;
  gate_checked?: number;
  gate_passed?: number;
  gate_pass_rate?: number;
  landed?: number;
  last_flush_note?: string;
  last_landed_at?: number | null;
}

export function GrowthSection(): JSX.Element {
  const tauri = createTauriInvoker();
  const [status, setStatus] = useState<GrowthStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const load = async (): Promise<void> => {
    if (!tauri) {
      setUnavailable(true);
      return;
    }
    try {
      const result = (await tauri.invoke('growth_report', {})) as {
        growth?: GrowthStatus;
        knowledge_count?: number;
      };
      const growth = result?.growth ?? {};
      setStatus({
        ...growth,
        knowledge_count: growth.knowledge_count ?? result?.knowledge_count ?? 0,
      });
      setUnavailable(false);
    } catch {
      setUnavailable(true);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tauri]);

  const passRate = status?.gate_pass_rate !== undefined ? Math.round(status.gate_pass_rate * 100) : null;
  const gateChecked = status?.gate_checked ?? 0;

  return (
    <div className="space-y-4">
      <div className="ink-elevated space-y-2.5 px-3.5 py-3">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-medium tracking-wide ink-text-muted">自学习管线（孵化闭环）</div>
          <span
            className="ink-chip"
            data-ui="growth_enabled"
            data-active={status?.enabled ?? true}
          >
            {status?.enabled === false ? '停用' : '默认开启'}
          </span>
        </div>
        {unavailable ? (
          <p className="text-[10px] ink-text-faint">成长状态暂不可用（宿主未就绪）</p>
        ) : (
          <p className="text-[10px] ink-text-faint" data-ui="growth_flush_note">
            {status?.last_flush_note ?? '自学习管线就绪（回合收尾按需蒸馏）'}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="ink-elevated space-y-1.5 px-3.5 py-3">
          <div className="flex items-center gap-1.5 text-[10px] ink-text-faint">
            <Activity size={11} strokeWidth={1.6} aria-hidden /> 孵化中信号
          </div>
          <div className="text-[var(--ink-font-lg)] font-semibold" data-ui="growth_incubating">
            {status?.incubating_signals ?? 0}
          </div>
          <div className="text-[9px] ink-text-faint">
            累计收集 {status?.collected_total ?? 0} · 已落位 {status?.landed ?? 0}
          </div>
        </div>
        <div className="ink-elevated space-y-1.5 px-3.5 py-3">
          <div className="flex items-center gap-1.5 text-[10px] ink-text-faint">
            <Database size={11} strokeWidth={1.6} aria-hidden /> 知识集规模
          </div>
          <div className="text-[var(--ink-font-lg)] font-semibold" data-ui="growth_knowledge">
            {status?.knowledge_count ?? 0}
          </div>
          <div className="text-[9px] ink-text-faint">条目（随补丁链版本化）</div>
        </div>
        <div className="ink-elevated space-y-1.5 px-3.5 py-3">
          <div className="flex items-center gap-1.5 text-[10px] ink-text-faint">
            <ShieldCheck size={11} strokeWidth={1.6} aria-hidden /> 闸门通过率
          </div>
          <div className="text-[var(--ink-font-lg)] font-semibold" data-ui="growth_gate_rate">
            {passRate !== null ? `${passRate}%` : '—'}
          </div>
          <div className="text-[9px] ink-text-faint">
            评估 {gateChecked} 次 · 通过 {status?.gate_passed ?? 0} 次
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between px-1">
        <p className="text-[9px] ink-text-faint">只读诊断信息（机制自动运行，无需配置）</p>
        <button
          type="button"
          onClick={() => void load()}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] ink-text-muted hover:bg-[var(--ink-bg-elevated)] cursor-pointer bg-transparent border-none"
          data-ui="growth_refresh"
        >
          <RefreshCw size={10} strokeWidth={1.6} aria-hidden /> 刷新
        </button>
      </div>
    </div>
  );
}
