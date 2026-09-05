/**
 * 主题档控制器（light / dark / system 三档）。
 *
 * 语义：system 档 = 跟随 OS prefers-color-scheme，监听变化即时切换；
 * light/dark 档 = 显式钉住并覆盖系统。默认 system。
 * 首启不闪屏：index.html 内联脚本在首屏渲染前解析持久偏好并预挂
 * data-theme；本模块在浏览器上下文二次确认（容错：jsdom/测试环境
 * 无 matchMedia 时回落 light，不抛）。
 *
 * 持久化经可注入存储（默认 localStorage，测试注入内存实现）；
 * 应用侧写法 = document.documentElement.dataset.theme =
 * 'light' | 'dark'（system 档清除属性，交由 CSS prefers-color-scheme）。
 */

import { useSyncExternalStore } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';
export type EffectiveTheme = 'light' | 'dark';

export interface ThemePersist {
  read(): ThemeMode | null;
  write(mode: ThemeMode): void;
}

export interface DarkQuery {
  /** 当前系统是否为暗色（注入面：测试可固定布尔）。 */
  matches: boolean;
  /** 订阅系统暗色切换（返回取消函数；不可用时返回 noop）。 */
  subscribe(cb: () => void): () => void;
}

const STORAGE_KEY = 'inkling.theme';

export function createLocalStoragePersist(storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void }): ThemePersist {
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  return {
    read(): ThemeMode | null {
      if (!store) return null;
      try {
        const value = store.getItem(STORAGE_KEY);
        return value === 'light' || value === 'dark' || value === 'system' ? value : null;
      } catch {
        return null;
      }
    },
    write(mode: ThemeMode): void {
      if (!store) return;
      try {
        store.setItem(STORAGE_KEY, mode);
      } catch {
        // 存储不可用（隐私模式等）时静默降级为不持久，不抛
      }
    },
  };
}

export function createMemoryPersist(initial?: ThemeMode | null): ThemePersist {
  let value = initial ?? null;
  return {
    read: () => value,
    write: (mode) => {
      value = mode;
    },
  };
}

/** 浏览器默认暗色查询源（matchMedia 不可用时回落 light，不抛）。 */
export function browserDarkQuery(): DarkQuery {
  try {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    return {
      matches: mql.matches,
      subscribe(cb) {
        try {
          mql.addEventListener('change', cb);
          return () => mql.removeEventListener('change', cb);
        } catch {
          return () => undefined;
        }
      },
    };
  } catch {
    return { matches: false, subscribe: () => () => undefined };
  }
}

export function resolveEffectiveTheme(mode: ThemeMode, systemDark: boolean): EffectiveTheme {
  if (mode === 'system') return systemDark ? 'dark' : 'light';
  return mode;
}

/** 应用档位 → data-theme 属性（system 档清除属性交回 CSS 媒体查询）。 */
export function applyThemeAttribute(effective: EffectiveTheme): void {
  const root = document.documentElement;
  if (effective === 'dark') root.dataset.theme = 'dark';
  else root.dataset.theme = 'light';
}

/** 主题档控制器：状态 + 持久化 + 系统暗色监听 + 属性应用（可注入三件套）。 */
export class ThemeModeController {
  private mode: ThemeMode = 'system';
  private listeners = new Set<() => void>();
  private unsubscribeDark: () => void = () => undefined;
  /** 任何主题变化（换档 / OS 暗色切换）都递增：useSyncExternalStore 据此重渲。 */
  private version = 0;

  constructor(
    private persist: ThemePersist = createLocalStoragePersist(),
    private darkQuery: DarkQuery = browserDarkQuery(),
    private apply: (effective: EffectiveTheme) => void = applyThemeAttribute,
  ) {
    this.mode = persist.read() ?? 'system';
    this.apply(resolveEffectiveTheme(this.mode, darkQuery.matches));
    this.unsubscribeDark = darkQuery.subscribe(() => {
      this.apply(resolveEffectiveTheme(this.mode, this.darkQuery.matches));
      this.version += 1;
      for (const listener of this.listeners) listener();
    });
  }

  getMode(): ThemeMode {
    return this.mode;
  }

  getEffective(): EffectiveTheme {
    return resolveEffectiveTheme(this.mode, this.darkQuery.matches);
  }

  /** 主题版本戳：换档与 OS 暗色切换均递增（system 档下 OS 切换也能触发重渲）。 */
  getVersion(): number {
    return this.version;
  }

  setMode(mode: ThemeMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.persist.write(mode);
    this.apply(this.getEffective());
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  disconnect(): void {
    this.unsubscribeDark();
  }
}

let sharedController: ThemeModeController | null = null;

/** 全局共享控制器（仅注册一次；测试可注入自有实例）。 */
export function getThemeController(): ThemeModeController {
  if (!sharedController) {
    sharedController = new ThemeModeController();
  }
  return sharedController;
}

/** 首屏前解析：控制器构造时即读取持久化档位并预挂 data-theme（防闪屏兜底）。 */
export function initThemeModeAtStartup(controller: ThemeModeController = getThemeController()): ThemeMode {
  return controller.getMode();
}

/** React 消费面：当前档位 / 有效主题 / 换档回调（订阅即时切换；system 档
 *  OS 暗色切换经版本戳同样触发重渲，brand-mark 等随 effective 换色）。 */
export function useThemeMode(): { mode: ThemeMode; effective: EffectiveTheme; setMode: (mode: ThemeMode) => void } {
  const controller = getThemeController();
  const version = useSyncExternalStore(
    (cb) => controller.subscribe(cb),
    () => controller.getVersion(),
  );
  void version;
  return {
    mode: controller.getMode(),
    effective: controller.getEffective(),
    setMode: (m) => controller.setMode(m),
  };
}
