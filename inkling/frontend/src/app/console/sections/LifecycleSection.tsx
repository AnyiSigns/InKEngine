import { useEffect, useState } from 'react';
import { AlertTriangle, Play, Power, Square } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { invokeOp } from '../../shared/invokeOp';

export type LifecycleState = 'running' | 'paused' | 'stopped' | 'safe_mode';

export interface LifecycleStatus {
  state: LifecycleState;
  boot_state: string;
  engine_ready: boolean;
  safe_mode: boolean;
}

const STATE_LABELS: Record<LifecycleState, string> = {
  running: '运行中',
  paused: '已暂停',
  stopped: '已停止',
  safe_mode: '安全模式',
};

export function LifecycleSection() {
  const [status, setStatus] = useState<LifecycleStatus | null>(null);

  useEffect(() => {
    void load();
  }, []);

  const load = async () => {
    const result = await invokeOp<LifecycleStatus>('runtime_state', {});
    setStatus(result ?? { state: 'stopped', boot_state: 'cold', engine_ready: false, safe_mode: false });
  };

  const handlePause = async () => {
    await invokeOp('runtime_pause', {});
    await load();
  };

  const handleResume = async () => {
    await invokeOp('runtime_resume', {});
    await load();
  };

  const handleStop = async () => {
    await invokeOp('runtime_stop', {});
    await load();
  };

  const handleExitSafeMode = async () => {
    await invokeOp('runtime_resume', {});
    await load();
  };

  const state = status?.state ?? 'stopped';

  return (
    <div data-ui="lifecycle_section" className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Power size={14} strokeWidth={1.6} className="text-[var(--ink-text-muted)]" />
        <h3 className="text-[13px] font-medium text-[var(--ink-text-base)]">生命周期</h3>
      </div>

      {status?.safe_mode && (
        <div className="flex items-center gap-2 rounded border border-[var(--ink-accent-border)] p-2 text-[11px] text-[var(--ink-accent-approval)]">
          <AlertTriangle size={12} strokeWidth={1.6} />
          引擎处于安全模式
        </div>
      )}

      <div className="flex flex-col gap-2 rounded border border-[var(--ink-border)] p-3">
        <div className="flex items-center gap-2">
          <span className={cn('h-2 w-2 rounded-full', status?.engine_ready ? 'bg-emerald-500' : 'bg-[var(--ink-text-faint)]')} />
          <span className="text-[12px] text-[var(--ink-text-base)]">
            {STATE_LABELS[state]}
          </span>
        </div>

        <div className="text-[10px] text-[var(--ink-text-faint)]">
          启动状态: {status?.boot_state}
        </div>
      </div>

      <div className="flex gap-2">
        {state === 'running' && (
          <Button size="sm" variant="secondary" onClick={() => handlePause()}>
            <Square size={12} strokeWidth={1.6} />
            暂停
          </Button>
        )}
        {(state === 'paused' || state === 'stopped') && (
          <Button size="sm" variant="primary" onClick={() => handleResume()}>
            <Play size={12} strokeWidth={1.6} />
            恢复
          </Button>
        )}
        {state === 'running' && (
          <Button size="sm" variant="secondary" onClick={() => handleStop()}>
            <Square size={12} strokeWidth={1.6} />
            停止
          </Button>
        )}
        {status?.safe_mode && (
          <Button size="sm" variant="accent" onClick={() => handleExitSafeMode()}>
            <Play size={12} strokeWidth={1.6} />
            退出安全模式
          </Button>
        )}
      </div>
    </div>
  );
}

function cn(...classes: Array<string | boolean | undefined>): string {
  return classes.filter(Boolean).join(' ');
}
