import { useState } from 'react';
import { Package } from 'lucide-react';

import { SkillCard } from './SkillCard';
import { SkillInstallWizard } from './SkillInstallWizard';
import type { SkillEntry, SkillsMarketData } from './backend';

const DEFAULT_MARKET: SkillsMarketData = {
  premounted: false,
  mount_policy: {
    required: ['vetting 静态核对', '审批卡预览', 'L2 人工审批', '补丁链落链可回退'],
    note: '出厂零预装：市场目录是候选清单，任何安装都须走既有 vetting → 审批 → 补丁链链路',
  },
  skills: [],
};

interface SkillMarketProps {
  data?: SkillsMarketData | null;
  onInstall?: (id: string) => void;
  onExport?: (id: string) => void;
}

export function SkillMarket({ data, onInstall, onExport }: SkillMarketProps) {
  const market = data ?? DEFAULT_MARKET;
  const skills = market.skills ?? [];
  const [installingSkill, setInstallingSkill] = useState<SkillEntry | null>(null);

  if (installingSkill) {
    return (
      <SkillInstallWizard
        skill={installingSkill}
        onClose={() => setInstallingSkill(null)}
        onConfirmInstall={(id) => {
          onInstall?.(id);
        }}
      />
    );
  }

  return (
    <div data-ui="skill_market" className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Package size={14} strokeWidth={1.6} className="text-[var(--ink-text-muted)]" />
        <h3 className="text-[13px] font-medium text-[var(--ink-text-base)]">技能市场</h3>
        <span className="text-[11px] text-[var(--ink-text-faint)]">
          {skills.length} 候选技能（出厂零预装）
        </span>
      </div>

      {skills.length === 0 ? (
        <div className="rounded border border-dashed border-[var(--ink-border)] px-3 py-8 text-center text-[12px] text-[var(--ink-text-faint)]">
          暂无可用技能
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {skills.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              onInstall={(id) => {
                const s = skills.find((x) => x.id === id);
                if (s) setInstallingSkill(s);
              }}
              onExport={onExport}
            />
          ))}
        </div>
      )}
    </div>
  );
}
