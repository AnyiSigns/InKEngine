/**
 * host.spec（kind='host' 宿主插件，HostFaces 面）的类型 + 加载/校验。
 *
 * 词汇对齐 PLUGINS.md §2 HostFaces：ports（storage/llm/exec/approval 实现形状）、
 * transport（stdio/http+ws/webview/terminal）、surface（tauri/web/cli/ide）、
 * approval（flag/card/interactive/auto）。host.spec 是装配期 spec，物理住
 * `hosts/<host>.spec.json`（与 plugins/ 无关，不走 npm 分发）。
 *
 * 敏感边界（用户定案）：spec 只声明非敏感缺省与面形状；api_key 等密钥与具体
 * 模型端点留在 config.json/环境（resolve_host_config 消费，不落 spec）。
 *
 * 目录探测：从进程 cwd 向上逐级找含 `hosts/` 的仓库根（dev/测试/e2e 均以仓库
 * 根为 cwd），与 seed_dir 探测同思路。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const HOST_SURFACES = ['tauri', 'web', 'cli', 'ide'] as const;
export type HostSurface = (typeof HOST_SURFACES)[number];

export const HOST_TRANSPORTS = ['stdio', 'http+ws', 'webview', 'terminal'] as const;
export type HostTransport = (typeof HOST_TRANSPORTS)[number];

export const HOST_APPROVALS = ['flag', 'card', 'interactive', 'auto'] as const;
export type HostApproval = (typeof HOST_APPROVALS)[number];

export const HOST_PORT_KEYS = ['storage', 'llm', 'exec', 'approval'] as const;
export type HostPortKey = (typeof HOST_PORT_KEYS)[number];

/** HostFaces：宿主面（kind='host' 专用；引擎只认这些端口契约，不认识宿主是谁）。 */
export interface HostFaces {
  surface: HostSurface;
  transport: HostTransport[];
  approval: HostApproval;
  /** 宿主需注入/提供的端口实现形状（storage 后端 / llm 槽 / exec 信封 / 审批）。 */
  ports: Record<HostPortKey, readonly string[]>;
  /** 显示设备 ui 源（web 宿主：dev=vite/prod=builtin；非 HostFaces 扩展，仅 web 面用）。 */
  ui_origin?: { dev?: string; prod?: string } | null;
}

/** 呈现面实现指针（cli→cli/src/tui；web→renderer/src；为装配定位实现目录的扩展字段）。 */
export interface HostRendererRef {
  target: 'engine' | 'host' | 'web';
  entry: string;
}

/** 非敏感运行配置缺省（密钥外置；运行时仍可被 config/环境覆盖）。 */
export interface HostRuntimeDefaults {
  headless?: boolean;
  approval_timeout?: number | null;
  ui_origin?: string | null;
}

export interface HostSpec {
  id: string;
  kind: 'host';
  capability: 'host_tool';
  /** 装配实现是否在本仓（tauri/ide = false：外部壳仓按本 spec 装配）。 */
  implemented: boolean;
  host: HostFaces;
  renderer?: HostRendererRef;
  runtime?: HostRuntimeDefaults;
  note?: string;
}

export interface HostSpecLoadOptions {
  /** 仓库根（含 hosts/ 的目录）；缺省 = 从 cwd 向上探测。 */
  root?: string;
}

const SURFACE_SET = new Set<string>(HOST_SURFACES);
const TRANSPORT_SET = new Set<string>(HOST_TRANSPORTS);
const APPROVAL_SET = new Set<string>(HOST_APPROVALS);
const PORT_KEY_SET = new Set<string>(HOST_PORT_KEYS);

/** 从 start 向上找含 hosts/ 的仓库根（找不到 = null）。 */
export function findHostsRoot(start?: string): string | null {
  let current = resolve(start ?? process.cwd());
  for (;;) {
    if (existsSync(join(current, 'hosts'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function fail(message: string): never {
  throw new Error(`host.spec 校验失败: ${message}`);
}

/** 形状校验（纯逻辑；entry 是否真实存在属装配期/verify 责任，这里只保形状）。 */
export function validateHostSpec(spec: HostSpec): HostSpec {
  if (typeof spec !== 'object' || spec === null) fail('须为对象');
  if (typeof spec.id !== 'string' || spec.id === '') fail('缺 id');
  if (spec.kind !== 'host') fail('kind 须为 host');
  if (spec.capability !== 'host_tool') fail('capability 须为 host_tool');
  if (typeof spec.host !== 'object' || spec.host === null) fail('缺 host（HostFaces）');
  const faces = spec.host;
  if (typeof faces.surface !== 'string' || !SURFACE_SET.has(faces.surface)) {
    fail(`surface 非法: ${String(faces.surface)}（${HOST_SURFACES.join('|')}）`);
  }
  if (!Array.isArray(faces.transport) || faces.transport.length === 0 || faces.transport.some((t) => !TRANSPORT_SET.has(t))) {
    fail(`transport 须为非空子集 ${HOST_TRANSPORTS.join('|')}`);
  }
  if (typeof faces.approval !== 'string' || !APPROVAL_SET.has(faces.approval)) {
    fail(`approval 非法: ${String(faces.approval)}（${HOST_APPROVALS.join('|')}）`);
  }
  if (typeof faces.ports !== 'object' || faces.ports === null) fail('缺 ports');
  for (const key of HOST_PORT_KEYS) {
    const value = faces.ports[key];
    if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== 'string' || v === '')) {
      fail(`ports.${key} 须为非空字符串数组`);
    }
  }
  if (spec.renderer !== undefined) {
    if (typeof spec.renderer !== 'object' || spec.renderer === null) fail('renderer 须为对象');
    if (!['engine', 'host', 'web'].includes(spec.renderer.target)) fail('renderer.target 非法');
    if (typeof spec.renderer.entry !== 'string' || spec.renderer.entry === '') fail('renderer.entry 须非空');
  }
  if (spec.runtime !== undefined) {
    const runtime = spec.runtime;
    if (typeof runtime !== 'object' || runtime === null) fail('runtime 须为对象');
    if (runtime.approval_timeout !== null && runtime.approval_timeout !== undefined && typeof runtime.approval_timeout !== 'number') {
      fail('runtime.approval_timeout 须为数字或 null');
    }
  }
  if (spec.implemented === false && (typeof spec.note !== 'string' || spec.note === '')) {
    fail('implemented=false 的宿主 spec 须带 note（说明装配实现所在/外部壳仓）');
  }
  if (typeof spec.implemented !== 'boolean') fail('implemented 须为布尔');
  return spec;
}

/** 读取并校验 hosts/<id>.spec.json。 */
export function loadHostSpec(id: string, options: HostSpecLoadOptions = {}): HostSpec {
  const root = options.root ?? findHostsRoot();
  if (root === null) fail(`找不到 hosts/ 目录（自 cwd 向上探测）`);
  const specPath = join(root, 'hosts', `${id}.spec.json`);
  let text: string;
  try {
    text = readFileSync(specPath, 'utf8');
  } catch {
    fail(`hosts/${id}.spec.json 缺失或不可读: ${specPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`hosts/${id}.spec.json 解析失败: ${(error as Error).message}`);
  }
  const spec = parsed as HostSpec;
  if (spec.id !== id) fail(`spec.id(${spec.id}) 与文件名(${id}) 不符`);
  return validateHostSpec(spec);
}

/** PORT_KEY 数组是否含给定后端/端口形状（装配映射用）。 */
export function hostPortHas(spec: HostSpec, key: HostPortKey, value: string): boolean {
  const list = spec.host.ports[key];
  return Array.isArray(list) && list.includes(value);
}
