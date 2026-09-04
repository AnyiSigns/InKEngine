/**
 * 指令注入检测段（knowledge_gate.py L1 安全扫描面移植）。
 *
 * web 蒸馏是注入主要入口：规则文本是声明数据，L1 安全扫描须区分「内容」
 * 与「指令」——检出指令型措辞即拒绝（恶意网页内容学进规则集会让规则本身
 * 成为注入载体）。关键词命中（中英文指令句式、全角/空格混淆变体经归一化
 * 同样可命中）+ 混淆熵启发（ENG1-21，补 base64/编码形态覆盖）。本文件另
 * 含扫描面提取工具（字符串值/键名，跳过 provenance 元数据子树），供闸门
 * 将知识条目可读文本面拼合成注入扫描输入。
 */

import { isRecord } from '../json.js';

/** 归一化长度阈值：编码块最小有意义长度（短路径/短语不触发熵启发）。 */
const _ENTROPY_MIN_CHARS = 24;

/** 符号占比上限：纯符号噪声不判（base64 自带 +/= 填充，占比天然低）。 */
const _SYMBOL_RATIO_CAP = 0.5;

/**
 * L1 安全扫描的指令型措辞命中模式（声明数据中禁止出现的「指令」句式）。
 *
 * 中英文指令句式均收录（英文是 web 来源注入的主要形态，不可漏）；匹配前
 * 做归一化（全角转半角、去空白、小写），空格/全角混淆变体同样可命中。
 */
export const _INJECTION_PATTERNS: readonly string[] = [
  // 中文指令型措辞
  '忽略上文',
  '忽略之前',
  '忽略上面的所有指令',
  '无视之前',
  '忘记所有',
  '你是助手',
  '你现在是',
  '重新定义你',
  '覆盖你的',
  '系统指令',
  '输出格式覆盖',
  '不要遵守',
  '绕过',
  // 英文指令型措辞（web 来源注入的主要形态）
  'ignore all previous instructions',
  'ignore previous instructions',
  'ignore above',
  'disregard',
  'forget all previous',
  'you are now',
  'from now on',
  'system prompt',
  'system instruction',
  'override your',
  'jailbreak',
  'do not follow',
  'new instructions',
  'print your',
  'reveal your',
];

/** Python str.isspace 语义的字符级判定（含全角空格/行与段落分隔符，
 *  不含 BOM——与 Python 的空白定义逐点对齐）。 */
function _is_space_char(ch: string): boolean {
  const code = ch.codePointAt(0)!;
  return (
    (code >= 0x09 && code <= 0x0d) || // \t \n \v \f \r
    (code >= 0x1c && code <= 0x20) || // 信息分隔符 + 空格
    code === 0x85 || // NEL
    code === 0xa0 || // 不换行空格
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 // 全角空格
  );
}

/** 注入检测归一化：全角转半角 + 去空白 + 小写（防混淆变体绕过）。 */
export function _normalize_injection_text(text: string): string {
  let out = '';
  for (const ch of text.toLowerCase()) {
    const code = ch.codePointAt(0)!;
    let mapped = ch;
    if (code === 0x3000) {
      mapped = ' ';
    } else if (code >= 0xff01 && code <= 0xff5e) {
      mapped = String.fromCodePoint(code - 0xfee0);
    }
    if (!_is_space_char(mapped)) {
      out += mapped;
    }
  }
  return out;
}

/**
 * 混淆熵启发信号：疑似 base64/编码混淆块的指纹（ENG1-21）。
 *
 * 静态关键词对 base64/编码形态覆盖有限，熵启发作为补充判据。判据保守
 * 设计（压低自然文本/路径误伤）：归一化长度 ≥ 24；原文同时含大写/小写
 * 字母与数字（大小写是编码形态指纹，归一化小写化会抹掉该信号，必须在
 * 原文上判定）；符号占比 ≤ 0.5（纯符号噪声不判）。该信号只做「疑似」
 * 标记，随命中清单返回（调用方按 L1 拒绝语义处理，与关键词命中同权）。
 */
export function _obfuscation_entropy_hits(text: string): readonly string[] {
  const normalized = _normalize_injection_text(text);
  const points = [...normalized];
  if (points.length < _ENTROPY_MIN_CHARS) {
    return [];
  }
  const hasUpper = /\p{Lu}/u.test(text);
  const hasLower = /\p{Ll}/u.test(text);
  const hasDigit = /\p{Nd}/u.test(text);
  if (!(hasUpper && hasLower && hasDigit)) {
    return [];
  }
  let alnum = 0;
  for (const ch of points) {
    if (/[\p{L}\p{N}]/u.test(ch)) {
      alnum += 1;
    }
  }
  const symbolRatio = 1.0 - alnum / points.length;
  if (symbolRatio > _SYMBOL_RATIO_CAP) {
    return [];
  }
  return ['疑似编码混淆（base64 形态指纹：大小写数字混合）'];
}

/**
 * 指令注入检测（纯文本形态，公开入口）。
 *
 * 供检索结果/外部内容等不可信文本进入上下文前扫描（web 检索注入防线）；
 * 命中清单（空 = 干净）。归一化与命中语义与知识条目扫描同源——全角/空格
 * 混淆变体与英文句式同样可命中；熵启发作为关键词之外的补充信号（疑似
 * 编码混淆也入清单）。命中即拒：检出指令型措辞的文本不得进入模型上下文。
 */
export function scan_text_injection(
  text: string,
  patterns: readonly string[] = _INJECTION_PATTERNS,
): readonly string[] {
  const normalized = _normalize_injection_text(text);
  if (!normalized) {
    return [];
  }
  const hits: string[] = [];
  for (const pattern of patterns) {
    if (normalized.includes(_normalize_injection_text(pattern))) {
      hits.push(pattern);
    }
  }
  hits.push(..._obfuscation_entropy_hits(text));
  return [...new Set(hits)];
}

/** 递归提取条目数据中的字符串值（注入检测的文本面）。 */
export function _string_values(
  data: unknown,
  options?: { depth?: number },
): string[] {
  const depth = options?.depth ?? 0;
  if (depth > 8) {
    return [];
  }
  if (typeof data === 'string') {
    return [data];
  }
  if (Array.isArray(data)) {
    const out: string[] = [];
    for (const item of data) {
      out.push(..._string_values(item, { depth: depth + 1 }));
    }
    return out;
  }
  if (isRecord(data)) {
    const out: string[] = [];
    for (const value of Object.values(data)) {
      out.push(..._string_values(value, { depth: depth + 1 }));
    }
    return out;
  }
  return [];
}

/**
 * 递归提取条目数据中的字符串键名（指令注入的键位面）。
 *
 * 键名也能携带指令措辞（如把整句注入句式作为字段名）——与值同等扫描；
 * 常规结构键以下划线/点号分隔，与指令句式（含空格的完整措辞）天然不
 * 冲突，误伤面可忽略。
 */
export function _string_keys(
  data: unknown,
  options?: { depth?: number },
): string[] {
  const depth = options?.depth ?? 0;
  if (depth > 8) {
    return [];
  }
  if (isRecord(data)) {
    const out: string[] = [];
    for (const [key, value] of Object.entries(data)) {
      if (typeof key === 'string') {
        out.push(key);
      }
      out.push(..._string_keys(value, { depth: depth + 1 }));
    }
    return out;
  }
  if (Array.isArray(data)) {
    const out: string[] = [];
    for (const item of data) {
      out.push(..._string_keys(item, { depth: depth + 1 }));
    }
    return out;
  }
  return [];
}

/**
 * 扫描面提取：字符串值 + 键名（跳过 provenance 元数据子树）。
 *
 * provenance = 导入/沉淀的结构化书签元数据（源地址/时间戳等），非知识
 * 内容——源地址（文件路径/URL）的大小写数字混合会误伤熵启发（外部 URL
 * 导入将恒拒）；扫描面只覆盖实际知识内容（外部内容注入风险仍在内容/
 * 标题/标签面上完整检测）。
 */
export function _scan_surface(
  data: unknown,
  options?: { depth?: number },
): string[] {
  const depth = options?.depth ?? 0;
  if (depth > 8) {
    return [];
  }
  const out: string[] = [];
  if (isRecord(data)) {
    for (const [key, value] of Object.entries(data)) {
      if (key === 'provenance') {
        continue;
      }
      if (typeof key === 'string') {
        out.push(key);
      }
      out.push(..._scan_surface(value, { depth: depth + 1 }));
    }
  } else if (Array.isArray(data)) {
    for (const item of data) {
      out.push(..._scan_surface(item, { depth: depth + 1 }));
    }
  } else if (typeof data === 'string') {
    out.push(data);
  }
  return out;
}
