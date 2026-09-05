/**
 * data 门禁：seed_data 与 contracts fixtures 及前端镜像的数据一致性核。
 *
 * 核对边：
 * 1. seed_data/event_types.json 事件名集合 == web EVENT_TYPE_NAMES 镜像集合；
 * 2. seed_data/tools.json 工具 endpoint 使用集 ⊆ contracts endpoint_registry
 *    fixture 内置端点集，且内置端点全部被使用（双向覆盖）；
 * 3. seed_data/fixtures/tools_os.json 由 tools.json 派生的夹具与派生产物一致
 *    （执行 seed_data/scripts/sync_tools_fixtures.mjs --check）；
 * 4. 计数一致：事件 48 / 工具 35 / 内置端点 7 以 seed 与 fixture 实际值核对，
 *    不写死数字（数字漂移以双侧真实差异暴露）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  tools: Array<{ name: string; endpoint?: string }>;
}

interface EndpointRegistryFile {
  builtin_endpoints: Array<{ name: string }>;
}

/** 从 web 镜像文件提取 EVENT_TYPE_NAMES 数组（纯常量模块，无依赖）。 */
function extractWebEventNames(fileText: string): string[] {
  const block = /EVENT_TYPE_NAMES\s*=\s*\[([\s\S]*?)\];/.exec(fileText);
  if (block === null) return [];
  const names: string[] = [];
  for (const m of block[1]!.matchAll(/'([^']+)'/g)) names.push(m[1]!);
  return names;
}

export async function runGateData(ctx: SelfCheckContext): Promise<GateResult> {
  const started = Date.now();
  const issues: string[] = [];
  const seedRoot = join(ctx.inkTsRoot, 'seed_data');
  const contractsRoot = join(ctx.inkTsRoot, 'contracts');

  const events = parseJson<EventTypesFile>(join(seedRoot, 'event_types.json'));
  const tools = parseJson<ToolsFile>(join(seedRoot, 'tools.json'));
  const endpointRegistry = parseJson<EndpointRegistryFile>(join(contractsRoot, 'fixtures', 'endpoint_registry.fixture.json'));

  const seedEventNames = events.events.map((e) => e.name);
  const seedUnique = new Set(seedEventNames);
  if (seedUnique.size !== seedEventNames.length) {
    issues.push(`event_types.json 存在重复事件名（${seedEventNames.length} → ${seedUnique.size}）`);
  }

  const webText = readFileSync(join(ctx.inkTsRoot, 'web', 'src', 'shared', 'session', 'eventTypes.ts'), 'utf8');
  const webNames = extractWebEventNames(webText);
  const seedSet = new Set(seedEventNames);
  const webSet = new Set(webNames);
  const onlySeed = [...seedSet].filter((n) => !webSet.has(n));
  const onlyWeb = [...webSet].filter((n) => !seedSet.has(n));
  if (seedEventNames.length !== webNames.length) {
    issues.push(`事件计数不一致：seed ${seedEventNames.length} vs web 镜像 ${webNames.length}`);
  }
  if (onlySeed.length > 0) issues.push(`web 镜像缺事件：${onlySeed.join(', ')}`);
  if (onlyWeb.length > 0) issues.push(`web 镜像多余事件：${onlyWeb.join(', ')}`);

  const toolNames = tools.tools.map((t) => t.name);
  if (new Set(toolNames).size !== toolNames.length) {
    issues.push('tools.json 存在重复工具名');
  }
  const builtinNames = endpointRegistry.builtin_endpoints.map((e) => e.name);
  const builtinSet = new Set(builtinNames);
  const usedEndpoints = new Set<string>();
  for (const tool of tools.tools) {
    if (tool.endpoint !== undefined && tool.endpoint !== '') usedEndpoints.add(tool.endpoint);
  }
  const notBuiltin = [...usedEndpoints].filter((e) => !builtinSet.has(e));
  const unusedBuiltin = [...builtinSet].filter((e) => !usedEndpoints.has(e));
  if (notBuiltin.length > 0) issues.push(`工具 endpoint 越界内置端点集：${notBuiltin.join(', ')}`);
  if (unusedBuiltin.length > 0) issues.push(`内置端点未被任何工具使用：${unusedBuiltin.join(', ')}`);

  const sync = await runCommand(
    [process.execPath, join(seedRoot, 'scripts', 'sync_tools_fixtures.mjs'), '--check'],
    { cwd: ctx.inkTsRoot, timeoutMs: 60_000 },
  );
  if (sync.code !== 0) {
    issues.push(`tools_os 夹具与 seed 派生产物不一致（exit ${sync.code ?? '超时'}）`);
  }

  const seconds = (Date.now() - started) / 1000;
  const passed = issues.length === 0;
  const counts = `事件 ${seedEventNames.length} / 工具 ${toolNames.length} / 内置端点 ${builtinNames.length}`;
  return {
    key: 'data',
    label: '数据一致性核（seed↔contracts）',
    command: 'seed_data + contracts fixtures + sync_tools_fixtures --check',
    passed,
    seconds,
    summary: passed ? `${counts}，全部分支一致` : `${counts}，存在 ${issues.length} 处不一致`,
    tail: issues,
  };
}
