/**
 * 设置「高级」节（开发者模式专属）：机制视图浮窗入口清单。
 *
 * 主会话界面不放机制导航——引擎机制视图（架构/演化/技能市场/
 * 知识面板）统一收纳于此，点击以浮窗打开；市场/工具/OS/工作区/界面编辑器
 * 与原管理台各节已内嵌为设置开发者节，不在此重复列出。
 * 演化已内联为主区「演化」页签，高级节不重复列出。
 * 入口经 SettingsActionsContext 由装配层注入。
 */

import { createContext, useContext } from 'react';

import { ChevronRight } from 'lucide-react';

import { NAV_ENTRIES } from '@/app/wiring/navEntries';

export interface SettingsActions {
  /** 打开机制/市场视图浮窗（key 见 navEntries）。 */
  onOpenView: (key: string) => void;
}

export const SettingsActionsContext = createContext<SettingsActions>({
  onOpenView: () => undefined,
});

/** 已有设置内嵌节/主区页签的视图键，高级行不重复列出。 */
const INLINE_SECTION_KEYS = new Set([
  'mcp_market',
  'component_registry',
  'tools_panel',
  'workspace_auth',
  'ui_editor_host',
  'evolution',
  'knowledge_panel',
]);

export function AdvancedSection(): JSX.Element {
  const { onOpenView } = useContext(SettingsActionsContext);
  const entries = NAV_ENTRIES.filter((e) => !INLINE_SECTION_KEYS.has(e.key));

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-relaxed ink-text-faint">
        引擎机制视图面向调试与治理，默认不进主界面。以下入口仅在开发者模式可见；
        注册表/账本/审计等诊断节见左侧「开发者」分组。
      </p>
      <div className="ink-elevated divide-y divide-[var(--ink-border)] overflow-hidden">
        {entries.map((entry) => {
          const Icon = entry.icon;
          return (
            <button
              key={entry.key}
              type="button"
              data-ui={`advanced_open_${entry.key}`}
              onClick={() => onOpenView(entry.key)}
              className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-[var(--ink-bg-surface)]"
            >
              <Icon size={15} strokeWidth={1.6} className="shrink-0 ink-text-muted" aria-hidden />
              <span className="flex-1 text-[13px]">{entry.label}</span>
              <span className="text-[11px] ink-text-faint">{entry.group === 'mech' ? '机制视图' : '能力视图'}</span>
              <ChevronRight size={14} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
            </button>
          );
        })}
      </div>
    </div>
  );
}
