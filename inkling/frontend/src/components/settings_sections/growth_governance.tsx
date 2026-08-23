/**
 * 设置「生长治理」节：孵化/进化/补丁链的治理开关 + 记忆与知识集。
 */

import { Download, Upload } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { Field, TextInput } from '@/shared/ui/Field';

export type GateDefaultLevel = 'L0' | 'L1' | 'L2';

export interface GrowthValue {
  autoIncubate: boolean;
  seedPeriodDays: string;
  gateDefaultLevel: GateDefaultLevel;
  memoryWindowDays: string;
}

export const DEFAULT_GROWTH: GrowthValue = {
  autoIncubate: true,
  seedPeriodDays: '7',
  gateDefaultLevel: 'L2',
  memoryWindowDays: '30',
};

interface GrowthGovernanceProps {
  value: GrowthValue;
  patch: (next: Partial<GrowthValue>) => void;
}

export function GrowthGovernance({ value, patch }: GrowthGovernanceProps) {
  return (
    <div className="space-y-4">
      <div className="ink-elevated space-y-2.5 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">孵化与进化</div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            className="ink-check"
            checked={value.autoIncubate}
            onChange={(e) => patch({ autoIncubate: e.target.checked })}
            data-ui="growth_auto_incubate"
          />
          <span className="text-[11px]">自动孵化观察信号（会话内静默收集，变更落位需闸门）</span>
        </label>
        <div className="flex items-center gap-2">
          <span className="w-28 shrink-0 text-[11px] ink-text-muted">种子观察周期</span>
          <TextInput
            value={value.seedPeriodDays}
            aria-label="种子观察周期天数"
            className="w-20"
            onChange={(e) => patch({ seedPeriodDays: e.target.value })}
          />
          <span className="text-[10px] ink-text-faint">天 · 期满再蒸馏</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-28 shrink-0 text-[11px] ink-text-muted">闸门默认档</span>
          <div className="ink-seg">
            {(['L0', 'L1', 'L2'] as const).map((level) => (
              <button
                key={level}
                data-ui={`growth_gate_${level}`}
                data-active={value.gateDefaultLevel === level}
                onClick={() => patch({ gateDefaultLevel: level })}
                className="ink-seg-item"
              >
                {level}
              </button>
            ))}
          </div>
          <span className="text-[10px] ink-text-faint">跨层晋升须经批准模式</span>
        </div>
      </div>
      <div className="ink-elevated space-y-2.5 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">记忆窗口</div>
        <Field label="记忆失效窗口（天）" hint="过去 N 天内的记忆条目参与召回检索，过期条目降权。">
          <TextInput
            className="w-28"
            value={value.memoryWindowDays}
            onChange={(e) => patch({ memoryWindowDays: e.target.value })}
            aria-label="记忆失效窗口"
          />
        </Field>
      </div>
      <div className="ink-elevated space-y-2.5 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">知识集存取</div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary"><Download size={11} strokeWidth={1.6} /> 导出知识集</Button>
          <Button size="sm" variant="secondary"><Upload size={11} strokeWidth={1.6} /> 导入知识集</Button>
        </div>
      </div>
    </div>
  );
}
