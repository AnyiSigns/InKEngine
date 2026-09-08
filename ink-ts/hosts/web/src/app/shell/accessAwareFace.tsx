import type { ComponentType } from 'react';
import { createElement } from 'react';

import type { PlainComponent } from '@/renderer/componentRegistry';
import { declaredUiAccess, sliceUiAccess } from './uiAccessSlice';

/**
 * 注册包装层切片：真 ui 面插件默认导出注册进渲染器白名单前的
 * 壳装配包装——渲染器 DynamicComponent/UINodeView **不感知插件契约**（保持
 * 通用挂载），全量 product chrome 仍经 chromeProps 到本包装层，由本层按插件
 * spec 声明的 faces.ui.access（store 数据/服务座位 + inject 宿主动作）切片，
 * 只把声明名作为顶层 props 交给插件默认导出（props.authorized / props.onSend…）。
 *
 * 语义：
 * - 未声明 access 的插件（壳特例 settings_floater / 未迁移面板）= 原样透传
 *   props（含全量 product），注册行为零变化（settings_floater 需全量 chrome
 *   作面板切片源，豁免不迁，见其 AGENTS）；
 * - 声明 access 的插件 = 剥掉全量 product，只把命中声明的切片名放顶层——
 *   无隐式全量注入（读词表外字段 = undefined，verify_unload 已锁词表命中）；
 * - bind/节点 props（bindValue、node props）不属 product，原样保留。
 *
 * 由生成器 sync_plugin_manifest.mjs 在 pluginFaces.generated.ts 中对每个真
 * ui 面默认导出套本包装注册（registerComponent(id, accessAwareFace(id, Face))）。
 */
export function accessAwareFace(id: string, Face: PlainComponent): ComponentType<Record<string, unknown>> {
  const wrap: ComponentType<Record<string, unknown>> = (props: Record<string, unknown>) => {
    if (!declaredUiAccess(id)) return createElement(Face, props);
    const { product, ...rest } = props;
    const slice = sliceUiAccess(id, (product as Record<string, unknown> | null | undefined) ?? {});
    return createElement(Face, { ...rest, ...slice });
  };
  wrap.displayName = `accessAware(${id})`;
  return wrap;
}
