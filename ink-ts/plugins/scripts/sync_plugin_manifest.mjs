#!/usr/bin/env node
/**
 * 同步生成插件源派生视图（plugins/manifest.json + host/src/bridge/commands.generated.ts），
 * plugins/ 各 spec.json 为真源。
 *
 * 职责边界（对齐 PLUGINS.md §1 / docs/component_data_endgame.md §三）：
 * - plugins/<kind>/<id>/spec.json = 能力插件声明真源（唯一手改处）；
 * - plugins/manifest.json = 派生视图**生成物**——从各 spec 聚合（插件索引 +
 *   tools 工具表行 + mcp 市场视图），禁手工维护；
 * - host/src/bridge/commands.generated.ts = 命令面派生视图**生成物**——从
 *   plugins/commands/<id>/spec.json 聚合（各域命令元组 + 域命令类型），
 *   禁手工维护；host 域实现文件据此取方法名/键类型（编译期锁）。
 *
 * 消费方一律经派生视图取用：web dev 夹具（backend.ts）、host mcp.market、
 * tools_os 夹具生成（sync_tools_fixtures.mjs）、self_check data 门禁
 * （manifest）；host bridge 命令面（commands.generated.ts）。
 *
 * 规则：
 * - plugins/tools/<tool-name>/spec.json：kind='tool'，spec.data.tool 承载原工具行；
 * - plugins/mcp/<server-id>/spec.json：kind='mcp'，spec.data.server；市场级
 *   元数据（premounted/mount_policy）真源在 plugins/mcp/market.json；
 * - plugins/commands/<method>/spec.json：kind='command'；spec.data.group =
 *   实现域（映射表 DOMAIN_TABLE 的 group），spec.data.order = 域内序号（1..n 升序）。
 *   命令方法名 = spec.id（目录名），域内/跨域顺序均以此数据决定；
 * - spec 顶层必含 id/kind/capability；聚合顺序 = 确定性（工具/市场 id 升序；
 *   命令 = DOMAIN_TABLE 顺序 + 域内 data.order）；
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
  '从 plugins/<kind>/<id>/spec.json 聚合生成；改工具/市场声明只改 spec.json，' +
  '重跑本脚本同步。tools = kind=tool 工具表行（data.tool 逐字，id 升序）；' +
  'mcp_market = kind=mcp 市场视图（data.server + market.json 全局配置）；' +
  'plugins = 全插件索引（id/kind/capability/包名/目录）。';

const COMMANDS_HEADER =
  '/**\n' +
  ' * 生成文件勿手改：命令面声明派生视图（真源 = plugins/commands/<id>/spec.json）。\n' +
  ' * 由 plugins/scripts/sync_plugin_manifest.mjs 生成（data.group 决定实现域、\n' +
  ' * data.order 决定域内顺序；跨域序见 DOMAIN_TABLE）。改命令声明只改\n' +
  ' * plugins/commands/<id>/spec.json 后重跑生成器；verify:plugin-manifest 强制。\n' +
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
  };
}

function render(data) {
  const order = { version: 1, note: 2, plugins: 3, tools: 4, mcp_market: 5 };
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
  return JSON.stringify(sortKeys({ ...data, tools, mcp_market: market }, order), null, 2) + '\n';
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

  if (check) {
    const okManifest = await compareFile(MANIFEST, manifestRendered, 'manifest', 'sync_plugin_manifest.mjs');
    const okCommands = await compareFile(
      COMMANDS_GENERATED,
      commandsRendered,
      'commands.generated.ts',
      'sync_plugin_manifest.mjs',
    );
    if (!okManifest || !okCommands) process.exitCode = 1;
    return;
  }

  await mkdir(PLUGINS_ROOT, { recursive: true });
  await writeFile(MANIFEST, manifestRendered, 'utf8');
  await mkdir(dirname(COMMANDS_GENERATED), { recursive: true });
  await writeFile(COMMANDS_GENERATED, commandsRendered, 'utf8');
  console.log(
    `已生成 manifest.json + commands.generated.ts（${data.plugins.length} 插件：${data.tools.length} tools + ${data.mcp_market.servers.length} mcp + ${data.commands.length} commands，真源 plugins/）`,
  );
}

await main();
