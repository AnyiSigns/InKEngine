/**
 * gate 检查规则（纯函数）：行数上限（例外须标注）/core import 纪律/core 词汇/
 * 源文件 UTF-8 合法性/生成文件禁改。CODING.md 第 7 节为规则与仓库一致关系的
 * 单一事实源。
 */

import type { GateConfig } from './config.js';

export interface Violation {
  path: string;
  rule: 'line-limit' | 'core-import' | 'core-token' | 'src-test' | 'utf8-valid';
  message: string;
}

/** 超限例外标注（CODING.md §2.2）：文件头 12 行内的 `// gate: 超限(<N> 行) - 原因`。 */
export function hasLineLimitException(content: string): boolean {
  const head = content.split('\n', 12).join('\n');
  return /gate:\s*(超限\(\s*\d+\s*行\)|over\s*-?\s*limit)/i.test(head);
}

export function checkLineLimit(content: string, path: string, maxLines: number): Violation | null {
  const lines = content.split('\n').length;
  if (lines <= maxLines) return null;
  if (hasLineLimitException(content)) return null;
  return {
    path,
    rule: 'line-limit',
    message: `${lines} 行超过上限 ${maxLines}，且无超限标注（超限例外须文件头注释 // gate: 超限(<N> 行) - 原因）`,
  };
}

/** 源文件字节须为合法 UTF-8：content 为按替换字符解码后的文本，出现 U+FFFD
 *  即原字节含非法 UTF-8 序列（合法文件整文件 UTF-8 往返一致，无替换）。 */
export function checkUtf8Valid(content: string, path: string): Violation | null {
  if (!content.includes('\uFFFD')) return null;
  return {
    path,
    rule: 'utf8-valid',
    message: '源文件含非法 UTF-8 字节（整文件须为合法 UTF-8 编码，中文注释/文案不得转码为其他编码）',
  };
}

const IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g;

/** core 区放行的外部包白名单（精确匹配，全字比较）：仅数据契约层
 *  @ink-ts/contracts ——CODING §1 ``engine → contracts`` 依赖方向的实现点
 *  （L0/L1 数据面 schema/fixture/generated 真源，core 零 IO 纯数据）。
 *  不放行其它 @ink-ts/*（自引用/adapters）、第三方与 node:。 */
const CORE_ALLOWED_PACKAGES: readonly string[] = ['@ink-ts/contracts'];

/** core 区禁 node:* 与第三方 import（相对 import 允许；类型 import 同规）。
 *  相对 import 命中 forbiddenRel 子串 = 反向依赖下方层（adapters），拒绝；
 *  node: 内置仅 coreAllowedNode 白名单放行（如 async_hooks 镜像 contextvars）；
 *  裸包名仅 CORE_ALLOWED_PACKAGES 精确放行（数据契约层）。 */
export function checkCoreImports(
  content: string,
  path: string,
  forbiddenRel: readonly string[] = [],
  coreAllowedNode: readonly string[] = [],
): Violation[] {
  const out: Violation[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(IMPORT_RE)) {
    const specifier = (match[1] ?? match[2]) as string;
    if (seen.has(specifier)) continue;
    seen.add(specifier);
    if (specifier.startsWith('.') || specifier.startsWith('#')) {
      if (forbiddenRel.some((sub) => specifier.includes(sub))) {
        out.push({
          path,
          rule: 'core-import',
          message: `core 禁反向依赖下方层（adapters）import: ${specifier}`,
        });
      }
      continue;
    }
    if (CORE_ALLOWED_PACKAGES.includes(specifier)) continue;
    if (specifier.startsWith('node:')) {
      if (coreAllowedNode.includes(specifier)) continue;
      out.push({
        path,
        rule: 'core-import',
        message: `core 禁 node 内置模块 import: ${specifier}`,
      });
      continue;
    }
    out.push({
      path,
      rule: 'core-import',
      message: `core 禁第三方/外部 import: ${specifier}`,
    });
  }
  return out;
}

/** core 区禁宿主/框架词（词边界，大小写不敏感；不透明协议串内出现除外）。 */
export function checkCoreTokens(
  content: string,
  path: string,
  words: readonly string[],
  opaqueTokens: readonly string[] = [],
): Violation[] {
  if (words.length === 0) return [];
  const re = new RegExp(`\\b(${words.join('|')})\\b`, 'gi');
  const out: Violation[] = [];
  for (const match of content.matchAll(re)) {
    const index = match.index ?? 0;
    if (opaqueTokens.some((token) => isInsideOpaqueToken(content, index, match[0].length, token))) continue;
    out.push({ path, rule: 'core-token', message: `core 禁宿主/框架词: ${match[0]}` });
  }
  return out;
}

/** 词命中是否落在某个不透明协议串出现处（协议串大小写不敏感整段匹配）。 */
function isInsideOpaqueToken(content: string, start: number, len: number, token: string): boolean {
  const lower = content.toLowerCase();
  const word = lower.slice(start, start + len);
  const t = token.toLowerCase();
  if (!t.includes(word)) return false;
  let from = 0;
  for (;;) {
    const p = lower.indexOf(t, from);
    if (p < 0) return false;
    if (p <= start && start + len <= p + t.length) return true;
    from = p + t.length;
  }
}
