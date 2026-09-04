/**
 * checkpoint/事件记录落库前的敏感信息剥离（安全要求：状态永不落 key）。
 * 继承 `_strip_api_key_from_checkpoint` 语义为引擎层默认：任何写入存储的
 * 快照/记录在序列化前递归剔除敏感键（api_key/token/secret/authorization 等），
 * 凭据只存在于运行期内存态，进程崩溃/异常快照也不会残留密钥。
 *
 * 判定顺序（fail-closed 优先，见 is_sensitive_key）：
 * - 精确集合命中（含常见驼峰凭据键的小写形态）→ 恒敏感；
 * - 分隔符后缀命中（openai_api_key/client_secret/auth_token 等）→ 恒敏感；
 * - 末组件判定：_ / - / . 分隔的末组件为凭据词（auth-token/my.secret 等，
 *   须存在分隔符——裸 key 是中断键/记录主键等业务通用形态，不视为凭据）；
 * - 驼峰拼接判定：原键存在小写→大写边界且词尾为凭据词（clientSecret/
 *   masterToken 等；monkey/keyboard 无驼峰边界不命中）。极少见的全小写
 *   无分隔拼接形态不再命中——精确集合已覆盖常见形态，此类键应显式入集合。
 *
 * 剥离是纯函数（不改原结构）：dict 按键剔除——敏感键置空保留（下游
 * .get("api_key") 恒返回空串，防残留密钥）；PatchChain 是引擎主内容通道
 * （内容工作区），其 base 与每条补丁 value 同样递归剥离，否则序列化会让
 * 敏感键经 PatchChain 绕过（返回新链，原链不变）；list 逐项递归。
 * copy-on-write：子树不含敏感键时返回原对象，checkpoint/事件热路径零拷贝。
 *
 * TS 形态差异：Python 的 tuple/frozenset/set 在 TS 域以只读数组/Set 表达；
 * frozenset 无运行时不可变形态，frozenset 与 set 分支合一为 Set——输入输出
 * 同型、恒等零拷贝语义保持。驼峰边界以等价 lookbehind 正则表达。本模块
 * 纯确定性，无时间/随机依赖，无需 seam 注入。
 */

import { isRecord } from '../json.js';
import type { Json } from '../json.js';
import { PatchChain } from '../patch/patchChain.js';
import type { Patch } from '../patch/types.js';

// 敏感键（大小写不敏感匹配）：出现即从持久化数据中整体移除。
// 含常见驼峰凭据键的小写形态（clientSecret/openAiKey/authToken 等）——
// 精确集合命中优先，无需依赖后缀启发式。
export const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'api_key',
  'apikey',
  'api-key',
  'token',
  'secret',
  'authorization',
  'password',
  'access_token',
  'refresh_token',
  'clientsecret',
  'openaikey',
  'authtoken',
  'accesstoken',
  'refreshtoken',
  'privatekey',
  'secretkey',
]);

// 常见凭据键后缀（openai_api_key/client_secret/auth_token 等前后缀形态，
// 精确匹配覆盖不到；分隔符后缀命中基本即凭据，误伤面小）。
const SENSITIVE_SUFFIXES: readonly string[] = [
  '_key',
  '_token',
  '_secret',
  '_password',
  '_keys',
  '_tokens',
  '_secrets',
  '_passwords',
  '_credentials',
];

// 凭据词末组件集合（组件化判定：仅当键名的「末组件」为凭据词时才命中）。
// 与后缀启发式的区别：monkey/keyboard/turkey 等以 key 结尾的普通英文词
// 末组件不是独立凭据词，不再被误伤（词尾启发式过宽修复）。
const CREDENTIAL_WORDS: ReadonlySet<string> = new Set([
  'key',
  'keys',
  'token',
  'tokens',
  'secret',
  'secrets',
  'password',
  'passwords',
  'credential',
  'credentials',
]);

// 组件分隔符（_ / - / . 任一分隔后末组件为凭据词 → 敏感）
const COMPONENT_SEPARATORS: readonly string[] = ['_', '-', '.'];

// 驼峰边界（clientSecret/openAiKey/authToken 等拼接形态的判定依据：
// 原键存在小写→大写边界 + 词尾为凭据词 → 敏感——camelCase 标识符是代码
// 产物形态，出现以 key/token/secret 结尾的驼峰词基本即凭据）
const CAMEL_BOUNDARY_RE = /(?<=[a-z])(?=[A-Z])/;

/**
 * 判定键名是否携带凭据语义（精确集合 + 后缀 + 组件化词尾判定）。
 * 词尾为任一凭据词即命中；大小写不敏感（先 lower 化再做集合/后缀/末组件
 * 判定，驼峰边界须用原键——lower 化后边界信息丢失）。
 */
export function is_sensitive_key(key: unknown): boolean {
  const original = String(key);
  const k = original.toLowerCase();
  if (SENSITIVE_KEYS.has(k)) return true;
  for (const suffix of SENSITIVE_SUFFIXES) {
    if (k.endsWith(suffix)) return true;
  }
  // 末组件判定（须有分隔符：末组件完整词才命中，token_count 等指标键末组件
  // 为 count 不误伤；secret_note 末组件 note 不误伤；裸 key 无分隔符不命中）
  let last_sep = -1;
  for (const sep of COMPONENT_SEPARATORS) {
    const idx = k.lastIndexOf(sep);
    if (idx > last_sep) last_sep = idx;
  }
  if (last_sep > 0 && last_sep < k.length - 1) {
    if (CREDENTIAL_WORDS.has(k.slice(last_sep + 1))) return true;
  }
  // 驼峰拼接形态（原键判边界：monkey/keyboard 无边界不命中）
  if (CAMEL_BOUNDARY_RE.test(original)) {
    for (const word of CREDENTIAL_WORDS) {
      if (k.endsWith(word)) return true;
    }
  }
  return false;
}

/**
 * 递归剥离单值的内部实现（unknown 域；对外出口 strip_sensitive 以泛型
 * 保留调用侧类型）。容器判定顺序与 Python 对齐：PatchChain → Set → 数组 →
 * 普通记录，其余原样返回。
 */
function stripSensitiveUnknown(value: unknown): unknown {
  if (value instanceof PatchChain) return stripPatchChain(value);
  if (value instanceof Set) {
    let changed = false;
    const out = new Set<unknown>();
    for (const item of value) {
      const stripped = stripSensitiveUnknown(item);
      if (stripped !== item) changed = true;
      out.add(stripped);
    }
    return changed ? out : value;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    let changed = false;
    for (const item of value) {
      const stripped = stripSensitiveUnknown(item);
      if (stripped !== item) changed = true;
      out.push(stripped);
    }
    return changed ? out : value;
  }
  if (isRecord(value)) {
    return stripDict(value);
  }
  return value;
}

// copy-on-write：子树无敏感键时返回原对象（checkpoint/事件热路径零拷贝）
function stripDict(data: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (is_sensitive_key(key)) {
      // 置空保留：键结构不破坏，下游 .get("api_key") 恒返回空串，防残留密钥
      result[key] = '';
      changed = true;
      continue;
    }
    const stripped = stripSensitiveUnknown(value);
    if (stripped !== value) changed = true;
    result[key] = stripped;
  }
  return changed ? result : data;
}

// PatchChain 是引擎主内容通道：base 按 dict 语义剥离，每条补丁 value 递归
// 剥离。剥离是纯函数（不改原结构，PatchChain 返回新链）。
function stripPatchChain(chain: PatchChain): PatchChain {
  const base = stripDict(chain.base) as {
    [key: string]: Json;
  };
  const patches: Patch[] = chain.patches.map((p) => ({
    op: p.op,
    path: p.path,
    value: (p.value === undefined ? undefined : stripSensitiveUnknown(p.value)) as
      | Json
      | undefined,
  }));
  return new PatchChain(base, patches);
}

/**
 * 递归剥离敏感键（dict 按键剔除；list/Set 逐项递归；其余原样返回）。
 * 纯函数：不改原结构，copy-on-write——子树不含敏感键时返回原对象。
 */
export function strip_sensitive<T>(value: T): T {
  return stripSensitiveUnknown(value) as T;
}
