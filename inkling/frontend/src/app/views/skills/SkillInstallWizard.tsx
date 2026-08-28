import { cn } from '@/shared/cn';
import { useState } from 'react';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import type { SkillEntry } from './backend';

type InstallStep = 'preview' | 'confirm' | 'approval' | 'done';

interface SkillInstallWizardProps {
  skill: SkillEntry;
  onClose: () => void;
  onConfirmInstall?: (id: string) => void;
}

export function SkillInstallWizard({ skill, onClose, onConfirmInstall }: SkillInstallWizardProps) {
  const [step, setStep] = useState<InstallStep>('preview');

  const contractSummary = skill.contract_snapshot.map(([name, ver]) => `${name}@${ver}`).join(' → ');
  const evidenceSummary = skill.evidence_snapshot.map(
    (e) => `${e.src_type}→${e.dst_type}: ${e.success_count}成功/${e.fail_count}失败`,
  );

  const steps: InstallStep[] = ['preview', 'confirm', 'approval', 'done'];
  const currentIndex = steps.indexOf(step);

  return (
    <div data-ui="skill_install_wizard" className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <h3 className="text-[13px] font-medium text-[var(--ink-text-base)]">安装向导</h3>
        <span className="text-[11px] text-[var(--ink-text-muted)]">{skill.name}</span>
      </div>

      <div className="flex items-center gap-1 text-[10px] text-[var(--ink-text-faint)]">
        {steps.map((s, i) => (
          <span key={s} className="flex items-center gap-1">
            <span className={cn('rounded px-1.5 py-0.5', i <= currentIndex ? 'text-[var(--ink-text-base)]' : '')}>
              {s === 'preview' ? '预览契约' : s === 'confirm' ? '确认' : s === 'approval' ? '审批' : '完成'}
            </span>
            {i < steps.length - 1 && <ArrowRight size={10} strokeWidth={1.6} />}
          </span>
        ))}
      </div>

      {step === 'preview' && (
        <div className="flex flex-col gap-2 rounded border border-[var(--ink-border)] p-3 text-[11px]">
          <div className="font-medium text-[var(--ink-text-base)]">契约快照</div>
          <div className="text-[var(--ink-text-muted)]">{contractSummary}</div>
          <div className="mt-1 font-medium text-[var(--ink-text-base)]">证据统计</div>
          {evidenceSummary.map((e, i) => (
            <div key={i} className="text-[var(--ink-text-muted)]">{e}</div>
          ))}
          <div className="mt-1 font-medium text-[var(--ink-text-base)]">测试报告</div>
          <div className="text-[var(--ink-text-muted)]">
            {skill.test_report.skill_name} · 成功率 {(skill.test_report.success_rate * 100).toFixed(0)}%
          </div>
          <div className="text-[10px] text-[var(--ink-text-faint)]">{skill.test_report.note}</div>
        </div>
      )}

      {step === 'confirm' && (
        <div className="flex flex-col gap-2 rounded border border-[var(--ink-border)] p-3 text-[11px]">
          <div className="text-[var(--ink-text-base)]">确认安装「{skill.name}」？</div>
          <div className="text-[var(--ink-text-muted)]">
            安装后技能将经审批落链，可经补丁链回退。
          </div>
        </div>
      )}

      {step === 'approval' && (
        <div className="flex flex-col gap-2 rounded border border-[var(--ink-accent-border)] p-3 text-[11px]">
          <div className="text-[var(--ink-text-base)]">等待审批</div>
          <div className="text-[var(--ink-text-muted)]">
            技能安装须经审批确认。审批通过后落链生效。
          </div>
        </div>
      )}

      {step === 'done' && (
        <div className="flex flex-col gap-2 rounded border border-[var(--ink-border)] p-3 text-[11px]">
          <div className="flex items-center gap-1 text-[var(--ink-text-base)]">
            <Check size={12} strokeWidth={1.6} />
            安装完成
          </div>
          <div className="text-[var(--ink-text-muted)]">
            技能「{skill.name}」已安装并落链。
          </div>
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        <Button size="sm" variant="ghost" onClick={onClose}>
          <ArrowLeft size={12} strokeWidth={1.6} />
          关闭
        </Button>
        <div className="flex gap-2">
          {step !== 'done' && (
            <Button size="sm" variant="secondary" onClick={onClose}>取消</Button>
          )}
          {step === 'preview' && (
            <Button size="sm" variant="primary" onClick={() => setStep('confirm')}>
              下一步
            </Button>
          )}
          {step === 'confirm' && (
            <Button size="sm" variant="primary" onClick={() => setStep('approval')}>
              确认安装
            </Button>
          )}
          {step === 'approval' && (
            <Button size="sm" variant="accent" onClick={() => {
              onConfirmInstall?.(skill.id);
              setStep('done');
            }}>
              审批通过
            </Button>
          )}
          {step === 'done' && (
            <Button size="sm" variant="primary" onClick={onClose}>完成</Button>
          )}
        </div>
      </div>
    </div>
  );
}
