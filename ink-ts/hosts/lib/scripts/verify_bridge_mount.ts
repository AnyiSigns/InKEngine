#!/usr/bin/env tsx
/**
 * verify:bridge-mount —— 命令声明即挂载校验（S3 升级：命令实现位 = 插件 logic face）。
 *
 * 断言：
 * 1. host bridge 方法面（BRIDGE_METHODS）全部由各域命令声明元组
 *    （`<DOMAIN>_COMMANDS`）spread 派生，index.ts 数组体不含任何手写点分
 *    方法名字面量（防回退为「命令名散落手写数组」）。
 * 2. **挂载完整性（双向一致）**：
 *    - 每个 BRIDGE_METHODS 方法名必须对应 plugins/commands/<id> 插件
 *      （id = 方法名）且其 spec 声明 faces.logic（target='host'）——有方法
 *      无插件/无逻辑面 = FAIL（装配期 buildBridge 必然 fail-closed）；
 *    - 每个声明 faces.logic 的命令插件必须在 BRIDGE_METHODS 中——有插件
 *      无方法 = FAIL（孤儿命令：BRIDGE_METHODS 少收录）。
 *    真源 = plugins/manifest.json plugins[] 行（dir='commands/<id>' +
 *    faces.logic；生成器已逐字透传 spec 顶层 faces）。
 *
 * 键集合与实现表一致由类型系统保证：命令插件 faces/logic 默认导出工厂返回
 * BridgeHandler；buildBridge 装配期按 BRIDGE_METHODS 装载并双向校验（有方法
 * 无插件即抛）。本脚本负责防「BRIDGE_METHODS 回退手写 / 挂载漂移」这一源码
 * 纪律面，与运行时/类型校验互补。
 *
 * 扫描口径：
 * 1. BRIDGE_METHODS 数组体内（剥离 // 注释与空行后）每行必须匹配
 *    `...<IDENT>_COMMANDS,` spread；出现点分字符串字面量（'a.b',）= 违规。
 * 2. 每个被 spread 的 `<IDENT>_COMMANDS` 必须已从 `./commands.generated.js` import。
 * 3. 挂载双向一致（见上）。
 *
 * 退出码：0 = PASS；1 = 任一违规（打印违规清单）。
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = join(HERE, '..');
const INDEX_PATH = join(HOST, 'src', 'bridge', 'index.ts');
const MANIFEST_PATH = join(HOST, '..', '..', 'plugins', 'manifest.json');

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

/** 校验数组体：只允许 spread 行 / 注释行 / 空行；引用常量须已 import。 */
function checkBody(content: string, lines: string[], range: { start: number; end: number }): void {
  const imported = new Set<string>();
  // 扫描全文：所有 `import { ... } from './commands.generated.js'` 语句，逐名
  // 注册（多名称 import 块一次捕获全部 `*_COMMANDS` 符号）。
  for (const stmt of content.matchAll(/import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/commands\.generated\.js/g)) {
    for (const m of stmt[0].matchAll(/([A-Z][A-Z0-9_]*_COMMANDS)/g)) {
      imported.add(m[1]!);
    }
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
          message: `spread 引用 ${spread[1]} 未从 ./commands.generated.js import`,
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

interface ManifestRow {
  id: string;
  dir: string;
  faces?: Record<string, { target: string; entry: string }>;
}

/** 读取 manifest 命令插件行（id/dir/faces.logic）；manifest 缺失 = 致命违规。 */
function manifestCommandRows(): ManifestRow[] {
  let manifest: { plugins?: unknown };
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    violations.push({ line: 0, text: '', message: `plugins/manifest.json 缺失或不可解析（先跑 node plugins/scripts/sync_plugin_manifest.mjs）: ${MANIFEST_PATH}` });
    return [];
  }
  const rows: ManifestRow[] = [];
  if (!Array.isArray(manifest.plugins)) return rows;
  for (const row of manifest.plugins) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (r['kind'] !== 'command' || typeof r['id'] !== 'string') continue;
    const faces = r['faces'];
    rows.push({
      id: r['id'],
      dir: typeof r['dir'] === 'string' ? r['dir'] : '',
      faces: typeof faces === 'object' && faces !== null
        ? (faces as Record<string, { target: string; entry: string }>)
        : undefined,
    });
  }
  return rows;
}

/** 挂载双向一致：BRIDGE_METHODS ↔ manifest 命令插件 faces.logic。 */
function checkMountCompleteness(methods: string[], commandRows: ManifestRow[]): void {
  const declared = new Set<string>();
  for (const row of commandRows) {
    declared.add(row.id);
    if (row.dir !== `commands/${row.id}`) {
      violations.push({
        line: 0,
        text: row.id,
        message: `命令插件 dir 形态非法: ${row.dir}（应 commands/<id>）`,
      });
    }
    const logic = row.faces?.['logic'];
    if (logic === undefined || logic.target !== 'host') {
      violations.push({
        line: 0,
        text: row.id,
        message: '命令插件未声明 faces.logic（target=host）——命令实现位 = plugins/commands/<id>/faces/logic',
      });
    }
  }
  for (const method of methods) {
    if (!declared.has(method)) {
      violations.push({
        line: 0,
        text: method,
        message: `BRIDGE_METHODS 方法名无对应命令插件（plugins/commands/${method} 缺失或未声明 faces.logic）`,
      });
    }
  }
  for (const row of commandRows) {
    if (!methods.includes(row.id)) {
      violations.push({
        line: 0,
        text: row.id,
        message: '命令插件声明 faces.logic 但不在 BRIDGE_METHODS（孤儿命令——BRIDGE_METHODS 少收录或 spec.id 漂移）',
      });
    }
  }
}

const content = readFileSync(INDEX_PATH, 'utf8');
const lines = content.split('\n');
const range = bridgeMethodsBody(lines);
if (range !== null) {
  checkBody(content, lines, range);
}
// 方法名真源 = commands.generated.ts 各域 `*_COMMANDS` 元组（index.ts 数组体
// 只 spread，不含字面量）。逐块抽取点分字符串作为 BRIDGE_METHODS 全集。
const generatedPath = join(HOST, 'src', 'bridge', 'commands.generated.ts');
const generatedText = readFileSync(generatedPath, 'utf8');
const tupleBlockRe = /export const \w+_COMMANDS = \[([\s\S]*?)\] as const;/g;
const literalRe = /'([a-z_][a-z0-9_.]*)'/g;
const methods: string[] = [];
for (const block of generatedText.matchAll(tupleBlockRe)) {
  for (const m of block[1]!.matchAll(literalRe)) {
    methods.push(m[1]!);
  }
}
checkMountCompleteness(methods, manifestCommandRows());

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
  `verify:bridge-mount PASS (BRIDGE_METHODS 全由域声明元组 spread 派生，无手写方法名；BRIDGE_METHODS ↔ manifest 命令 faces.logic 双向一致)`,
);
