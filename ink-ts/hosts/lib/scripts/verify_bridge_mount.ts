#!/usr/bin/env tsx
/**
 * verify:bridge-mount —— 命令声明即挂载校验（阶段 2 样板 + 阶段 3b1 真源迁移）。
 *
 * 断言：
 * 1. host bridge 方法面（BRIDGE_METHODS）全部由各域命令声明元组
 *    （`<DOMAIN>_COMMANDS`）spread 派生，index.ts 数组体不含任何手写点分
 *    方法名字面量（防回退为「命令名散落手写数组」）。
 * 2. 域实现文件（rounds.ts / todos.ts / …）不得本地声明 `*_COMMANDS` 字面量
 *    数组——命令方法名真源 = plugins/commands/<id>/spec.json → 生成物
 *    commands.generated.ts（verify:plugin-manifest 强制逐字一致），域文件
 *    只允许 `import … from './commands.generated.js'` / re-export；本检查防
 *    域文件旁路手写数组（旁路会让「真源在 plugins」失守）。
 *
 * 键集合与实现表一致由类型系统保证：各域工厂返回
 * `Readonly<Record<<Domain>Command, BridgeHandler>>`，对象字面量少键/多键/
 * 拼错键均 typecheck 失败；装配期 buildBridge 再双向校验（有声明没实现 /
 * 有实现没声明即抛错）。本脚本负责防「BRIDGE_METHODS/域文件回退手写」这一
 * 源码纪律面，与运行时/类型校验互补。
 *
 * 扫描口径：
 * 1. BRIDGE_METHODS 数组体内（剥离 // 注释与空行后）每行必须匹配
 *    `...<IDENT>_COMMANDS,` spread；出现点分字符串字面量（'a.b',）= 违规。
 * 2. 每个被 spread 的 `<IDENT>_COMMANDS` 必须已从 `./<域>.js` import。
 * 3. bridge/ 下非生成物、非 index.ts 的 *.ts：禁止 `export const <IDENT>_COMMANDS
 *    = [` 本地声明（方法名数组只允许存在于 commands.generated.ts）。
 *
 * 退出码：0 = PASS；1 = 任一违规（打印违规清单）。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = join(HERE, '..');
const INDEX_PATH = join(HOST, 'src', 'bridge', 'index.ts');
const BRIDGE_DIR = join(HOST, 'src', 'bridge');

interface Violation {
  line: number;
  text: string;
  message: string;
}

const violations: Violation[] = [];

/** 抽取 BRIDGE_METHODS 数组体行（含注释行，供逐行判断；不含首尾）。 */
function bridgeMethodsBody(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((line) => /export const BRIDGE_METHODS = \[/.test(line));
  if (start === -1) {
    violations.push({ line: 0, text: '', message: 'index.ts 缺 BRIDGE_METHODS 导出' });
    return null;
  }
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\] as const;/.test(lines[i]!)) {
      return { start: start + 1, end: i };
    }
  }
  violations.push({ line: start + 1, text: '', message: 'BRIDGE_METHODS 数组未以 `] as const;` 收尾' });
  return null;
}

const SPREAD_COMMANDS_RE = /^\.\.\.([A-Z][A-Z0-9_]*_COMMANDS),?$/;
const DOTTED_LITERAL_RE = /^['"][a-z_][a-z0-9_.]*['"],?$/;
const IMPORT_COMMANDS_RE = /import\s*\{[^}]*\b([A-Z][A-Z0-9_]*_COMMANDS)\b[^}]*\}\s*from\s*['"]\.\//;

/** 校验数组体：只允许 spread 行 / 注释行 / 空行；引用常量须已 import。 */
function checkBody(lines: string[], range: { start: number; end: number }): void {
  const imported = new Set<string>();
  for (const line of lines) {
    const match = IMPORT_COMMANDS_RE.exec(line);
    if (match !== null) imported.add(match[1]!);
  }
  for (let i = range.start; i < range.end; i += 1) {
    const raw = lines[i]!;
    const lineNo = i + 1;
    const stripped = raw.replace(/\/\/.*$/, '').trim();
    if (stripped === '') continue;
    const spread = SPREAD_COMMANDS_RE.exec(stripped);
    if (spread !== null) {
      if (!imported.has(spread[1]!)) {
        violations.push({
          line: lineNo,
          text: raw.trim(),
          message: `spread 引用 ${spread[1]} 未从 ./<域>.js import`,
        });
      }
      continue;
    }
    if (DOTTED_LITERAL_RE.test(stripped)) {
      violations.push({
        line: lineNo,
        text: raw.trim(),
        message: 'BRIDGE_METHODS 数组体出现手写方法名字面量——方法名只允许经各域 *_COMMANDS spread 派生',
      });
      continue;
    }
    violations.push({
      line: lineNo,
      text: raw.trim(),
      message: 'BRIDGE_METHODS 数组体行非法：只允许 `...<DOMAIN>_COMMANDS,` spread 或注释',
    });
  }
}

/** 域文件旁路检查：非生成物/非 index 的 bridge 源码不得本地声明 *_COMMANDS 数组。 */
function checkNoLocalCommandArrays(): void {
  const LOCAL_COMMANDS_DECL_RE = /export const [A-Z][A-Z0-9_]*_COMMANDS = \[/;
  for (const entry of readdirSync(BRIDGE_DIR)) {
    if (!entry.endsWith('.ts')) continue;
    if (entry === 'commands.generated.ts' || entry === 'index.ts') continue;
    const text = readFileSync(join(BRIDGE_DIR, entry), 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, idx) => {
      if (LOCAL_COMMANDS_DECL_RE.test(line)) {
        violations.push({
          line: idx + 1,
          text: line.trim(),
          message: `域文件 ${entry} 本地声明 *_COMMANDS 数组——方法名真源须为 plugins/commands → commands.generated.ts（域文件只 re-export）`,
        });
      }
    });
  }
}

const content = readFileSync(INDEX_PATH, 'utf8');
const lines = content.split('\n');
const range = bridgeMethodsBody(lines);
if (range !== null) {
  checkBody(lines, range);
}
checkNoLocalCommandArrays();

if (violations.length > 0) {
  console.error(`verify:bridge-mount FAIL (${INDEX_PATH})`);
  for (const item of violations) {
    const at = item.line > 0 ? `:${item.line}` : '';
    console.error(`  ${at} ${item.message}`);
    if (item.text !== '') console.error(`      ${item.text}`);
  }
  process.exit(1);
}
console.log(
  `verify:bridge-mount PASS (BRIDGE_METHODS 全由域声明元组 spread 派生，无手写方法名；域文件无本地 *_COMMANDS 数组)`,
);
