/**
 * 设置页居中模态（注册式驱动）。
 *
 * 形态：居中卡片（≤880px × ≤620px）+ 遮罩轻雾化可点击关闭 + pop 入场 180ms；
 * 左节导航竖排（全部节对用户开放），右内容区单列。
 * 即改即存：节内控件各自直写通道并自带三态反馈，本壳不提供全局保存按钮
 * （原全局保存对所有节均为 no-op，已移除）。
 */

import { useEffect, useState } from 'react';

import { X } from 'lucide-react';

import { listSettingsSections } from './registry';
import { SettingsItemRenderer } from './settings_item_renderer';
import { useT } from '@/i18n/useT';

interface SettingsFloaterProps {
  open: boolean;
  onClose: () => void;
  backend: {
    available: boolean;
    status(): Promise<{ engine_ready: boolean; first_run?: boolean }>;
    firstRunDismiss(): Promise<{ dismissed: boolean }>;
  };
}

export function SettingsFloater({ open, onClose, backend }: SettingsFloaterProps) {
  const { t } = useT();
  const [active, setActive] = useState<string>('');
  const [mounted, setMounted] = useState(false);
  const [sections, setSections] = useState(() => listSettingsSections());

  /** 节标签：翻译键优先（settings.section.<key>），未登记键回落注册 label。 */
  const sectionLabel = (section: (typeof sections)[number]): string => {
    const key = `settings.section.${section.key}`;
    const translated = t(key);
    return translated === key ? section.label : translated;
  };

  useEffect(() => {
    setSections(listSettingsSections());
  }, []);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setActive((prev) => {
        const first = sections.find((s) => s.key === prev) ?? sections[0];
        return first?.key ?? '';
      });
    } else {
      setMounted(false);
    }
  }, [open, sections]);

  const activeSection = sections.find((s) => s.key === active) ?? sections[0];

  if (!open || !mounted) return null;

  const renderNavItem = (section: (typeof sections)[number]) => {
    const isActive = activeSection?.key === section.key;
    return (
      <button
        key={section.key}
        data-ui={`settings_nav_${section.key}`}
        data-active={isActive}
        onClick={() => setActive(section.key)}
        className={[
          'ink-settings-nav-item',
          isActive ? 'ink-settings-nav-item-active' : '',
        ].join(' ')}
      >
        <span className="ink-icon-chip h-7 w-7 shrink-0">{section.icon}</span>
        <span className="truncate text-[12px]">{sectionLabel(section)}</span>
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
            <div className="space-y-0.5">{sections.map(renderNavItem)}</div>
          </nav>

          {/* 右内容区 */}
          <div className="ink-settings-content">
            <div className="flex items-center justify-between px-6 py-4">
              <h2 className="text-[var(--ink-font-md)] font-semibold tracking-tight">{sectionLabel(activeSection)}</h2>
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

            <div className="ink-scroll-auto px-6 pb-6">
              {activeSection?.render ? (
                activeSection.render()
              ) : (
                <div className="space-y-3">
                  {activeSection?.items?.map((item) => (
                    <SettingsItemRenderer key={item.key} item={item} backendAvailable={backend.available} />
                  )) ?? (
                    <p className="text-[11px] ink-text-faint">{t('settings.no_items')}</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
