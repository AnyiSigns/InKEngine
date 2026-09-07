/**
 * 主题 token 白名单（渲染器三层防线之一）与 CSS 变量应用。
 *
 * 白名单语义 token（分三组）：
 * - 基底组：bg.base 底色 / text.base 字色 / accent.approval 朱砂
 *   （accent 语义槽只出现在审批/决策点）；
 * - 透明组（alpha ≤ 0.5）：status.bubble.fill 状态气泡底、
 *   status.bubble.edge 状态气泡描边、status.card.edge 状态卡片细描边——
 *   状态层一律走半透明 token，正文消息则完全实底不透明；
 * - 派生组：其余 --ink-* 均由以上 token 经 color-mix 派生，不直写颜色。
 *
 * ui_spec.theme 中未声明的 token 拒绝应用（渲染侧不落地）；token 值随
 * PatchKind.THEME 演化/皮肤试穿换色（白名单内），审批卡跟随主题。
 * 透明组值必须满足 alpha ≤ 0.5 的上限（浏览器侧由语义类保证叠加后
 * 不超过半透明；白名单只约束可用槽位）。
 */

export const THEME_TOKEN_WHITELIST = [
  'bg.base',
  'text.base',
  'accent.approval',
  'status.bubble.fill',
  'status.bubble.edge',
  'status.card.edge',
] as const;

export type ThemeTokenName = (typeof THEME_TOKEN_WHITELIST)[number];

/** 出厂默认值（ui_spec 无 theme 或 token 缺失时的基线）。 */
export const THEME_TOKEN_DEFAULTS: Record<ThemeTokenName, string> = {
  'bg.base': '#09090b',
  'text.base': '#e5e6e8',
  'accent.approval': '#f59e0b',
  'status.bubble.fill': 'color-mix(in srgb, var(--ink-text-base) 18%, transparent)',
  'status.bubble.edge': 'color-mix(in srgb, var(--ink-text-base) 30%, transparent)',
  'status.card.edge': 'color-mix(in srgb, var(--ink-text-base) 22%, transparent)',
};

/** 白名单 token → CSS 变量名映射（唯一注入点）。 */
const TOKEN_TO_VARIABLE: Record<ThemeTokenName, string> = {
  'bg.base': '--ink-bg-base',
  'text.base': '--ink-text-base',
  'accent.approval': '--ink-accent-approval',
  'status.bubble.fill': '--ink-status-bubble-fill',
  'status.bubble.edge': '--ink-status-bubble-edge',
  'status.card.edge': '--ink-status-card-edge',
};

/** 透明组 token（状态层专用；alpha 上限 ≤ 0.5 由默认值与语义类共同约束）。 */
export const ALPHA_TOKEN_GROUP = [
  'status.bubble.fill',
  'status.bubble.edge',
  'status.card.edge',
] as const satisfies readonly ThemeTokenName[];

/**
 * 应用主题：仅白名单 token 落地为 CSS 变量；未声明 token 拒绝并记录。
 * 返回还原函数（卸载时清理）。
 */
export function applyThemeTokens(theme: Record<string, string> | undefined): () => void {
  const root = document.documentElement;
  const applied: string[] = [];
  if (theme) {
    for (const [key, value] of Object.entries(theme)) {
      const variable = TOKEN_TO_VARIABLE[key as ThemeTokenName];
      if (!variable) {
        // 白名单外 token：拒绝落地（防注入/防样式漂移）
        continue;
      }
      root.style.setProperty(variable, value);
      applied.push(variable);
    }
  }
  return () => {
    for (const variable of applied) root.style.removeProperty(variable);
  };
}

/** 白名单外 token 清单（测试与「外观」面板的拒绝提示用）。 */
export function rejectedThemeTokens(theme: Record<string, string> | undefined): string[] {
  if (!theme) return [];
  return Object.keys(theme).filter((key) => !TOKEN_TO_VARIABLE[key as ThemeTokenName]);
}

/** 指定 token 对应的 CSS 变量名（测试/诊断用）。 */
export function tokenVariableOf(token: ThemeTokenName): string {
  return TOKEN_TO_VARIABLE[token];
}
