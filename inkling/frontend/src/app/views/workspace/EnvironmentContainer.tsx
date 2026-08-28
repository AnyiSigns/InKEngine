/**
 * 环境容器视图（W5.5）：环境容器节显示为禁用态。
 *
 * 文案「桌面以 OS 沙箱为主；容器域标记」。
 * Q27 定稿不假实现不补命令；该节在设置页由波 2 就位，
 * 此处确保无残留假动作。
 */

import { AppWindow, Server } from 'lucide-react';

import { Button } from '@/shared/ui/Button';

interface EnvironmentContainerProps {
  /** 容器域标记（供设置页波 2 传入） */
  domainMark?: string;
}

export function EnvironmentContainer({ domainMark }: EnvironmentContainerProps) {
  const handleStub = (): void => {
    null;
  };

  return (
    <section className="ink-panel p-4 space-y-4" data-ui="environment_container">
      <div className="flex items-center gap-2.5">
        <Server size={14} strokeWidth={1.5} className="ink-text-faint" aria-hidden />
        <span className="text-[12px] font-semibold tracking-tight">环境容器</span>
      </div>

      <div className="ink-elevated space-y-3 px-3.5 py-3">
        <div className="flex items-center gap-2.5">
          <span className="w-28 text-[10px] ink-text-muted">容器创建策略</span>
          <span className="text-[10px] ink-text-faint">（暂未启用）</span>
        </div>

        <div className="flex items-center gap-2.5">
          <span className="w-28 text-[10px] ink-text-muted">镜像清单</span>
          <span className="font-mono text-[9px] ink-text-faint break-all">
            inkling-workspace:0.1.0
          </span>
        </div>

        <div className="flex gap-2">
          <Button size="sm" variant="secondary" data-ui="env_create" onClick={handleStub} disabled>
            <AppWindow size={10} strokeWidth={1.5} aria-hidden />
            创建容器
          </Button>
          <Button size="sm" variant="ghost" data-ui="env_destroy" onClick={handleStub} disabled>
            全部销毁
          </Button>
        </div>

        {domainMark ? (
          <div className="text-[10px] leading-relaxed ink-text-faint">
            容器域标记：{domainMark}
          </div>
        ) : null}

        <p className="flex items-center gap-1.5 text-[10px] leading-relaxed ink-text-faint">
          <AppWindow size={10} strokeWidth={1.5} className="shrink-0" aria-hidden />
          桌面以 OS 沙箱为主；容器域标记。
        </p>
      </div>
    </section>
  );
}
