/**
 * 设计 token 全集（单一事实源）：间距 / 圆角 / 阴影 / 动效 / 字号 / 层级。
 *
 * 数值纪律：视觉值一律经本表取用，禁止内联魔法数字；颜色与透明度
 * 一律经 themeTokens + CSS 变量取用（本表不含颜色值，仅几何/节奏/层级）。
 *
 * 间距走 8pt 栅格（Tailwind 默认 spacing 同源：1/2/3/4/6/8 = 4/8/12/16/24/32）；
 * 圆角 4/8/12 三档；阴影 0/1/2 三级；动效 150–250ms 以 ease-out 为主，
 * 进入动效统一 180ms；字号 12/13/15/17/20 的紧凑正文轴，行高 1.6。
 *
 * 层级（z-index）策略规约：正文 < 底栏 < 卡片 < 悬浮窗——底栏粘性层
 * 只压在正文上，卡片弹层压过底栏，悬浮窗（可拖拽/可编辑的复杂多步
 * 交互容器）置于最顶，且全部经 CSS 变量取用，组件不得直写 z 数值。
 */

export const SPACE_SCALE = [4, 8, 12, 16, 24, 32] as const;
export type SpaceToken = (typeof SPACE_SCALE)[number];

export const RADIUS_SCALE = [4, 8, 12] as const;
export type RadiusToken = (typeof RADIUS_SCALE)[number];

export const RADIUS_VARIANTS: Record<RadiusToken, string> = {
  4: 'var(--ink-radius-sm)',
  8: 'var(--ink-radius-md)',
  12: 'var(--ink-radius-lg)',
};

export const SHADOW_LEVELS = [0, 1, 2] as const;
export type ShadowToken = (typeof SHADOW_LEVELS)[number];

export const SHADOW_VARIANTS: Record<ShadowToken, string> = {
  0: 'none',
  1: 'var(--ink-shadow-soft)',
  2: 'var(--ink-shadow-pop)',
};

/** 动效节奏：快速反馈 150ms / 标准 180ms / 舒缓 250ms，统一 ease-out。 */
export const MOTION = {
  fastMs: 150,
  baseMs: 180,
  slowMs: 250,
  easing: 'ease-out',
} as const;

export const TYPE_SCALE = [12, 13, 15, 17, 20] as const;
export type TypeToken = (typeof TYPE_SCALE)[number];

export const TYPE_VARIANTS: Record<TypeToken, string> = {
  12: 'var(--ink-font-xs)',
  13: 'var(--ink-font-sm)',
  15: 'var(--ink-font-md)',
  17: 'var(--ink-font-lg)',
  20: 'var(--ink-font-xl)',
};

/** 正文默认行高。 */
export const LINE_HEIGHT_BODY = 1.6;

/**
 * 层级策略（递增 = 越靠上层；组件经 .ink-z-* 语义类取用，禁直写数值）：
 * 底栏（粘性操作条）压在正文之上；卡片（居中弹层/审批卡）压过底栏；
 * 悬浮窗（拖拽/可缩放的多步交互容器）置于最顶。
 */
export const Z_INDEX = {
  base: 0,
  bar: 10,
  card: 30,
  floater: 40,
} as const;

export type ZLevel = keyof typeof Z_INDEX;

export const Z_VARIANTS: Record<ZLevel, string> = {
  base: 'var(--ink-z-base)',
  bar: 'var(--ink-z-bar)',
  card: 'var(--ink-z-card)',
  floater: 'var(--ink-z-floater)',
};
