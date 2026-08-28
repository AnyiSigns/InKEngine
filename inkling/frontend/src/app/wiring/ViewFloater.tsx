/**
 * 视图浮窗：机制视图（独立视图）与市场/能力组件的统一右滑入容器。
 * 解析规则：键命中 getRegisteredViews() → 直接渲染该视图组件；否则视为
 * componentRegistry 组件键（MCP/组件/技能/工具/OS/工作区/界面）。
 */

import { X } from 'lucide-react';

import { getRegisteredViews } from '@/app/views/registry';
import { DynamicComponent } from '@/renderer/componentRegistry';
import type { NavEntry } from './navEntries';

interface ViewFloaterProps {
  entry: NavEntry;
  onClose: () => void;
  /** 注入给注册视图的额外 props（装配层按视图类型提供，如来源视图的依据留痕）。 */
  extraProps?: Record<string, unknown>;
}

export function ViewFloater({ entry, onClose, extraProps }: ViewFloaterProps) {
  const registered = getRegisteredViews().find((v) => v.id === entry.key);
  const Icon = entry.icon;
  const width = entry.group === 'mech' ? '72%' : '58%';

  const renderView = () => {
    if (!registered) return <DynamicComponent name={entry.key} />;
    const Comp = registered.Component as React.ComponentType<Record<string, unknown>>;
    return <Comp {...(extraProps ?? {})} />;
  };

  return (
    <div className="ink-settings-overlay" data-ui="view_floater_overlay" onClick={onClose}>
      <section
        data-ui="view_floater"
        className="ink-settings-panel"
        style={{ width, maxWidth: '1200px' }}
        role="dialog"
        aria-label={entry.label}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-full flex-col">
          <header className="flex items-center justify-between border-b ink-border px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-medium ink-text-base">
              <Icon size={16} strokeWidth={1.6} aria-hidden />
              {entry.label}
            </div>
            <button
              type="button"
              data-ui="view_floater_close"
              onClick={onClose}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] ink-text-muted hover:text-[var(--ink-text-base)]"
            >
              <X size={14} strokeWidth={1.6} aria-hidden />
              返回主界面
            </button>
          </header>
          <div className="ink-scroll-auto flex-1 overflow-y-auto px-4 py-4">
            {renderView()}
          </div>
        </div>
      </section>
    </div>
  );
}
