/**
 * i18n 骨架（显示层开放的第三道开放面）。
 *
 * 文案表数据化：zh / en 各一张 JSON 表，新增语种 = 新增一张表，不改渲染逻辑；
 * useT 订阅语言切换即时刷新文案。语言偏好经可注入存储持久化（默认
 * localStorage，测试注入内存实现），设置面板经 setLang 写入。
 *
 * 骨架先行：仅提供表 + hook + 切换，不全量替换既有中文文案。
 */

import { useSyncExternalStore } from 'react';

import en from '@/locales/en.json';
import zh from '@/locales/zh.json';

export type Locale = 'zh' | 'en';

const TABLES: Record<Locale, Record<string, string>> = { zh, en };

const STORAGE_KEY = 'inkling.lang';

export interface LangPersist {
  read(): Locale | null;
  write(lang: Locale): void;
}

export function isLocale(value: unknown): value is Locale {
  return value === 'zh' || value === 'en';
}

export function createLocalStorageLangPersist(
  storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void } | null,
): LangPersist {
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  return {
    read(): Locale | null {
      if (!store) return null;
      try {
        const value = store.getItem(STORAGE_KEY);
        return isLocale(value) ? value : null;
      } catch {
        return null;
      }
    },
    write(lang: Locale): void {
      if (!store) return;
      try {
        store.setItem(STORAGE_KEY, lang);
      } catch {
        // 存储不可用（隐私模式等）时静默降级为不持久，不抛
      }
    },
  };
}

export function createMemoryLangPersist(initial: Locale = 'zh'): LangPersist & { current(): Locale } {
  let value: Locale = initial;
  return {
    current: () => value,
    read: () => value,
    write: (lang) => {
      value = lang;
    },
  };
}

let persist: LangPersist = createLocalStorageLangPersist();
let current: Locale = persist.read() ?? 'zh';
const listeners = new Set<() => void>();

function setLocaleInternal(lang: Locale): void {
  if (lang === current) return;
  current = lang;
  persist.write(lang);
  for (const listener of listeners) listener();
}

/** 注入存储实现（测试用）。 */
export function setLangPersist(next: LangPersist): void {
  persist = next;
  current = next.read() ?? 'zh';
  for (const listener of listeners) listener();
}

/** 当前语言。 */
export function getLocale(): Locale {
  return current;
}

/** 切换语言。 */
export function setLocale(lang: Locale): void {
  setLocaleInternal(lang);
}

/** 查表翻译：当前语种优先，缺译回退中文，再缺回退键名。 */
export function translate(lang: Locale, key: string): string {
  return TABLES[lang][key] ?? TABLES.zh[key] ?? key;
}

/** React 消费面：t(key) + 当前语言 + 切换回调（订阅即时刷新）。 */
export function useT(): { t: (key: string) => string; lang: Locale; setLang: (lang: Locale) => void } {
  const lang = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
  return {
    t: (key: string) => translate(lang, key),
    lang,
    setLang: setLocaleInternal,
  };
}
