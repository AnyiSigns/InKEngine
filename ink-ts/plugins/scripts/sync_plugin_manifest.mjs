#!/usr/bin/env node
/**
 * 同步生成插件源派生视图（plugins/manifest.json），plugins/ 各 spec.json 为真源。
 *
 * 职责边界（对齐 PLUGINS.md §1 / docs/component_data_endgame.md §三）：
 * - plugins/<kind>/<id>/spec.json = 能力插件声明真源（唯一手改处）；
 * - plugins/manifest.json = 派生视图**生成物**——从各 spec 聚合（插件索引 +
 *   tools 工具表行 + mcp 市场视图），禁手工维护（漂移由 --check 硬校验）。
 *
 * 消费方一律经 manifest 取用：web dev 夹具（backend.ts）、host mcp.market、
 * tools_os 夹具生成（sync_tools_fixtures.mjs）、self_check data 门禁。
 *
 * 规则：
 * - 目录 = plugins/tools/<tool-name>（kind='tool'，spec.data.tool 承载原工具行）；
 *   plugins/mcp/<server-id>（kind='mcp'，spec.data.server）；市场级元数据
 *   （premounted/mount_policy）真源在 plugins/mcp/market.json；
 * - spec 顶层必含 id/kind/capability；data.tool / data.server 逐字承载声明；
 * - 聚合顺序 = id 升序（确定性；工具表/市场展示序非语义，勿依赖源文件序）；
 * - 派生文件不写任何 spec 未声明内容（除固定 note/version）。
 *
 * 幂等：确定性 JSON（键序固定 + 成员 id 升序）。--check 只校验不落盘。
 */

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PLUGINS_ROOT = join(here, '..');
const MANIFEST = join(PLUGINS_ROOT, 'manifest.json');

const MANIFEST_NOTE =
  '插件源派生视图（生成物，禁手改）：由 plugins/scripts/sync_plugin_manifest.mjs ' +
  '从 plugins/<kind>/<id>/spec.json 聚合生成；改工具/市场声明只改 spec.json，' +
  '重跑本脚本同步。tools = kind=tool 工具表行（data.tool 逐字，id 升序）；' +
  'mcp_market = kind=mcp 市场视图（data.server + market.json 全局配置）；' +
  'plugins = 全插件索引（id/kind/capability/包名/目录）。';

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

async function fileExists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const check = process.argv.includes('--check');
  const data = await derive();
  const rendered = render(data);

  if (check) {
    if (!(await fileExists(MANIFEST))) {
      console.error(`manifest 缺失: ${MANIFEST}`);
      process.exitCode = 1;
      return;
    }
    const current = (await readFile(MANIFEST, 'utf8')).replace(/\r\n/g, '\n');
    if (current !== rendered) {
      console.error(
        `manifest 漂移: ${MANIFEST} 与 plugins 真源派生产物不一致（重跑 sync_plugin_manifest.mjs）`,
      );
      process.exitCode = 1;
      return;
    }
    console.log('manifest 与 plugins 真源派生产物一致');
    return;
  }

  await mkdir(PLUGINS_ROOT, { recursive: true });
  await writeFile(MANIFEST, rendered, 'utf8');
  console.log(
    `已生成 manifest.json（${data.plugins.length} 插件：${data.tools.length} tools + ${data.mcp_market.servers.length} mcp，真源 plugins/）`,
  );
}

await main();
