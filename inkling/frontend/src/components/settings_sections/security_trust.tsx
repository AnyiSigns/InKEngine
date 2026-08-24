/**
 * 设置「安全信任」节：权限矩阵 / 网络策略 / 审计入口 / 导出恢复入口。
 */

import { useState } from 'react';

import { Download, FileClock, ShieldCheck, Upload } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { TextInput } from '@/shared/ui/Field';
import { Feedback } from '@/components/floaters/feedback';
import type { FeedbackPhase } from '@/components/floaters/feedback';

export const APPROVAL_LEVELS = ['L0', 'L1', 'L2'] as const;
export const APPROVAL_KINDS = ['rule', 'knowledge', 'tool', 'harness', 'theme', 'event_type', 'environment', 'artifact'] as const;
export const DEFAULT_PERMISSIONS = ['allow', 'review', 'deny'] as const;

export type ApprovalLevel = (typeof APPROVAL_LEVELS)[number];
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];
export type DefaultPermission = (typeof DEFAULT_PERMISSIONS)[number];

export interface SecurityValue {
  approvals: Record<ApprovalKind, ApprovalLevel>;
  defaultPermission: DefaultPermission;
  timeoutSecs: string;
  networkEnabled: boolean;
  networkAllowlist: string;
}

export const DEFAULT_SECURITY: SecurityValue = {
  approvals: {
    rule: 'L1', knowledge: 'L2', tool: 'L2', harness: 'L2', theme: 'L0', event_type: 'L2', environment: 'L2', artifact: 'L2',
  },
  defaultPermission: 'review',
  timeoutSecs: '30',
  networkEnabled: false,
  networkAllowlist: '',
};

interface SecurityTrustProps {
  value: SecurityValue;
  patch: (next: Partial<SecurityValue>) => void;
  /** 备份/恢复向导入口（宿主接线：导出 = 一键打包；恢复 = 校验预览 + 快照） */
  onOpenBackupWizard?: (mode: 'export' | 'restore') => void;
}

export function SecurityTrust({ value, patch, onOpenBackupWizard }: SecurityTrustProps) {
  const [auditPhase, setAuditPhase] = useState<FeedbackPhase>('idle');

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1.5 text-[11px] font-medium tracking-wide ink-text-muted">权限矩阵（kind → L0/L1/L2）</div>
        <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden">
          {APPROVAL_KINDS.map((kind) => (
            <div key={kind} className="flex items-center gap-3 px-3.5 py-2">
              <span className="w-32 shrink-0 truncate font-mono text-[10px] ink-text-muted">{kind}</span>
              <div className="flex gap-0.5">
                {APPROVAL_LEVELS.map((level) => (
                  <button
                    key={level}
                    data-ui={`approval_${kind}_${level}`}
                    data-active={value.approvals[kind] === level}
                    onClick={() => patch({ approvals: { ...value.approvals, [kind]: level } })}
                    className="ink-seg-item"
                  >
                    {level}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="ink-elevated space-y-3 px-3.5 py-3">
        <div className="flex items-center gap-3">
          <span className="w-32 shrink-0 text-[11px] ink-text-muted">默认权限档</span>
          <div className="ink-seg">
            {DEFAULT_PERMISSIONS.map((permission) => (
              <button
                key={permission}
                data-ui={`default_permission_${permission}`}
                data-active={value.defaultPermission === permission}
                onClick={() => patch({ defaultPermission: permission })}
                className="ink-seg-item"
              >
                {permission}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-32 shrink-0 text-[11px] ink-text-muted">审批超时</span>
          <TextInput
            className="w-24"
            value={value.timeoutSecs}
            onChange={(e) => patch({ timeoutSecs: e.target.value })}
            aria-label="审批超时秒数"
          />
          <span className="text-[10px] ink-text-faint">秒 · fail-closed</span>
        </div>
      </div>
      <div className="ink-elevated space-y-2.5 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">网络策略</div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            className="ink-check"
            checked={value.networkEnabled}
            onChange={(e) => patch({ networkEnabled: e.target.checked })}
            data-ui="net_enabled"
          />
          <span className="text-[11px]">允许联网工具（fetch_web / MCP 网络端点）</span>
        </label>
        <div className="flex items-center gap-2">
          <span className="w-32 shrink-0 text-[11px] ink-text-muted">域名白名单</span>
          <TextInput
            value={value.networkAllowlist}
            placeholder="example.com, docs.example.org"
            aria-label="网络域名白名单"
            className="font-mono text-[10px]"
            onChange={(e) => patch({ networkAllowlist: e.target.value })}
          />
        </div>
      </div>
      <div className="ink-elevated space-y-2.5 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">审计与恢复</div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            data-ui="audit_export"
            onClick={() => {
              setAuditPhase('loading');
              setTimeout(() => setAuditPhase('success'), 120);
            }}
          >
            <FileClock size={11} strokeWidth={1.6} /> 导出审计日志
          </Button>
          <Feedback phase={auditPhase} okText="审计日志已导出" failText="导出失败" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            data-ui="backup_export_entry"
            onClick={() => onOpenBackupWizard?.('export')}
          >
            <Download size={11} strokeWidth={1.6} /> 一键导出
          </Button>
          <Button
            size="sm"
            variant="secondary"
            data-ui="backup_restore_entry"
            onClick={() => onOpenBackupWizard?.('restore')}
          >
            <Upload size={11} strokeWidth={1.6} /> 恢复向导
          </Button>
          <Button size="sm" variant="ghost">清除本地配置</Button>
        </div>
        <p className="flex items-center gap-1.5 text-[10px] leading-relaxed ink-text-faint">
          <ShieldCheck size={10} strokeWidth={1.6} className="shrink-0" aria-hidden />
          导出 = 数据目录一键打包（含会话/记忆/补丁链快照）；恢复前自动快照当前态（防误恢复）。
        </p>
      </div>
    </div>
  );
}
