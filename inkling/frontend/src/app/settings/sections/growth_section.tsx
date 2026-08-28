/**
 * 设置「生长治理」节：占位空态（波 3/W3 接线前无后端桥 op）。
 *
 * 空态文案：「治理数据暂不可用」+ 说明「接线后可用」。
 */

import { Sparkles } from 'lucide-react';

export function GrowthSection(): JSX.Element {
  return (
    <div className="space-y-4">
      <div className="ink-elevated space-y-3 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">孵化与进化</div>
        <div className="flex items-center gap-2 text-[10px] ink-text-faint">
          <Sparkles size={12} strokeWidth={1.6} aria-hidden />
          治理数据暂不可用（治理接线后可用）
        </div>
      </div>
    </div>
  );
}
