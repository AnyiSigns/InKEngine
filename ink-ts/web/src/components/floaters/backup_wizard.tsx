/**
 * 备份/恢复向导（多步交互，承载于悬浮窗）：导出路径 → 打包执行；
 * 恢复 = 选包 → 校验预览 → 当前态快照 → 执行恢复。
 *
 * 数据面经可注入备份操作（生产 = 宿主后端；测试 = mock）；恢复前
 * 宿主侧先拍当前态快照（失败留快照不击穿），执行结果带快照路径反馈。
 */

import { useState } from 'react';

import { ArchiveRestore, Download, HardDriveDownload } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { TextInput } from '@/shared/ui/Field';
import { Feedback } from './feedback';
import type { FeedbackPhase } from './feedback';
import { FloaterWindow } from './floater_window';
import type { BackupPreview, BackendAdapter } from '@/shared/backend/backendAdapter';

export interface BackupOps {
  exportTo(dest: string): Promise<{ entries: number; size: number; has_db: boolean }>;
  preview(path: string): Promise<BackupPreview>;
  restore(path: string): Promise<{ restored_entries: number; snapshot: string }>;
}

export type BackupMode = 'export' | 'restore';

interface BackupWizardProps {
  mode: BackupMode;
  onClose: () => void;
  ops?: BackupOps | null;
}

/** 默认备份操作（宿主后端支撑；无宿主 = 空操作按失败反馈）。 */
export function backupOpsFrom(backend: BackendAdapter | null): BackupOps | null {
  if (!backend?.available) return null;
  return {
    exportTo: (dest) => backend.backupExport(dest),
    preview: (path) => backend.backupPreview(path),
    restore: (path) => backend.backupRestore(path),
  };
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function BackupWizard({ mode, onClose, ops }: BackupWizardProps) {
  const [phase, setPhase] = useState<FeedbackPhase>('idle');
  const [path, setPath] = useState('');
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const runExport = async (): Promise<void> => {
    if (!ops) {
      setPhase('fail');
      return;
    }
    const dest = path.trim();
    if (!dest) {
      setPhase('fail');
      return;
    }
    setPhase('loading');
    try {
      const outcome = await ops.exportTo(dest);
      setResult(`已导出 ${outcome.entries} 个文件（${formatSize(outcome.size)}，${outcome.has_db ? '含数据库' : '无库'}）`);
      setPhase('success');
    } catch {
      setPhase('fail');
    }
  };

  const stepPreview = async (): Promise<void> => {
    if (!ops) {
      setPhase('fail');
      return;
    }
    const source = path.trim();
    if (!source) {
      setPhase('fail');
      return;
    }
    setPhase('loading');
    try {
      const previewValue = await ops.preview(source);
      setPreview(previewValue);
      setPhase('idle');
    } catch {
      setPhase('fail');
    }
  };

  const runRestore = async (): Promise<void> => {
    if (!ops || !preview) {
      setPhase('fail');
      return;
    }
    setPhase('loading');
    try {
      const outcome = await ops.restore(path.trim());
      setResult(`已恢复 ${outcome.restored_entries} 个文件；恢复前快照：${outcome.snapshot}`);
      setPhase('success');
    } catch {
      setPhase('fail');
    }
  };

  const title = mode === 'export' ? '备份向导' : '恢复向导';
  const Icon = mode === 'export' ? HardDriveDownload : ArchiveRestore;

  return (
    <FloaterWindow
      title={title}
      floaterKey="backup-wizard"
      icon={<Icon size={12} strokeWidth={1.6} />}
      onClose={onClose}
      initialRect={{ x: 260, y: 120, width: 460, height: 300 }}
      dataUi="backup_wizard"
    >
      <div className="flex h-full flex-col p-3.5">
        <div className="space-y-2.5">
          <label className="block space-y-1">
            <span className="flex items-center gap-1 text-[11px] font-medium tracking-wide ink-text-muted">
              <Download size={10} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
              {mode === 'export' ? '导出目标路径' : '备份包路径'}
            </span>
            <TextInput
              value={path}
              onChange={(e) => {
                setPath(e.target.value);
                setPreview(null);
                setResult(null);
              }}
              placeholder={mode === 'export' ? 'C:\\Users\\you\\inkling-backup.inkbk' : 'C:\\Users\\you\\inkling-backup.inkbk'}
              aria-label="备份路径"
              className="font-mono text-[10px]"
            />
          </label>

          {mode === 'restore' && (
            <div className="space-y-1.5">
              <Button
                size="sm"
                variant="secondary"
                data-ui="backup_preview"
                disabled={!path.trim()}
                onClick={() => void stepPreview()}
              >
                校验并预览
              </Button>
              {preview && (
                <div className="ink-status-card px-3 py-2 text-[11px]" data-ui="backup_preview_summary">
                  <div>条目 {preview.entries_total} · 覆盖 {preview.will_overwrite} · 体积 {formatSize(preview.total_size)}{preview.has_db ? ' · 含数据库' : ''}</div>
                  <div className="text-[10px] ink-text-faint">恢复前将自动快照当前态（防误恢复，保留快照可回退）</div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <Feedback
            phase={phase}
            okText={result ?? (mode === 'export' ? '导出成功' : '恢复成功')}
            failText="操作失败（路径/包无效或宿主不可用）"
          />
        </div>

        <div className="mt-auto flex items-center justify-between pt-3">
          <Button size="sm" variant="ghost" onClick={onClose}>关闭</Button>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="secondary" onClick={onClose}>取消</Button>
            {mode === 'export' ? (
              <Button
                size="sm"
                variant="primary"
                data-ui="backup_export_run"
                disabled={!path.trim()}
                onClick={() => void runExport()}
              >
                开始导出
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                data-ui="backup_restore_run"
                disabled={!preview}
                onClick={() => void runRestore()}
              >
                执行恢复
              </Button>
            )}
          </div>
        </div>
      </div>
    </FloaterWindow>
  );
}
