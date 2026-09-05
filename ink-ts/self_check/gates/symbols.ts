/**
 * symbols 门禁：符号引用计数最小等价（engine core 顶层导出孤儿扫描）。
 *
 * 语义随迁自 inkling/self_check symbols 门禁：顶层导出的函数/类/枚举/常量，
 * 若其标识符在整个被扫描源码树中只出现 1 次（仅定义行），即无任何消费方，
 * 视为孤儿。allowlist 文件（orphan_allowlist.txt）收录已知需保留的导出
 * （版本号/契约面/跨包 API），新增孤儿不被豁免。
 *
 * 扫描范围：
 * - 定义抽取：engine/src/core 下所有 .ts 的顶层 `export function|class|enum|const`；
 * - 消费索引：engine/src、engine/test、host/src、host/test、cli/src、cli/test、
 *   web/src、web/test、contracts/src（token 计数，注释/字符串也会计入，宽松侧）。
 *
 * 计数方式：标识符 token 计数（非子串），避免把长标识符前缀误判为引用。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { GateResult } from '../_report.js';
import type { SelfCheckContext } from '../index.js';

const INDEX_DIRS = [
  'engine/src',
  'engine/test',
  'host/src',
  'host/test',
  'cli/src',
  'cli/test',
  'web/src',
  'web/test',
  'contracts/src',
];

const ALLOWLIST_NAME = 'orphan_allowlist.txt';

const DEF_RE = /^export\s+(?:async\s+|abstract\s+|declare\s+)*(?:function|class|enum|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;

function walkFiles(dir: string): string[] {
  const result: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return result;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let isDir = false;
    let isFile = false;
    try {
      const stat = statSync(full);
      isDir = stat.isDirectory();
      isFile = stat.isFile();
    } catch {
      // 忽略不可读项
    }
    if (isDir) result.push(...walkFiles(full));
    else if (isFile && /\.(ts|tsx)$/.test(entry)) result.push(full);
  }
  return result;
}

interface Def {
  name: string;
  file: string;
}

/** 收集定义与词频：一次遍历构建 { 文件 -> token 计数 }。 */
function collect(ctx: SelfCheckContext): { defs: Def[]; counts: Map<string, number> } {
  const coreDir = join(ctx.inkTsRoot, 'engine', 'src', 'core');
  const defs: Def[] = [];
  const counts = new Map<string, number>();
  const addTokens = (text: string): void => {
    const tokenRe = /[A-Za-z_$][A-Za-z0-9_$]*/g;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(text)) !== null) {
      const token = m[0];
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  };
  const walk = (dir: string, base: string): void => {
    for (const file of walkFiles(dir)) {
      const relPath = relative(base, file).split(sep).join('/');
      const text = readFileSync(file, 'utf8');
      addTokens(text);
      if (relPath.startsWith('engine/src/core/')) {
        DEF_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = DEF_RE.exec(text)) !== null) {
          const name = m[1]!;
          if (name.startsWith('_')) continue;
          defs.push({ name, file: relPath });
        }
      }
    }
  };
  walk(join(ctx.inkTsRoot, 'engine', 'src'), ctx.inkTsRoot);
  for (const dir of INDEX_DIRS) {
    if (dir === 'engine/src') continue;
    walk(join(ctx.inkTsRoot, dir), ctx.inkTsRoot);
  }
  return { defs, counts };
}

/** 读取 allowlist：每行 `<name>@<relpath>`；空行/`#` 注释跳过。 */
function loadAllowlist(here: string): Set<string> {
  const set = new Set<string>();
  let text: string;
  try {
    text = readFileSync(join(here, ALLOWLIST_NAME), 'utf8');
  } catch {
    return set;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const [name, file] = trimmed.split('@');
    if (name !== undefined && file !== undefined) set.add(`${name}@${file}`);
  }
  return set;
}

const selfCheckDir = fileURLToPath(new URL('..', import.meta.url));

export async function runGateSymbols(ctx: SelfCheckContext): Promise<GateResult> {
  const started = Date.now();
  const { defs, counts } = collect(ctx);
  const allowlist = loadAllowlist(selfCheckDir);
  const orphans: Array<{ name: string; file: string }> = [];
  for (const def of defs) {
    const occurrence = counts.get(def.name) ?? 0;
    if (occurrence >= 2) continue;
    if (allowlist.has(`${def.name}@${def.file}`)) continue;
    orphans.push(def);
  }
  const seconds = (Date.now() - started) / 1000;
  const passed = orphans.length === 0;
  const summary = passed
    ? `全绿：core 顶层导出 ${defs.length} 个，零孤儿`
    : `发现 ${orphans.length} 个孤儿导出（顶层定义后无任何消费引用）`;
  const tail = orphans.map((o) => `[ORPHAN] ${o.name} @ ${o.file}`);
  return {
    key: 'symbols',
    label: '符号引用计数',
    command: 'engine/src/core 顶层导出孤儿扫描',
    passed,
    seconds,
    summary,
    tail,
  };
}
