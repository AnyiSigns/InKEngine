/**
 * 装配层：把 fe4 的五个 section（markets/tools/os/workspace/ui_editor）归一为
 * fe2 设置注册表可消费条目。
 *
 * fe4 契约：item.kind 含 'component'、read/write 为同步函数、icon 是 ReactNode；
 * fe2 契约：item.kind 为 text/secret/select/toggle/custom、write 可选、无 'component'。
 * 归一策略：fe4 section 以 render 形态注册——每个 'component' 条目经组件白名单
 * 渲染对应视图组件（fe4 已把组件注册到 componentRegistry，键名即 item.key）。
 */

import { DynamicComponent } from '@/renderer/componentRegistry';
import type { SettingsSectionSpec } from '@/app/settings/types';
import type { Wave4SettingsSection } from '@/app/views/wave4activate';

export function normalizeWave4Sections(sections: Wave4SettingsSection[]): SettingsSectionSpec[] {
  return sections.map((section) => ({
    key: section.key,
    label: section.label,
    icon: section.icon,
    order: section.order,
    render: () => (
      <div className="space-y-4">
        {section.items?.map((item) => (
          <div key={item.key} className="space-y-2" data-ui={`wave4_item_${item.key}`}>
            <div className="text-[12px] font-medium ink-text-base">{item.label}</div>
            {item.hint && <p className="text-[10px] leading-relaxed ink-text-faint">{item.hint}</p>}
            {item.disabledReason ? (
              <p className="text-[11px] ink-feedback-warn">{item.disabledReason}</p>
            ) : (
              <DynamicComponent name={item.key} />
            )}
          </div>
        ))}
      </div>
    ),
  }));
}
