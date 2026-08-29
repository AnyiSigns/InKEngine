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
import { useT } from '@/i18n/useT';

interface SettingsItemRendererProps {
  item: SettingsItemSpec;
  backendAvailable: boolean;
}

export function SettingsItemRenderer({ item, backendAvailable }: SettingsItemRendererProps) {
  const { t } = useT();
  const [value, setValue] = useState<string>('');
  const [phase, setPhase] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  /** 项标签/提示：翻译键优先（settings.item.<key> / settings.item.hint.<key>），未登记回落注册文案。 */
  const itemLabel = (): string => {
    const key = `settings.item.${item.key}`;
    const translated = t(key);
    return translated === key ? item.label : translated;
  };
  const itemHint = (): string | undefined => {
    if (!item.hint) return undefined;
    const key = `settings.item.hint.${item.key}`;
    const translated = t(key);
    return translated === key ? item.hint : translated;
  };

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
  const disabledReason = item.disabledReason ?? (backendAvailable ? '' : t('settings.data_driven'));

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
            aria-label={itemLabel()}
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
            aria-label={itemLabel()}
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
              aria-label={itemLabel()}
            />
            <span className="text-[11px]">{value === 'true' || value === '1' ? t('settings.on') : t('settings.off')}</span>
          </label>
        );
      case 'custom':
        return (
          <div className="text-[10px] ink-text-faint">{t('settings.custom_note')}</div>
        );
      case 'text':
      default:
        return (
          <TextInput
            value={value}
            disabled={disabled}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => writeValue(value)}
            aria-label={itemLabel()}
          />
        );
    }
  })();

  return (
    <div className={['ink-elevated px-3.5 py-2.5', disabled ? 'opacity-60' : ''].join(' ')}>
      <Field label={itemLabel()} hint={itemHint()}>
        {input}
      </Field>
      {disabled && disabledReason && (
        <p className="mt-1 text-[10px] ink-text-faint">{disabledReason}</p>
      )}
      {error && <p className="mt-1 text-[10px] ink-text-faint">{error}</p>}
      {phase === 'saving' && <span className="text-[10px] ink-text-muted">{t('settings.saving')}</span>}
      {phase === 'saved' && <span className="text-[10px] ink-feedback-ok">{t('settings.saved')}</span>}
      {phase === 'error' && <span className="text-[10px] ink-feedback-fail">{t('settings.save_failed')}</span>}
    </div>
  );
}
