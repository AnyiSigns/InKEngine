/**
 * 主题 token 白名单（渲染器三层防线之一）与 CSS 变量应用。
 *
 * 白名单语义 token（PLAN §5.2 定稿）：
 * - bg.base 深墨底（出厂默认 #09090b）
 * - text.base 纸白字（出厂默认 #e4e4e7）
 * - accent.approval 审批卡朱砂（出厂默认 #f59e0b；accent 语义槽只出现在审批/决策点）
 *
 * ui_spec.theme 中未声明的 token 拒绝应用（渲染侧不落地）；token 值随
 * PatchKind.THEME 演化/皮肤试穿换色（白名单内），审批卡跟随主题。
 */

export const THEME_TOKEN_WHITELIST = ['bg.base', 'text.base', 'accent.approval'] as const;

export type ThemeTokenName = (typeof THEME_TOKEN_WHITELIST)[number];

/** 出厂默认值（ui_spec 无 theme 或 token 缺失时的基线）。 */
export const THEME_TOKEN_DEFAULTS: Record<ThemeTokenName, string> = {
  'bg.base': '#09090b',
  'text.base': '#e4e4e7',
  'accent.approval': '#f59e0b',
};

/** 白名单 token → CSS 变量名映射（唯一注入点）。 */
const TOKEN_TO_VARIABLE: Record<ThemeTokenName, string> = {
  'bg.base': '--ink-bg-base',
  'text.base': '--ink-text-base',
  'accent.approval': '--ink-accent-approval',
};

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
