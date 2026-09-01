/**
 * 首启引导 5 步（W2.4）：欢迎+主权声明 → 模型配置[Ollama 快捷/自定义/跳过]
 * → 工作区授权 → 3 示例任务 → 完成。
 *
 * 可跳过；dismiss 走 first_run_dismiss 仅首次；
 * 未配模型点击示例任务 → 提示「先配置模型」。
 */

import { useState } from 'react';

import { ChevronRight, FolderOpen, Globe, MessageSquare, Rocket, SkipForward, X } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { createBackend } from '@/shared/backend/backendAdapter';
import { PRODUCT_NAME, PRODUCT_TAGLINE } from '@/shared/identity';

type Step = 1 | 2 | 3 | 4 | 5;

interface OnboardingFlowProps {
  open: boolean;
  onClose: () => void;
  onComplete: () => void;
}

const STEPS: Array<{ step: Step; title: string; body: string; icon: typeof Rocket }> = [
  { step: 1, title: `欢迎使用 ${PRODUCT_NAME}`, body: `你的${PRODUCT_TAGLINE}。所有数据默认本地存储，你拥有完全的数据主权。`, icon: Rocket },
  { step: 2, title: '配置模型', body: '选择 Ollama 本地模型、自定义端点，或暂时跳过稍后配置。', icon: Globe },
  { step: 3, title: '授权工作区', body: '选择要授予 AI 访问权限的工作区目录，文件操作前会再次确认。', icon: FolderOpen },
  { step: 4, title: '试试示例任务', body: '选择一项开始体验，或直接进入主界面。', icon: MessageSquare },
  { step: 5, title: '准备就绪', body: 'InKling 已根据你的偏好初始化完成，随时可以开始。', icon: Rocket },
];

const EXAMPLE_TASKS = [
  '帮我总结这份文档的核心观点',
  '分析这个项目的架构并提出优化建议',
  '将这个 Python 脚本转换为 TypeScript',
];

export function OnboardingFlow({ open, onClose, onComplete }: OnboardingFlowProps): JSX.Element | null {
  const [step, setStep] = useState<Step>(1);
  const backend = createBackend();

  if (!open) return null;

  const current = STEPS.find((s) => s.step === step) ?? STEPS[0];
  const Icon = current.icon;

  const handleNext = async (): Promise<void> => {
    if (step === 5) {
      await dismiss();
      onComplete();
      return;
    }
    setStep((prev) => ((prev + 1) as Step));
  };

  const handleSkip = async (): Promise<void> => {
    await dismiss();
    onClose();
  };

  const dismiss = async (): Promise<void> => {
    try {
      if (backend.available) {
        await backend.firstRunDismiss();
      }
    } catch {
      // 静默降级
    }
  };

  const handleExampleTask = (_task: string): void => {
    alert('请先配置模型');
  };

  return (
    <div className="ink-onboarding-overlay" data-ui="onboarding_overlay">
      <div className="ink-onboarding-panel" role="dialog" aria-label="首启引导">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <span className="text-[11px] ink-text-muted">步骤 {step} / {STEPS.length}</span>
          </div>
          <button
            type="button"
            onClick={handleSkip}
            className="flex h-6 w-6 items-center justify-center rounded-md text-[10px] ink-text-faint hover:text-[var(--ink-text-base)] cursor-pointer bg-transparent border-none"
            aria-label="跳过引导"
          >
            <X size={12} strokeWidth={1.6} aria-hidden />
          </button>
        </div>

        <div className="px-6 pb-6">
          <div className="ink-elevated space-y-4 px-5 py-5">
            <div className="flex items-center gap-3">
              <span className="ink-icon-chip h-10 w-10 rounded-xl">
                <Icon size={18} strokeWidth={1.6} aria-hidden />
              </span>
              <div>
                <h3 className="text-[var(--ink-font-sm)] font-semibold">{current.title}</h3>
                <p className="mt-0.5 text-[11px] leading-relaxed ink-text-faint">{current.body}</p>
              </div>
            </div>

            {step === 2 && (
              <div className="space-y-2">
                <Button size="sm" variant="primary" data-ui="onboarding_ollama">
                  <Globe size={11} strokeWidth={1.6} /> Ollama 快捷配置
                </Button>
                <Button size="sm" variant="secondary" data-ui="onboarding_custom">
                  自定义端点
                </Button>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-2">
                <Button size="sm" variant="primary" data-ui="onboarding_authorize">
                  <FolderOpen size={11} strokeWidth={1.6} /> 授权工作区
                </Button>
              </div>
            )}

            {step === 4 && (
              <div className="space-y-2">
                {EXAMPLE_TASKS.map((task) => (
                  <button
                    key={task}
                    data-ui={`example_task_${task.slice(0, 8)}`}
                    onClick={() => handleExampleTask(task)}
                    className="ink-seg-item w-full text-left"
                  >
                    {task}
                  </button>
                ))}
              </div>
            )}

            {step === 5 && (
              <div className="flex items-center gap-2">
                <Button size="sm" variant="primary" onClick={handleNext}>
                  开始使用 <ChevronRight size={11} strokeWidth={1.6} />
                </Button>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between px-6 py-3">
          <button
            type="button"
            onClick={handleSkip}
            className="flex items-center gap-1 text-[10px] ink-text-faint cursor-pointer bg-transparent border-none"
          >
            <SkipForward size={10} strokeWidth={1.6} aria-hidden />
            跳过
          </button>
          {step < 5 && (
            <Button size="sm" variant="secondary" onClick={handleNext} data-ui="onboarding_next">
              下一步 <ChevronRight size={11} strokeWidth={1.6} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
