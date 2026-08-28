import { FileText, ShieldCheck, TestTube } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import type { SkillEntry } from './backend';
import { successRate, crystalSourceLabel } from './backend';

interface SkillCardProps {
  skill: SkillEntry;
  onInstall?: (id: string) => void;
  onExport?: (id: string) => void;
}

export function SkillCard({ skill, onInstall, onExport }: SkillCardProps) {
  const rate = successRate(skill);
  const contractSummary = skill.contract_snapshot.map(([name, ver]) => `${name}@${ver}`).join(' → ');

  return (
    <div
      data-ui={`skill_card_${skill.id}`}
      className="flex flex-col gap-2 rounded border border-[var(--ink-border)] p-3"
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-[12px] font-medium text-[var(--ink-text-base)]">{skill.name}</span>
        <span className="rounded border border-[var(--ink-border)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--ink-text-faint)]">
          v{skill.version}
        </span>
        <span className="rounded border border-[var(--ink-border)] px-1.5 py-0.5 text-[9px] text-[var(--ink-text-faint)]">
          {skill.kind}
        </span>
      </div>

      <div className="text-[11px] text-[var(--ink-text-muted)]">{skill.description}</div>

      <div className="flex items-center gap-3 text-[10px] text-[var(--ink-text-faint)]">
        <span className="flex items-center gap-1">
          <ShieldCheck size={10} strokeWidth={1.6} />
          命中 {skill.hit_count} · 失败 {skill.fail_count}
        </span>
        <span className="flex items-center gap-1">
          <FileText size={10} strokeWidth={1.6} />
          成功率 {rate.toFixed(0)}%
        </span>
      </div>

      <div className="text-[10px] text-[var(--ink-text-faint)]">
        契约: {contractSummary}
      </div>

      <div className="text-[10px] text-[var(--ink-text-faint)]">
        {crystalSourceLabel(skill)}
      </div>

      <div className="mt-1 flex items-center gap-2">
        <Button size="xs" variant="secondary" data-ui={`skill_install_${skill.id}`} onClick={() => onInstall?.(skill.id)}>
          安装
        </Button>
        <Button size="xs" variant="ghost" data-ui={`skill_export_${skill.id}`} onClick={() => onExport?.(skill.id)}>
          <TestTube size={10} strokeWidth={1.6} />
          导出
        </Button>
      </div>
    </div>
  );
}
