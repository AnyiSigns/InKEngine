/**
 * 设置页右滑入大浮窗（注册式驱动）。
 *
 * 形态：全高、宽约 42%、遮罩轻雾化可点击关闭、滑入 180ms ease-out；
 * 左节导航竖排 9 节（lucide 线性 16px）；右单列表单 ≤480px。
 * 表单规范：label 12px 墨灰 + 输入行 36px 高 hairline 底边；
 * 即改即存（有通道）或「保存」按钮显式态；三态反馈（无静默）；
 * 无通道项灰禁用+说明「该配置由数据声明驱动」。
 */

import { useEffect, useState } from 'react';

import { X } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { Feedback } from '@/components/floaters/feedback';
import type { FeedbackPhase } from '@/components/floaters/feedback';
import { listSettingsSections } from './registry';
import { SettingsItemRenderer } from './settings_item_renderer';

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
  const [active, setActive] = useState<string>('');
  const [savePhase, setSavePhase] = useState<FeedbackPhase>('idle');
  const [mounted, setMounted] = useState(false);
  const [sections, setSections] = useState(() => listSettingsSections());

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

  const handleSave = async (): Promise<void> => {
    setSavePhase('loading');
    try {
      const section = sections.find((s) => s.key === active);
      if (section?.items) {
        await Promise.all(
          section.items.map((item) => {
            if (!item.write) return Promise.resolve();
            return item.read().then((val) => item.write?.(val));
          }),
        );
      }
      setSavePhase('success');
      setTimeout(() => setSavePhase('idle'), 1200);
    } catch {
      setSavePhase('fail');
      setTimeout(() => setSavePhase('idle'), 2000);
    }
  };

  if (!open || !mounted) return null;

  return (
    <div className="ink-settings-overlay" data-ui="settings_floater_overlay" onClick={onClose}>
      <section
        data-ui="settings_floater"
        className="ink-settings-panel"
        role="dialog"
        aria-label="设置"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-full">
          {/* 左节导航 */}
          <nav className="ink-settings-rail" aria-label="设置节导航">
            <div className="px-3 pb-2 text-[9px] font-medium tracking-[0.14em] uppercase ink-text-faint">设置</div>
            <div className="space-y-0.5">
              {sections.map((section) => {
                const isActive = active === section.key;
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
                    <span className="truncate text-[11px]">{section.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="mt-auto px-2">
              <button
                type="button"
                data-ui="settings_close"
                onClick={onClose}
                className="flex h-7 w-full items-center justify-center gap-1 rounded-lg text-[10px] ink-text-muted hover:text-[var(--ink-text-base)] cursor-pointer bg-transparent border-none"
              >
                <X size={12} strokeWidth={1.6} aria-hidden />
                关闭
              </button>
            </div>
          </nav>

          {/* 右内容区 */}
          <div className="ink-settings-content">
            <div className="flex items-center justify-between px-6 py-4">
              <div>
                <h2 className="text-[var(--ink-font-md)] font-semibold tracking-tight">{activeSection?.label}</h2>
                <p className="mt-0.5 text-[10px] leading-relaxed ink-text-faint">
                  即改即存 · 设置注入走宿主装配参数不走 env
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Feedback phase={savePhase} okText="已保存" failText="保存失败" />
                <Button size="sm" variant="primary" onClick={handleSave} data-ui="settings_save">
                  保存
                </Button>
              </div>
            </div>

            <div className="ink-scroll-auto px-6 pb-6">
              {activeSection?.render ? (
                activeSection.render()
              ) : (
                <div className="space-y-3">
                  {activeSection?.items?.map((item) => (
                    <SettingsItemRenderer key={item.key} item={item} backendAvailable={backend.available} />
                  )) ?? (
                    <p className="text-[10px] ink-text-faint">该节暂无配置项。</p>
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
