/**
 * 设置「环境容器」节：创建前审批 / 镜像清单 / 孤儿清理 / 幂等销毁入口。
 */

import { useState } from 'react';

import { AppWindow, Trash2 } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { Field, TextInput } from '@/shared/ui/Field';
import { Feedback } from '@/components/floaters/feedback';
import type { FeedbackPhase } from '@/components/floaters/feedback';

export interface EnvironmentValue {
  approveBeforeCreate: boolean;
  imageRef: string;
}

export const DEFAULT_ENVIRONMENT: EnvironmentValue = {
  approveBeforeCreate: true,
  imageRef: 'inkling-workspace:0.1.0',
};

interface EnvironmentContainerProps {
  value: EnvironmentValue;
  patch: (next: Partial<EnvironmentValue>) => void;
}

export function EnvironmentContainer({ value, patch }: EnvironmentContainerProps) {
  const [cleaning, setCleaning] = useState<FeedbackPhase>('idle');
  const [destroyArmed, setDestroyArmed] = useState(false);

  const runClean = (): void => {
    setCleaning('success');
  };

  return (
    <div className="space-y-4">
      <div className="ink-elevated space-y-2.5 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">容器创建策略</div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            className="ink-check"
            checked={value.approveBeforeCreate}
            onChange={(e) => patch({ approveBeforeCreate: e.target.checked })}
            data-ui="env_approve_before_create"
          />
          <span className="text-[11px]">创建容器前必须人工审批（fail-closed）</span>
        </label>
        <Field label="镜像清单（image_ref）" hint="环境容器创建基线；离线缓存优先，缺失时提示拉取。">
          <TextInput
            value={value.imageRef}
            aria-label="镜像清单"
            className="w-56 font-mono text-[10px]"
            onChange={(e) => patch({ imageRef: e.target.value })}
          />
        </Field>
      </div>
      <div className="ink-elevated space-y-2.5 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">维护入口</div>
        <div className="flex items-center gap-2">
          <span className="w-28 shrink-0 text-[11px] ink-text-muted">孤儿清理</span>
          <Button size="sm" variant="secondary" data-ui="env_orphan_clean" onClick={runClean}>
            清理孤儿容器
          </Button>
          <Feedback phase={cleaning} okText="清理完成" failText="清理失败" />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-28 shrink-0 text-[11px] ink-text-muted">幂等销毁</span>
          {destroyArmed ? (
            <div className="ink-status-bubble flex items-center gap-1.5 px-2 py-1" data-ui="env_destroy_confirm">
              <span className="text-[10px] ink-text-muted">确认销毁全部环境容器？</span>
              <Button
                size="xs"
                variant="accent"
                onClick={() => {
                  setDestroyArmed(false);
                }}
              >
                确认
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setDestroyArmed(false)}>
                取消
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="ghost" data-ui="env_destroy" onClick={() => setDestroyArmed(true)}>
              <Trash2 size={11} strokeWidth={1.6} /> 全部销毁
            </Button>
          )}
        </div>
      </div>
      <p className="flex items-center gap-1.5 text-[10px] leading-relaxed ink-text-faint">
        <AppWindow size={10} strokeWidth={1.6} className="shrink-0" aria-hidden />
        环境容器 = 引擎执行侧的工作区沙箱；本页为策略与维护入口，容器生命周期由宿主执行件承载。
      </p>
    </div>
  );
}
