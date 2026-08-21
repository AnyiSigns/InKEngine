/**
 * 推演轨迹树（推演视图）：simulate_decision 分支对比 + swap_branch 换选。
 *
 * 数据源：state.simulations 通道（分支 + Evaluator 评分 + 选中态）。
 * 换选动作经 onSwapBranch 注入（宿主接线，集成期对接引擎 swap_branch 决议）；
 * 无回调时本地切换展示态，不崩。
 */

import { GitBranch } from 'lucide-react';

import { cn } from '@/shared/cn';
import type { SimulationBranch } from '@/shared/session/types';

interface SimulationTreeProps {
  bindValue?: unknown;
  onSwapBranch?: (branchId: string) => void;
}

export function SimulationTree({ bindValue, onSwapBranch }: SimulationTreeProps) {
  const branches = (bindValue as SimulationBranch[] | undefined) ?? [];

  return (
    <section className="ink-panel rounded-md p-3">
      <div className="flex items-center gap-1.5">
        <GitBranch size={12} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
        <span className="text-[11px] font-medium">推演轨迹树</span>
        <span className="ml-auto text-[10px] ink-text-faint">simulate_decision · 分支对比</span>
      </div>

      {branches.length === 0 ? (
        <div className="mt-2 rounded-md border border-dashed px-3 py-4 text-center text-[11px] ink-border ink-text-faint">
          暂无推演（决策点经 simulate_decision 展开分支，Evaluator 评分后换选）
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          {branches.map((branch) => (
            <div
              key={branch.branchId}
              className={cn(
                'ink-elevated rounded-md px-2.5 py-2',
                branch.selected && 'border-[var(--ink-border-strong)]',
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'rounded px-1.5 py-px text-[9px]',
                    branch.selected ? 'ink-panel' : 'ink-text-faint',
                  )}
                >
                  {branch.selected ? '已选中' : '候选'}
                </span>
                <span className="truncate text-[11px]">{branch.label}</span>
                <span className="ml-auto shrink-0 text-[10px] tabular-nums ink-text-faint">
                  评分 {branch.score.toFixed(2)}
                </span>
                {!branch.selected && (
                  <button
                    onClick={() => onSwapBranch?.(branch.branchId)}
                    data-ui={`swap_${branch.branchId}`}
                    className="ink-btn-secondary h-5 shrink-0 rounded px-1.5 text-[9px] cursor-pointer"
                  >
                    换选
                  </button>
                )}
              </div>
              {branch.rationale && (
                <div className="mt-1 text-[10px] leading-relaxed ink-text-muted">{branch.rationale}</div>
              )}
              {branch.steps.length > 0 && (
                <ul className="mt-1.5 space-y-0.5 border-l pl-2 ink-border">
                  {branch.steps.map((step, index) => (
                    <li key={`${branch.branchId}-${index}`} className="flex items-center gap-1.5 text-[10px]">
                      <span
                        className={cn(
                          'h-1.5 w-1.5 shrink-0 rounded-full',
                          step.status === 'completed' ? 'bg-[var(--ink-border-strong)]' : step.status === 'failed' ? 'ink-accent' : 'bg-[var(--ink-border)]',
                        )}
                        aria-hidden
                      />
                      <span className="truncate">{step.node}</span>
                      {step.note ? <span className="truncate ink-text-faint">{step.note}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
