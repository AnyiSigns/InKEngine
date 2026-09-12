/**
 * semantic-e2e 门禁（计划 §13.6 第 2 条 / §13.9 硬门禁，P3b 落地即强制）：
 * 端到端语义标签断言——「声明了就必须有真实执行点」，两端任一断链即红。
 *
 * 1) 命令面：`plugins/commands/<id>/spec.json` 中 kind=command 的插件，其声明
 *    命令 id 必须命中 `hosts/lib/src/bridge/` 内的带点引号字面量——
 *    commands.generated.ts 各域 `*_COMMANDS` 元组（BRIDGE_METHODS 派生源）
 *    或域工厂方法表的 `'命令.id':` 键。声明了却在宿主桥接层找不到执行点 =
 *    孤儿语义标签（前端标了后端不真做），不得以注释/空态掩盖。
 * 2) ui 脸面：`plugins/ui_features/<id>/spec.json` 的 faces.ui / faces.logic
 *    声明的 entry 相对路径所指文件必须真实存在（相对插件目录解析、禁逃逸）。
 *
 * 扫描面目录写死为相对路径（§5.1 口径：精确不模糊）；只读扫描
 * plugins/hosts，不改其内容。目录不存在时整规则静默跳过（与既有扫描器
 * 「未搬迁/不存在 = 不误报」行为一致——真实工作树三目录恒在，强制面不因此松动）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { Violation } from './rules.js';

const COMMANDS_DIR = 'plugins/commands';
const UI_FEATURES_DIR = 'plugins/ui_features';
const BRIDGE_DIR = 'hosts/lib/src/bridge';
/** bridge 文件里的带点字符串字面量（'domain.name' / "a.b.c"）——命令执行点词汇面。 */
const DOTTED_LITERAL_RE = /['"]([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+)['"]/g;

interface PluginSpec {
  id?: unknown;
  kind?: unknown;
  faces?: unknown;
}

function readSpecJson(specAbs: string): PluginSpec | 'missing' | 'invalid' {
  let text: string;
  try {
    text = readFileSync(specAbs, 'utf8');
  } catch {
    return 'missing';
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'invalid';
    return parsed as PluginSpec;
  } catch {
    return 'invalid';
  }
}

function subDirs(abs: string): string[] {
  try {
    return readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** 收集 bridge 树内全部 .ts 的带点字符串字面量（命令执行点声明域）。 */
function collectBridgeLiterals(root: string): Set<string> | null {
  const dir = join(root, BRIDGE_DIR);
  if (!existsSync(dir)) return null;
  const literals = new Set<string>();
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const full = join(abs, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(full);
      } else if (/\.(?:ts|tsx)$/.test(entry.name)) {
        const text = readFileSync(full, 'utf8');
        for (const m of text.matchAll(DOTTED_LITERAL_RE)) {
          if (m[1] !== undefined) literals.add(m[1]);
        }
      }
    }
  };
  walk(dir);
  return literals;
}

/** 命令面检查：每个 kind=command 声明的 id 须在 bridge 词汇面命中执行点。 */
function checkCommands(root: string, relOf: (abs: string) => string): Violation[] {
  const out: Violation[] = [];
  const commandsAbs = join(root, COMMANDS_DIR);
  if (!existsSync(commandsAbs)) return out; // 扫描面不存在 → 静默（见头注）
  const bridgeLiterals = collectBridgeLiterals(root);
  if (bridgeLiterals === null) return out; // bridge 缺面 = 装配环境不完整，不误报声明
  for (const dirName of subDirs(commandsAbs)) {
    const specAbs = join(commandsAbs, dirName, 'spec.json');
    const specRel = relOf(specAbs);
    const spec = readSpecJson(specAbs);
    if (spec === 'missing') {
      out.push({ path: relOf(join(commandsAbs, dirName)), rule: 'semantic-e2e', message: `命令插件缺 spec.json（${dirName}）` });
      continue;
    }
    if (spec === 'invalid') {
      out.push({ path: specRel.replace(/\\/g, '/'), rule: 'semantic-e2e', message: 'spec.json 非法（须为 JSON 对象）' });
      continue;
    }
    if (spec.kind !== 'command') continue;
    const id = typeof spec.id === 'string' ? spec.id : null;
    if (id === null) {
      out.push({ path: specRel.replace(/\\/g, '/'), rule: 'semantic-e2e', message: 'kind=command 声明缺字符串 id' });
      continue;
    }
    if (!bridgeLiterals.has(id)) {
      out.push({
        path: specRel.replace(/\\/g, '/'),
        rule: 'semantic-e2e',
        message: `命令「${id}」在 hosts/lib/src/bridge（BRIDGE_METHODS 生成物/域工厂实现）找不到执行点——声明即须端到端兑现（§13.6.2）`,
      });
    }
  }
  return out;
}

/** faces 单脸 entry 断言：声明了 face 就必须有真实入口文件（禁逃逸出插件目录）。 */
function checkFaceEntry(faceName: string, face: unknown, pluginAbs: string, relPathOf: (abs: string) => string, specRel: string): Violation[] {
  const out: Violation[] = [];
  if (face === undefined || face === null) return out;
  if (typeof face !== 'object' || Array.isArray(face)) {
    out.push({ path: specRel, rule: 'semantic-e2e', message: `faces.${faceName} 须为对象` });
    return out;
  }
  const entry = (face as Record<string, unknown>)['entry'];
  if (entry === undefined || entry === null) {
    out.push({ path: specRel, rule: 'semantic-e2e', message: `faces.${faceName} 声明了脸但缺 entry（执行点不可达）` });
    return out;
  }
  if (typeof entry !== 'string' || isAbsolute(entry) || entry.startsWith('/')) {
    out.push({ path: specRel, rule: 'semantic-e2e', message: `faces.${faceName}.entry 须为相对路径字符串（命中 ${String(entry)}）` });
    return out;
  }
  const abs = resolve(pluginAbs, entry);
  const relToPlugin = relative(pluginAbs, abs);
  if (relToPlugin.startsWith('..') || relToPlugin.split(sep).includes('..')) {
    out.push({ path: specRel, rule: 'semantic-e2e', message: `faces.${faceName}.entry 逃逸插件目录（${entry}）` });
    return out;
  }
  let isFile = false;
  try {
    isFile = statSync(abs).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    out.push({
      path: specRel,
      rule: 'semantic-e2e',
      message: `faces.${faceName}.entry 指向的文件不存在：${relPathOf(abs)}（前端标了后端不真做 = 孤儿语义标签）`,
    });
  }
  return out;
}

/** UI 脸面检查：ui_features spec 的 faces.ui / faces.logic entry 真实存在。 */
function checkUiFaces(root: string, relOf: (abs: string) => string): Violation[] {
  const out: Violation[] = [];
  const featuresAbs = join(root, UI_FEATURES_DIR);
  if (!existsSync(featuresAbs)) return out; // 扫描面不存在 → 静默（见头注）
  for (const dirName of subDirs(featuresAbs)) {
    const pluginAbs = join(featuresAbs, dirName);
    const specAbs = join(pluginAbs, 'spec.json');
    const specRel = relOf(specAbs).replace(/\\/g, '/');
    const spec = readSpecJson(specAbs);
    if (spec === 'missing') continue; // 无 spec 的目录不由本规则定性（verify:unload 执法）
    if (spec === 'invalid') {
      out.push({ path: specRel, rule: 'semantic-e2e', message: 'spec.json 非法（须为 JSON 对象）' });
      continue;
    }
    if (spec.kind !== 'ui_feature' || typeof spec.id !== 'string') continue;
    if (spec.faces === undefined || spec.faces === null) continue;
    if (typeof spec.faces !== 'object' || Array.isArray(spec.faces)) {
      out.push({ path: specRel, rule: 'semantic-e2e', message: 'faces 须为对象' });
      continue;
    }
    const faces = spec.faces as Record<string, unknown>;
    for (const faceName of ['ui', 'logic']) {
      out.push(...checkFaceEntry(faceName, faces[faceName], pluginAbs, relOf, specRel));
    }
  }
  return out;
}

/** semantic-e2e 全量扫描（root = ink-ts 工作区根）。 */
export async function scanSemanticE2e(root: string): Promise<Violation[]> {
  const relOf = (abs: string): string => relative(root, abs).split(sep).join('/');
  const violations: Violation[] = [];
  violations.push(...checkCommands(root, relOf));
  violations.push(...checkUiFaces(root, relOf));
  return violations;
}
