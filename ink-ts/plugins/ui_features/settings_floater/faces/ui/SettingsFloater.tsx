/**
 * settings_floater ui 真面：设置浮层（注册式节导航驱动）。
 *
 * 形态沿用原生壳版本：居中卡片（≤880px × ≤620px）+ 遮罩轻雾化可点击关闭 +
 * pop 入场 180ms；左节导航竖排，右内容区单列。即改即存：节内控件各自直写
 * 通道并自带三态反馈，本壳不提供全局保存按钮。
 *
 * 本真面读派生清单 SETTINGS_SECTIONS（真源 = 各面板插件 spec 的
 * data.settings_section，order 升序）渲染左导航；内容经
 * DynamicComponent name=插件 id 渲染面板插件真 ui 面（pluginFaces.generated.ts
 * 装配期注册）。打开态 = 壳 settingsOpen，关闭经 onCloseSettings 回落。
 */

import { useEffect, useState } from 'react';

import { X } from 'lucide-react';

import { SETTINGS_SECTIONS } from '@/app/settings/settingsSections.generated';
import { DynamicComponent } from '@/renderer/componentRegistry';
import { useT } from '@/i18n/useT';
import { sectionIcon } from './icons';

export interface SettingsFloaterProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsFloater({ open, onClose }: SettingsFloaterProps) {
  const { t } = useT();
  const [activeKey, setActiveKey] = useState<string>('');
  const [mounted, setMounted] = useState(false);

  /** 节标签：翻译键优先（settings.section.<key>），未登记键回落声明 label。 */
  const sectionLabel = (key: string, label: string): string => {
    const tKey = `settings.section.${key}`;
    const translated = t(tKey);
    return translated === tKey ? label : translated;
  };

  useEffect(() => {
    if (open) {
      setMounted(true);
      setActiveKey((prev) => {
        const hit = SETTINGS_SECTIONS.find((s) => s.key === prev);
        return hit?.key ?? SETTINGS_SECTIONS[0]?.key ?? '';
      });
    } else {
      setMounted(false);
    }
  }, [open]);

  const active = SETTINGS_SECTIONS.find((s) => s.key === activeKey) ?? SETTINGS_SECTIONS[0];

  if (!open || !mounted) return null;

  const renderNavItem = (section: (typeof SETTINGS_SECTIONS)[number]) => {
    const isActive = active?.key === section.key;
    return (
      <button
        key={section.key}
        data-ui={`settings_nav_${section.key}`}
        data-active={isActive}
        onClick={() => setActiveKey(section.key)}
        className={[
          'ink-settings-nav-item',
          isActive ? 'ink-settings-nav-item-active' : '',
        ].join(' ')}
      >
        <span className="ink-icon-chip h-7 w-7 shrink-0">{sectionIcon(section.icon, section.label)}</span>
        <span className="truncate text-[12px]">{sectionLabel(section.key, section.label)}</span>
      </button>
    );
  };

  return (
    <div className="ink-modal-overlay" data-ui="settings_floater_overlay" onClick={onClose}>
      <section
        data-ui="settings_floater"
        className="ink-modal-panel"
        role="dialog"
        aria-label={t('settings.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-full">
          {/* 左节导航 */}
          <nav className="ink-settings-rail" aria-label={t('settings.title')}>
            <div className="px-3 pb-2 text-[10px] font-medium tracking-[0.14em] uppercase ink-text-faint">{t('settings.title')}</div>
            <div className="space-y-0.5">{SETTINGS_SECTIONS.map(renderNavItem)}</div>
          </nav>

          {/* 右内容区 */}
          <div className="ink-settings-content">
            <div className="flex items-center justify-between px-6 py-4">
              <h2 className="text-[var(--ink-font-md)] font-semibold tracking-tight">
                {active ? sectionLabel(active.key, active.label) : ''}
              </h2>
              <button
                type="button"
                data-ui="settings_close_top"
                onClick={onClose}
                className="flex h-7 w-7 items-center justify-center rounded-lg ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)]"
                aria-label={t('settings.close')}
              >
                <X size={15} strokeWidth={1.6} aria-hidden />
              </button>
            </div>

            <div className="ink-scroll-auto px-6 pb-6">{active ? <DynamicComponent name={active.id} /> : null}</div>
          </div>
        </div>
      </section>
    </div>
  );
}
