/**
 * 「审计与恢复」设置节：审计导出 + 会话链回退（checkpoints/rollback 以当前
 * 活动会话 thread_id 为上下文）+ 出厂重置。
 *
 * 数据源：
 * - audit.list 只读窗口 → JSON 下载；
 * - recovery.checkpoints / recovery.rollback（per-thread 回退点与回退入口）；
 * - recovery.reset（出厂重置，危险操作确认词 fail-closed）。
 * 无活动会话 = 回退区空态文案（不误触发空目标/全量操作）；确认词流程保持。
 */

import { useCallback, useEffect, useState } from 'react';
import { Download, FileClock, History, RotateCcw, Settings2, ShieldAlert } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { TextInput } from '@/shared/ui/Field';
import { cn } from '@/shared/cn';
import { createBackend } from '@/shared/backend/backendAdapter';
import type { BackendAdapter, RecoveryCheckpoint } from '@/shared/backend/backendAdapter';
import { Feedback, type FeedbackPhase } from '@/components/floaters/feedback';
import { logger } from '@/shared/logger';
import { useActiveThreadId } from '@app/state/activeThread';

const AUDIT_EXPORT_LIMIT = 2000;

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

/** 可回退链状态（无活动会话/无父锚点 = 不可回退空态）。 */
function rollbackAvailable(points: RecoveryCheckpoint[]): boolean {
  return points.length >= 2;
}

export function AuditRecoverySection({ backend }: { backend?: BackendAdapter }) {
  const host = backend ?? createBackend();
  const threadId = useActiveThreadId();
  const [auditPhase, setAuditPhase] = useState<FeedbackPhase>('idle');
  const [auditCount, setAuditCount] = useState(0);
  const [points, setPoints] = useState<RecoveryCheckpoint[]>([]);
  const [pointsPhase, setPointsPhase] = useState<FeedbackPhase>('idle');
  const [rollbackPhase, setRollbackPhase] = useState<FeedbackPhase>('idle');
  const [confirmingRollback, setConfirmingRollback] = useState(false);
  const [resetPhase, setResetPhase] = useState<FeedbackPhase>('idle');
  const [resetConfirmWord, setResetConfirmWord] = useState('');
  const [settingsResetPhase, setSettingsResetPhase] = useState<FeedbackPhase>('idle');
  const [settingsResetConfirmWord, setSettingsResetConfirmWord] = useState('');

  const hasThread = threadId.trim() !== '';

  const refreshPoints = useCallback(() => {
    if (!host.available || !hasThread) {
      setPoints([]);
      setPointsPhase(hasThread ? 'fail' : 'idle');
      return;
    }
    setPointsPhase('loading');
    host
      .recoverySnapshots(threadId)
      .then((view) => {
        setPoints(view.points ?? []);
        setPointsPhase('success');
      })
      .catch(() => {
        logger.error('settings', '会话链回退点读取失败');
        setPoints([]);
        setPointsPhase('fail');
      });
  }, [host, threadId, hasThread]);

  useEffect(() => {
    setPoints([]);
    setConfirmingRollback(false);
    refreshPoints();
  }, [refreshPoints, threadId]);

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
      const result = await host.auditList({ limit: AUDIT_EXPORT_LIMIT });
      const records = Array.isArray(result?.records) ? result.records : [];
      downloadJson(records);
      setAuditCount(records.length);
      setAuditPhase('success');
    } catch (err) {
      logger.error('settings', '审计日志导出失败', { err: String(err) });
      setAuditPhase('fail');
    }
  }, [host]);

  const runRollback = useCallback(async () => {
    if (!host.available || !hasThread) {
      setRollbackPhase('fail');
      return;
    }
    if (!rollbackAvailable(points)) {
      setRollbackPhase('fail');
      return;
    }
    setRollbackPhase('loading');
    try {
      await host.recoveryRestoreSnapshot(threadId);
      setRollbackPhase('success');
      setConfirmingRollback(false);
      refreshPoints();
    } catch (err) {
      logger.error('settings', '会话链回退失败', { err: String(err), threadId });
      setRollbackPhase('fail');
    }
  }, [host, threadId, hasThread, points, refreshPoints]);

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
      refreshPoints();
    } catch (err) {
      logger.error('settings', '出厂重置失败', { err: String(err) });
      setResetPhase('fail');
    }
  }, [host, refreshPoints]);

  /** 恢复设置默认（B6 逃生）：清能力台账/常驻集/组件停用/MCP 启用与额外连接；
   *  不动会话链/知识/审计；独立确认词 fail-closed。 */
  const runSettingsReset = useCallback(async () => {
    if (!host.available) {
      setSettingsResetPhase('fail');
      return;
    }
    setSettingsResetPhase('loading');
    try {
      await host.recoverySettingsReset();
      setSettingsResetConfirmWord('');
      setSettingsResetPhase('success');
      refreshPoints();
    } catch (err) {
      logger.error('settings', '恢复设置默认失败', { err: String(err) });
      setSettingsResetPhase('fail');
    }
  }, [host, refreshPoints]);

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
          <span className="text-[11px] font-medium text-[var(--ink-text-base)]">会话链回退（撤销最近回合）</span>
        </div>
        <div className="text-[10px] leading-relaxed text-[var(--ink-text-faint)]">
          回退点按当前活动会话 thread_id 查询；回退 = 删除链尾派生 checkpoint 并留审计，
          回退后引擎停机重挂，下次命令自动回到目标检查点形态。
        </div>
        {!hasThread ? (
          <p className="text-[10px] text-[var(--ink-text-faint)]" data-ui="recovery_no_thread">
            无活动会话上下文：请先在对话区选择/新建一个会话，再回到本页查看该会话链回退点。
          </p>
        ) : pointsPhase === 'fail' ? (
          <p className="text-[10px] text-[var(--ink-text-faint)]">
            回退点读取失败（宿主未接线或该会话无链数据）。
          </p>
        ) : points.length === 0 ? (
          <p className="text-[10px] text-[var(--ink-text-faint)]">
            本会话还没有回退点（回合产生 checkpoint 后出现）。
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" data-ui="recovery_refresh" onClick={refreshPoints}>
                <History size={11} strokeWidth={1.6} />
                刷新回退点
              </Button>
              {rollbackAvailable(points) && (
                <Button
                  size="sm"
                  variant="secondary"
                  data-ui="recovery_rollback"
                  onClick={() => {
                    if (confirmingRollback) {
                      void runRollback();
                    } else {
                      setConfirmingRollback(true);
                    }
                  }}
                >
                  <RotateCcw size={11} strokeWidth={1.6} />
                  {confirmingRollback ? '确认回退链尾（撤销最近回合）？' : '回退链尾'}
                </Button>
              )}
              {confirmingRollback && (
                <Button
                  size="sm"
                  variant="ghost"
                  data-ui="recovery_rollback_cancel"
                  onClick={() => setConfirmingRollback(false)}
                >
                  取消
                </Button>
              )}
              <Feedback phase={rollbackPhase} okText="已回退到上一检查点" failText="回退失败" />
              <Feedback phase={pointsPhase} okText="回退点已刷新" failText="回退点读取失败" />
            </div>
            <ul className="divide-y divide-[var(--ink-border)] overflow-hidden rounded">
              {points.slice(0, 10).map((point) => (
                <li
                  key={point.checkpoint_id}
                  data-ui={`recovery_point_${point.checkpoint_id}`}
                  className="flex items-center justify-between gap-2 px-1 py-1.5"
                >
                  <span className={cn('truncate font-mono text-[10px]', 'text-[var(--ink-text-muted)]')}>
                    #{point.checkpoint_id}
                    {point.reason ? ` · ${point.reason}` : ''}
                  </span>
                  <span className="shrink-0 text-[10px] text-[var(--ink-text-faint)]">
                    {point.checkpoint_id === points[0]?.checkpoint_id ? '链尾 · ' : ''}父 {point.parent_id ?? '—'}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="flex flex-col gap-2 rounded border border-[var(--ink-border)] p-3">
        <div className="flex items-center gap-1 text-[11px] text-[var(--ink-text-muted)]">
          <Settings2 size={11} strokeWidth={1.6} />
          <span className="font-medium text-[var(--ink-text-base)]">恢复设置默认（逃生）</span>
        </div>
        <div className="text-[10px] leading-relaxed text-[var(--ink-text-faint)]">
          恢复出厂档位与管理设置：常驻必带回出厂集、界面组件停用清空（禁停集
          本就不可停）、MCP 工具型插件全部停用并清台账（含指定安装的额外连接）、
          能力台账回缺省（auto 审批/回合上限/档位登记）。不动会话链、知识集与审计。
          请输入确认词「设置默认」。
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TextInput
            className="w-44"
            value={settingsResetConfirmWord}
            onChange={(e) => setSettingsResetConfirmWord(e.target.value)}
            placeholder="输入确认词「设置默认」"
            aria-label="设置默认确认词"
          />
          <Button
            size="sm"
            variant="accent"
            data-ui="recovery_settings_reset"
            disabled={settingsResetConfirmWord !== '设置默认' || settingsResetPhase === 'loading'}
            onClick={() => void runSettingsReset()}
          >
            <RotateCcw size={11} strokeWidth={1.6} />
            确认恢复设置默认
          </Button>
          <Feedback phase={settingsResetPhase} okText="已恢复设置默认" failText="恢复失败" />
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded border border-[var(--ink-accent-border)] p-3">
        <div className="flex items-center gap-1 text-[11px] text-[var(--ink-accent-approval)]">
          <ShieldAlert size={11} strokeWidth={1.6} />
          <span className="font-medium text-[var(--ink-text-base)]">出厂重置（清除本地会话与事件）</span>
        </div>
        <div className="text-[10px] leading-relaxed text-[var(--ink-text-faint)]">
          清空全部会话链、回合账本与事件日志（事件已同步清除）；知识集与审计留痕
          （set_audit）保留不参与本次重置。完成后引擎停机重挂 = 出厂基线 + 种子重注入。
          请输入确认词「重置」。
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
