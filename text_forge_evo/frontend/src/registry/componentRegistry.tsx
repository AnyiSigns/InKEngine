/**
 * 动态组件注册表：AI 演化生成的新组件经构建管线产出独立 bundle，
 * 前端 import() 动态加载 + React.lazy + Suspense + 错误边界兜底。
 *
 * 布局 JSON 只能引用已注册组件（组件白名单）——注册即白名单放行；
 * 未注册组件渲染占位拒绝（组件名 + 缺口提示），并上报能力缺口信号
 * （AI 可感知「界面引用了未挂载组件」→ 补挂或改布局），不执行任意
 * 代码。加载失败/渲染异常回退占位（产物哈希 URL 缓存失效等场景不
 * 击穿面板）。数据绑定（bind）由渲染器订阅状态通道后经 bindValue
 * 注入组件——组件不感知通道细节，只消费数据。
 */

import { Component, Suspense, lazy, useEffect, useMemo, useRef } from 'react';
import type { ComponentType, ErrorInfo, ReactNode } from 'react';

import { SUPPORTED_BIND_CHANNELS, useBoundPath } from '@/renderer/stateChannel';
import type { UIBind } from '@/renderer/bootRenderer';

export type ComponentLoader = () => Promise<{ default: ComponentType<Record<string, unknown>> }>;

interface ComponentEntry {
  /** 同步组件（内置基线）或动态加载工厂（AI 生成的独立 bundle） */
  load: ComponentLoader | (() => ComponentType<Record<string, unknown>>);
}

const components = new Map<string, ComponentEntry>();

/** 注册组件（同名覆盖——内置基线优先，演化产物可接管）。 */
export function registerComponent(
  name: string,
  entry: ComponentEntry,
): void {
  if (!name) throw new Error('组件名不能为空');
  components.set(name, entry);
}

/** 注册托管产物组件：独立 bundle URL → import() 动态加载（哈希由 URL 携带）。 */
export function registerDynamicComponent(name: string, url: string): void {
  if (!name) throw new Error('组件名不能为空');
  if (!url) throw new Error('产物 URL 不能为空');
  registerComponent(name, {
    load: () =>
      import(/* @vite-ignore */ url) as Promise<{
        default: ComponentType<Record<string, unknown>>;
      }>,
  });
}

/** 组件是否已注册（白名单判定）。 */
export function isComponentRegistered(name: string): boolean {
  return components.has(name);
}

/** 解析组件：同步组件原样返回，动态工厂包 React.lazy（Suspense 加载）。 */
export function resolveComponent(
  name: string,
): ComponentType<Record<string, unknown>> | null {
  const entry = components.get(name);
  if (!entry) return null;
  const resolved = entry.load();
  if (
    typeof resolved === 'object' &&
    resolved !== null &&
    typeof (resolved as Promise<unknown>).then === 'function'
  ) {
    return lazy(() => resolved as Promise<{ default: ComponentType<any> }>);
  }
  return resolved as ComponentType<Record<string, unknown>>;
}

interface ErrorBoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/** 组件渲染错误边界：AI 生成的组件运行异常回退占位，不击穿面板。 */
class ComponentErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('动态组件渲染失败', error, info);
  }

  render(): ReactNode {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

function renderFallback(name: string, message: string): ReactNode {
  return (
    <div className="rounded-md border border-dashed border-foreground/15 px-3 py-2 text-[11px] text-muted-foreground/60">
      {name} {message}
    </div>
  );
}

/** 绑定组件挂载点：按 bind.path 订阅通道取值，经 bindValue 注入组件。 */
function BoundComponent({
  Comp,
  name,
  props,
  path,
}: {
  Comp: ComponentType<Record<string, unknown>>;
  name: string;
  props?: Record<string, unknown>;
  path: string;
}) {
  const bindValue = useBoundPath<unknown>(path);
  return (
    <ComponentErrorBoundary fallback={renderFallback(name, '渲染失败，已回退占位')}>
      <Suspense fallback={renderFallback(name, '加载中…')}>
        <Comp {...(props ?? {})} bindValue={bindValue} />
      </Suspense>
    </ComponentErrorBoundary>
  );
}

/** 动态组件挂载点：白名单解析 + 异步加载 + 绑定注入 + 错误兜底。 */
export function DynamicComponent({
  name,
  props,
  bind = null,
}: {
  name: string;
  props?: Record<string, unknown>;
  bind?: UIBind | null;
}) {
  const Comp = useMemo(() => resolveComponent(name), [name]);
  const unreportedRef = useRef(new Set<string>());

  // 能力缺口闭环：未注册组件占位时上报（观察通道），AI 感知补挂或改布局
  useEffect(() => {
    if (Comp || unreportedRef.current.has(name)) return;
    unreportedRef.current.add(name);
    void fetch('/api/self/ui/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'capability_gap', component: name }),
    }).catch(() => undefined);
  }, [Comp, name]);

  if (!Comp) {
    return (
      <div className="rounded-md border border-dashed border-destructive/25 bg-destructive/[0.03] px-3 py-2 text-[11px] text-destructive/60">
        未注册组件：{name}（组件白名单拒绝）
      </div>
    );
  }
  if (bind) {
    if (!SUPPORTED_BIND_CHANNELS.includes(bind.channel)) {
      return (
        <div className="rounded-md border border-dashed border-destructive/25 px-3 py-2 text-[11px] text-destructive/60">
          绑定通道未放行：{bind.channel}（仅支持 {SUPPORTED_BIND_CHANNELS.join('/')}）
        </div>
      );
    }
    return <BoundComponent Comp={Comp} name={name} props={props} path={bind.path} />;
  }
  return (
    <ComponentErrorBoundary fallback={renderFallback(name, '渲染失败，已回退占位')}>
      <Suspense fallback={renderFallback(name, '加载中…')}>
        <Comp {...(props ?? {})} />
      </Suspense>
    </ComponentErrorBoundary>
  );
}
