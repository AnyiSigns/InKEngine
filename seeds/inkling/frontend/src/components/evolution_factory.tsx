/**
 * 进化工厂面板（演化视图）：变异 / 防退化。
 *
 * 数据源：state.incubation 通道（signalType=mutation 的条目为变异提案，
 * 闸门=guard 的判定为防退化守卫结果）。展示变异产物与防退化判定，
 * 不持有写入通道（变异/回退走引擎补丁链管线）。
 */

import { FlaskConical, ShieldCheck } from 'lucide-react';

import { cn } from '@/shared/cn';
import type { IncubationEntry } from '@/shared/session/types';

interface EvolutionFactoryProps {
  bindValue?: unknown;
}

export function EvolutionFactory({ bindValue }: EvolutionFactoryProps) {
  const entries = (bindValue as IncubationEntry[] | undefined) ?? [];
  const mutations = entries.filter((e) => e.signalType === 'mutation');

  return (
    <section className="ink-panel p-3">
      <div className="flex items-center gap-1.5">
        <FlaskConical size={12} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
        <span className="text-[11px] font-medium">进化工厂</span>
        <span className="ml-auto text-[10px] ink-text-faint">变异 · 防退化守卫</span>
      </div>

      {mutations.length === 0 ? (
        <div className="mt-2 rounded-xl border border-dashed px-3 py-4 text-center text-[11px] ink-border ink-text-faint">
          暂无变异提案（反思式变体经防退化守卫后才可沉淀）
        </div>
      ) : (
        <div className="mt-2 space-y-1.5">
          {mutations.map((entry) => {
            const passed = entry.stage === 'passed';
            const blocked = entry.stage === 'blocked';
            return (
              <div key={entry.id} className="ink-elevated px-3 py-2">
                <div className="flex items-center gap-2">
                  <ShieldCheck
                    size={11}
                    strokeWidth={1.6}
                    className={cn('shrink-0', blocked ? 'ink-accent' : 'ink-text-faint')}
                    aria-hidden
                  />
                  <span className="text-[11px]">{entry.signal}</span>
                  <span
                    className={cn(
                      'ml-auto shrink-0 rounded-md px-1.5 py-px text-[9px]',
                      blocked ? 'ink-accent-bg ink-accent' : 'ink-panel',
                    )}
                  >
                    {blocked ? '防退化拦截' : passed ? '防退化通过' : '守卫中'}
                  </span>
                </div>
                {entry.verdict && <div className="mt-1 text-[10px] ink-text-muted">判定：{entry.verdict}</div>}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
