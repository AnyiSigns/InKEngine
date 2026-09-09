/**
 * data 门禁：plugins 插件源（真源）与 engine 数据面 fixtures 及前端镜像的
 * 数据一致性核 + 引擎发射事件登记核。
 *
 * 核对边：
 * 1. seed_data/event_types.json 事件名集合 == web EVENT_TYPE_NAMES 镜像集合，
 *    且 EVENT_TYPE_SPECS 声明名与 EVENT_TYPE_NAMES 一一对应（事件名↔spec 一致）；
 * 2. plugins/manifest.json tools 工具 endpoint 使用集 ⊆ engine endpoint_registry
 *    fixture 内置端点集（host_command 工具族例外：endpoint = 宿主注册的引擎
 *    自定义端点，见 HOST_COMMAND_ENDPOINTS），且内置端点全部被使用（双向覆盖）；
 * 3. seed_data/fixtures/tools_os.json 由 plugins 源派生的夹具与派生产物一致
 *    （执行 seed_data/scripts/sync_tools_fixtures.mjs --check）；夹具成员的
 *    endpoint/permission/sandbox 映射与 plugins 声明自洽（endpoint 映射规则 +
 *    sandbox 结构守卫）；
 * 4. engine/src 内事件发射字面量 ⊆ seed 事件集 ∪ internal 允许表
 *    （engine_emit_allowlist.txt，data 门禁的发射登记核：新增真实 UI 事件须
 *    登记 seed，引擎内部事件须登 internal 允许表）；
 * 5. plugins/manifest.json 派生视图与 plugins/ 各 spec 真源一致
 *    （执行 plugins/scripts/sync_plugin_manifest.mjs --check，防手改 manifest）；
 * 6. 计数一致：事件 48 / 工具 38（含 session_command host_command 3 件）/ 内置
 *    端点 7 + 宿主自定义端点以 plugins manifest 与 fixture 实际值核对，
 *    不写死数字（数字漂移以双侧真实差异暴露）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { GateResult } from '../_report.js';
import { runCommand } from '../_proc.js';
import type { SelfCheckContext } from '../index.js';

function parseJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

interface EventTypesFile {
  events: Array<{ name: string }>;
}

interface ToolsFile {
  tools: Array<{
    name: string;
    endpoint?: string;
    endpoint_config?: { server_id?: string } | null;
    approval?: string;
  }>;
}

interface EndpointRegistryFile {
  builtin_endpoints: Array<{ name: string }>;
}

interface ToolsOsFile {
  tools: Array<{
    name: string;
    permission?: string;
    endpoint?: string;
    sandbox?: Record<string, unknown>;
  }>;
}

const SELF_CHECK_DIR = fileURLToPath(new URL('..', import.meta.url));
const EMIT_ALLOWLIST_FILE = join(SELF_CHECK_DIR, 'engine_emit_allowlist.txt');

const SANDBOX_MODES = [
  'command_allowlist',
  'query_allowlist',
  'path_roots',
  'bounds',
  'length_caps',
  'coordinate_click',
  'text_input',
  'window_target',
] as const;

/**
 * 宿主注册的引擎自定义端点族（host_command 工具）：plugins 声明直接引用该
 * endpoint，运行期由宿主装配在引擎 EndpointTypeRegistry 登记执行体/提取器
 * （既有通道，非引擎内置 fixture 成员）。清单增删须同步 hosts/lib
 * session_command 工具接线模块；本集合是 self_check 对宿主自定义端点的
 * 登记面（放行其出现在 plugin 工具行，其余仍须 ⊆ 内置端点）。
 */
const HOST_COMMAND_ENDPOINTS: ReadonlySet<string> = new Set(['session_command']);

function isNonEmptyStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string');
}

function isNumberArray(value: unknown, keys: readonly string[]): boolean {
  return keys.every((k) => typeof (value as Record<string, unknown>)[k] === 'number');
}

/** 夹具 sandbox 结构守卫：mode 须在守卫模式集内，且必备字段形态正确。 */
function sandboxIssue(sandbox: Record<string, unknown> | undefined): string | null {
  if (sandbox === undefined || typeof sandbox !== 'object') return '缺 sandbox 守卫';
  const mode = sandbox['mode'];
  if (typeof mode !== 'string' || !(SANDBOX_MODES as readonly string[]).includes(mode)) {
    return `sandbox.mode 非法: ${JSON.stringify(mode)}`;
  }
  if ((mode === 'command_allowlist' || mode === 'query_allowlist') && !isNonEmptyStringArray(sandbox['allowlist'])) {
    return `${mode} 缺非空字符串 allowlist`;
  }
  if (mode === 'path_roots' && !isNonEmptyStringArray(sandbox['roots'])) return 'path_roots 缺非空字符串 roots';
  if (mode === 'bounds' && !isNumberArray(sandbox, ['min', 'max'])) return 'bounds 缺数值 min/max';
  if (mode === 'length_caps' && !isNumberArray(sandbox, ['title_max', 'body_max'])) return 'length_caps 缺数值 title_max/body_max';
  if (
    mode === 'coordinate_click' &&
    (!isNumberArray(sandbox, ['x_min', 'x_max', 'y_min', 'y_max']) || !isNonEmptyStringArray(sandbox['buttons']))
  ) {
    return 'coordinate_click 缺坐标边界或按键清单';
  }
  if (mode === 'text_input' && typeof sandbox['max_chars'] !== 'number') return 'text_input 缺数值 max_chars';
  if (mode === 'window_target' && !Array.isArray(sandbox['scopes'])) return 'window_target 缺 scopes 数组';
  return null;
}

/** 从 web 镜像文件提取 EVENT_TYPE_NAMES 数组（纯常量模块，无依赖）。 */
function extractWebEventNames(fileText: string): string[] {
  const block = /EVENT_TYPE_NAMES\s*=\s*\[([\s\S]*?)\];/.exec(fileText);
  if (block === null) return [];
  const names: string[] = [];
  for (const m of block[1]!.matchAll(/'([^']+)'/g)) names.push(m[1]!);
  return names;
}

/** 从 web 镜像文件提取 EVENT_TYPE_SPECS 条目名数组（name 字段）。 */
function extractWebEventSpecNames(fileText: string): string[] {
  const block = /EVENT_TYPE_SPECS[^=]*=\s*\[([\s\S]*?)\];/.exec(fileText);
  if (block === null) return [];
  const names: string[] = [];
  for (const m of block[1]!.matchAll(/name:\s*'([^']+)'/g)) names.push(m[1]!);
  return names;
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      out.push(...walkFiles(full));
    } else if (/\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const EMIT_CALL_RE = /(?:\.emit|emit|emit_event|emitEvent)\s*\(\s*['"]([A-Za-z_][A-Za-z0-9_.-]*)['"]/g;
const EMIT_METHOD_CALL_RE = /emit\.call\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*['"]([A-Za-z_][A-Za-z0-9_.-]*)['"]/g;
const PUBLISH_EMIT_RE = /publish_emit\s*\([^)]*?['"]([A-Za-z_][A-Za-z0-9_.-]*)['"]/g;

/** 收集 engine/src 内事件发射字面量（emit('name')/emit.call/publish_emit）。 */
function collectEngineEmitNames(engineSrc: string): Set<string> {
  const names = new Set<string>();
  for (const file of walkFiles(engineSrc)) {
    const text = readFileSync(file, 'utf8');
    for (const re of [EMIT_CALL_RE, EMIT_METHOD_CALL_RE, PUBLISH_EMIT_RE]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) names.add(m[1]!);
    }
  }
  return names;
}

/** 读取 internal 允许表：每行 `<name> <用途注释>`；空行/`#` 跳过。 */
function loadEmitAllowlist(): Map<string, string> {
  const map = new Map<string, string>();
  let text: string;
  try {
    text = readFileSync(EMIT_ALLOWLIST_FILE, 'utf8');
  } catch {
    return map;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_.-]*)\s+(.+)$/.exec(trimmed);
    if (match !== null) map.set(match[1]!, match[2]!);
  }
  return map;
}

export async function runGateData(ctx: SelfCheckContext): Promise<GateResult> {
  const started = Date.now();
  const issues: string[] = [];
  const seedRoot = join(ctx.inkTsRoot, 'seed_data');
  const engineFixtureRoot = join(ctx.inkTsRoot, 'engine', 'fixtures');

  const events = parseJson<EventTypesFile>(join(seedRoot, 'event_types.json'));
  const tools = parseJson<ToolsFile>(join(ctx.inkTsRoot, 'plugins', 'manifest.json'));
  const endpointRegistry = parseJson<EndpointRegistryFile>(join(engineFixtureRoot, 'endpoint_registry.fixture.json'));
  const toolsOs = parseJson<ToolsOsFile>(join(seedRoot, 'fixtures', 'tools_os.json'));

  const seedEventNames = events.events.map((e) => e.name);
  const seedUnique = new Set(seedEventNames);
  if (seedUnique.size !== seedEventNames.length) {
    issues.push(`event_types.json 存在重复事件名（${seedEventNames.length} → ${seedUnique.size}）`);
  }

  const webText = readFileSync(join(ctx.inkTsRoot, 'renderer', 'src', 'shared', 'session', 'eventTypes.ts'), 'utf8');
  const webNames = extractWebEventNames(webText);
  const webSpecNames = extractWebEventSpecNames(webText);
  const seedSet = new Set(seedEventNames);
  const webSet = new Set(webNames);
  const onlySeed = [...seedSet].filter((n) => !webSet.has(n));
  const onlyWeb = [...webSet].filter((n) => !seedSet.has(n));
  if (seedEventNames.length !== webNames.length) {
    issues.push(`事件计数不一致：seed ${seedEventNames.length} vs web 镜像 ${webNames.length}`);
  }
  if (onlySeed.length > 0) issues.push(`web 镜像缺事件：${onlySeed.join(', ')}`);
  if (onlyWeb.length > 0) issues.push(`web 镜像多余事件：${onlyWeb.join(', ')}`);
  if (webSpecNames.length !== webNames.length) {
    issues.push(`EVENT_TYPE_SPECS 声明数与 EVENT_TYPE_NAMES 不一致：${webSpecNames.length} vs ${webNames.length}`);
  } else {
    const specSet = new Set(webSpecNames);
    const specOnly = webNames.filter((n) => !specSet.has(n));
    const nameOnly = webSpecNames.filter((n) => !webSet.has(n));
    if (specOnly.length > 0) issues.push(`EVENT_TYPE_SPECS 缺名称登记：${specOnly.join(', ')}`);
    if (nameOnly.length > 0) issues.push(`EVENT_TYPE_SPECS 含名称表外事件：${nameOnly.join(', ')}`);
  }

  const toolNames = tools.tools.map((t) => t.name);
  if (new Set(toolNames).size !== toolNames.length) {
    issues.push('plugins manifest tools 存在重复工具名');
  }
  const builtinNames = endpointRegistry.builtin_endpoints.map((e) => e.name);
  const builtinSet = new Set(builtinNames);
  const usedEndpoints = new Set<string>();
  for (const tool of tools.tools) {
    if (tool.endpoint !== undefined && tool.endpoint !== '') usedEndpoints.add(tool.endpoint);
  }
  const notBuiltin = [...usedEndpoints].filter(
    (e) => !builtinSet.has(e) && !HOST_COMMAND_ENDPOINTS.has(e),
  );
  const unusedBuiltin = [...builtinSet].filter((e) => !usedEndpoints.has(e));
  if (notBuiltin.length > 0) issues.push(`工具 endpoint 越界内置端点集：${notBuiltin.join(', ')}`);
  if (unusedBuiltin.length > 0) issues.push(`内置端点未被任何工具使用：${unusedBuiltin.join(', ')}`);

  // plugins manifest 派生视图自洽：manifest 由 plugins 真源派生，与各 spec 逐字一致
  // （禁手改 manifest；任何 spec 改动须重跑 sync_plugin_manifest.mjs）。
  const manifestSync = await runCommand(
    [process.execPath, join(ctx.inkTsRoot, 'plugins', 'scripts', 'sync_plugin_manifest.mjs'), '--check'],
    { cwd: ctx.inkTsRoot, timeoutMs: 60_000 },
  );
  if (manifestSync.code !== 0) {
    issues.push(`plugins/manifest.json 与 plugins 真源派生产物不一致（exit ${manifestSync.code ?? '超时'}）`);
  }

  // plugins → tools_os.json 映射自洽：夹具成员均须在 plugins 有声明，且
  // endpoint/permission 映射与 plugins 对齐、sandbox 结构合规（SANDBOX_MAPPING
  // 是夹具沙箱唯一源，任何 shape 漂移在此暴露）。
  const seedByName = new Map(tools.tools.map((t) => [t.name, t]));
  const fixtureToolNames = new Set(toolsOs.tools.map((t) => t.name));
  const osExtraNames = toolsOs.tools.filter((t) => !seedByName.has(t.name)).map((t) => t.name);
  if (osExtraNames.length > 0) issues.push(`夹具含 plugins 未声明工具：${osExtraNames.join(', ')}`);
  for (const tool of toolsOs.tools) {
    const seed = seedByName.get(tool.name);
    if (seed === undefined) continue;
    if (seed.approval !== undefined && tool.permission !== seed.approval) {
      issues.push(`工具 ${tool.name} permission 与 plugins approval 不一致：${tool.permission} vs ${seed.approval}`);
    }
    const seedEndpoint = seed.endpoint ?? '';
    const fixtureEndpoint = tool.endpoint ?? '';
    if (seedEndpoint === 'process_exec' && fixtureEndpoint !== 'process_exec') {
      issues.push(`工具 ${tool.name} 端点映射漂移：plugins process_exec → 夹具 ${fixtureEndpoint}`);
    }
    if (seedEndpoint === 'mcp' && fixtureEndpoint !== 'device_mcp') {
      issues.push(`工具 ${tool.name} 端点映射漂移：plugins mcp → 夹具 ${fixtureEndpoint}（设备类应映射 device_mcp）`);
    }
    if (seedEndpoint !== 'process_exec' && seedEndpoint !== 'mcp' && fixtureEndpoint !== '') {
      issues.push(`工具 ${tool.name} plugins 端点 ${seedEndpoint} 无夹具映射规则`);
    }
    const sandboxIssueText = sandboxIssue(tool.sandbox);
    if (sandboxIssueText !== null) issues.push(`工具 ${tool.name} ${sandboxIssueText}`);
  }

  const sync = await runCommand(
    [process.execPath, join(seedRoot, 'scripts', 'sync_tools_fixtures.mjs'), '--check'],
    { cwd: ctx.inkTsRoot, timeoutMs: 60_000 },
  );
  if (sync.code !== 0) {
    issues.push(`tools_os 夹具与 plugins 派生产物不一致（exit ${sync.code ?? '超时'}）`);
  }

  // 引擎发射事件登记核：emit 字面量 ⊆ seed ∪ internal 允许表。
  const emitNames = collectEngineEmitNames(join(ctx.inkTsRoot, 'engine', 'src'));
  const internal = loadEmitAllowlist();
  const notRegistered = [...emitNames].filter((n) => !seedSet.has(n) && !internal.has(n));
  if (notRegistered.length > 0) {
    issues.push(
      `引擎发射事件未登记：${notRegistered.join(', ')}（新 UI 事件须登记 seed_data/event_types.json；引擎内部事件须登记 self_check/engine_emit_allowlist.txt）`,
    );
  }
  const internalUnused = [...internal.keys()].filter((n) => !emitNames.has(n));
  if (internalUnused.length > 0) {
    issues.push(`engine_emit_allowlist.txt 含未见发射的事件：${internalUnused.join(', ')}（无发射点应移除登记）`);
  }

  const seconds = (Date.now() - started) / 1000;
  const passed = issues.length === 0;
  const counts = `事件 ${seedEventNames.length} / 工具 ${toolNames.length} / 内置端点 ${builtinNames.length} / 发射事件 ${emitNames.size} / internal ${internal.size}`;
  return {
    key: 'data',
    label: '数据一致性核（plugins↔engine fixtures + 发射事件登记）',
    command: 'plugins manifest + engine fixtures + sync_plugin_manifest --check + sync_tools_fixtures --check + engine emit 字面量',
    passed,
    seconds,
    summary: passed ? `${counts}，全部分支一致` : `${counts}，存在 ${issues.length} 处不一致`,
    tail: issues,
  };
}
