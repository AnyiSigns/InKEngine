/**
 * MCP 挂载向导（多步交互，承载于悬浮窗）：选服务 → 配置 → vetting
 * 观察 → 挂载确认。单步轻交互内联，多步流程进悬浮窗，挂载结果经
 * 回调反馈宿主（设置页已挂载清单即时同步）。
 */

import { useState } from 'react';

import { PlugZap } from 'lucide-react';

import { cn } from '@/shared/cn';
import { Button } from '@/shared/ui/Button';
import { TextInput } from '@/shared/ui/Field';
import { Feedback } from './feedback';
import type { FeedbackPhase } from './feedback';
import { FloaterWindow } from './floater_window';

export interface McpMarketEntry {
  name: string;
  source: 'market' | 'manual';
  endpoint: string;
  credential: 'none' | 'required';
  risk: 'low' | 'medium' | 'high';
}

export const MCP_MARKET_DEFAULT: McpMarketEntry[] = [
  { name: 'web_search', source: 'market', endpoint: 'stdio: npx -y @inkling/web-search', credential: 'none', risk: 'low' },
  { name: 'web_crawl', source: 'market', endpoint: 'stdio: npx -y @inkling/web-crawl', credential: 'none', risk: 'medium' },
  { name: 'file_system', source: 'market', endpoint: 'stdio: npx -y @inkling/fs-server', credential: 'none', risk: 'high' },
];

const STEP_LABELS = ['选择服务', '配置', '观察', '挂载'] as const;
type StepIndex = 0 | 1 | 2 | 3;

interface MountWizardFloaterProps {
  onClose: () => void;
  onMounted?: (entry: McpMarketEntry) => void;
  market?: McpMarketEntry[];
}

export function MountWizardFloater({ onClose, onMounted, market = MCP_MARKET_DEFAULT }: MountWizardFloaterProps) {
  const [step, setStep] = useState<StepIndex>(0);
  const [selected, setSelected] = useState<McpMarketEntry | null>(null);
  const [scope, setScope] = useState('会话级');
  const [phase, setPhase] = useState<FeedbackPhase>('idle');

  const next = (): void => {
    if (step === 2) {
      setPhase('success');
      setStep(3);
      return;
    }
    if (step === 3) {
      if (selected) onMounted?.(selected);
      onClose();
      return;
    }
    setStep((s) => (s + 1) as StepIndex);
  };

  return (
    <FloaterWindow
      title="挂载向导"
      floaterKey="mount-wizard"
      icon={<PlugZap size={12} strokeWidth={1.6} />}
      onClose={onClose}
      initialRect={{ x: 200, y: 96, width: 420, height: 380 }}
      dataUi="mount_wizard"
    >
      <div className="flex h-full flex-col p-3.5">
        <div className="mb-3 flex items-center gap-1">
          {STEP_LABELS.map((label, index) => (
            <span
              key={label}
              data-active={index <= step}
              className={cn(
                'rounded-md px-2 py-0.5 text-[10px]',
                index <= step ? 'bg-[var(--ink-bg-elevated)] font-medium' : 'ink-text-faint',
              )}
            >
              {index + 1}.{label}
            </span>
          ))}
        </div>

        <div className="min-h-0 flex-1">
          {step === 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] ink-text-muted">出厂零预挂：选择目录条目，挂载后走 vetting → 观察 → 转正。</div>
              {market.map((entry) => (
                <button
                  key={entry.name}
                  data-ui={`wizard_market_${entry.name}`}
                  data-active={selected?.name === entry.name}
                  onClick={() => setSelected(entry)}
                  className="ink-elevated flex w-full items-center gap-2 px-3 py-2 text-left cursor-pointer"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[var(--ink-font-xs)] font-medium">{entry.name}</span>
                    <span className="block truncate font-mono text-[10px] ink-text-faint">{entry.endpoint}</span>
                  </span>
                  <span className="ink-chip font-mono text-[9px] ink-text-faint">{entry.risk}</span>
                </button>
              ))}
            </div>
          )}

          {step === 1 && selected && (
            <div className="space-y-2.5">
              <div className="flex items-center gap-2 text-[var(--ink-font-xs)]">
                <span className="w-16 shrink-0 ink-text-muted">服务</span>
                <span className="font-mono text-[11px]">{selected.name}</span>
              </div>
              <div className="flex items-center gap-2 text-[var(--ink-font-xs)]">
                <span className="w-16 shrink-0 ink-text-muted">凭据</span>
                <span className="text-[11px]">{selected.credential === 'none' ? '无需（出厂挂载）' : '需要（集成期接入）'}</span>
              </div>
              <div className="flex items-center gap-2 text-[var(--ink-font-xs)]">
                <span className="w-16 shrink-0 ink-text-muted">权限</span>
                <div className="ink-seg">
                  {(['会话级', '项目级', '全局'] as const).map((scopeOption) => (
                    <button
                      key={scopeOption}
                      data-active={scope === scopeOption}
                      onClick={() => setScope(scopeOption)}
                      className="ink-seg-item"
                    >
                      {scopeOption}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {step === 2 && selected && (
            <div className="space-y-2.5 text-[11px] leading-[var(--ink-lh-body)]">
              <div className="ink-status-card px-3 py-2.5">
                <div className="font-medium">vetting 静态钩子核对</div>
                <div className="ink-text-faint">挂载前对端点声明/风险标签/凭据要求做静态核对；观察期播报无静默变化。</div>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] ink-text-muted">等待核对完成后点击「下一步」确认挂载</div>
            </div>
          )}

          {step === 3 && selected && (
            <div className="space-y-2.5 text-[11px]">
              <div className="flex items-center gap-2">
                <Feedback phase={phase} okText="vetting 通过，待挂载确认" failText="vetting 未通过" />
              </div>
              <label className="block space-y-1">
                <span className="block text-[11px] font-medium tracking-wide ink-text-muted">端点确认（可改）</span>
                <TextInput value={selected.endpoint} readOnly data-ui="wizard_endpoint" />
              </label>
            </div>
          )}
        </div>

        <div className="mt-3 flex items-center justify-between">
          {step > 0 && (
            <Button size="sm" variant="ghost" onClick={() => { setStep((s) => (s - 1) as StepIndex); setPhase('idle'); }}>
              上一步
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="secondary" onClick={onClose}>取消</Button>
            <Button
              size="sm"
              variant="primary"
              data-ui={`wizard_next_${step}`}
              disabled={step === 0 && !selected}
              onClick={next}
            >
              {step === 3 ? '完成挂载' : '下一步'}
            </Button>
          </div>
        </div>
      </div>
    </FloaterWindow>
  );
}
