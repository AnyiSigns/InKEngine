#!/usr/bin/env tsx
/**
 * verify:unload —— 插件卸载一致性审计（阶段 4：faces/depends 卸载级联，fail-closed）。
 *
 * 语义（对应 docs/component_data_endgame.md §七 阶段 4 与 PLUGINS.md §1）：
 * - 插件即数据：plugins/<kind>/<id>/spec.json 顶层可声明 CapabilityComponent 全脸
 *   （actions/depends/faces/contract），注册表行（manifest plugins[]）已携带；
 *   语义校验在此执行（生成器 sync_plugin_manifest.mjs 只守 JSON 形状）。
 * - depends 可引用其它插件 id 或机制端口 id（引擎单一真源
 *   engine/src/kernel/registry/ports.ts —— 本脚本是唯一跨进引擎内部取端口的
 *   开发工具，端口词表不自维护第二份）。装配/装载前校验：悬空 = 违规；
 *   插件间 depends 有环 = 违规（机制端口是叶子，不参与环）。
 * - 卸载级联策略（用户定案 2026-09-07）：fail-closed 拒绝——有活动下游依赖
 *   （depends 反向引用）或 ui 组合引用（父容器 data.children.$ref）即不可独立卸载，
 *   --plan <id> 输出阻断方与子树影响面（卸载前先查拆除清单）。
 * - faces 结构校验：ui/logic/data 三脸，target ∈ engine|host|web，entry 非空；
 *   contract.effects ⊆ 机制端口词表。
 * - 状态引脚（阶段 4 定案：内置插件均 data-only——共享端点/共享域实现/
 *   共享渲染原语，无插件独占实现面，不填占位声明）：任何 spec 出现非空
 *   actions/depends/faces/contract 即视为「数据面转真」，引脚红并提示同步文档。
 *   ui 树不变式：除装配入口外每个 ui_feature 插件必须被 ≥1 容器引用（可达性，
 *   与生成器孤儿检查同源，双保险）。
 *
 * 用法：tsx plugins/scripts/verify_unload.ts           # 全量审计（exit 1 = 违规）
 *       tsx plugins/scripts/verify_unload.ts --plan <id>  # 输出卸载影响面/阻断方
 * 退出码：0 = PASS；1 = 违规或未知插件。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MECHANISM_PORT_IDS } from '../../engine/src/kernel/registry/ports.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGINS_ROOT = join(HERE, '..');
const MANIFEST_PATH = join(PLUGINS_ROOT, 'manifest.json');

const KIND_DIRS: { kind: string; dir: string }[] = [
  { kind: 'tool', dir: 'tools' },
  { kind: 'mcp', dir: 'mcp' },
  { kind: 'command', dir: 'commands' },
  { kind: 'ui_feature', dir: 'ui_features' },
  { kind: 'endpoint', dir: 'endpoints' },
];

/** 真面内置插件白名单（阶段 7a 首真面样板：doc_parse 首个 host logic face；
 *  阶段 7b 起 ui_feature 组件叶子/面板经规则放行（见 realFaceAllowed），
 *  内置其余仍 data-only 拒真面——防平行真相；外部插件按 capability 放行）。 */
const REAL_FACE_BUILTINS = new Set(['doc_parse']);

const FACE_TARGETS = new Set(['engine', 'host', 'web']);
const FACE_KEYS = new Set(['ui', 'logic', 'data']);
const PORT_IDS = new Set<string>(MECHANISM_PORT_IDS);

interface FaceRef {
  target: string;
  entry: string;
}

interface Plugin {
  id: string;
  kind: string;
  dir: string;
  capability: string;
  actions: string[];
  depends: string[];
  effects: string[];
  faces: Record<string, FaceRef>;
  uiChildren: string[];
  isUiComponent: boolean;
  isUiEntry: boolean;
  /** 设置页段声明（data.settings_section.key；经 settings 清单引用，非布局树）。 */
  settingsKey?: string;
}

interface Violation {
  id: string;
  message: string;
}

const violations: Violation[] = [];

function violation(id: string, message: string): void {
  violations.push({ id, message });
}

function readSpecFile(kind: string, dir: string): { ok: true; spec: Record<string, unknown> } | { ok: false; message: string } {
  const specPath = join(dir, 'spec.json');
  let text: string;
  try {
    text = readFileSync(specPath, 'utf8');
  } catch {
    return { ok: false, message: `${kind} 插件缺 spec.json: ${dir}` };
  }
  let spec: unknown;
  try {
    spec = JSON.parse(text);
  } catch (err) {
    return { ok: false, message: `spec.json 解析失败: ${specPath}（${(err as Error).message}）` };
  }
  if (typeof spec !== 'object' || spec === null || typeof (spec as Record<string, unknown>).id !== 'string') {
    return { ok: false, message: `${kind} 插件 spec 缺 id: ${specPath}` };
  }
  if ((spec as Record<string, unknown>).kind !== kind) {
    return { ok: false, message: `${kind} 插件 spec.kind 不符: ${(spec as Record<string, unknown>).id}` };
  }
  return { ok: true, spec: spec as Record<string, unknown> };
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string') : [];
}

function facesOf(spec: Record<string, unknown>): Record<string, FaceRef> {
  const faces = spec.faces;
  if (typeof faces !== 'object' || faces === null || Array.isArray(faces)) return {};
  const out: Record<string, FaceRef> = {};
  for (const [face, ref] of Object.entries(faces)) {
    if (typeof ref === 'object' && ref !== null) {
      out[face] = {
        target: (ref as Record<string, unknown>).target as string,
        entry: (ref as Record<string, unknown>).entry as string,
      };
    }
  }
  return out;
}

function effectsOf(spec: Record<string, unknown>): string[] {
  const contract = spec.contract;
  if (typeof contract !== 'object' || contract === null || Array.isArray(contract)) return [];
  return strArray((contract as Record<string, unknown>).effects);
}

function uiChildrenOf(kind: string, spec: Record<string, unknown>): string[] {
  if (kind !== 'ui_feature') return [];
  const data = spec.data;
  if (typeof data !== 'object' || data === null) return [];
  const out: string[] = [];
  const children = (data as Record<string, unknown>).children;
  if (Array.isArray(children)) {
    for (const slot of children) {
      if (typeof slot === 'object' && slot !== null && typeof (slot as Record<string, unknown>).$ref === 'string') {
        out.push((slot as Record<string, unknown>).$ref as string);
      }
    }
  }
  const root = (data as Record<string, unknown>).root;
  if (typeof root === 'object' && root !== null && typeof (root as Record<string, unknown>).$ref === 'string') {
    out.push((root as Record<string, unknown>).$ref as string);
  }
  return out;
}

function loadUniverse(): Map<string, Plugin> {
  const universe = new Map<string, Plugin>();
  for (const { kind, dir } of KIND_DIRS) {
    let entries: string[] = [];
    try {
      entries = readdirSync(join(PLUGINS_ROOT, dir), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      entries = [];
    }
    for (const id of entries) {
      const read = readSpecFile(kind, join(PLUGINS_ROOT, dir, id));
      if (!read.ok) {
        violation(id, read.message);
        continue;
      }
      const spec = read.spec;
      const data = spec.data;
      universe.set(id, {
        id,
        kind,
        dir: `${dir}/${id}`,
        capability: typeof spec.capability === 'string' ? spec.capability : kind === 'mcp' ? 'external_tool' : 'host_tool',
        actions: strArray(spec.actions),
        depends: strArray(spec.depends),
        effects: effectsOf(spec),
        faces: facesOf(spec),
        uiChildren: uiChildrenOf(kind, spec),
        isUiComponent:
          kind === 'ui_feature' &&
          typeof data === 'object' &&
          data !== null &&
          typeof (data as Record<string, unknown>).node === 'object' &&
          (data as Record<string, unknown>).node !== null &&
          ((data as Record<string, unknown>).node as Record<string, unknown>).kind === 'component',
        isUiEntry:
          kind === 'ui_feature' &&
          typeof data === 'object' &&
          data !== null &&
          typeof (data as Record<string, unknown>).root === 'object' &&
          (data as Record<string, unknown>).root !== null,
        settingsKey:
          kind === 'ui_feature' &&
          typeof data === 'object' &&
          data !== null &&
          typeof (data as Record<string, unknown>).settings_section === 'object' &&
          (data as Record<string, unknown>).settings_section !== null
            ? ((data as Record<string, unknown>).settings_section as { key?: string }).key
            : undefined,
      });
    }
  }
  return universe;
}

/** depends 解析：每项须为插件 id 或机制端口 id（悬空 = 违规）。 */
function auditDependsResolve(universe: Map<string, Plugin>): void {
  for (const plugin of universe.values()) {
    for (const dep of plugin.depends) {
      if (!universe.has(dep) && !PORT_IDS.has(dep)) {
        violation(plugin.id, `depends 悬空/未登记: ${dep}（须为插件 id 或机制端口 ${MECHANISM_PORT_IDS.join('|')}）`);
      }
    }
  }
}

/** 插件间 depends 环检测（机制端口为叶子，不参与）；环上全部插件列名。 */
function auditDependsCycle(universe: Map<string, Plugin>): void {
  const color = new Map<string, number>();
  const stack: string[] = [];
  const cycleMembers = new Set<string>();
  const dfs = (id: string): void => {
    const state = color.get(id) ?? 0;
    if (state === 2) return;
    if (state === 1) {
      const at = stack.indexOf(id);
      for (const member of stack.slice(at)) cycleMembers.add(member);
      cycleMembers.add(id);
      return;
    }
    color.set(id, 1);
    stack.push(id);
    const plugin = universe.get(id);
    if (plugin !== undefined) {
      for (const dep of plugin.depends) {
        if (universe.has(dep)) dfs(dep);
      }
    }
    stack.pop();
    color.set(id, 2);
  };
  for (const id of universe.keys()) dfs(id);
  if (cycleMembers.size > 0) {
    violation(
      [...cycleMembers].join(', '),
      `插件 depends 成环（fail-closed，机制端口为叶子）: ${[...cycleMembers].join(' -> ')}`,
    );
  }
}

/** faces 结构 + contract.effects 词表校验。 */
function auditFacesAndContract(universe: Map<string, Plugin>): void {
  for (const plugin of universe.values()) {
    for (const face of Object.keys(plugin.faces)) {
      const ref = plugin.faces[face];
      if (!FACE_KEYS.has(face)) {
        violation(plugin.id, `faces 未知脸: ${face}（只允许 ui/logic/data）`);
        continue;
      }
      if (!FACE_TARGETS.has(ref.target)) {
        violation(plugin.id, `faces.${face} 非法 target: ${ref.target}（engine|host|web）`);
      }
      if (typeof ref.entry !== 'string' || ref.entry.length === 0) {
        violation(plugin.id, `faces.${face} 缺非空 entry`);
      }
    }
    for (const effect of plugin.effects) {
      if (!PORT_IDS.has(effect)) {
        violation(plugin.id, `contract.effects 未登记端口: ${effect}（词表 ${MECHANISM_PORT_IDS.join('|')}）`);
      }
    }
  }
}

/** 真面许可：声明了全脸字段的插件须为 capability=external_tool、白名单内置
 *  （阶段 7a doc_parse 样板）或 ui_feature 组件节点（阶段 7b：布局叶子/设置
 *  面板的独占 UI 实现随插件 faces/ui 同住）；data-only（无声明）不在此判定。 */
function realFaceAllowed(plugin: Plugin): boolean {
  return plugin.capability === 'external_tool' || REAL_FACE_BUILTINS.has(plugin.id) || plugin.isUiComponent === true;
}

/** 真面插件 faces 结构约束：face entry 须相对插件目录（禁绝对/`..` 逃逸）且
 *  文件真实同住（物理单目录不变式，阶段 7a）；仅对有 faces 声明的插件执行。 */
function auditRealFaceEntries(universe: Map<string, Plugin>): void {
  for (const plugin of universe.values()) {
    const faces = plugin.faces;
    if (Object.keys(faces).length === 0) continue;
    if (!realFaceAllowed(plugin)) continue;
    for (const [face, ref] of Object.entries(faces)) {
      const entry = ref.entry;
      const safe = !entry.startsWith('/') && !/(^|[\\/])\.\.([\\/]|$)/.test(entry) && !/^[a-zA-Z]:/.test(entry);
      if (!safe) {
        violation(plugin.id, `faces.${face} entry 越界（须为插件目录内相对路径）: ${entry}`);
        continue;
      }
      const target = join(PLUGINS_ROOT, plugin.dir, entry);
      if (!existsSync(target)) {
        violation(plugin.id, `faces.${face} entry 文件缺失（测试/实现须随插件同住）: ${plugin.dir}/${entry}`);
      }
    }
  }
}

/** ui 组合反向边：子插件 id → 引用它的父容器插件 id 列表。 */
function buildUiReferrers(universe: Map<string, Plugin>): Map<string, string[]> {
  const referrers = new Map<string, string[]>();
  const push = (child: string, parent: string): void => {
    const list = referrers.get(child) ?? [];
    list.push(parent);
    referrers.set(child, list);
  };
  for (const plugin of universe.values()) {
    if (plugin.kind !== 'ui_feature') continue;
    for (const child of plugin.uiChildren) push(child, plugin.id);
  }
  for (const list of referrers.values()) list.sort();
  return referrers;
}

/** 容器的子树成员（含容器自身；不含装配入口祖先侧），BFS 沿 data.children.$ref。 */
function subtreeOf(plugin: Plugin, universe: Map<string, Plugin>): string[] {
  const seen = new Set<string>();
  const queue = [plugin.id];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = universe.get(id);
    if (node === undefined) continue;
    for (const child of node.uiChildren) queue.push(child);
  }
  return [...seen].sort();
}

/** 卸载影响面（fail-closed）：下游 depends 依赖方 + ui 组合引用方 + 级联子树成员。 */
function unloadPlan(id: string, universe: Map<string, Plugin>, referrers: Map<string, string[]>): {
  id: string;
  exists: boolean;
  dependents: string[];
  uiReferrers: string[];
  descendants: string[];
} {
  const plugin = universe.get(id);
  if (plugin === undefined) {
    return { id, exists: false, dependents: [], uiReferrers: [], descendants: [] };
  }
  const dependents: string[] = [];
  for (const other of universe.values()) {
    if (other.depends.includes(id)) dependents.push(other.id);
  }
  dependents.sort();
  const uiReferrers = referrers.get(id) ?? [];
  const descendants = subtreeOf(plugin, universe).filter((m) => m !== id);
  return { id, exists: true, dependents, uiReferrers, descendants };
}

/** manifest 平价：派生视图 plugins[] 与真源目录逐一对应（防审计装载器漂移/陈旧 manifest）。 */
function auditManifestParity(universe: Map<string, Plugin>): void {
  let manifest: { plugins?: { id?: unknown; kind?: unknown; dir?: unknown }[] };
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    violation('manifest', 'plugins/manifest.json 缺失或不可解析——先跑 node plugins/scripts/sync_plugin_manifest.mjs');
    return;
  }
  const rows = Array.isArray(manifest.plugins) ? manifest.plugins : [];
  if (rows.length !== universe.size) {
    violation('manifest', `manifest plugins[] 行数 ${rows.length} ≠ 真源插件数 ${universe.size}（重跑生成器）`);
  }
  for (const row of rows) {
    if (typeof row?.id !== 'string') {
      violation('manifest', 'manifest plugins[] 行缺 id');
      continue;
    }
    const plugin = universe.get(row.id);
    if (plugin === undefined) {
      violation('manifest', `manifest 含真源缺失插件: ${row.id}（删除目录后须重跑生成器）`);
      continue;
    }
    if (row.kind !== plugin.kind) violation(row.id, `manifest kind=${row.kind} 与真源 kind=${plugin.kind} 不符`);
    if (row.dir !== plugin.dir) violation(row.id, `manifest dir=${row.dir} 与真源 ${plugin.dir} 不符`);
  }
}

/** 状态引脚（阶段 4 定案 data-only；阶段 7a 起 realFaceAllowed 真面例外）。 */
function auditDataOnlyState(universe: Map<string, Plugin>): void {
  for (const plugin of universe.values()) {
    const hasDecl = plugin.actions.length > 0 || plugin.depends.length > 0 || plugin.effects.length > 0 || Object.keys(plugin.faces).length > 0;
    if (!hasDecl) continue;
    if (realFaceAllowed(plugin)) continue;
    violation(
      plugin.id,
      'spec 出现非空全脸声明（actions/depends/faces/contract）——阶段 4 定案内置插件 data-only，' +
        '共享端点/共享域实现/共享渲染原语不设插件独占面；真面许可 = capability=external_tool 或 ' +
        'verify_unload REAL_FACE_BUILTINS 白名单（阶段 7a doc_parse 样板）；真实声明须同步引脚与 ' +
        'PLUGINS.md/plugins-AGENTS 文档',
    );
  }
}

/** ui 不变式：除装配入口与 settings 段插件（data.settings_section 数据引用）外，
 * 每个 ui_feature 插件须被 ≥1 容器引用（无孤儿节点）。 */
function auditUiReachability(universe: Map<string, Plugin>, referrers: Map<string, string[]>): void {
  for (const plugin of universe.values()) {
    if (plugin.kind !== 'ui_feature' || plugin.isUiEntry || plugin.settingsKey !== undefined) continue;
    if ((referrers.get(plugin.id) ?? []).length === 0) {
      violation(plugin.id, 'ui_feature 节点未被任何容器 data.children 引用（孤儿节点；删除或挂回父容器）');
    }
  }
  const entries = [...universe.values()].filter((p) => p.kind === 'ui_feature' && p.isUiEntry);
  if (entries.length === 0) violation('ui_features', '缺装配入口插件（spec.data.root.$ref）');
  if (entries.length > 1) violation('ui_features', `存在多个装配入口: ${entries.map((e) => e.id).join(', ')}`);
}

function printViolations(): void {
  if (violations.length === 0) return;
  console.error(`verify:unload FAIL (${violations.length} 违规)`);
  const byId = new Map<string, string[]>();
  for (const v of violations) {
    const list = byId.get(v.id) ?? [];
    list.push(v.message);
    byId.set(v.id, list);
  }
  for (const [id, messages] of byId) {
    console.error(`  [${id}]`);
    for (const message of messages) console.error(`      ${message}`);
  }
}

function main(): void {
  const planArg = process.argv.indexOf('--plan');
  const planId = planArg !== -1 ? process.argv[planArg + 1] : undefined;

  const universe = loadUniverse();
  const referrers = buildUiReferrers(universe);

  if (planId !== undefined) {
    const plan = unloadPlan(planId, universe, referrers);
    if (!plan.exists) {
      console.error(`verify:unload --plan FAIL: 未知插件 ${planId}（可用 plugins/ 目录枚举 id）`);
      process.exit(1);
    }
    console.log(`卸载影响面 [${plan.id}]（fail-closed：有阻断方即不可独立卸载）`);
    console.log(`  下游 depends 依赖方: ${plan.dependents.length === 0 ? '无' : plan.dependents.join(', ')}`);
    console.log(`  ui 组合引用方(父容器): ${plan.uiReferrers.length === 0 ? '无' : plan.uiReferrers.join(', ')}`);
    console.log(`  级联子树成员(容器卸载含): ${plan.descendants.length === 0 ? '无' : plan.descendants.join(', ')}`);
    const blocked = plan.dependents.length > 0 || plan.uiReferrers.length > 0;
    console.log(blocked ? '  结论：不可独立卸载（先卸/改下游与父容器引用）' : '  结论：可独立卸载');
    process.exit(0);
  }

  auditDependsResolve(universe);
  auditDependsCycle(universe);
  auditFacesAndContract(universe);
  auditRealFaceEntries(universe);
  auditManifestParity(universe);
  auditDataOnlyState(universe);
  auditUiReachability(universe, referrers);

  if (violations.length > 0) {
    printViolations();
    process.exit(1);
  }
  const counts = new Map<string, number>();
  for (const plugin of universe.values()) {
    counts.set(plugin.kind, (counts.get(plugin.kind) ?? 0) + 1);
  }
  const summary = [...counts.entries()].map(([kind, n]) => `${kind} ${n}`).join(' + ');
  console.log(
    `verify:unload PASS（${universe.size} 插件：${summary}；depends/faces/effects 全解析、无环、` +
      `manifest 平价、data-only 状态引脚与 ui 可达性不变式全部成立）`,
  );
}

main();
