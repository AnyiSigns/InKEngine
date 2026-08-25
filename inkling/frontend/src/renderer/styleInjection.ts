/**
 * 用户样式注入（显示层开放的第二道开放面）。
 *
 * 白名单通道 = 既有 --ink-* CSS 变量体系：用户样式文件经产物补丁链注入时，
 * 仅允许声明 --ink-* 自定义属性，且取值不含 url()/expression()/尖括号/花括号/
 * at-rule 等危险片段；其余任何选择器、其它属性、越界声明一律拒绝（整段不注入，
 * fail-closed），防 CSS 注入扩散到布局/其它组件。
 */

const INK_PREFIX = '--ink-';

const PROP_RE = new RegExp('^\\s*(' + INK_PREFIX + '[a-z0-9-]+)\\s*:\\s*(.+?)\\s*$', 'i');
const UNSAFE_FRAGMENT = /url\(|expression\(|<|>|;|}|@/i;

export interface InjectResult {
  ok: boolean;
  /** 拒绝原因（ok=false 时存在） */
  reason?: string;
  /** 通过校验的净化样式文本（ok=true 时存在） */
  sanitized?: string;
}

/**
 * 净化用户样式（fail-closed）：拆条校验，逐条须为 --ink-* 声明且取值安全；
 * 任一越界 → 整段拒绝（不返回部分净化结果）。
 */
export function sanitizeUserStyle(css: string): InjectResult {
  const parts = css.split(';');
  const out: string[] = [];
  for (const part of parts) {
    const text = part.trim();
    if (text === '') continue;
    const match = text.match(PROP_RE);
    if (!match) {
      return { ok: false, reason: `越界样式声明被拒绝：${text}` };
    }
    const value = match[2].trim();
    if (UNSAFE_FRAGMENT.test(value)) {
      return { ok: false, reason: `样式值含危险片段被拒绝：${value}` };
    }
    out.push(`${match[1]}: ${value};`);
  }
  if (out.length === 0) {
    return { ok: false, reason: '无白名单样式声明' };
  }
  return { ok: true, sanitized: out.join(' ') };
}

/**
 * 注入用户样式：净化通过后建 style 元素挂载 :root；同时把变量同步到 target
 * （默认 document.documentElement）便于断言与即时生效。整段未通过校验则不注入。
 */
export function injectUserStyle(css: string, target: HTMLElement = document.documentElement): InjectResult {
  const result = sanitizeUserStyle(css);
  if (!result.ok || !result.sanitized) return result;
  const style = document.createElement('style');
  style.setAttribute('data-ink-user-style', '');
  style.textContent = `:root{${result.sanitized}}`;
  document.head.appendChild(style);
  for (const decl of result.sanitized.split(';')) {
    const part = decl.trim();
    if (part === '') continue;
    const match = part.match(PROP_RE);
    if (match) target.style.setProperty(match[1], match[2].trim());
  }
  return { ok: true, sanitized: result.sanitized };
}
