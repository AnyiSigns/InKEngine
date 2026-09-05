#!/usr/bin/env node
/**
 * 同步生成工具声明夹具（fixtures/tools_os.json），seed 为唯一真源。
 *
 * 语义随迁自 inkling/scripts/sync_tools_fixtures.py（旧侧壳执行器声明
 * 生成物）；ink-ts 侧落位为产品级生成管线，供 host/exec/web 消费前与
 * seed 漂移校验。职责边界：
 * - seed_data/tools.json = 引擎代理工具目录真源（引擎/宿主消费的声明）；
 * - fixtures/tools_os.json = 执行器声明**生成物**——从 seed 派生，禁手工
 *   维护（生成产物与 seed 成员/档位/端点漂移由 --check 模式硬校验）。
 *
 * 成员集合规则（生成器显式映射，勿静默改动）：
 * - 种子 = seed 中 meta.domain == "os" 的 OS 域工具（引擎代理目录的 OS 能力面）；
 * - 追加 = 执行器实现的 seed 非 OS 域工具（文档/导入/自指演化，固定清单）；
 * - shell_exec = 工作区命令执行器（混合级别：白名单内命令 cwd 钉工作区
 *   挂载根；白名单外命令经引擎升级审批通过后一次性系统级放行）。
 *
 * schema 形态差异映射（seed 嵌套 schema → 夹具扁平签名）：
 * - 参数：取 seed parameters.properties 中除固定 command 枚举外的参数；
 * - 端点：seed endpoint（process_exec / mcp）→ process_exec / device_mcp
 *   （mcp + inkling_shell 的感知类，见 MCP_TO_DEVICE）；
 * - 档位：seed approval（allow/review/deny）→ 夹具 permission；
 * - 沙箱：夹具沙箱值为执行器守卫数据，由本脚本内 SANDBOX_MAPPING 显式
 *   承载（任一成员缺映射即生成失败）。
 *
 * 幂等：确定性 JSON（排序键 + 固定成员顺序）。--check 只校验不落盘。
 */

import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SEED_ROOT = join(here, '..');
const SEED_TOOLS = join(SEED_ROOT, 'tools.json');
const FIXTURE = join(SEED_ROOT, 'fixtures', 'tools_os.json');

// seed 非 OS 域但执行器实现的工具（固定清单，新增须显式登记）
const FIXTURE_EXTRA_TOOLS = ['doc_parse', 'doc_generate', 'material_import', 'propose_patch'];

// 豁免：seed 有声明、执行器无实现的工具（当前为空）
const FIXTURE_EXEMPTIONS = {};

// seed 参数面与执行器签名面有意的形态分叉（agent 面向 vs 执行运行面）
const DIVERGED_SEED_PARAMS = {
  system_query: ['scope'],
  set_volume: ['level'],
  set_brightness: ['level'],
  file_query: ['pattern'],
};

// 夹具扁平参数（name/type/required）
const PARAMS_MAPPING = {
  launch_app: [['app', 'string', true]],
  open_file: [['path', 'string', true]],
  system_query: [['query', 'string', true]],
  set_volume: [['percent', 'integer', true]],
  set_brightness: [['percent', 'integer', true]],
  notify: [['title', 'string', true], ['body', 'string', true]],
  sleep: [['seconds', 'integer', true]],
  file_query: [['path', 'string', true]],
  ui_query: [['target', 'string', false], ['scope', 'string', false]],
  ui_click: [['x', 'integer', true], ['y', 'integer', true], ['button', 'string', true]],
  ui_type: [['text', 'string', true]],
  window_focus: [['handle', 'string', true]],
  window_minimize: [['handle', 'string', true]],
  doc_parse: [['path', 'string', true]],
  doc_generate: [['format', 'string', true], ['title', 'string', true], ['body', 'string', false], ['table', 'string', false]],
  material_import: [['path', 'string', true], ['recursive', 'boolean', false]],
  screenshot_capture: [['model_class', 'string', true], ['destination', 'string', false]],
  propose_patch: [['kind', 'string', true], ['payload', 'string', true], ['base_version', 'integer', false], ['rationale', 'string', false]],
  shell_exec: [['command', 'string', true], ['argv', 'stringarray', true], ['timeout', 'integer', false]],
};

// 夹具沙箱规则（执行器守卫数据；值以本表为唯一源）
const SANDBOX_MAPPING = {
  launch_app: { mode: 'command_allowlist', allowlist: ['notepad', 'calc', 'mspaint'] },
  open_file: { mode: 'path_roots', roots: ['~/.inkling/workspace'] },
  system_query: { mode: 'query_allowlist', allowlist: ['os', 'arch', 'hostname', 'home', 'cwd', 'uptime'] },
  set_volume: { mode: 'bounds', min: 0, max: 100 },
  set_brightness: { mode: 'bounds', min: 0, max: 100 },
  notify: { mode: 'length_caps', title_max: 80, body_max: 300 },
  sleep: { mode: 'bounds', min: 1, max: 86400 },
  file_query: { mode: 'path_roots', roots: ['~/.inkling/workspace'] },
  ui_query: { mode: 'command_allowlist', allowlist: ['tree', 'resolution', 'work_area'] },
  ui_click: { mode: 'coordinate_click', x_min: 0, x_max: 32767, y_min: 0, y_max: 32767, buttons: ['left', 'right', 'middle'] },
  ui_type: { mode: 'text_input', max_chars: 256 },
  window_focus: { mode: 'window_target', scopes: [] },
  window_minimize: { mode: 'window_target', scopes: [] },
  doc_parse: { mode: 'path_roots', roots: ['~/.inkling/workspace', '~/.inkling/attachments'] },
  doc_generate: { mode: 'path_roots', roots: ['~/.inkling/workspace'] },
  material_import: { mode: 'path_roots', roots: ['~/.inkling/workspace', '~/.inkling/attachments', '~'] },
  screenshot_capture: { mode: 'query_allowlist', allowlist: ['local', 'cloud'] },
  propose_patch: { mode: 'command_allowlist', allowlist: ['propose_patch'] },
  shell_exec: { mode: 'command_allowlist', allowlist: ['pip', 'python', 'uv', 'git', 'cargo', 'npm', 'npx'] },
};

const FIXTURE_NOTE =
  '执行器声明生成物：由 seed_data/tools.json 经 ink-ts/seed_data/scripts/' +
  'sync_tools_fixtures.mjs 生成（seed=引擎代理工具目录真源，fixtures=执行器声明，' +
  '禁手工维护）；成员 = seed OS 域工具 ∪ 执行工具（shell_exec 为混合级别：白名单内' +
  '沙箱执行 + 白名单外升级审批放行），漂移由 --check 硬校验。params 为扁平签名形态。';

const MCP_TO_DEVICE = { inkling_shell: 'device_mcp' };

function fail(message) {
  throw new Error(message);
}

async function loadJson(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    fail(`读取失败: ${path}（${err.message}）`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    fail(`JSON 解析失败: ${path}（${err.message}）`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    fail(`JSON 顶层应为对象: ${path}`);
  }
  return data;
}

function mcpToDeviceMcp(endpoint, seedTool) {
  if (endpoint !== 'mcp') return endpoint;
  const config = seedTool.endpoint_config;
  const serverId = config && typeof config === 'object' ? String(config.server_id ?? '') : '';
  return MCP_TO_DEVICE[serverId] ?? endpoint;
}

function assertSeedParamsShape(name, seedTool) {
  const parameters = seedTool.parameters ?? {};
  const props = parameters.properties;
  if (typeof props !== 'object' || props === null) {
    fail(`工具 ${name} 缺 parameters.properties（seed 声明不完整）`);
  }
  const seedNames = new Set(Object.keys(props));

  if (seedTool.endpoint === 'process_exec') {
    const commandProp = props.command;
    const commandEnum = commandProp && typeof commandProp === 'object' ? commandProp.enum : null;
    const expected = [name];
    if (!Array.isArray(commandEnum) || commandEnum.length !== expected.length || commandEnum[0] !== expected[0]) {
      fail(`工具 ${name} 的固定 command 枚举应为 [${JSON.stringify(name)}]（实际 ${JSON.stringify(commandEnum)}）`);
    }
  }

  const mappedNames = new Set((PARAMS_MAPPING[name] ?? []).map(([p]) => p));
  const diverged = DIVERGED_SEED_PARAMS[name] ?? [];
  const ignoredAllowed = new Set(['command', ...diverged]);
  const allowedIgnored = { launch_app: ['args'] }[name] ?? [];
  const unexpected = [...seedNames].filter(
    (p) => !mappedNames.has(p) && !ignoredAllowed.has(p) && !allowedIgnored.includes(p),
  );
  if (unexpected.length > 0) {
    fail(`工具 ${name} 的 seed 参数未在生成映射中: ${JSON.stringify(unexpected.sort())}（新增参数须显式登记到 PARAMS_MAPPING）`);
  }
}

async function deriveFixture(seed) {
  const tools = seed.tools;
  if (!Array.isArray(tools)) fail('seed tools.json 缺 tools 清单');
  const byName = new Map();
  for (const tool of tools) {
    if (tool && typeof tool === 'object' && typeof tool.name === 'string') {
      byName.set(tool.name, tool);
    }
  }

  const osTools = tools
    .filter((tool) => tool && typeof tool === 'object' && tool.meta?.domain === 'os')
    .map((tool) => String(tool.name));

  const memberOrder = [];
  for (const name of [...osTools, ...FIXTURE_EXTRA_TOOLS]) {
    if (name in FIXTURE_EXEMPTIONS) continue;
    if (!memberOrder.includes(name)) memberOrder.push(name);
  }

  const missing = memberOrder.filter((name) => !byName.has(name));
  if (missing.length > 0) fail(`成员集合含 seed 缺失工具: ${JSON.stringify(missing)}`);

  for (const exempt of Object.keys(FIXTURE_EXEMPTIONS)) {
    const tool = byName.get(exempt);
    if (!tool) fail(`豁免项 ${exempt} 在 seed 中不存在（豁免登记失真）`);
    if (tool.meta?.domain !== 'os') fail(`豁免项 ${exempt} 非 OS 域工具（豁免登记失真）`);
  }

  const decls = [];
  for (const name of memberOrder) {
    const seedTool = byName.get(name);
    const approval = String(seedTool.approval ?? '');
    if (!['allow', 'review', 'deny'].includes(approval)) {
      fail(`工具 ${name} approval 档位非法: ${JSON.stringify(approval)}`);
    }
    const endpoint = String(seedTool.endpoint ?? '');
    const fixtureEndpoint = mcpToDeviceMcp(endpoint, seedTool);
    if (!['process_exec', 'device_mcp'].includes(fixtureEndpoint)) {
      fail(`工具 ${name} 端点无法映射到执行器端点: ${JSON.stringify(endpoint)}`);
    }

    const params = PARAMS_MAPPING[name];
    const sandbox = SANDBOX_MAPPING[name];
    if (!params || !sandbox) fail(`工具 ${name} 缺生成映射（params/sandbox 须显式登记）`);

    assertSeedParamsShape(name, seedTool);
    decls.push({
      name,
      description: String(seedTool.description ?? ''),
      permission: approval,
      endpoint: fixtureEndpoint,
      sandbox,
      params: params.map(([pname, ptype, required]) => ({ name: pname, type: ptype, required })),
    });
  }
  return { note: FIXTURE_NOTE, tools: decls };
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const check = process.argv.includes('--check');
  const seed = await loadJson(SEED_TOOLS);
  const generated = await deriveFixture(seed);
  const rendered = `${JSON.stringify(generated, null, 2)}\n`;

  if (check) {
    if (!(await fileExists(FIXTURE))) {
      console.error(`夹具缺失: ${FIXTURE}`);
      process.exitCode = 1;
      return;
    }
    const current = (await readFile(FIXTURE, 'utf8')).replace(/\r\n/g, '\n');
    if (current !== rendered) {
      console.error(`夹具漂移: ${FIXTURE} 与 seed 派生产物不一致（重跑 sync_tools_fixtures.mjs）`);
      process.exitCode = 1;
      return;
    }
    console.log('夹具与 seed 派生产物一致');
    return;
  }

  await mkdir(dirname(FIXTURE), { recursive: true });
  await writeFile(FIXTURE, rendered, 'utf8');
  console.log(`已生成 ${relative(SEED_ROOT, FIXTURE)}（${generated.tools.length} 件声明，seed 真源）`);
}

await main();
