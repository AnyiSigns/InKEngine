/**
 * 「审计与恢复」生产设置节：审计流水导出（audit.list → JSON 下载）+ 崩溃
 * 回退快照恢复（recovery_snapshots 列表 → recovery_restore_snapshot 回到
 * 上一稳定版本；恢复后引擎停机重挂，下次命令自动装配快照时刻形态）。
 *
 * 全部经 BackendAdapter 命令面接线（受控通道）；宿主不可用 / 下载能力
 * 缺失 = 明确失败反馈，不报假成功。
 */

import { useCallback, useEffect, useState } from 'react';
import { Download, FileClock, History, RotateCcw, ShieldAlert } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { TextInput } from '@/shared/ui/Field';
import { cn } from '@/shared/cn';
import { createBackend } from '@/shared/backend/backendAdapter';
import type { BackendAdapter, RecoverySnapshot } from '@/shared/backend/backendAdapter';
import { Feedback, type FeedbackPhase } from '@/components/floaters/feedback';
import { logger } from '@/shared/logger';

/** 审计导出单次上限（与壳侧 audit.list 默认窗口一致，防全量膨胀）。 */
const AUDIT_EXPORT_LIMIT = 2000;

function formatSnapshotTime(createdAt: number): string {
  if (!createdAt) return '—';
  return new Date(createdAt).toLocaleString('zh-CN', { hour12: false });
}

function downloadJson(records: unknown): void {
  const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `audit_log_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function AuditRecoverySection({ backend }: { backend?: BackendAdapter }) {
  const host = backend ?? createBackend();
  const [auditPhase, setAuditPhase] = useState<FeedbackPhase>('idle');
  const [auditCount, setAuditCount] = useState(0);
  const [snapshots, setSnapshots] = useState<RecoverySnapshot[]>([]);
  const [snapshotsPhase, setSnapshotsPhase] = useState<FeedbackPhase>('idle');
  const [restorePhase, setRestorePhase] = useState<FeedbackPhase>('idle');
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const [resetPhase, setResetPhase] = useState<FeedbackPhase>('idle');
  const [resetConfirmWord, setResetConfirmWord] = useState('');

  const refreshSnapshots = useCallback(() => {
    if (!host.available) {
      setSnapshotsPhase('fail');
      return;
    }
    setSnapshotsPhase('loading');
    host
      .recoverySnapshots()
      .then(({ snapshots: list }) => {
        setSnapshots(list);
        setSnapshotsPhase('success');
      })
      .catch(() => {
        logger.error('settings', '启动快照清单读取失败');
        setSnapshotsPhase('fail');
      });
  }, [host]);

  useEffect(() => {
    refreshSnapshots();
  }, [refreshSnapshots]);

  const handleExportAudit = useCallback(async () => {
    if (!host.available) {
      setAuditPhase('fail');
      return;
    }
    const canDownload =
      typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
    if (!canDownload) {
      setAuditPhase('fail');
      return;
    }
    setAuditPhase('loading');
    try {
      const result = (await host.auditList({ limit: AUDIT_EXPORT_LIMIT })) as unknown[];
      downloadJson(result);
      setAuditCount(Array.isArray(result) ? result.length : 0);
      setAuditPhase('success');
    } catch (err) {
      logger.error('settings', '审计日志导出失败', { err: String(err) });
      setAuditPhase('fail');
    }
  }, [host]);

  const restoreSnapshot = useCallback(async () => {
    if (!host.available) {
      setRestorePhase('fail');
      return;
    }
    const target = snapshots[0];
    if (!target) {
      setRestorePhase('fail');
      return;
    }
    setRestorePhase('loading');
    try {
      await host.recoveryRestoreSnapshot(target.name);
      setRestorePhase('success');
      setConfirmingRestore(false);
      refreshSnapshots();
    } catch (err) {
      logger.error('settings', '快照恢复失败', { err: String(err), name: target.name });
      setRestorePhase('fail');
    }
  }, [host, snapshots, refreshSnapshots]);

  const latestSnapshot = snapshots[0] ?? null;

  const runFactoryReset = useCallback(async () => {
    if (!host.available) {
      setResetPhase('fail');
      return;
    }
    setResetPhase('loading');
    try {
      await host.recoveryFactoryReset();
      setResetConfirmWord('');
      setResetPhase('success');
      refreshSnapshots();
    } catch (err) {
      logger.error('settings', '出厂重置失败', { err: String(err) });
      setResetPhase('fail');
    }
  }, [host, refreshSnapshots]);

  return (
    <div data-ui="audit_recovery_section" className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <FileClock size={14} strokeWidth={1.6} className="text-[var(--ink-text-muted)]" />
        <h3 className="text-[13px] font-medium text-[var(--ink-text-base)]">审计与恢复</h3>
      </div>

      <div className="flex flex-col gap-2 rounded border border-[var(--ink-border)] p-3">
        <div className="text-[11px] font-medium text-[var(--ink-text-base)]">审计导出</div>
        <div className="text-[10px] leading-relaxed text-[var(--ink-text-faint)]">
          导出审计流水（audit.list → JSON 下载）：自进化/干预动作的 append-only 留痕，
          最近 {AUDIT_EXPORT_LIMIT} 条。
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            data-ui="audit_export"
            disabled={!host.available || auditPhase === 'loading'}
            onClick={() => void handleExportAudit()}
          >
            <Download size={11} strokeWidth={1.6} />
            导出审计 JSON
          </Button>
          <Feedback
            phase={auditPhase}
            okText={auditCount > 0 ? `已导出 ${auditCount} 条审计记录` : '审计日志已导出'}
            failText={host.available ? '导出失败（下载能力不可用或宿主异常）' : '宿主不可用，导出未接线'}
          />
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded border border-[var(--ink-border)] p-3">
        <div className="flex items-center gap-2">
          <History size={11} strokeWidth={1.6} className="text-[var(--ink-text-muted)]" />
          <span className="text-[11px] font-medium text-[var(--ink-text-base)]">崩溃回退（回到上一稳定版本）</span>
        </div>
        <div className="text-[10px] leading-relaxed text-[var(--ink-text-faint)]">
          启动快照按链版本轮换保留（成功启动自动生成）。恢复 = 从最新快照经引擎存储
          契约 restore → 引擎停机重挂，下次命令自动回到快照时刻形态。
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" data-ui="recovery_refresh" onClick={refreshSnapshots}>
            <History size={11} strokeWidth={1.6} />
            刷新快照
          </Button>
          {latestSnapshot && (
            <Button
              size="sm"
              variant="secondary"
              data-ui="recovery_restore"
              onClick={() => {
                if (confirmingRestore) {
                  void restoreSnapshot();
                } else {
                  setConfirmingRestore(true);
                }
              }}
            >
              <RotateCcw size={11} strokeWidth={1.6} />
              {confirmingRestore ? `确认恢复 ${latestSnapshot.name}？` : '恢复到上一稳定版本'}
            </Button>
          )}
          {confirmingRestore && (
            <Button size="sm" variant="ghost" data-ui="recovery_restore_cancel" onClick={() => setConfirmingRestore(false)}>
              取消
            </Button>
          )}
          <Feedback phase={restorePhase} okText="已恢复到上一稳定版本" failText="恢复失败" />
          <Feedback phase={snapshotsPhase} okText="快照已刷新" failText="快照读取失败" />
        </div>
        {latestSnapshot ? (
          <ul className="divide-y divide-[var(--ink-border)] overflow-hidden rounded">
            {snapshots.slice(0, 5).map((snapshot) => (
              <li
                key={snapshot.name}
                data-ui={`recovery_snapshot_${snapshot.name}`}
                className="flex items-center justify-between gap-2 px-1 py-1.5"
              >
                <span className={cn('truncate font-mono text-[10px]', 'text-[var(--ink-text-muted)]')}>
                  {snapshot.name}
                </span>
                <span className="shrink-0 text-[10px] text-[var(--ink-text-faint)]">
                  v{snapshot.chain_version} · {formatSnapshotTime(snapshot.created_at)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[10px] text-[var(--ink-text-faint)]">
            {snapshotsPhase === 'fail'
              ? '快照清单读取失败（宿主未接线或不可用）。'
              : '暂无启动快照（成功启动后按链版本自动轮换生成）。'}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2 rounded border border-[var(--ink-accent-border)] p-3">
        <div className="flex items-center gap-1 text-[11px] text-[var(--ink-accent-approval)]">
          <ShieldAlert size={11} strokeWidth={1.6} />
          <span className="font-medium text-[var(--ink-text-base)]">出厂重置（清除本地配置）</span>
        </div>
        <div className="text-[10px] leading-relaxed text-[var(--ink-text-faint)]">
          补丁链逐尾回退至基线（每条回退留审计）；链记录损坏时清空回基线并留痕。
          完成后引擎停机重挂 = 出厂基线 + 种子重注入。请输入确认词「重置」。
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TextInput
            className="w-40"
            value={resetConfirmWord}
            onChange={(e) => setResetConfirmWord(e.target.value)}
            placeholder="输入确认词「重置」"
            aria-label="重置确认词"
          />
          <Button
            size="sm"
            variant="accent"
            data-ui="recovery_factory_reset"
            disabled={resetConfirmWord !== '重置' || resetPhase === 'loading'}
            onClick={() => void runFactoryReset()}
          >
            <RotateCcw size={11} strokeWidth={1.6} />
            确认出厂重置
          </Button>
          <Feedback phase={resetPhase} okText="已重置为出厂基线" failText="重置失败" />
        </div>
      </div>
    </div>
  );
}
