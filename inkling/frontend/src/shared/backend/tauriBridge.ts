/**
 * Tauri IPC 桥（桌面宿主最小接入面）：window.__TAURI_INTERNALS__ 直调。
 *
 * 不引入 @tauri-apps/api 依赖（Tauri v2 核心在 WebView 注入 IPC 内部件，
 * 前端侧以最小类型面直呼 invoke 与事件通道）；宿主不可用（浏览器 dev /
 * 测试环境）时 available=false，调用方回落夹具路径。
 */

export interface TauriInvoker {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}

interface TauriInternals {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  transformCallback: (callback: (payload: unknown) => void) => number;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

/** 宿主 IPC 是否可用（WebView 内嵌形态才存在内部件）。 */
export function isTauriHost(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.__TAURI_INTERNALS__?.invoke === 'function'
  );
}

/** 最小注入面（测试注入 mock 后端；缺省 = 真实宿主桥）。 */
export function createTauriInvoker(): TauriInvoker | null {
  if (!isTauriHost()) return null;
  return {
    invoke: (cmd, args) => {
      const internals = window.__TAURI_INTERNALS__;
      if (!internals) return Promise.reject(new Error('宿主 IPC 不可用'));
      return internals.invoke(cmd, args ?? {});
    },
  };
}

/** 事件通道载荷（Tauri 核心事件插件的回调形态）。 */
export interface TauriEventEnvelope<T> {
  event: string;
  id: number;
  payload: T;
}

/**
 * 订阅宿主事件（经核心事件插件通道：invoke plugin:event|listen）。
 * 返回注销函数；宿主不可用或订阅失败时返回空操作，调用方回落轮询。
 */
export async function listenHostEvent<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  const internals = window.__TAURI_INTERNALS__;
  if (!internals || typeof internals.transformCallback !== 'function') {
    return () => undefined;
  }
  const callbackId = internals.transformCallback((envelope) => {
    const typed = envelope as TauriEventEnvelope<T>;
    handler(typed?.payload);
  });
  try {
    const eventId = (await internals.invoke('plugin:event|listen', {
      event,
      target: { kind: 'Any' },
      handler: callbackId,
      options: {},
    })) as number;
    return async () => {
      try {
        await internals.invoke('plugin:event|unlisten', { event, eventId });
      } catch {
        // 注销失败无副作用（订阅随窗口关闭自然失效）
      }
    };
  } catch {
    return () => undefined;
  }
}
