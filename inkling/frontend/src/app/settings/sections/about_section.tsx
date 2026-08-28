/**
 * 设置「关于」节：版本 / 引擎兼容 / 契约清单 / 数据主权声明 / 审计导出入口。
 *
 * 审计导出真功能归波 5 管理台，此处留入口态。
 */

import { useState } from 'react';

import { FileClock, Info, ShieldCheck } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { Feedback } from '@/components/floaters/feedback';
import type { FeedbackPhase } from '@/components/floaters/feedback';

export function AboutSection(): JSX.Element {
  const [auditPhase, setAuditPhase] = useState<FeedbackPhase>('idle');

  const handleAuditExport = (): void => {
    setAuditPhase('loading');
    setTimeout(() => setAuditPhase('success'), 800);
    setTimeout(() => setAuditPhase('idle'), 2000);
  };

  return (
    <div className="space-y-4">
      <div className="ink-elevated space-y-2 px-3.5 py-3">
        <div className="flex items-center gap-2">
          <Info size={14} strokeWidth={1.6} aria-hidden />
          <span className="text-[var(--ink-font-xs)] font-semibold">InKling 0.1.0</span>
        </div>
        <div className="text-[10px] leading-relaxed ink-text-muted">engine_version_compat：按当前 ink_engine 锁定</div>
        <div className="text-[10px] leading-relaxed ink-text-faint">
          契约：inkling_exec（执行件）· inkling_shell（宿主件）· 渲染组件白名单 · 事件类型清单 · 工具清单
        </div>
      </div>

      <div className="ink-elevated space-y-2.5 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">数据主权</div>
        <p className="text-[10px] leading-relaxed ink-text-faint">
          本地优先：所有会话数据、记忆、补丁链默认存储于本地数据目录，不上传云端。
          远程模型调用仅传输当前回合所需上下文，不发送历史记录。
        </p>
      </div>

      <div className="ink-elevated space-y-2.5 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">审计</div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={handleAuditExport} data-ui="audit_export">
            <FileClock size={11} strokeWidth={1.6} /> 导出审计日志
          </Button>
          <Feedback phase={auditPhase} okText="审计日志已导出" failText="导出失败" />
        </div>
        <p className="text-[10px] ink-text-faint">审计导出真功能归波 5 管理台，此处留入口态。</p>
      </div>

      <div className="ink-elevated space-y-2.5 px-3.5 py-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={14} strokeWidth={1.6} aria-hidden />
          <span className="text-[11px] font-medium">安全与合规</span>
        </div>
        <p className="text-[10px] leading-relaxed ink-text-faint">
          密钥三处剥离（落库/日志/事件无值）；错误不回显明文；审计导出不含 URL/API key。
        </p>
      </div>
    </div>
  );
}
