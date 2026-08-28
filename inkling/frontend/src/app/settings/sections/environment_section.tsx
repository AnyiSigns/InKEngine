/**
 * 设置「环境容器」节：Q27 定稿禁用态 + 文案「桌面以 OS 沙箱为主；容器域标记」。
 *
 * 不出假开关，整节禁用灰显+说明。
 */

import { AppWindow } from 'lucide-react';

export function EnvironmentSection(): JSX.Element {
  return (
    <div className="space-y-4">
      <div className="ink-elevated space-y-3 px-3.5 py-3 opacity-60">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">环境容器</div>
        <div className="flex items-center gap-2">
          <AppWindow size={14} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
          <span className="text-[11px] ink-text-muted">容器域标记</span>
        </div>
        <p className="text-[10px] leading-relaxed ink-text-faint">
          桌面以 OS 沙箱为主；容器域标记由宿主执行件承载，本页暂不可配置。
        </p>
      </div>
    </div>
  );
}
