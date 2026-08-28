import type { ComponentType } from 'react';

import type { LucideIcon } from 'lucide-react';

/** 视图注册项（集成 agent 经 getRegisteredViews 取用并装配）。 */
export interface RegisteredView {
  id: string;
  /** 中文标签。 */
  label: string;
  icon: LucideIcon;
  Component: ComponentType;
}

const registry = new Map<string, RegisteredView>();

/** 注册一个机制视图（W3 四视图由 activate() 统一注册）。 */
export function registerView(view: RegisteredView): void {
  registry.set(view.id, view);
}

/** 取已注册视图（集成层装配用）。 */
export function getRegisteredViews(): RegisteredView[] {
  return [...registry.values()];
}
