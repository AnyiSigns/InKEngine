/**
 * 自定义消息渲染器注册表（渲染器显示层开放的开放通道）。
 *
 * 数据化：渲染器键 = 事件类型名（或经白名单登记的自定键），绑定自定义
 * 渲染组件；新事件类型先经 registerRendererKey 登记进白名单，再绑定渲染器。
 * 白名单校验 fail-closed：键不在白名单 → 拒绝绑定；形态未声明 → 解析返回
 * null（不回落到任意渲染器）。
 *
 * 形态（view_forms）：同一渲染器可声明支持 mini（内联紧凑）/ overlay
 * （弹层展开）形态，bootRenderer 经 resolveMessageRenderer(key, form)
 * 选择形态消费（挂接以追加式注入 chromeProps，不重构既有布局树）。
 */

import type { ComponentType } from 'react';

import { EVENT_TYPE_NAMES } from '@/shared/session/eventTypes';

export type MessageRendererForm = 'mini' | 'overlay';

export interface MessageRendererProps {
  event?: unknown;
  form?: MessageRendererForm;
  [key: string]: unknown;
}

export type MessageRenderer = ComponentType<MessageRendererProps>;

interface MessageRendererEntry {
  renderer: MessageRenderer;
  forms: MessageRendererForm[];
}

const registry = new Map<string, MessageRendererEntry>();
const keyWhitelist = new Set<string>(EVENT_TYPE_NAMES as readonly string[]);

/** 重置（测试隔离用）：清注册表并复原白名单基线。 */
export function resetMessageRendererRegistry(): void {
  registry.clear();
  keyWhitelist.clear();
  for (const name of EVENT_TYPE_NAMES) keyWhitelist.add(name);
}

/** 登记渲染器键进白名单（命名形态须为小写字母/数字/下划线）。 */
export function registerRendererKey(key: string): boolean {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) return false;
  keyWhitelist.add(key);
  return true;
}

/** 渲染器键是否在白名单内。 */
export function isRendererKeyAllowed(key: string): boolean {
  return keyWhitelist.has(key);
}

/** 白名单键清单（诊断用）。 */
export function listRendererKeys(): string[] {
  return [...keyWhitelist];
}

/**
 * 绑定自定义渲染器到渲染器键（fail-closed）：
 * - 键不在白名单 → 拒绝；
 * - 渲染器缺失 → 拒绝；
 * - 形态清单为空或全非法 → 拒绝。
 */
export function registerMessageRenderer(
  key: string,
  renderer: MessageRenderer,
  forms: MessageRendererForm[] = ['mini', 'overlay'],
): boolean {
  if (!isRendererKeyAllowed(key)) return false;
  if (!renderer) return false;
  const safe = forms.filter((f) => f === 'mini' || f === 'overlay');
  if (safe.length === 0) return false;
  registry.set(key, { renderer, forms: safe });
  return true;
}

/**
 * 解析渲染器（fail-closed）：键未绑定 / 形态未声明 → 返回 null，
 * 不回落到任意渲染器（防开放通道被滥用）。
 */
export function resolveMessageRenderer(key: string, form: MessageRendererForm = 'mini'): MessageRenderer | null {
  const entry = registry.get(key);
  if (!entry) return null;
  if (!entry.forms.includes(form)) return null;
  return entry.renderer;
}

/** 注销渲染器键绑定（清单刷新/卸载用）。 */
export function unregisterMessageRenderer(key: string): void {
  registry.delete(key);
}
