/**
 * 产品壳布局 canonical 适配器：顶栏 / 左右栏 / 覆盖层（审批卡/设置浮层）。
 *
 * 适配器职责：宿主 product chrome（产品壳视图模型 + 动作面）→ 产品组件
 * props 映射。栏体折叠与顶栏自动隐藏属本地 UI 态（不进布局数据）；
 * 无宿主数据时回落可渲染占位（组件不崩），供渲染器白名单测试独立使用。
 */

import type { ComponentType, ReactNode } from 'react';

import { SettingsFloater } from '@/app/settings/settings_floater';
import type { ProductShellChrome } from '@/app/shell/productView';

function productOf(props: Record<string, unknown>): ProductShellChrome {
  return (props.product as ProductShellChrome | null | undefined) ?? {};
}

const noop = (): void => undefined;

/** settings_floater：设置浮层（注册式驱动；打开态 = 宿主 settingsOpen）。 */
const SettingsFloaterAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = productOf(props);
  const backend = product.backend as { available?: boolean } | undefined;
  return (
    <SettingsFloater
      open={product.settingsOpen === true}
      onClose={product.onCloseSettings ?? noop}
      backend={{ available: backend?.available === true }}
    />
  );
};

/** canonical 布局适配器注册表（top_bar/file_tree/session_list/task_capsule/
 *  review_card 已真面化随插件 faces/ui 同住，pluginFaces 注册）。 */
export const layoutAdapterRegistry: Record<string, ComponentType<Record<string, unknown>>> = {
  settings_floater: SettingsFloaterAdapter,
};

/** 空态说明（占位适配器共用文案）。 */
export function adapterEmptyNote(text: string): ReactNode {
  return <div className="px-3 py-2 text-[11px] ink-text-faint">{text}</div>;
}
