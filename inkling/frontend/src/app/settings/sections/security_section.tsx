/**
 * 设置「安全信任」节骨架：安全流水线安装态 + 权限矩阵入口（详细归波 4）。
 *
 * 展示「安全流水线已安装/未安装」；未安装 = 提示 + 说明「沙箱守卫不生效」；
 * 权限矩阵/自动审批编辑归波 4 经 registry 扩展位，此处留注入口。
 */

import { useEffect, useState } from 'react';

import { ShieldCheck, ShieldAlert } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { Feedback } from '@/components/floaters/feedback';
import type { FeedbackPhase } from '@/components/floaters/feedback';
import { createTauriInvoker } from '@/shared/backend/tauriBridge';

export interface SecuritySectionValue {
  pipelineInstalled: boolean;
}

export function SecuritySection(): JSX.Element {
  const tauri = createTauriInvoker();
  const [pipeline, setPipeline] = useState<boolean>(false);
  const [phase, setPhase] = useState<FeedbackPhase>('idle');

  useEffect(() => {
    if (!tauri) return;
    void (async () => {
      try {
        const result = (await tauri.invoke('pipeline_security_status')) as { installed?: boolean };
        setPipeline(Boolean(result?.installed));
      } catch {
        setPipeline(false);
      }
    })();
  }, [tauri]);

  const toggle = async (): Promise<void> => {
    setPhase('loading');
    try {
      if (tauri) {
        await tauri.invoke('pipeline_install_security_pipeline', { install: !pipeline });
      }
      setPipeline((prev) => !prev);
      setPhase('success');
      setTimeout(() => setPhase('idle'), 1200);
    } catch {
      setPhase('fail');
      setTimeout(() => setPhase('idle'), 2000);
    }
  };

  return (
    <div className="space-y-4">
      <div className="ink-elevated space-y-3 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">安全流水线</div>
        <div className="flex items-center gap-3">
          <span className="ink-icon-chip h-8 w-8 inline-flex items-center justify-center rounded-lg">
            {pipeline ? (
              <ShieldCheck size={16} strokeWidth={1.6} className="ink-text-accent" aria-hidden />
            ) : (
              <ShieldAlert size={16} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
            )}
          </span>
          <div className="min-w-0">
            <div className="text-[11px] font-medium">{pipeline ? '安全流水线已安装' : '安全流水线未安装'}</div>
            <div className="text-[10px] ink-text-faint">
              {pipeline ? '沙箱守卫已生效' : '沙箱守卫不生效，建议立即安装'}
            </div>
          </div>
          <div className="ml-auto">
            <Button size="xs" variant={pipeline ? 'secondary' : 'accent'} onClick={toggle} data-ui="pipeline_toggle">
              {pipeline ? '卸载' : '安装'}
            </Button>
          </div>
        </div>
        <Feedback phase={phase} okText="操作成功" failText="操作失败" />
      </div>

      <div className="ink-elevated space-y-3 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">权限矩阵</div>
        <p className="text-[10px] ink-text-faint">
          详细权限矩阵编辑（allow/review/deny 三档 + 自动审批工具集勾选）归波 4 经 registry 扩展位实现，此处留注入口。
        </p>
        <Button size="sm" variant="secondary" disabled data-ui="permission_matrix_entry">
          权限矩阵（待接线）
        </Button>
      </div>
    </div>
  );
}
