/**
 * 阶段 9b 壳装配层切片：按 ui_feature 插件 spec 声明的 faces.ui.access
 * （store 数据/服务座位 + inject 宿主动作）从 product chrome 中挑出该插件
 * 声明消费的名字，注入 DynamicComponent——无隐式全量注入（未声明的不给）。
 *
 * access 声明真源 = plugins/ui_features/<id>/spec.json 的 faces.ui.access，
 * 生成器把它全量带进 plugins/manifest.json plugins[] 行（row.faces.ui.access）；
 * 词表单一真源 = hostAccessVocab.ts（ProductShellModel 座位 ∪ ProductShellActions
 * 动作，verify_unload 语义审计：仅真 ui 面合法 + store/inject 槽位命中词表）。
 *
 * 本模块住 hosts/web（壳装配层），渲染器 DynamicComponent 不感知插件契约；
 * 设置浮层等真 ui 面壳把本切片函数当作「按声明注入面」使用。
 */

import pluginManifest from '../../../../../plugins/manifest.json';

interface UiAccessDecl {
  store?: string[];
  inject?: string[];
}

/** 查插件 spec 声明的接入面（undefined = 未声明 access）。 */
export function declaredUiAccess(pluginId: string): UiAccessDecl | undefined {
  const rows = (pluginManifest as { plugins?: Array<Record<string, unknown>> }).plugins ?? [];
  const row = rows.find((p) => p.id === pluginId);
  const faces = row?.faces;
  if (typeof faces !== 'object' || faces === null || Array.isArray(faces)) return undefined;
  const ui = (faces as Record<string, unknown>).ui;
  if (typeof ui !== 'object' || ui === null || Array.isArray(ui)) return undefined;
  const access = (ui as Record<string, unknown>).access;
  if (typeof access !== 'object' || access === null || Array.isArray(access)) return undefined;
  const a = access as Record<string, unknown>;
  const store = Array.isArray(a.store) ? a.store.filter((x): x is string => typeof x === 'string') : [];
  const inject = Array.isArray(a.inject) ? a.inject.filter((x): x is string => typeof x === 'string') : [];
  if (store.length === 0 && inject.length === 0) return undefined;
  return { store, inject };
}

/** 按声明切片：只取该插件 access 声明命中的 chrome 座位/动作（未声明 = 空对象）。 */
export function sliceUiAccess(pluginId: string, chrome: Record<string, unknown>): Record<string, unknown> {
  const access = declaredUiAccess(pluginId);
  if (!access) return {};
  const slice: Record<string, unknown> = {};
  for (const name of [...(access.store ?? []), ...(access.inject ?? [])]) {
    if (name in chrome) slice[name] = chrome[name];
  }
  return slice;
}
