#!/usr/bin/env node
/**
 * 同步生成插件源派生视图（plugins/manifest.json + host/src/bridge/commands.generated.ts
 * + plugins/ui.generated.json + host/src/bridge/ui_canonical.generated.ts
 * + host/src/exec/native.generated.ts），
 * plugins/ 各 spec.json 为真源。
 *
 * 职责边界（对齐 PLUGINS.md §1 / docs/component_data_endgame.md §三）：
 * - plugins/<kind>/<id>/spec.json = 能力插件声明真源（唯一手改处）；
 * - plugins/manifest.json = 派生视图**生成物**——从各 spec 聚合（插件索引 +
 *   tools 工具表行 + mcp 市场视图 + ui_features 组件白名单），禁手工维护；
 * - host/src/bridge/commands.generated.ts = 命令面派生视图**生成物**——从
 *   plugins/commands/<id>/spec.json 聚合（各域命令元组 + 域命令类型），
 *   禁手工维护；host 域实现文件据此取方法名/键类型（编译期锁）。
 * - plugins/ui.generated.json = 产品主壳布局派生视图**生成物**——从
 *   plugins/ui_features/<id>/spec.json 装配（装配入口 inkling.ui 的 $ref 树
 *   展开重建完整布局树，与渲染器 UISpec 同构），禁手工维护；web 渲染/
 *   fixture 据此取布局。
 * - host/src/bridge/ui_canonical.generated.ts = 产品 UI canonical 组件白名单
 *   派生视图**生成物**——布局树引用组件 type 并集（升序），禁手工维护；
 *   host 配方白名单与出厂组件面据此装配。
 * - host/src/exec/native.generated.ts = 原生执行件端点派生视图**生成物**——
 *   从 plugins/endpoints/<id>/spec.json 聚合（每二进制 file + env 覆盖键），
 *   禁手工维护；host/src/exec/binary.ts 据此按声明定位（替 binary.ts 手写表）。
 *
 * 消费方一律经派生视图取用：web dev 夹具（backend.ts）、host mcp.market、
 * tools_os 夹具生成（sync_tools_fixtures.mjs）、self_check data 门禁
 * （manifest）；host bridge 命令面（commands.generated.ts）；web 产品主壳
 * （ui.generated.json）；host recipe 界面白名单（ui_canonical.generated.ts）。
 *
 * 规则：
 * - plugins/tools/<tool-name>/spec.json：kind='tool'，spec.data.tool 承载原工具行；
 * - plugins/mcp/<server-id>/spec.json：kind='mcp'，spec.data.server；市场级
 *   元数据（premounted/mount_policy）真源在 plugins/mcp/market.json；
 * - plugins/commands/<method>/spec.json：kind='command'；spec.data.group =
 *   实现域（映射表 DOMAIN_TABLE 的 group），spec.data.order = 域内序号（1..n 升序）。
 *   命令方法名 = spec.id（目录名），域内/跨域顺序均以此数据决定；
 * - plugins/ui_features/<id>/spec.json：kind='ui_feature'，一节点一插件。
 *   装配入口（如 inkling.ui）spec.data 带 name/version/theme + root.$ref；
 *   容器插件 data.node（kind='container'）+ data.children（按序 $ref 子插件）；
 *   组件插件 data.node（kind='component'，叶子无 children）。生成器 DFS 沿
 *   $ref 展开重建完整布局树，循环/缺失/孤儿引用 fail-closed；组件 type 并集
 *   升序 = canonical 白名单；
 * - plugins/endpoints/<id>/spec.json：kind='endpoint'，一个原生执行件一个目录
 *   （exec/infer/mcp，宿主装配期注入）；spec.data.native = 二进制文件名 file +
 *   env 覆盖键；host/src/exec/native.generated.ts 派生视图据此生成。
 * - spec 顶层必含 id/kind/capability；聚合顺序 = 确定性（工具/市场 id 升序；
 *   命令 = DOMAIN_TABLE 顺序 + 域内 data.order；ui = 装配树引用序）；
 * - 派生文件不写任何 spec 未声明内容（除固定 note/version/头注）。
 *
 * 幂等：确定性 JSON（键序固定 + 成员确定性序）/确定性 TS。--check 只校验不落盘。
 */

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PLUGINS_ROOT = join(here, '..');
const MANIFEST = join(PLUGINS_ROOT, 'manifest.json');
const COMMANDS_GENERATED = join(PLUGINS_ROOT, '..', 'host', 'src', 'bridge', 'commands.generated.ts');
const UI_GENERATED = join(PLUGINS_ROOT, 'ui.generated.json');
const UI_CANONICAL_GENERATED = join(PLUGINS_ROOT, '..', 'host', 'src', 'bridge', 'ui_canonical.generated.ts');
const NATIVE_GENERATED = join(PLUGINS_ROOT, '..', 'host', 'src', 'exec', 'native.generated.ts');
const PLUGIN_FACES_GENERATED = join(PLUGINS_ROOT, '..', 'renderer', 'src', 'app', 'pluginFaces.generated.ts');
const SETTINGS_GENERATED = join(PLUGINS_ROOT, '..', 'renderer', 'src', 'app', 'settings', 'settingsSections.generated.ts');

/**
 * 命令实现域映射表（group → const/type 名）；顺序 = BRIDGE_METHODS 跨域序
 * （= host/src/bridge/index.ts spread 序；web_command_surface 夹具逐字比对）。
 * 新增实现域须在此登记 + plugins/commands/<method>/spec.json 指定 group。
 */
const DOMAIN_TABLE = [
  { group: 'rounds', const: 'ROUNDS_COMMANDS', type: 'RoundsCommand' },
  { group: 'todos', const: 'TODOS_COMMANDS', type: 'TodosCommand' },
  { group: 'records', const: 'RECORDS_COMMANDS', type: 'RecordsCommand' },
  { group: 'sessions', const: 'SESSIONS_COMMANDS', type: 'SessionsCommand' },
  { group: 'approval', const: 'APPROVAL_COMMANDS', type: 'ApprovalCommand' },
  { group: 'audit', const: 'AUDIT_COMMANDS', type: 'AuditCommand' },
  { group: 'tools', const: 'TOOLS_COMMANDS', type: 'ToolsCommand' },
  { group: 'recovery', const: 'RECOVERY_COMMANDS', type: 'RecoveryCommand' },
  { group: 'backup', const: 'BACKUP_COMMANDS', type: 'BackupCommand' },
  { group: 'mcp', const: 'MCP_COMMANDS', type: 'McpCommand' },
  { group: 'knowledge', const: 'KNOWLEDGE_COMMANDS', type: 'KnowledgeCommand' },
  { group: 'memory', const: 'MEMORY_COMMANDS', type: 'MemoryCommand' },
  { group: 'growth', const: 'GROWTH_COMMANDS', type: 'GrowthCommand' },
  { group: 'graph', const: 'GRAPH_COMMANDS', type: 'GraphCommand' },
  { group: 'pool', const: 'POOL_COMMANDS', type: 'PoolCommand' },
  { group: 'edge_evidence', const: 'EDGE_EVIDENCE_COMMANDS', type: 'EdgeEvidenceCommand' },
  { group: 'metrics', const: 'METRICS_COMMANDS', type: 'MetricsCommand' },
  { group: 'assemble', const: 'ASSEMBLE_COMMANDS', type: 'AssembleCommand' },
  { group: 'cache', const: 'CACHE_COMMANDS', type: 'CacheCommand' },
  { group: 'path', const: 'PATH_COMMANDS', type: 'PathCommand' },
  { group: 'entities', const: 'ENTITIES_COMMANDS', type: 'EntitiesCommand' },
  { group: 'os', const: 'OS_COMMANDS', type: 'OsCommand' },
  { group: 'search', const: 'SEARCH_COMMANDS', type: 'SearchCommand' },
  { group: 'material', const: 'MATERIAL_COMMANDS', type: 'MaterialCommand' },
  { group: 'models', const: 'MODELS_COMMANDS', type: 'ModelsCommand' },
  { group: 'model_archive', const: 'MODEL_ARCHIVE_COMMANDS', type: 'ModelArchiveCommand' },
  { group: 'capability', const: 'CAPABILITY_COMMANDS', type: 'CapabilityCommand' },
  { group: 'policy', const: 'POLICY_COMMANDS', type: 'PolicyCommand' },
  { group: 'ui_components', const: 'UI_COMPONENTS_COMMANDS', type: 'UiComponentsCommand' },
  { group: 'workspace', const: 'WORKSPACE_COMMANDS', type: 'WorkspaceCommand' },
  { group: 'dialog', const: 'DIALOG_COMMANDS', type: 'DialogCommand' },
];

const MANIFEST_NOTE =
  '插件源派生视图（生成物，禁手改）：由 plugins/scripts/sync_plugin_manifest.mjs ' +
  '从 plugins/<kind>/<id>/spec.json 聚合生成；改工具/市场/命令/ui 声明只改 spec.json，' +
  '重跑本脚本同步。tools = kind=tool 工具表行（data.tool 逐字，id 升序）；' +
  'mcp_market = kind=mcp 市场视图（data.server + market.json 全局配置）；' +
  'ui_features = 产品主壳布局装配（plugins/ui_features 真源）派生：components = 布局树' +
  '引用组件 type 并集（升序，canonical 白名单；host/ui_canonical.generated.ts 同源）；' +
  'plugins = 全插件索引（id/kind/capability/包名/目录；行可携带 spec 顶层声明的 ' +
  'actions/depends/faces/contract——CapabilityComponent 全脸字段，未声明不输出；' +
  '引用解析/effects 词表语义由 verify:unload 校验）。endpoints = kind=endpoint ' +
  '原生执行件端点声明（data.native；host/src/exec/native.generated.ts 同源派生）。';

const COMMANDS_HEADER =
  '/**\n' +
  ' * 生成文件勿手改：命令面声明派生视图（真源 = plugins/commands/<id>/spec.json）。\n' +
  ' * 由 plugins/scripts/sync_plugin_manifest.mjs 生成（data.group 决定实现域、\n' +
  ' * data.order 决定域内顺序；跨域序见 DOMAIN_TABLE）。改命令声明只改\n' +
  ' * plugins/commands/<id>/spec.json 后重跑生成器；verify:plugin-manifest 强制。\n' +
  ' */\n';

const UI_CANONICAL_HEADER =
  '/**\n' +
  ' * 生成文件勿手改：产品 UI canonical 组件白名单派生视图（真源 = plugins/ui_features/<id>/spec.json\n' +
  ' * 布局树引用组件 type 并集，升序）。由 plugins/scripts/sync_plugin_manifest.mjs 生成；\n' +
  ' * host 配方界面白名单与出厂组件面据此装配；verify:plugin-manifest 强制逐字一致。\n' +
  ' */\n';

const NATIVE_HEADER =
  '/**\n' +
  ' * 生成文件勿手改：原生执行件端点声明派生视图（真源 = plugins/endpoints/<id>/spec.json\n' +
  ' * 的 data.native：二进制文件名 file + env 覆盖键）。由 plugins/scripts/sync_plugin_manifest.mjs\n' +
  ' * 生成；host/src/exec/binary.ts 据此按声明定位；verify:plugin-manifest 强制逐字一致。\n' +
  ' */\n';

const PLUGIN_FACES_HEADER =
  '/**\n' +
  ' * 生成文件勿手改：渲染器插件 ui 面注册派生视图（真源 = plugins/ui_features/<id>/spec.json\n' +
  ' * 的 faces.ui + data.node（kind=component））。由 plugins/scripts/sync_plugin_manifest.mjs\n' +
  ' * 生成（按插件 id 升序静态 import 各真 ui 面 entry + registerComponent 白名单注册）；\n' +
  ' * renderer 装配期经 registerPluginFaces() 调用；verify:plugin-manifest 强制逐字一致。\n' +
  ' */\n';

const SETTINGS_HEADER =
  '/**\n' +
  ' * 生成文件勿手改：设置页段清单派生视图（真源 = plugins/ui_features/<id>/spec.json\n' +
  ' * 的 data.settings_section：key/label/order/icon + faces.ui）。由\n' +
  ' * plugins/scripts/sync_plugin_manifest.mjs 生成（order 升序）；renderer 设置浮层\n' +
  ' * 壳读本清单渲染导航与内容（DynamicComponent name=插件 id）；verify:plugin-manifest\n' +
  ' * 强制逐字一致。\n' +
  ' */\n';

async function fail(message) {
  throw new Error(message);
}

async function listDirs(parent) {
  let entries = [];
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** 顶层全脸字段形状校验（CapabilityComponent：actions/depends/faces/contract）。
 *  引用可解析性（depends 指向存在的插件/机制端口、effects 在端口词表内）属语义
 *  校验，由 plugins/scripts/verify_unload.ts 执行（它经 tsx 引用引擎端口单一真源）；
 *  本生成器只守 JSON 形状，防畸形声明进派生视图。 */
const FACE_TARGETS = new Set(['engine', 'host', 'web']);
const FACE_KEYS = new Set(['ui', 'logic', 'data']);

async function validateDeclared(spec, kind, id) {
  if (spec.actions !== undefined) {
    if (!Array.isArray(spec.actions) || spec.actions.some((a) => typeof a !== 'string' || a.length === 0)) {
      await fail(`${kind} 插件 ${id} 的 actions 须为非空字符串数组`);
    }
  }
  if (spec.depends !== undefined) {
    if (!Array.isArray(spec.depends) || spec.depends.some((d) => typeof d !== 'string' || d.length === 0)) {
      await fail(`${kind} 插件 ${id} 的 depends 须为非空字符串数组`);
    }
  }
  if (spec.faces !== undefined) {
    if (typeof spec.faces !== 'object' || spec.faces === null || Array.isArray(spec.faces)) {
      await fail(`${kind} 插件 ${id} 的 faces 须为对象（{ui|logic|data}: FaceRef）`);
    }
    for (const [face, ref] of Object.entries(spec.faces)) {
      if (!FACE_KEYS.has(face)) await fail(`${kind} 插件 ${id} 的 faces 出现未知脸: ${face}（只允许 ui/logic/data）`);
      if (typeof ref !== 'object' || ref === null || typeof ref.target !== 'string' || !FACE_TARGETS.has(ref.target)) {
        await fail(`${kind} 插件 ${id} 的 faces.${face} 缺合法 target（engine|host|web）`);
      }
      if (typeof ref.entry !== 'string' || ref.entry.length === 0) {
        await fail(`${kind} 插件 ${id} 的 faces.${face} 缺非空 entry`);
      }
    }
  }
  if (spec.contract !== undefined) {
    if (typeof spec.contract !== 'object' || spec.contract === null || Array.isArray(spec.contract)) {
      await fail(`${kind} 插件 ${id} 的 contract 须为对象`);
    }
    if (spec.contract.effects !== undefined) {
      if (!Array.isArray(spec.contract.effects) || spec.contract.effects.some((e) => typeof e !== 'string' || e.length === 0)) {
        await fail(`${kind} 插件 ${id} 的 contract.effects 须为非空字符串数组`);
      }
    }
  }
}

/** 注册表行携带的顶层声明字段（缺省/空数组不输出，保持现有派生视图字节不变）。 */
function declaredRow(spec) {
  const row = {};
  if (Array.isArray(spec.actions) && spec.actions.length > 0) row.actions = spec.actions;
  if (Array.isArray(spec.depends) && spec.depends.length > 0) row.depends = spec.depends;
  if (spec.contract !== undefined) row.contract = spec.contract;
  if (spec.faces !== undefined) row.faces = spec.faces;
  return row;
}

async function readSpec(dir, kind) {
  const specPath = join(dir, 'spec.json');
  let text;
  try {
    text = await readFile(specPath, 'utf8');
  } catch {
    await fail(`${kind} 插件缺 spec.json: ${dir}`);
  }
  let spec;
  try {
    spec = JSON.parse(text);
  } catch (err) {
    await fail(`spec.json 解析失败: ${specPath}（${err.message}）`);
  }
  if (typeof spec !== 'object' || spec === null || typeof spec.id !== 'string') {
    await fail(`${kind} 插件 spec 缺 id: ${specPath}`);
  }
  if (spec.kind !== kind) await fail(`${kind} 插件 spec.kind 不符: ${spec.id}`);
  await validateDeclared(spec, kind, spec.id);
  return spec;
}

async function loadPackage(dir) {
  try {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    return typeof pkg === 'object' && pkg !== null && typeof pkg.name === 'string'
      ? pkg.name
      : '';
  } catch {
    return '';
  }
}

const groupByName = new Map(DOMAIN_TABLE.map((d) => [d.group, d]));

async function derive() {
  const plugins = [];

  // kind='tool'：plugins/tools/<id>/spec.json → data.tool 逐字聚合
  const toolRows = [];
  for (const id of await listDirs(join(PLUGINS_ROOT, 'tools'))) {
    const dir = join(PLUGINS_ROOT, 'tools', id);
    const spec = await readSpec(dir, 'tool');
    if (typeof spec.data?.tool !== 'object' || spec.data.tool === null) {
      await fail(`tool 插件 ${id} 缺 data.tool`);
    }
    if (spec.data.tool.name !== id) await fail(`tool 插件 ${id} data.tool.name 与目录不符`);
    toolRows.push(spec.data.tool);
    plugins.push({
      id,
      kind: 'tool',
      capability: spec.capability ?? 'host_tool',
      package: await loadPackage(dir),
      dir: `tools/${id}`,
      ...declaredRow(spec),
    });
  }

  // kind='mcp'：plugins/mcp/<id>/spec.json → data.server 逐字聚合 + market.json 全局配置
  const servers = [];
  for (const id of await listDirs(join(PLUGINS_ROOT, 'mcp'))) {
    const dir = join(PLUGINS_ROOT, 'mcp', id);
    const spec = await readSpec(dir, 'mcp');
    if (typeof spec.data?.server !== 'object' || spec.data.server === null) {
      await fail(`mcp 插件 ${id} 缺 data.server`);
    }
    if (spec.data.server.id !== id) await fail(`mcp 插件 ${id} data.server.id 与目录不符`);
    servers.push(spec.data.server);
    plugins.push({
      id,
      kind: 'mcp',
      capability: spec.capability ?? 'external_tool',
      package: await loadPackage(dir),
      dir: `mcp/${id}`,
      ...declaredRow(spec),
    });
  }

  let marketMeta = {};
  try {
    marketMeta = JSON.parse(await readFile(join(PLUGINS_ROOT, 'mcp', 'market.json'), 'utf8'));
  } catch {
    await fail('mcp 域缺 market.json（premounted/mount_policy 真源）');
  }

  // kind='command'：plugins/commands/<method>/spec.json → 按 group/order 归组
  const commands = []; // { id, group, order }
  for (const id of await listDirs(join(PLUGINS_ROOT, 'commands'))) {
    const dir = join(PLUGINS_ROOT, 'commands', id);
    const spec = await readSpec(dir, 'command');
    if (typeof spec.data?.group !== 'string' || typeof spec.data?.order !== 'number') {
      await fail(`command 插件 ${id} 缺 data.group/data.order`);
    }
    if (!groupByName.has(spec.data.group)) {
      await fail(`command 插件 ${id} data.group 未在 DOMAIN_TABLE 登记: ${spec.data.group}`);
    }
    const seen = new Set(commands.map((c) => c.id));
    if (seen.has(id)) await fail(`command 插件重复方法: ${id}`);
    if (commands.some((c) => c.group === spec.data.group && c.order === spec.data.order)) {
      await fail(`command 插件 ${id} data.order 冲突（group=${spec.data.group} order=${spec.data.order}）`);
    }
    commands.push({ id, group: spec.data.group, order: spec.data.order });
    plugins.push({
      id,
      kind: 'command',
      capability: spec.capability ?? 'host_tool',
      package: await loadPackage(dir),
      dir: `commands/${id}`,
      ...declaredRow(spec),
    });
  }

  // 命令域完整性：每个登记域须有 ≥1 命令；域内 order 连续 1..n 无缺
  const byGroup = new Map();
  for (const c of commands) {
    const list = byGroup.get(c.group) ?? [];
    list.push(c);
    byGroup.set(c.group, list);
  }
  for (const domain of DOMAIN_TABLE) {
    const list = (byGroup.get(domain.group) ?? []).sort((a, b) => a.order - b.order);
    if (list.length === 0) await fail(`命令域 ${domain.group} 无任何命令插件（DOMAIN_TABLE 孤儿）`);
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].order !== i + 1) {
        await fail(`命令域 ${domain.group} 的 ${list[i].id} order=${list[i].order}，应连续 1..${list.length}`);
      }
    }
  }

  // kind='ui_feature'：plugins/ui_features/<id>/spec.json，一节点一插件。
  // 装配入口（spec.data 带 name/version/theme/root.$ref）全局唯一；容器插件
  // data.node（kind='container'）+ data.children（按序 $ref 子插件）；组件插件
  // data.node（kind='component'，叶子）。DFS 沿 $ref 展开重建布局树：引用缺失/
  // 环/组件带 children/孤儿节点插件一律 fail-closed。组件 type 并集（升序）=
  // canonical 白名单（ui.generated.json 与 host ui_canonical.generated.ts 共用）。
  const uiFeatures = [];
  for (const id of await listDirs(join(PLUGINS_ROOT, 'ui_features'))) {
    const dir = join(PLUGINS_ROOT, 'ui_features', id);
    const spec = await readSpec(dir, 'ui_feature');
    uiFeatures.push({ id, spec });
    plugins.push({
      id,
      kind: 'ui_feature',
      capability: spec.capability ?? 'host_tool',
      package: await loadPackage(dir),
      dir: `ui_features/${id}`,
      ...declaredRow(spec),
    });
  }
  // kind='endpoint'：plugins/endpoints/<id>/spec.json → 原生执行件端点声明
  // （data.native：file 二进制文件名 + env 覆盖键）。三件套 exec/infer/mcp 由
  // host/src/exec/native.generated.ts 派生（host/src/exec/binary.ts 按声明定位）。
  const nativeDecls = [];
  for (const id of await listDirs(join(PLUGINS_ROOT, 'endpoints'))) {
    const dir = join(PLUGINS_ROOT, 'endpoints', id);
    const spec = await readSpec(dir, 'endpoint');
    const native = spec.data?.native;
    if (typeof native !== 'object' || native === null) {
      await fail(`endpoint 插件 ${id} 缺 data.native`);
    }
    if (typeof native.file !== 'string' || native.file.length === 0) {
      await fail(`endpoint 插件 ${id} 缺 data.native.file（二进制文件名）`);
    }
    if (typeof native.env !== 'string' || native.env.length === 0) {
      await fail(`endpoint 插件 ${id} 缺 data.native.env（env 覆盖键）`);
    }
    nativeDecls.push({ id, file: native.file, env: native.env });
    plugins.push({
      id,
      kind: 'endpoint',
      capability: spec.capability ?? 'host_tool',
      package: await loadPackage(dir),
      dir: `endpoints/${id}`,
      ...declaredRow(spec),
    });
  }
  const entryList = uiFeatures.filter(
    (f) => typeof f.spec.data?.root === 'object' && f.spec.data.root !== null,
  );
  if (entryList.length === 0) {
    await fail('ui_features 域缺装配入口插件（唯一一份 spec.data 带 root.$ref）');
  }
  if (entryList.length > 1) {
    await fail(`ui_features 存在多个装配入口（root 只允许一份）: ${entryList.map((f) => f.id).join(', ')}`);
  }
  const uiEntry = entryList[0];
  const uiByName = new Map(uiFeatures.map((f) => [f.id, f]));
  const uiReached = new Set();
  const uiComponents = [];
  const uiFaces = [];
  async function expandUi(ref, stack) {
    if (stack.includes(ref)) {
      await fail(`ui 引用成环: ${[...stack, ref].join(' -> ')}`);
    }
    const feat = uiByName.get(ref);
    if (!feat) await fail(`ui 引用缺失插件: ${ref}`);
    const node = feat.spec.data?.node;
    if (typeof node !== 'object' || node === null || (node.kind !== 'container' && node.kind !== 'component')) {
      await fail(`ui_feature 插件 ${ref} 缺 data.node（kind 须为 container|component）`);
    }
    if (typeof node.type !== 'string' || node.type.length === 0) {
      await fail(`ui_feature 插件 ${ref} 的 data.node.type 缺失`);
    }
    const next = { kind: node.kind, type: node.type };
    if (node.props !== undefined) next.props = node.props;
    if (node.bind !== undefined) next.bind = node.bind;
    if (node.kind === 'container') {
      if (!Array.isArray(feat.spec.data.children)) {
        await fail(`ui 容器插件 ${ref} 缺 data.children（按序 $ref 子插件）`);
      }
      const kids = [];
      for (const slot of feat.spec.data.children) {
        if (typeof slot !== 'object' || slot === null || typeof slot.$ref !== 'string') {
          await fail(`ui 容器插件 ${ref} 的 data.children 项须为 { "$ref": "<插件 id>" }`);
        }
        kids.push(await expandUi(slot.$ref, [...stack, ref]));
      }
      next.children = kids;
    } else if (feat.spec.data.children !== undefined) {
      await fail(`ui 组件插件 ${ref} 不得带 data.children（组件为叶子）`);
    }
    uiReached.add(ref);
    if (node.kind === 'component') {
      uiComponents.push(node.type);
      const facesUi = typeof feat.spec.faces === 'object' && feat.spec.faces !== null
        ? feat.spec.faces.ui
        : undefined;
      if (typeof facesUi === 'object' && facesUi !== null && typeof facesUi.entry === 'string') {
        uiFaces.push({ id: ref, type: node.type, entry: facesUi.entry });
      }
    }
    return next;
  }
  const uiRoot = await expandUi(uiEntry.spec.data.root.$ref, []);
  // settings 段（阶段 7b settings 面板插件）：ui_feature 组件插件可经
  // data.settings_section 声明为设置页内容段（key/label/order/icon）——不走
  // 布局树 $ref，由设置浮层壳读派生清单渲染（data-reference 挂载）；声明者须
  // faces.ui（真 ui 面）且不被布局树引用豁免。
  const settingsSections = [];
  for (const f of uiFeatures) {
    const meta = f.spec.data?.settings_section;
    if (typeof meta !== 'object' || meta === null) continue;
    if (typeof meta.key !== 'string' || meta.key.length === 0) {
      await fail(`settings 面板插件 ${f.id} 缺 data.settings_section.key`);
    }
    if (typeof meta.label !== 'string' || meta.label.length === 0) {
      await fail(`settings 面板插件 ${f.id} 缺 data.settings_section.label`);
    }
    if (typeof meta.order !== 'number' || !Number.isFinite(meta.order)) {
      await fail(`settings 面板插件 ${f.id} 的 data.settings_section.order 须为有限数字`);
    }
    const node = f.spec.data?.node;
    if (typeof node !== 'object' || node === null || node.kind !== 'component') {
      await fail(`settings 面板插件 ${f.id} 须为组件节点（data.node.kind=component）`);
    }
    const facesUi = typeof f.spec.faces === 'object' && f.spec.faces !== null ? f.spec.faces.ui : undefined;
    if (typeof facesUi !== 'object' || facesUi === null || typeof facesUi.entry !== 'string') {
      await fail(`settings 面板插件 ${f.id} 须声明 faces.ui（真 ui 面）`);
    }
    const row = { id: f.id, type: node.type, key: meta.key, label: meta.label, order: meta.order };
    if (typeof meta.icon === 'string' && meta.icon.length > 0) row.icon = meta.icon;
    row.entry = facesUi.entry;
    settingsSections.push(row);
  }
  settingsSections.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  for (const f of uiFeatures) {
    if (f.id !== uiEntry.id && !uiReached.has(f.id) && !f.spec.data?.settings_section) {
      await fail(`ui_feature 插件 ${f.id} 未被装配树引用（孤儿）`);
    }
  }
  // settings 面板经 settings 清单引用（非布局树），同样要注册进 pluginFaces
  // （壳以 DynamicComponent name=插件 id 渲染）。
  const uiFacesById = new Set(uiFaces.map((f) => f.id));
  for (const s of settingsSections) {
    if (!uiFacesById.has(s.id)) uiFaces.push({ id: s.id, type: s.type, entry: s.entry });
  }
  const uiLayout = {
    name: uiEntry.spec.data.name,
    version: uiEntry.spec.data.version,
    theme: uiEntry.spec.data.theme,
    root: uiRoot,
  };
  if (typeof uiLayout.name !== 'string' || uiLayout.name.length === 0) {
    await fail(`ui 装配入口 ${uiEntry.id} 缺 data.name`);
  }
  if (uiEntry.spec.data.root === null || typeof uiEntry.spec.data.root.$ref !== 'string') {
    await fail(`ui 装配入口 ${uiEntry.id} 缺 data.root.$ref`);
  }
  const uiCanonical = [...new Set(uiComponents)].sort();

  return {
    version: 1,
    note: MANIFEST_NOTE,
    plugins,
    tools: toolRows,
    mcp_market: {
      premounted: marketMeta.premounted === true,
      mount_policy:
        typeof marketMeta.mount_policy === 'object' && marketMeta.mount_policy !== null
          ? marketMeta.mount_policy
          : {},
      servers,
    },
    commands,
    ui_features: {
      components: uiCanonical,
      settings: settingsSections,
    },
    ui_layout: uiLayout,
    ui_faces: uiFaces,
    native: nativeDecls,
  };
}

function render(data) {
  const order = {
    version: 1, note: 2, plugins: 3, tools: 4, mcp_market: 5,
    commands: 6, ui_features: 7,
  };
  const toolOrder = {
    name: 1, description: 2, parameters: 3, permissions: 4, approval: 5,
    endpoint: 6, endpoint_config: 7, network_policy: 8, meta: 9,
  };
  const serverOrder = {
    id: 1, name: 2, source: 3, transport: 4, url: 5, command: 6, args: 7,
    credentials: 8, risk: 9, risk_note: 10, category: 11, premounted: 12,
  };

  const sortKeys = (obj, priority) => {
    const out = {};
    for (const key of Object.keys(obj).sort((a, b) => {
      const pa = priority[a] ?? 9;
      const pb = priority[b] ?? 9;
      return pa !== pb ? pa - pb : a.localeCompare(b);
    })) {
      out[key] = obj[key];
    }
    return out;
  };

  const tools = data.tools.map((t) => sortKeys(t, toolOrder));
  const servers = data.mcp_market.servers.map((s) => sortKeys(s, serverOrder));
  const market = sortKeys(
    { premounted: data.mcp_market.premounted, mount_policy: data.mcp_market.mount_policy, servers },
    { premounted: 1, mount_policy: 1, servers: 1 },
  );
  const settingsOrder = { id: 1, type: 2, key: 3, label: 4, order: 5, icon: 6, entry: 7 };
  const settings = data.ui_features.settings.map((s) => sortKeys(s, settingsOrder));
  return JSON.stringify(
    sortKeys(
      {
        version: data.version,
        note: data.note,
        plugins: data.plugins,
        tools,
        mcp_market: market,
        commands: data.commands,
        ui_features: { components: data.ui_features.components, settings },
      },
      order,
    ),
    null,
    2,
  ) + '\n';
}

/** 渲染 ui.generated.json（产品主壳完整布局树；布局 = 装配入口 data.name/version/
 *  theme + $ref 展开 root。键序与迁移前的 seed_data/ui_spec.json 一致，渲染器 UISpec 同构）。 */
function renderUiLayout(layout) {
  return JSON.stringify(layout, null, 2) + '\n';
}

/** 渲染 host ui_canonical.generated.ts（canonical 组件白名单 = 布局树引用 type 并集升序）。 */
function renderUiCanonicalTs(components) {
  const lines = [UI_CANONICAL_HEADER];
  lines.push('export const UI_CANONICAL_COMPONENTS = [');
  for (const name of components) lines.push(`  '${name}',`);
  lines.push('] as const;');
  return lines.join('\n');
}

/** 渲染命令派生 TS（各域元组 + 域命令类型；顺序 = DOMAIN_TABLE × data.order）。 */
function renderCommandsTs(commands) {
  const byGroup = new Map();
  for (const c of commands) {
    const list = byGroup.get(c.group) ?? [];
    list.push(c);
    byGroup.set(c.group, list);
  }
  const lines = [COMMANDS_HEADER];
  for (const domain of DOMAIN_TABLE) {
    const list = (byGroup.get(domain.group) ?? []).sort((a, b) => a.order - b.order);
    const names = list.map((c) => c.id);
    lines.push(`/** ${domain.group} 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */`);
    lines.push(`export const ${domain.const} = [`);
    for (const name of names) lines.push(`  '${name}',`);
    lines.push(`] as const;`);
    lines.push('');
    lines.push(`export type ${domain.type} = (typeof ${domain.const})[number];`);
    lines.push('');
  }
  return lines.join('\n');
}

/** 渲染原生执行件端点派生 TS（NATIVE_BINARY_DECLS + NativeBinaryKind 类型；顺序 = id 升序）。 */
function renderNativeTs(nativeDecls) {
  const lines = [NATIVE_HEADER];
  lines.push('export const NATIVE_BINARY_DECLS = [');
  for (const decl of nativeDecls) {
    lines.push(`  { id: '${decl.id}', file: '${decl.file}', env: '${decl.env}' },`);
  }
  lines.push('] as const;');
  lines.push('');
  lines.push('export type NativeBinaryKind = (typeof NATIVE_BINARY_DECLS)[number][\'id\'];');
  lines.push('');
  return lines.join('\n');
}

/** 渲染渲染器插件 ui 面注册派生 TS（真源 = plugins/ui_features/<id>/spec.json 的
 *  faces.ui + data.node（kind=component）；装配期 registerPluginFaces() 把每个真
 *  ui 面插件的默认导出注册进 componentRegistry 白名单（名 = 插件 id，canonical
 *  叶子 id = data.node.type）。entry 相对插件目录，禁逃逸由 verify:unload 强制；
 *  本文件按 id 升序静态 import（构建期把插件 ui 实现编入渲染器产物）。 */
function renderPluginFacesTs(uiFaces) {
  const lines = [PLUGIN_FACES_HEADER];
  if (uiFaces.length > 0) {
    lines.push(`import type { PlainComponent } from '../renderer/componentRegistry';`);
    lines.push(`import { registerComponent } from '../renderer/componentRegistry';`);
    lines.push('');
    lines.push(`export interface UiFaceEntry {`);
    lines.push(`  id: string;`);
    lines.push(`  type: string;`);
    lines.push(`  entry: string;`);
    lines.push(`}`);
    lines.push('');
    lines.push('export const PLUGIN_UI_FACES: UiFaceEntry[] = [');
    for (const f of uiFaces) {
      lines.push(`  { id: '${f.id}', type: '${f.type}', entry: '../../../plugins/ui_features/${f.id}/${f.entry.replace(/^\.\//, '')}' },`);
    }
    lines.push('] as const;');
    lines.push('');
    lines.push('/** 装配期调用：把各真 ui 面插件的默认导出注册进渲染器白名单。 */');
    lines.push('export function registerPluginFaces(): void {');
    for (const f of uiFaces) {
      const alias = `${f.id.replace(/[.-]/g, '_')}Default`;
      lines.push(`  registerComponent('${f.id}', (${alias} as unknown) as PlainComponent);`);
    }
    lines.push('}');
    lines.push('');
    for (const f of uiFaces) {
      const alias = `${f.id.replace(/[.-]/g, '_')}Default`;
      const rel = `../../../plugins/ui_features/${f.id}/${f.entry.replace(/^\.\//, '')}`;
      lines.push(`import ${alias} from '${rel}';`);
    }
  } else {
    lines.push('/** 当前无声明 faces.ui 的真 ui 面插件；随 7b 迁移逐个补入。 */');
    lines.push('export function registerPluginFaces(): void {');
    lines.push('  // 空：无真 ui 面插件');
    lines.push('}');
  }
  return lines.join('\n') + '\n';
}

/** 渲染设置页段清单派生 TS（真源 = plugins/ui_features/<id>/spec.json 的
 *  data.settings_section；order 升序。renderer 设置浮层壳读此清单渲染导航，
 *  DynamicComponent name = 插件 id（pluginFaces.generated.ts 已注册）。 */
function renderSettingsSectionsTs(settings) {
  const lines = [SETTINGS_HEADER];
  lines.push('export interface SettingsSectionEntry {');
  lines.push('  id: string;');
  lines.push('  type: string;');
  lines.push('  key: string;');
  lines.push('  label: string;');
  lines.push('  order: number;');
  lines.push('  icon?: string;');
  lines.push('}');
  lines.push('');
  lines.push('export const SETTINGS_SECTIONS: SettingsSectionEntry[] = [');
  for (const s of settings) {
    const icon = typeof s.icon === 'string' ? `, icon: '${s.icon}'` : '';
    lines.push(`  { id: '${s.id}', type: '${s.type}', key: '${s.key}', label: '${s.label}', order: ${s.order}${icon} },`);
  }
  lines.push('];');
  return lines.join('\n') + '\n';
}

async function fileExists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function compareFile(path, rendered, label, hint) {
  if (!(await fileExists(path))) {
    console.error(`${label} 缺失: ${path}`);
    return false;
  }
  const current = (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
  if (current !== rendered) {
    console.error(`${label} 漂移: ${path} 与 plugins 真源派生产物不一致（重跑 ${hint}）`);
    return false;
  }
  console.log(`${label} 与 plugins 真源派生产物一致`);
  return true;
}

async function main() {
  const check = process.argv.includes('--check');
  const data = await derive();
  const manifestRendered = render(data);
  const commandsRendered = renderCommandsTs(data.commands);
  const uiRendered = renderUiLayout(data.ui_layout);
  const uiCanonicalRendered = renderUiCanonicalTs(data.ui_features.components);
  const nativeRendered = renderNativeTs(data.native);
  const pluginFacesRendered = renderPluginFacesTs(data.ui_faces);
  const settingsRendered = renderSettingsSectionsTs(data.ui_features.settings);

  if (check) {
    const okManifest = await compareFile(MANIFEST, manifestRendered, 'manifest', 'sync_plugin_manifest.mjs');
    const okCommands = await compareFile(
      COMMANDS_GENERATED,
      commandsRendered,
      'commands.generated.ts',
      'sync_plugin_manifest.mjs',
    );
    const okUi = await compareFile(UI_GENERATED, uiRendered, 'ui.generated.json', 'sync_plugin_manifest.mjs');
    const okUiCanonical = await compareFile(
      UI_CANONICAL_GENERATED,
      uiCanonicalRendered,
      'ui_canonical.generated.ts',
      'sync_plugin_manifest.mjs',
    );
    const okNative = await compareFile(
      NATIVE_GENERATED,
      nativeRendered,
      'native.generated.ts',
      'sync_plugin_manifest.mjs',
    );
    const okPluginFaces = await compareFile(
      PLUGIN_FACES_GENERATED,
      pluginFacesRendered,
      'pluginFaces.generated.ts',
      'sync_plugin_manifest.mjs',
    );
    const okSettings = await compareFile(
      SETTINGS_GENERATED,
      settingsRendered,
      'settingsSections.generated.ts',
      'sync_plugin_manifest.mjs',
    );
    if (!okManifest || !okCommands || !okUi || !okUiCanonical || !okNative || !okPluginFaces || !okSettings) process.exitCode = 1;
    return;
  }

  await mkdir(PLUGINS_ROOT, { recursive: true });
  await writeFile(MANIFEST, manifestRendered, 'utf8');
  await mkdir(dirname(COMMANDS_GENERATED), { recursive: true });
  await writeFile(COMMANDS_GENERATED, commandsRendered, 'utf8');
  await writeFile(UI_GENERATED, uiRendered, 'utf8');
  await writeFile(UI_CANONICAL_GENERATED, uiCanonicalRendered, 'utf8');
  await mkdir(dirname(NATIVE_GENERATED), { recursive: true });
  await writeFile(NATIVE_GENERATED, nativeRendered, 'utf8');
  await mkdir(dirname(PLUGIN_FACES_GENERATED), { recursive: true });
  await writeFile(PLUGIN_FACES_GENERATED, pluginFacesRendered, 'utf8');
  await mkdir(dirname(SETTINGS_GENERATED), { recursive: true });
  await writeFile(SETTINGS_GENERATED, settingsRendered, 'utf8');
  console.log(
    `已生成 manifest.json + commands.generated.ts + ui.generated.json + ` +
      `ui_canonical.generated.ts + native.generated.ts + pluginFaces.generated.ts + ` +
      `settingsSections.generated.ts（${data.plugins.length} 插件：` +
      `${data.tools.length} tools + ${data.mcp_market.servers.length} mcp + ` +
      `${data.commands.length} commands + ` +
      `${data.plugins.filter((p) => p.kind === 'ui_feature').length} ui_features + ` +
      `${data.native.length} endpoints + ${data.ui_faces.length} 真 ui 面 + ` +
      `${data.ui_features.settings.length} settings 段，真源 plugins/）`,
  );
}

await main();
