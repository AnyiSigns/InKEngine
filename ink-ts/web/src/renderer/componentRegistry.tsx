/**
 * 动态组件注册表（渲染器一层防线：组件白名单）。
 *
 * 布局 JSON 只能引用已注册组件——注册即白名单放行；未注册组件渲染
 * 占位拒绝（组件名 + 缺口提示），不执行任意代码。绑定通道与主题 token
 * 的白名单判定在挂载点统一执行（三层白名单收敛于此）：
 *   1. 未声明组件 → 拒绝渲染（占位提示）；
 *   2. 未放行绑定通道 / _ 前缀内部通道 → 拒绝绑定（占位提示）；
 *   3. 未声明主题 token → 拒绝落地（themeTokens 层）。
 *
 * 渲染异常回退占位（错误边界），不击穿面板；未知事件类型折叠兜底。
 */

import { Component, useSyncExternalStore } from 'react';
import type { ComponentType, ErrorInfo, ReactNode } from 'react';

import { isBindChannelAllowed } from './channelWhitelist';
import { useBoundChannel } from './stateChannel';
import { useBoundEvent } from './eventChannel';
import type { UIBind } from './uiSpecTypes';

export type PlainComponent = ComponentType<Record<string, unknown>>;

const components = new Map<string, PlainComponent>();
/** 已停用出厂组件（组件 tab 勾选落地面；停用组件渲染占位拒绝）。 */
const disabledComponents = new Set<string>();
const gateListeners = new Set<() => void>();
let gateVersion = 0;

function notifyComponentGate(): void {
  gateVersion += 1;
  for (const listener of gateListeners) listener();
}

/** 出厂组件启停订阅（启停即时生效：产品面渲染闸随启停变化重渲）。 */
export function subscribeComponentGate(listener: () => void): () => void {
  gateListeners.add(listener);
  return () => gateListeners.delete(listener);
}

function getComponentGateVersion(): number {
  return gateVersion;
}

/** 注册组件（同名覆盖——内置基线优先，演化产物可接管）。 */
export function registerComponent(name: string, component: PlainComponent): void {
  if (!name) throw new Error('组件名不能为空');
  components.set(name, component);
}

/** 组件是否已注册（白名单判定）。 */
export function isComponentRegistered(name: string): boolean {
  return components.has(name);
}

/** 出厂组件启停同步（组件 tab 勾选落地面；整集替换）。 */
export function setUiComponentsDisabled(names: string[]): void {
  disabledComponents.clear();
  for (const name of names) disabledComponents.add(name);
  notifyComponentGate();
}

/** 组件是否启用（停用集排除；与注册白名单并存的第二道闸）。 */
export function isComponentEnabled(name: string): boolean {
  return !disabledComponents.has(name);
}

/** 解析组件：未注册返回 null（渲染占位拒绝）。 */
export function resolveComponent(name: string): PlainComponent | null {
  return components.get(name) ?? null;
}

/**
 * 出厂组件门闸（接真实渲染面）：把产品面直接渲染的组件套进该闸——
 * 停用即整区替换为占位（与引擎 ui_allowed_components 过滤同语义），
 * 启停变化经订阅即时生效，不再是只约束规格渲染的死闸。
 * mode="hidden" 时停用组件直接不渲染（侧栏等布局位不占位）。
 */
export function ComponentGate({
  name,
  children,
  mode = 'placeholder',
  className,
}: {
  name: string;
  children: ReactNode;
  mode?: 'placeholder' | 'hidden';
  className?: string;
}) {
  const version = useSyncExternalStore(subscribeComponentGate, getComponentGateVersion, getComponentGateVersion);
  void version;
  if (isComponentEnabled(name)) return <>{children}</>;
  if (mode === 'hidden') return null;
  return (
    <div
      className={`flex h-full min-h-[120px] w-full items-center justify-center border border-dashed px-4 text-center text-[11px] ink-border ink-text-faint ${className ?? ''}`}
      data-ui={`component_disabled_${name}`}
    >
      组件「{name}」已停用（出厂组件启停，可在设置 → 组件中恢复）
    </div>
  );
}

interface ErrorBoundaryProps {
  name: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/** 组件渲染错误边界：异常回退占位，不击穿面板。 */
class ComponentErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(`[inkling:error] [renderer] 组件渲染失败: ${this.props.name}`, error, info);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="border border-dashed px-3 py-2 text-[11px] ink-border ink-text-faint">
          {this.props.name} 渲染失败，已回退占位
        </div>
      );
    }
    return this.props.children;
  }
}

function rejectPlaceholder(message: string): ReactNode {
  return (
    <div className="border border-dashed px-3 py-2 text-[11px] ink-border ink-text-faint">
      {message}
    </div>
  );
}

/** 绑定挂载点：按 bind.channel 订阅（state/inspect 取值、events 事件），注入组件。 */
function BoundComponent({
  Comp,
  name,
  props,
  bind,
  chromeProps,
}: {
  Comp: PlainComponent;
  name: string;
  props: Record<string, unknown>;
  bind: UIBind;
  chromeProps: Record<string, unknown>;
}) {
  const { channel, path = '' } = bind;
  const isEventChannel = channel.startsWith('events.');
  const bindValue = isEventChannel ? useBoundEvent(channel) : useBoundChannel<unknown>(channel, path);
  return (
    <ComponentErrorBoundary name={name}>
      <Comp {...props} {...chromeProps} bindValue={bindValue} />
    </ComponentErrorBoundary>
  );
}

/**
 * 组件挂载点：白名单解析 + 绑定通道校验 + 绑定注入 + 错误兜底。
 * bind 存在但通道未放行时整组件拒绝渲染（三层白名单之一）。
 * chromeProps = 渲染器壳注入的机制回调（导航/审批决议），组件按需消费。
 */
export function DynamicComponent({
  name,
  props,
  bind = null,
  chromeProps = {},
}: {
  name: string;
  props?: Record<string, unknown>;
  bind?: UIBind | null;
  chromeProps?: Record<string, unknown>;
}) {
  // 每次渲染即时解析：动态注册（产物清单/启停恢复）后无需缓存失效，立即生效。
  const Comp = resolveComponent(name);

  if (!Comp) {
    return <>{rejectPlaceholder(`未注册组件：${name}（组件白名单拒绝）`)}</>;
  }

  if (!isComponentEnabled(name)) {
    return <>{rejectPlaceholder(`组件已停用：${name}（出厂组件停用）`)}</>;
  }

  if (bind) {
    if (!isBindChannelAllowed(bind.channel, bind.path ?? '')) {
      return (
        <>
          {rejectPlaceholder(
            bind.channel.startsWith('_')
              ? `绑定通道禁绑：${bind.channel}（内部通道）`
              : `绑定通道未放行：${bind.channel}（白名单拒绝）`,
          )}
        </>
      );
    }
    return <BoundComponent Comp={Comp} name={name} props={props ?? {}} bind={bind} chromeProps={chromeProps} />;
  }

  return (
    <ComponentErrorBoundary name={name}>
      <Comp {...(props ?? {})} {...chromeProps} />
    </ComponentErrorBoundary>
  );
}
