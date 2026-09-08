import type { ComponentType } from 'react';

import type { ProductShellChrome } from '@app/shell/productView';
import { SettingsFloater } from './SettingsFloater';

const noop = (): void => undefined;

/**
 * settings_floater ui 面入口：设置浮层（读派生清单 SETTINGS_SECTIONS 渲染节
 * 导航与面板内容）。装配期经 pluginFaces.generated.ts 注册；打开态 = 壳
 * product chrome settingsOpen，关闭经 onCloseSettings 回落。
 */
const SettingsFloaterAdapter: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
  const product = (props.product as ProductShellChrome | null | undefined) ?? {};
  return <SettingsFloater open={product.settingsOpen === true} onClose={product.onCloseSettings ?? noop} />;
};

export default SettingsFloaterAdapter;
