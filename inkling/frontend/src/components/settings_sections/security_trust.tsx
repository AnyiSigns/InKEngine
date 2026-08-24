/**
 * 设置「安全信任」节：权限矩阵 / 网络策略 / 审计入口 / 导出恢复入口 /
 * 崩溃回退（启动快照回上一稳定版本 / 出厂重置）。
 */

import { useCallback, useState } from 'react';

import { Download, FileClock, History, RotateCcw, ShieldCheck, Upload } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { TextInput } from '@/shared/ui/Field';
import { Feedback } from '@/components/floaters/feedback';
import type { FeedbackPhase } from '@/components/floaters/feedback';
import type { BackendAdapter, RecoverySnapshot } from '@/shared/backend/backendAdapter';

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

/** 崩溃回退操作面（宿主后端接线；无宿主 = 空操作，按钮失败反馈）。 */
export interface RecoveryOps {
  status(): Promise<{ engine_ready: boolean; tool_count: number; safe_mode?: boolean }>;
  snapshots(): Promise<{ snapshots: RecoverySnapshot[] }>;
  restore(name: string): Promise<{ restored: string; chain_version: number }>;
  factoryReset(): Promise<{ reverted_patches: number[]; overwritten: boolean }>;
}

/** 崩溃回退操作构造（宿主可用性为唯一判据）。 */
export function recoveryOpsFrom(backend: BackendAdapter | null): RecoveryOps | null {
  if (!backend?.available) return null;
  return {
    status: () => backend.status(),
    snapshots: () => backend.recoverySnapshots(),
    restore: (name) => backend.recoveryRestoreSnapshot(name),
    factoryReset: () => backend.recoveryFactoryReset(),
  };
}

function formatSnapshotTime(createdAt: number): string {
  if (!createdAt) return '—';
  return new Date(createdAt).toLocaleString('zh-CN', { hour12: false });
}

interface SecurityTrustProps {
  value: SecurityValue;
  patch: (next: Partial<SecurityValue>) => void;
  /** 备份/恢复向导入口（宿主接线：导出 = 一键打包；恢复 = 校验预览 + 快照） */
  onOpenBackupWizard?: (mode: 'export' | 'restore') => void;
  /** 崩溃回退操作面（回上一稳定版本 / 出厂重置的宿主接线） */
  recovery?: RecoveryOps | null;
}

export function SecurityTrust({ value, patch, onOpenBackupWizard, recovery }: SecurityTrustProps) {
  const [auditPhase, setAuditPhase] = useState<FeedbackPhase>('idle');
  const [snapshots, setSnapshots] = useState<RecoverySnapshot[]>([]);
  const [snapshotsPhase, setSnapshotsPhase] = useState<FeedbackPhase>('idle');
  const [restorePhase, setRestorePhase] = useState<FeedbackPhase>('idle');
  const [resetPhase, setResetPhase] = useState<FeedbackPhase>('idle');
  const [safeMode, setSafeMode] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'restore' | 'reset' | null>(null);

  const refreshSnapshots = useCallback(() => {
    if (!recovery) {
      setSnapshotsPhase('fail');
      return;
    }
    setSnapshotsPhase('loading');
    recovery
      .snapshots()
      .then(({ snapshots: list }) => {
        setSnapshots(list);
        setSnapshotsPhase('success');
      })
      .catch(() => setSnapshotsPhase('fail'));
    recovery
      .status()
      .then((status) => setSafeMode(Boolean(status.safe_mode)))
      .catch(() => setSafeMode(false));
  }, [recovery]);

  const runRestore = useCallback(() => {
    if (!recovery) {
      setRestorePhase('fail');
      return;
    }
    setRestorePhase('loading');
    recovery
      .restore(snapshots[0]?.name ?? '')
      .then(() => {
        setRestorePhase('success');
        setConfirmAction(null);
      })
      .catch(() => setRestorePhase('fail'));
  }, [recovery, snapshots]);

  const runFactoryReset = useCallback(() => {
    if (!recovery) {
      setResetPhase('fail');
      return;
    }
    setResetPhase('loading');
    recovery
      .factoryReset()
      .then(() => {
        setResetPhase('success');
        setConfirmAction(null);
      })
      .catch(() => setResetPhase('fail'));
  }, [recovery]);

  const latestSnapshot = snapshots[0] ?? null;

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
      <div className="ink-elevated space-y-2.5 px-3.5 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium tracking-wide ink-text-muted">崩溃回退</span>
          {safeMode && (
            <span
              data-ui="recovery_safe_mode_badge"
              className="rounded px-1.5 py-0.5 text-[10px] font-medium text-[var(--ink-warning)]"
            >
              安全模式：自写资产已停用（出厂基线启动）
            </span>
          )}
        </div>
        <p className="text-[10px] leading-relaxed ink-text-faint">
          启动失败自动逐尾回退补丁链直至可启动；连续失败转入安全模式。启动快照按链版本轮换保留，
          「回到上一稳定版本」= 从最新快照恢复。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" data-ui="recovery_refresh" onClick={refreshSnapshots}>
            <History size={11} strokeWidth={1.6} /> 刷新快照
          </Button>
          <Button
            size="sm"
            variant="secondary"
            data-ui="recovery_restore"
            disabled={!latestSnapshot}
            onClick={() => {
              if (confirmAction === 'restore') {
                runRestore();
              } else {
                setConfirmAction('restore');
              }
            }}
          >
            <RotateCcw size={11} strokeWidth={1.6} />
            {confirmAction === 'restore' ? '确认回到上一稳定版本？' : '回到上一稳定版本'}
          </Button>
          <Button
            size="sm"
            variant="accent"
            data-ui="recovery_factory_reset"
            onClick={() => {
              if (confirmAction === 'reset') {
                runFactoryReset();
              } else {
                setConfirmAction('reset');
              }
            }}
          >
            <Download size={11} strokeWidth={1.6} className="rotate-180" />
            {confirmAction === 'reset' ? '确认出厂重置？' : '出厂重置'}
          </Button>
          <Feedback phase={restorePhase} okText="已恢复到上一稳定版本" failText="恢复失败" />
          <Feedback phase={resetPhase} okText="已重置为出厂基线" failText="重置失败" />
        </div>
        <div className="flex items-center gap-2">
          <Feedback phase={snapshotsPhase} okText="快照已刷新" failText="快照读取失败" />
        </div>
        {latestSnapshot ? (
          <ul className="divide-y divide-[var(--ink-border)] overflow-hidden rounded">
            {snapshots.slice(0, 5).map((snapshot) => (
              <li key={snapshot.name} className="flex items-center justify-between gap-2 px-1 py-1.5">
                <span className="truncate font-mono text-[10px] ink-text-muted">{snapshot.name}</span>
                <span className="shrink-0 text-[10px] ink-text-faint">
                  v{snapshot.chain_version} · {formatSnapshotTime(snapshot.created_at)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[10px] ink-text-faint">暂无启动快照（成功启动后按链版本自动轮换生成）。</p>
        )}
      </div>
    </div>
  );
}
