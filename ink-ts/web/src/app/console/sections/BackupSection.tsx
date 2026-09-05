import { useState } from 'react';
import { Archive, HardDriveDownload, RotateCcw, ShieldAlert } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { TextInput } from '@/shared/ui/Field';
import { createBackend } from '@/shared/backend/backendAdapter';
import { useT } from '@/i18n/useT';

type BackupStep = 'select' | 'confirm' | 'done';

function fmt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}

export function BackupSection() {
  const { t } = useT();
  const backend = createBackend();
  const [mode, setMode] = useState<'export' | 'restore' | 'reset'>('export');
  const [step, setStep] = useState<BackupStep>('select');
  const [path, setPath] = useState('');
  const [confirmWord, setConfirmWord] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const restoreConfirmWord = t('backup.confirm_word_restore');
  const resetConfirmWord = t('backup.confirm_word_reset');

  const handleExport = async () => {
    if (!path.trim()) return;
    setLoading(true);
    try {
      const outcome = await backend.backupExport(path);
      setResult(fmt(t('backup.result.exported'), { n: String(outcome?.entries ?? 0) }));
      setStep('done');
    } catch {
      setResult(t('backup.result.export_failed'));
    } finally {
      setLoading(false);
    }
  };

  const handleRestore = async () => {
    if (confirmWord !== restoreConfirmWord) return;
    setLoading(true);
    try {
      const outcome = await backend.backupRestore(path);
      setResult(fmt(t('backup.result.restored'), { n: String(outcome?.restored_entries ?? 0) }));
      setStep('done');
    } catch {
      setResult(t('backup.result.restore_failed'));
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async () => {
    if (confirmWord !== resetConfirmWord) return;
    setLoading(true);
    try {
      await backend.recoveryFactoryReset();
      setResult(t('backup.result.reset_done'));
      setStep('done');
    } catch {
      setResult(t('backup.result.reset_failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div data-ui="backup_section" className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Archive size={14} strokeWidth={1.6} className="text-[var(--ink-text-muted)]" />
        <h3 className="text-[13px] font-medium text-[var(--ink-text-base)]">{t('backup.section')}</h3>
      </div>

      <div className="flex gap-1">
        <Button size="xs" variant={mode === 'export' ? 'primary' : 'ghost'} onClick={() => { setMode('export'); setStep('select'); }}>{t('backup.mode.export')}</Button>
        <Button size="xs" variant={mode === 'restore' ? 'primary' : 'ghost'} onClick={() => { setMode('restore'); setStep('select'); }}>{t('backup.mode.restore')}</Button>
        <Button size="xs" variant={mode === 'reset' ? 'primary' : 'ghost'} onClick={() => { setMode('reset'); setStep('select'); }}>{t('backup.mode.reset')}</Button>
      </div>

      {step === 'select' && mode === 'export' && (
        <div className="flex flex-col gap-2">
          <TextInput value={path} onChange={(e) => setPath(e.target.value)} placeholder={t('backup.export_path_placeholder')} />
          <Button size="sm" variant="primary" onClick={() => handleExport()} disabled={!path.trim() || loading}>
            <HardDriveDownload size={12} strokeWidth={1.6} />
            {t('backup.start_export')}
          </Button>
        </div>
      )}

      {step === 'select' && mode === 'restore' && (
        <div className="flex flex-col gap-2 rounded border border-[var(--ink-border)] p-3">
          <div className="text-[11px] text-[var(--ink-text-muted)]">{t('backup.restore_warning')}</div>
          <TextInput value={path} onChange={(e) => setPath(e.target.value)} placeholder={t('backup.restore_path_placeholder')} />
          <TextInput value={confirmWord} onChange={(e) => setConfirmWord(e.target.value)} placeholder={fmt(t('backup.confirm_word_placeholder'), { word: restoreConfirmWord })} />
          <Button size="sm" variant="accent" onClick={() => handleRestore()} disabled={confirmWord !== restoreConfirmWord || loading}>
            <RotateCcw size={12} strokeWidth={1.6} />
            {t('backup.confirm_restore')}
          </Button>
        </div>
      )}

      {step === 'select' && mode === 'reset' && (
        <div className="flex flex-col gap-2 rounded border border-[var(--ink-accent-border)] p-3">
          <div className="flex items-center gap-1 text-[11px] text-[var(--ink-accent-approval)]">
            <ShieldAlert size={12} strokeWidth={1.6} />
            {t('backup.reset_warning')}
          </div>
          <div className="text-[10px] text-[var(--ink-text-faint)]">
            {t('backup.reset_note')}
          </div>
          <TextInput value={confirmWord} onChange={(e) => setConfirmWord(e.target.value)} placeholder={fmt(t('backup.confirm_word_placeholder'), { word: resetConfirmWord })} />
          <Button size="sm" variant="accent" onClick={() => handleReset()} disabled={confirmWord !== resetConfirmWord || loading}>
            <RotateCcw size={12} strokeWidth={1.6} />
            {t('backup.confirm_reset')}
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
