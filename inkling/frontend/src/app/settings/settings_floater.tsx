/**
 * 设置页居中模态（注册式驱动）。
 *
 * 形态：居中卡片（≤880px × ≤620px）+ 遮罩轻雾化可点击关闭 + pop 入场 180ms；
 * 左节导航竖排（普通节在前、devOnly 节在「开发者」分组后）；右内容区单列。
 * 即改即存：节内控件各自直写通道并自带三态反馈，本壳不提供全局保存按钮
 * （原全局保存对所有节均为 no-op，已移除）。
 */

import { useEffect, useState } from 'react';

import { X } from 'lucide-react';

import { useDevMode } from '@/shared/ui/devMode';
import { listSettingsSections } from './registry';
import { SettingsItemRenderer } from './settings_item_renderer';
import { SettingsActionsContext, type SettingsActions } from './sections/advanced_section';

interface SettingsFloaterProps {
  open: boolean;
  onClose: () => void;
  backend: {
    available: boolean;
    status(): Promise<{ engine_ready: boolean; first_run?: boolean }>;
    firstRunDismiss(): Promise<{ dismissed: boolean }>;
  };
  actions?: SettingsActions;
}

export function SettingsFloater({ open, onClose, backend, actions }: SettingsFloaterProps) {
  const [active, setActive] = useState<string>('');
  const [mounted, setMounted] = useState(false);
  const [devMode] = useDevMode();
  const [sections, setSections] = useState(() => listSettingsSections());

  useEffect(() => {
    setSections(listSettingsSections());
  }, []);

  const visible = sections.filter((s) => devMode || !s.devOnly);
  const mainSections = visible.filter((s) => !s.devOnly);
  const devSections = visible.filter((s) => s.devOnly);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setActive((prev) => {
        const first = visible.find((s) => s.key === prev) ?? visible[0];
        return first?.key ?? '';
      });
    } else {
      setMounted(false);
    }
    // visible 列表由 devMode 派生，打开时重取即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, devMode]);

  const activeSection = visible.find((s) => s.key === active) ?? visible[0];

  if (!open || !mounted) return null;

  const renderNavItem = (section: (typeof visible)[number]) => {
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
        <span className="truncate text-[12px]">{section.label}</span>
      </button>
    );
  };

  return (
    <div className="ink-modal-overlay" data-ui="settings_floater_overlay" onClick={onClose}>
      <section
        data-ui="settings_floater"
        className="ink-modal-panel"
        role="dialog"
        aria-label="设置"
        onClick={(e) => e.stopPropagation()}
      >
        <SettingsActionsContext.Provider
          value={actions ?? { onOpenView: () => undefined }}
        >
          <div className="flex h-full">
            {/* 左节导航 */}
            <nav className="ink-settings-rail" aria-label="设置节导航">
              <div className="px-3 pb-2 text-[10px] font-medium tracking-[0.14em] uppercase ink-text-faint">设置</div>
              <div className="space-y-0.5">{mainSections.map(renderNavItem)}</div>
              {devSections.length > 0 && (
                <>
                  <div className="px-3 pb-1 pt-3 text-[10px] font-medium tracking-[0.14em] uppercase ink-text-faint">开发者</div>
                  <div className="space-y-0.5">{devSections.map(renderNavItem)}</div>
                </>
              )}
              <div className="mt-auto px-2">
                <button
                  type="button"
                  data-ui="settings_close"
                  onClick={onClose}
                  className="flex h-7 w-full items-center justify-center gap-1 rounded-lg text-[11px] ink-text-muted hover:text-[var(--ink-text-base)] cursor-pointer bg-transparent border-none"
                >
                  <X size={12} strokeWidth={1.6} aria-hidden />
                  关闭
                </button>
              </div>
            </nav>

            {/* 右内容区 */}
            <div className="ink-settings-content">
              <div className="flex items-center justify-between px-6 py-4">
                <h2 className="text-[var(--ink-font-md)] font-semibold tracking-tight">{activeSection?.label}</h2>
                <button
                  type="button"
                  data-ui="settings_close_top"
                  onClick={onClose}
                  className="flex h-7 w-7 items-center justify-center rounded-lg ink-text-muted hover:bg-[var(--ink-bg-elevated)] hover:text-[var(--ink-text-base)]"
                  aria-label="关闭设置"
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
                      <p className="text-[11px] ink-text-faint">该节暂无配置项。</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </SettingsActionsContext.Provider>
      </section>
    </div>
  );
}
