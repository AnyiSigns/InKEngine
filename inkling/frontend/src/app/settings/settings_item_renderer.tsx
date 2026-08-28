/**
 * 设置项渲染器（注册契约消费端）。
 *
 * 按 kind 分发：text / secret / select / toggle / custom；
 * 无通道项灰禁用+说明「该配置由数据声明驱动」；
 * 即改即存（有 write 通道）或仅展示。
 */

import { useState, useEffect } from 'react';

import { Field, TextInput, Select } from '@/shared/ui/Field';
import type { SettingsItemSpec } from './types';

interface SettingsItemRendererProps {
  item: SettingsItemSpec;
  backendAvailable: boolean;
}

export function SettingsItemRenderer({ item, backendAvailable }: SettingsItemRendererProps) {
  const [value, setValue] = useState<string>('');
  const [phase, setPhase] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void item.read().then((val) => {
      if (cancelled) return;
      setValue(String(val ?? ''));
    });
    return () => {
      cancelled = true;
    };
  }, [item.key, item.read]);

  const writeValue = async (next: string): Promise<void> => {
    if (!item.write) return;
    const validation = item.validate?.(next);
    if (validation) {
      setError(validation);
      return;
    }
    setError(null);
    setPhase('saving');
    try {
      await item.write(next);
      setPhase('saved');
      setTimeout(() => setPhase('idle'), 1200);
    } catch {
      setPhase('error');
      setTimeout(() => setPhase('idle'), 2000);
    }
  };

  const disabled = !!item.disabledReason || !backendAvailable;
  const disabledReason = item.disabledReason ?? (backendAvailable ? '' : '该配置由数据声明驱动');

  const input = (() => {
    switch (item.kind) {
      case 'secret':
        return (
          <TextInput
            type="password"
            value={value}
            placeholder="sk-..."
            disabled={disabled}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => writeValue(value)}
            aria-label={item.label}
          />
        );
      case 'select':
        return (
          <Select
            value={value}
            disabled={disabled}
            onChange={(e) => {
              setValue(e.target.value);
              writeValue(e.target.value);
            }}
            aria-label={item.label}
          >
            {item.options?.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </Select>
        );
      case 'toggle':
        return (
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="ink-check"
              checked={value === 'true' || value === '1'}
              disabled={disabled}
              onChange={(e) => {
                const next = String(e.target.checked);
                setValue(next);
                writeValue(next);
              }}
              aria-label={item.label}
            />
            <span className="text-[11px]">{value === 'true' || value === '1' ? '开' : '关'}</span>
          </label>
        );
      case 'custom':
        return (
          <div className="text-[10px] ink-text-faint">自定义控件需配合 render 使用。</div>
        );
      case 'text':
      default:
        return (
          <TextInput
            value={value}
            disabled={disabled}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => writeValue(value)}
            aria-label={item.label}
          />
        );
    }
  })();

  return (
    <div className={['ink-elevated px-3.5 py-2.5', disabled ? 'opacity-60' : ''].join(' ')}>
      <Field label={item.label} hint={item.hint}>
        {input}
      </Field>
      {disabled && disabledReason && (
        <p className="mt-1 text-[10px] ink-text-faint">{disabledReason}</p>
      )}
      {error && <p className="mt-1 text-[10px] ink-text-faint">{error}</p>}
      {phase === 'saving' && <span className="text-[10px] ink-text-muted">保存中…</span>}
      {phase === 'saved' && <span className="text-[10px] ink-feedback-ok">已保存</span>}
      {phase === 'error' && <span className="text-[10px] ink-feedback-fail">保存失败</span>}
    </div>
  );
}
