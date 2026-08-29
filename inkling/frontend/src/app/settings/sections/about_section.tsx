/**
 * 设置「关于」节：版本 / 数据主权声明 / 安全合规说明。
 *
 * 审计导出真功能在管理台（设置「审计」节），此处不放
 * 假成功按钮；引擎兼容细节同样归管理台「关于」。
 */

import { Info, ShieldCheck } from 'lucide-react';

export function AboutSection(): JSX.Element {
  return (
    <div className="space-y-4">
      <div className="ink-elevated space-y-2 px-3.5 py-3">
        <div className="flex items-center gap-2">
          <Info size={14} strokeWidth={1.6} aria-hidden />
          <span className="text-[var(--ink-font-xs)] font-semibold">InKling 0.1.0</span>
        </div>
        <div className="text-[11px] leading-relaxed ink-text-faint">
          自学习 agent 引擎桌面端；引擎版本随当前 ink_engine 锁定。
        </div>
      </div>

      <div className="ink-elevated space-y-2.5 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">数据主权</div>
        <p className="text-[11px] leading-relaxed ink-text-faint">
          本地优先：所有会话数据、记忆、补丁链默认存储于本地数据目录，不上传云端。
          远程模型调用仅传输当前回合所需上下文，不发送历史记录。
        </p>
      </div>

      <div className="ink-elevated space-y-2.5 px-3.5 py-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={14} strokeWidth={1.6} aria-hidden />
          <span className="text-[11px] font-medium">安全与合规</span>
        </div>
        <p className="text-[11px] leading-relaxed ink-text-faint">
          密钥三处剥离（落库/日志/事件无值）；错误不回显明文；审计导出不含 URL/API key。
        </p>
        <p className="text-[11px] leading-relaxed ink-text-faint">
          审计导出与引擎诊断位于「设置 → 审计」。
        </p>
      </div>
    </div>
  );
}
