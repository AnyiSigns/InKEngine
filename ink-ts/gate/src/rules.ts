/**
 * gate 检查规则（纯函数）：行数上限（例外须标注）/core import 纪律/core 词汇/
 * 源文件 UTF-8 合法性/生成文件禁改。CODING.md 第 7 节为规则与仓库一致关系的
 * 单一事实源。
 */

import type { GateConfig } from './config.js';

export interface Violation {
  path: string;
  rule: 'line-limit' | 'core-import' | 'core-token' | 'src-test' | 'utf8-valid' | 'private-seam' | 'json-valid' | 'layer-dag' | 'test-protection' | 'public-api' | 'no-pending' | 'no-orphan';
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

/** core 区放行的外部裸包白名单（精确匹配，全字比较）：当前为空——
 *  数据面契约随引擎内置生成物入 core/contracts/generated（相对 import
 *  消费），core 不再依赖任何外部包层（无数据契约包）。不放行 @ink-ts/*、
 *  adapters、第三方与 node:（node 仅 coreAllowedNode 白名单例外）。 */
const CORE_ALLOWED_PACKAGES: readonly string[] = [];

/** core 区禁 node:* 与第三方 import（相对 import 允许；类型 import 同规）。
 *  相对 import 命中 forbiddenRel 子串 = 反向依赖下方层（adapters），拒绝；
 *  node: 内置仅 coreAllowedNode 白名单放行（如 async_hooks 镜像 contextvars）；
 *  裸包名一律拒绝（数据面契约已随引擎内置生成物，core 内相对引用）。 */
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

/** 跨域私有模块的例外标注：core 私有模块文件头含此标记即视为共享 seam。 */
export function hasCrossDomainSeamMarker(content: string, marker: string): boolean {
  if (marker === '') return false;
  const head = content.split('\n', 12).join('\n');
  return head.includes(marker);
}

/** JSON 重复键检测（轻量扫描器：只关心对象成员键，跳字符串与转义）。 */
export function findDuplicateJsonKeys(text: string): string[] {
  const duplicates = new Set<string>();
  const seenAtDepth: Array<Set<string> | null> = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') j += 1;
        j += 1;
      }
      const keyEnd = j;
      let k = j + 1;
      while (k < text.length && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n' || text[k] === '\r')) k += 1;
      if (text[k] === ':') {
        const top = seenAtDepth[seenAtDepth.length - 1];
        if (top !== null && top !== undefined) {
          const key = text.slice(i + 1, keyEnd);
          if (top.has(key)) duplicates.add(key);
          top.add(key);
        }
      }
      i = j + 1;
      continue;
    }
    if (c === '{') seenAtDepth.push(new Set<string>());
    else if (c === '[') seenAtDepth.push(null);
    else if (c === '}' || c === ']') seenAtDepth.pop();
    i += 1;
  }
  return [...duplicates];
}

/** JSON 纪律：必须可 parse、无重复键、缩进为 2 空格格线（禁 tab、禁奇数缩进）。 */
export function checkJsonValid(content: string, path: string): Violation | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { path, rule: 'json-valid', message: `JSON parse 失败: ${message}` };
  }
  const duplicates = findDuplicateJsonKeys(content);
  if (duplicates.length > 0) {
    return { path, rule: 'json-valid', message: `JSON 重复键: ${[...new Set(duplicates)].join(', ')}` };
  }
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\t/.test(line)) return { path, rule: 'json-valid', message: `JSON 禁 tab 缩进（统一 2 空格）第 ${index + 1} 行` };
    const m = /^ +/.exec(line);
    if (m !== null && m[0].length % 2 !== 0) {
      return { path, rule: 'json-valid', message: `JSON 缩进非 2 空格格线（第 ${index + 1} 行前导 ${m[0].length} 空格）` };
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { path, rule: 'json-valid', message: 'JSON 顶层须为对象' };
  }
  return null;
}

/** no-pending 禁字检查（CODING §11.1.4 禁待定；§13.6 第 4 条）：
 *  源码/注释命中 `待接线/未来接线/待引擎补全/机制先行` 等字面即违规
 *  （「占位」经治理裁决在产品占位语义下放行，不入默认词表），
 *  按文件聚合（记录命中 token 与行号样例）。 */
export function checkPendingTokens(
  content: string,
  path: string,
  tokens: readonly string[],
): Violation[] {
  if (tokens.length === 0) return [];
  const lines = content.split('\n');
  const hits = new Map<string, number[]>();
  for (let i = 0; i < lines.length; i++) {
    for (const token of tokens) {
      if (token !== '' && lines[i]!.includes(token)) {
        const arr = hits.get(token) ?? [];
        arr.push(i + 1);
        hits.set(token, arr);
      }
    }
  }
  if (hits.size === 0) return [];
  const detail = [...hits.entries()]
    .map(([token, rows]) => `${token}×${rows.length}（L${rows.slice(0, 3).join(', L')}${rows.length > 3 ? ', …' : ''}）`)
    .join('；');
  return [{ path, rule: 'no-pending', message: `禁待定字面命中：${detail}` }];
}

/** public-api 快照逐字比对：不一致即违规（差异摘要 = 缺失/多余符号行）。
 *  两个入参为 dump_api_surface 排序去重后的清单文本（`\n` 分隔）。 */
export function compareApiSurface(snapshot: string, current: string, path = 'engine/api.surface.snapshot'): Violation | null {
  if (snapshot === current) return null;
  const before = new Set(snapshot.split('\n').filter((l) => l !== ''));
  const after = new Set(current.split('\n').filter((l) => l !== ''));
  const missing = [...before].filter((l) => !after.has(l));
  const extra = [...after].filter((l) => !before.has(l));
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`缺失 ${missing.length}：${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ' …' : ''}`);
  if (extra.length > 0) parts.push(`新增 ${extra.length}：${extra.slice(0, 8).join(', ')}${extra.length > 8 ? ' …' : ''}`);
  if (parts.length === 0) parts.push('内容非逐字一致（行序/空白漂移）');
  return { path, rule: 'public-api', message: `公共面快照漂移（导出符号增/删/改名即红）——${parts.join('；')}` };
}

/** test-protection 豁免标注（§13.2.3）：文件头 12 行内 `// gate: test-exempt - 原因`。 */
export function hasTestExemptMark(content: string): boolean {
  const head = content.split('\n', 12).join('\n');
  return /\/\/\s*gate:\s*test-exempt\s*-/.test(head);
}
