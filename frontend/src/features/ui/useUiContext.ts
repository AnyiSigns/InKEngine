/**
 * ui_context 上报（渲染器机制契约）：位置快照 + 交互事件。
 *
 * 位置快照（active_app/active_view/current_layout/focused_component/
 * selection）按值变化节流上报（3 秒窗口），字段白名单对齐后端端点；
 * 交互事件（点击/输入）带组件定位即时上报（审计留痕，同时是行为
 * 信号源）。上报失败静默——感知通道是增强不是收紧，不击穿面板。
 */

import { useEffect, useRef } from 'react';

export interface UiContextSnapshot {
  active_app?: string;
  active_view?: string;
  current_layout?: string | null;
  focused_component?: string;
  selection?: string | null;
}

const SNAPSHOT_INTERVAL_MS = 3000;
const SELECTION_MAX_CHARS = 120;
const INPUT_THROTTLE_MS = 500;

function postJson(url: string, body: unknown): void {
  void fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => undefined);
}

/** 聚焦组件定位：data-ui 属性优先，否则 tag（可带 id）。 */
function focusedComponent(): string {
  const el = document.activeElement;
  if (!el) return '';
  const ui = (el as HTMLElement).dataset?.ui;
  if (ui) return ui;
  const tag = el.tagName.toLowerCase();
  return el.id ? `${tag}#${el.id}` : tag;
}

function selectionText(): string | null {
  const text = window.getSelection()?.toString().trim();
  if (!text) return null;
  return text.slice(0, SELECTION_MAX_CHARS);
}

/** 位置快照上报（挂载于 boot 壳；应用/视图/布局变化时随依赖重订阅）。 */
export function useUiContext(opts: {
  appName?: string;
  viewName?: string;
  layoutName?: string | null;
}): void {
  const { appName = 'forge', viewName = 'chat', layoutName = null } = opts;
  const lastSnapshotRef = useRef<UiContextSnapshot>({});

  useEffect(() => {
    const collect = (): UiContextSnapshot => ({
      active_app: appName,
      active_view: viewName,
      current_layout: layoutName,
      focused_component: focusedComponent() || undefined,
      selection: selectionText(),
    });
    const report = () => {
      const snapshot = collect();
      const last = lastSnapshotRef.current;
      const changed = Object.entries(snapshot).some(
        ([key, value]) => last[key as keyof UiContextSnapshot] !== value,
      );
      if (!changed) return;
      lastSnapshotRef.current = snapshot;
      postJson('/api/self/ui/context', snapshot);
    };
    // 首次挂载即上报一次基线；此后按窗口轮询 + 焦点/选择事件即时检查
    report();
    const interval = window.setInterval(report, SNAPSHOT_INTERVAL_MS);
    window.addEventListener('focusin', report);
    document.addEventListener('selectionchange', report);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focusin', report);
      document.removeEventListener('selectionchange', report);
    };
  }, [appName, viewName, layoutName]);
}

/** 交互事件上报（点击即时；输入节流合并，防逐键刷日志）。 */
export function useUiInteractionReport(): void {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      const component = el?.dataset?.ui || el?.tagName.toLowerCase() || '';
      postJson('/api/self/ui/event', { type: 'click', component });
    };
    let lastInputAt = 0;
    const onInput = (e: Event) => {
      const now = Date.now();
      if (now - lastInputAt < INPUT_THROTTLE_MS) return;
      lastInputAt = now;
      const el = e.target as HTMLElement | null;
      const component = el?.dataset?.ui || el?.tagName.toLowerCase() || '';
      postJson('/api/self/ui/event', { type: 'input', component });
    };
    window.addEventListener('click', onClick);
    window.addEventListener('input', onInput);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('input', onInput);
    };
  }, []);
}
