/**
 * 阶段胶囊：step 序列每步图标+名称，可折叠。
 * step>5 折叠为「规划 · 5 步」+展开按钮；>8 步显示「规划 · 8 步」+「全部步骤」抽屉。
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, MoreHorizontal } from 'lucide-react';

export interface PhaseCapsuleProps {
  steps: Array<{ id: string; label: string; status?: string }>;
  chainLabel?: string;
  tier?: string;
}

export function PhaseCapsule({ steps, chainLabel, tier }: PhaseCapsuleProps) {
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const displaySteps = expanded || steps.length <= 5 ? steps : steps.slice(0, 5);
  const overflow = steps.length - 5;

  return (
    <div className="ink-status-card rounded-xl p-3">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium">阶段</span>
        {chainLabel && <span className="ink-chip text-[10px]">{chainLabel}</span>}
        {tier && <span className="ink-chip text-[10px]">{tier}</span>}
        <button type="button" onClick={() => setExpanded(!expanded)} className="ml-auto flex items-center gap-1 text-[10px] ink-text-muted hover:text-[var(--ink-text-base)]">
          {expanded ? <ChevronDown size={12} strokeWidth={1.5} /> : <ChevronRight size={12} strokeWidth={1.5} />}
          {expanded ? '收起' : '展开'}
        </button>
      </div>
      {expanded && (
        <div className="mt-2 space-y-1">
          {displaySteps.map((step) => (
            <div key={step.id} className="flex items-center gap-2 text-xs ink-text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              <span className="flex-1 truncate">{step.label}</span>
              {step.status && <span className="text-[10px] opacity-70">{step.status}</span>}
            </div>
          ))}
          {overflow > 0 && !showAll && (
            <button type="button" onClick={() => setShowAll(true)} className="flex items-center gap-1 text-[10px] ink-text-muted hover:text-[var(--ink-text-base)]">
              <MoreHorizontal size={12} strokeWidth={1.5} />
              <span>全部步骤 ({steps.length})</span>
            </button>
          )}
          {showAll && (
            <div className="mt-1 space-y-1">
              {steps.slice(5).map((step) => (
                <div key={step.id} className="flex items-center gap-2 text-xs ink-text-muted">
                  <span className="h-1.5 w-1.5 rounded-full bg-current" />
                  <span className="flex-1 truncate">{step.label}</span>
                  {step.status && <span className="text-[10px] opacity-70">{step.status}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
