/**
 * 结构 token 白名单（渲染器显示层开放的第一道开放面）。
 *
 * 与主题 token 白名单（themeTokens.ts）并列、互不混用：
 * - 主题 token 白名单只承载颜色语义（基底/字色/朱砂 + 半透明状态层），
 *   颜色值经 color-mix / alpha 合成落地；
 * - 结构 token 白名单只承载几何与节奏语义（间距 / 圆角 / 阴影 / 字号 /
 *   层级 / 动效），取值域为设计尺度（数值范围）或枚举档位，绝不承载颜色。
 *
 * 取值域校验（fail-closed）：token 名不在白名单、或取值不在该域允许集，
 * 一律拒绝落地（applyStructureTokens 只写通过校验的条目，返回还原函数）。
 * 结构 token 各自映射到 --ink-* CSS 变量（设计尺度单一事实源的派生注入点）。
 */

import {
  MOTION,
  RADIUS_SCALE,
  SHADOW_LEVELS,
  SHADOW_VARIANTS,
  SPACE_SCALE,
  TYPE_SCALE,
  Z_INDEX,
  type ZLevel,
} from './designTokens';
import { THEME_TOKEN_WHITELIST, type ThemeTokenName } from './themeTokens';

export type StructureDomain = 'space' | 'radius' | 'shadow' | 'type' | 'z' | 'motion';

export interface StructureTokenDef {
  /** 白名单 token 名（如 space.8 / z.floater） */
  name: string;
  domain: StructureDomain;
  /** 取值域：允许的原始取值（字符串形态，便于表单输入） */
  allowed: readonly string[];
  /** 映射到的 CSS 变量名（--ink-*） */
  variable: string;
  /** 通过校验后写入 CSS 变量的实际值 */
  toCss: (raw: string) => string;
}

const MOTION_MS: Record<'fast' | 'base' | 'slow', number> = {
  fast: MOTION.fastMs,
  base: MOTION.baseMs,
  slow: MOTION.slowMs,
};

function buildDefs(): StructureTokenDef[] {
  const defs: StructureTokenDef[] = [];

  for (const v of SPACE_SCALE) {
    defs.push({
      name: `space.${v}`,
      domain: 'space',
      allowed: [`${v}`],
      variable: `--ink-space-${v}`,
      toCss: (raw) => `${Number(raw)}px`,
    });
  }

  for (const v of RADIUS_SCALE) {
    defs.push({
      name: `radius.${v}`,
      domain: 'radius',
      allowed: [`${v}`],
      variable: `--ink-radius-${v}`,
      toCss: (raw) => `${Number(raw)}px`,
    });
  }

  for (const v of SHADOW_LEVELS) {
    defs.push({
      name: `shadow.${v}`,
      domain: 'shadow',
      allowed: [`${v}`],
      variable: `--ink-shadow-${v}`,
      toCss: () => SHADOW_VARIANTS[v],
    });
  }

  for (const v of TYPE_SCALE) {
    defs.push({
      name: `type.${v}`,
      domain: 'type',
      allowed: [`${v}`],
      variable: `--ink-type-${v}`,
      toCss: (raw) => `${Number(raw)}px`,
    });
  }

  const zLevels = Object.keys(Z_INDEX) as ZLevel[];
  for (const level of zLevels) {
    defs.push({
      name: `z.${level}`,
      domain: 'z',
      allowed: [level],
      variable: `--ink-z-${level}`,
      toCss: () => `${Z_INDEX[level]}`,
    });
  }

  const motionKeys = ['fast', 'base', 'slow'] as const;
  for (const k of motionKeys) {
    defs.push({
      name: `motion.${k}`,
      domain: 'motion',
      allowed: [k],
      variable: `--ink-motion-${k}`,
      toCss: () => `${MOTION_MS[k]}ms`,
    });
  }

  return defs;
}

export const STRUCTURE_TOKEN_DEFS = buildDefs();

export const STRUCTURE_TOKEN_WHITELIST = STRUCTURE_TOKEN_DEFS.map((d) => d.name) as readonly string[];

const STRUCTURE_TOKEN_SET = new Set(STRUCTURE_TOKEN_WHITELIST);

const DEF_BY_NAME = new Map(STRUCTURE_TOKEN_DEFS.map((d) => [d.name, d]));

const COLOR_TOKEN_SET = new Set<string>(THEME_TOKEN_WHITELIST as readonly string[]);

/** token 归属的表：color = 主题色表，structure = 结构表，null = 两表外。 */
export function tokenTableOf(name: string): 'color' | 'structure' | null {
  if (COLOR_TOKEN_SET.has(name)) return 'color';
  if (STRUCTURE_TOKEN_SET.has(name)) return 'structure';
  return null;
}

/** 是否结构 token 白名单成员。 */
export function isStructureToken(name: string): boolean {
  return STRUCTURE_TOKEN_SET.has(name);
}

/** 结构 token → CSS 变量名（测试/诊断用）。 */
export function structureTokenVariable(name: string): string | null {
  return DEF_BY_NAME.get(name)?.variable ?? null;
}

/**
 * 校验单条结构 token（fail-closed）：
 * - token 名不在白名单 → 拒绝；
 * - 取值不在该域允许集（数值范围/枚举档位）→ 拒绝；
 * 任一不通过均返回 false，渲染侧不落地。
 */
export function validateStructureToken(name: string, raw: string | number): boolean {
  const def = DEF_BY_NAME.get(name);
  if (!def) return false;
  const rawStr = String(raw);
  return def.allowed.includes(rawStr);
}

/**
 * 应用结构 token：仅通过校验的条目落地为 CSS 变量；未声明/越界 token
 * 拒绝并记录（防注入/防样式漂移）。返回还原函数（卸载时清理）。
 */
export function applyStructureTokens(tokens: Record<string, string | number> | undefined): () => void {
  const root = document.documentElement;
  const applied: string[] = [];
  if (tokens) {
    for (const [name, value] of Object.entries(tokens)) {
      const def = DEF_BY_NAME.get(name);
      if (!def) continue;
      if (!def.allowed.includes(String(value))) continue;
      root.style.setProperty(def.variable, def.toCss(String(value)));
      applied.push(def.variable);
    }
  }
  return () => {
    for (const variable of applied) root.style.removeProperty(variable);
  };
}

/** 白名单外 / 越界的结构 token 清单（测试与「外观」面板拒绝提示用）。 */
export function rejectedStructureTokens(tokens: Record<string, string | number> | undefined): string[] {
  if (!tokens) return [];
  return Object.keys(tokens).filter((name) => {
    const def = DEF_BY_NAME.get(name);
    if (!def) return true;
    return !def.allowed.includes(String(tokens[name]));
  });
}

/** 是否为主题色 token（与结构表并列判定用）。 */
export function isThemeColorToken(name: string): name is ThemeTokenName {
  return COLOR_TOKEN_SET.has(name);
}
