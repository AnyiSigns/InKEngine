import { useState } from 'react';
import { Archive, HardDriveDownload, RotateCcw, ShieldAlert } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { TextInput } from '@/shared/ui/Field';
import { invokeOp } from '../../shared/invokeOp';

type BackupStep = 'select' | 'confirm' | 'done';

export function BackupSection() {
  const [mode, setMode] = useState<'export' | 'restore' | 'reset'>('export');
  const [step, setStep] = useState<BackupStep>('select');
  const [path, setPath] = useState('');
  const [confirmWord, setConfirmWord] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleExport = async () => {
    if (!path.trim()) return;
    setLoading(true);
    try {
      const outcome = await invokeOp<{ entries: number; size: number; has_db: boolean }>('backup_export', { dest: path });
      setResult(`已导出 ${outcome?.entries ?? 0} 个文件`);
      setStep('done');
    } catch {
      setResult('导出失败');
    } finally {
      setLoading(false);
    }
  };

  const handleRestore = async () => {
    if (confirmWord !== '恢复') return;
    setLoading(true);
    try {
      const outcome = await invokeOp<{ restored_entries: number; snapshot: string }>('backup_restore', { path });
      setResult(`已恢复 ${outcome?.restored_entries ?? 0} 个文件`);
      setStep('done');
    } catch {
      setResult('恢复失败');
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async () => {
    if (confirmWord !== '重置') return;
    setLoading(true);
    try {
      await invokeOp('recovery_factory_reset', {});
      setResult('已重置');
      setStep('done');
    } catch {
      setResult('重置失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div data-ui="backup_section" className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Archive size={14} strokeWidth={1.6} className="text-[var(--ink-text-muted)]" />
        <h3 className="text-[13px] font-medium text-[var(--ink-text-base)]">备份</h3>
      </div>

      <div className="flex gap-1">
        <Button size="xs" variant={mode === 'export' ? 'primary' : 'ghost'} onClick={() => { setMode('export'); setStep('select'); }}>导出</Button>
        <Button size="xs" variant={mode === 'restore' ? 'primary' : 'ghost'} onClick={() => { setMode('restore'); setStep('select'); }}>恢复</Button>
        <Button size="xs" variant={mode === 'reset' ? 'primary' : 'ghost'} onClick={() => { setMode('reset'); setStep('select'); }}>工厂重置</Button>
      </div>

      {step === 'select' && mode === 'export' && (
        <div className="flex flex-col gap-2">
          <TextInput value={path} onChange={(e) => setPath(e.target.value)} placeholder="导出目标路径" />
          <Button size="sm" variant="primary" onClick={() => handleExport()} disabled={!path.trim() || loading}>
            <HardDriveDownload size={12} strokeWidth={1.6} />
            开始导出
          </Button>
        </div>
      )}

      {step === 'select' && mode === 'restore' && (
        <div className="flex flex-col gap-2 rounded border border-[var(--ink-border)] p-3">
          <div className="text-[11px] text-[var(--ink-text-muted)]">恢复操作将覆盖当前全部会话与设置，请先输入确认词</div>
          <TextInput value={path} onChange={(e) => setPath(e.target.value)} placeholder="备份包路径" />
          <TextInput value={confirmWord} onChange={(e) => setConfirmWord(e.target.value)} placeholder="输入确认词「恢复」" />
          <Button size="sm" variant="accent" onClick={() => handleRestore()} disabled={confirmWord !== '恢复' || loading}>
            <RotateCcw size={12} strokeWidth={1.6} />
            确认恢复
          </Button>
        </div>
      )}

      {step === 'select' && mode === 'reset' && (
        <div className="flex flex-col gap-2 rounded border border-[var(--ink-accent-border)] p-3">
          <div className="flex items-center gap-1 text-[11px] text-[var(--ink-accent-approval)]">
            <ShieldAlert size={12} strokeWidth={1.6} />
            警告：工厂重置将清除所有补丁链
          </div>
          <div className="text-[10px] text-[var(--ink-text-faint)]">
            重置保留项：数据 / 配置 / 补丁链（可勾选保留）
          </div>
          <TextInput value={confirmWord} onChange={(e) => setConfirmWord(e.target.value)} placeholder="输入确认词「重置」" />
          <Button size="sm" variant="accent" onClick={() => handleReset()} disabled={confirmWord !== '重置' || loading}>
            <RotateCcw size={12} strokeWidth={1.6} />
            确认重置
          </Button>
        </div>
      )}

      {step === 'done' && result && (
        <div className="rounded border border-[var(--ink-border)] p-3 text-[11px] text-[var(--ink-text-base)]">
          {result}
        </div>
      )}
    </div>
  );
}
