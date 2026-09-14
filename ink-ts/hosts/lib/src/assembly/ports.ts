// gate: test-exempt - 端口装配面（结构契约 + 运行时装载；构造面由 hosts
// assembly/recipe/mcp 测试覆盖）
/**
 * 端口提供方装配面（S2 adapters 下沉的子波：host 不再 import 适配器实现符号，
 * 改为按 manifest「ports」段动态装载端口提供方插件并注入引擎 seam）。
 *
 * 结构契约（host 侧本地型，doc_parse 先例）：P1 后 engine 公共面停供
 * storage/llm/mcp/boot 实现符号，hosts/lib 与 plugins/ports 为物理分离——
 * 经既有 face/loader（listHostLogicFaces/loadHostLogicFaces）装载各端口插件
 * logic face（target='host'），契约由本文件窄面互通：
 * - storage → create_storage（memory/sqlite 路由工厂）；
 * - llm → create_llm / register_adapter / adapter_names / get_adapter_class；
 * - mcp_client → McpClientManager 类 + register_mcp_executor + 内置 server 面；
 * - boot → BOOT_* 引导数据（纯数据资产，省略 implemented + data.boot）。
 *
 * 缺省语义：种子目录无 manifest / 端口插件缺失 = 缺失端口面返回 null，装配
 * 消费方降级（与 face/loader 缺省一致；仓库配方缺端口 = 设计师配方，不应当
 * 装配期要求）。插件声明存在但装载/契约不符 = fail-closed 抛错。
 */

import { loadHostLogicFaces } from '../face/loader.js';
import type { DeclarativeToolSpec, Storage } from '@ink-ts/engine';

/** 存储端口面（storage 插件默认工厂实例面）。 */
export interface StoragePortSeam {
  create_storage(connString: string): Storage;
}

/** LLM 端口面（llm 插件默认工厂实例面）。 */
export interface LlmPortSeam {
  create_llm(config: Record<string, unknown>): unknown;
  register_adapter(name: string, cls: unknown): void;
  adapter_names(): string[];
  get_adapter_class(name: string): unknown;
}

/** MCP server 配置面（plugin.ts 消费；from_dict 静态构造）。 */
export interface McpServerConfigLike {
  id: string;
  transport: 'stdio' | 'http';
  [key: string]: unknown;
}

/** MCP 管理器窄面（host 侧；来自 mcp_client 插件，结构契约互通）。 */
export interface McpClientManagerLike {
  list_servers(): string[];
  imported_tools(server_id: string): Set<string>;
  connect(config: McpServerConfigLike): Promise<unknown>;
  connect_builtin(server_id: string, overrides?: Record<string, unknown>): Promise<unknown>;
  disconnect(server_id: string): Promise<boolean>;
  import_tools(
    server_id: string,
    opts?: { source?: string; vetting?: unknown; signature?: string | null; shadow_workdir?: string | null },
  ): Promise<DeclarativeToolSpec[]>;
  close_all(): Promise<void>;
}

/** MCP 客户端端口面（mcp_client 插件默认工厂实例面）。 */
export interface McpClientPortSeam {
  McpClientManager: new () => McpClientManagerLike;
  McpServerConfig: {
    from_dict(data: Record<string, unknown>): McpServerConfigLike;
  };
  register_mcp_executor(executors: unknown, manager: McpClientManagerLike): void;
  BUILTIN_MCP_SERVERS: Readonly<Record<string, unknown>>;
  builtin_mcp_server_config(
    server_id: string,
    overrides?: Record<string, unknown>,
  ): McpServerConfigLike | null;
}

/** boot 纯数据端口面（boot 插件默认工厂实例面）。 */
export interface BootPortSeam {
  BOOT_EVENT_TYPES: readonly unknown[];
  BOOT_METATOOLS: readonly unknown[];
  BOOT_SYSTEM_PROMPT: string;
  BOOT_UI_SPEC: Record<string, unknown>;
  boot_harness_definition: () => unknown;
  build_boot_seed_entries: () => unknown[];
  BOOT_PROMPT_SEED_ID: string;
}

/** 端口面全集（缺省 null = 未装配）。 */
export interface PortsSeam {
  storage: StoragePortSeam | null;
  llm: LlmPortSeam | null;
  mcpClient: McpClientPortSeam | null;
  boot: BootPortSeam | null;
}

function asRecord(value: unknown, id: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`端口提供方 ${id} 默认工厂产出非对象（契约 = 工厂 => 实例）`);
  }
  return value as Record<string, unknown>;
}

function requiredPort<T>(
  pluginId: string,
  faces: Awaited<ReturnType<typeof loadHostLogicFaces>>,
  assertShape: (inst: Record<string, unknown>) => T,
): T | null {
  const module = faces[pluginId];
  if (module === undefined || module === null) return null;
  const factory = (module as { default?: unknown })['default'];
  if (typeof factory !== 'function') {
    throw new Error(`端口提供方 ${pluginId} 缺默认工厂（faces/logic 契约 = default(init) => 端口实例）`);
  }
  const inst = asRecord((factory as () => unknown)(), pluginId);
  return assertShape(inst);
}

function fn(inst: Record<string, unknown>, key: string, pluginId: string): unknown {
  const value = inst[key];
  if (typeof value !== 'function') {
    throw new Error(`端口提供方 ${pluginId} 契约不符：缺 ${key}（实例面函数）`);
  }
  return value;
}

/**
 * 装载端口提供方插件（seed 目录 manifest「ports」段 → 动态 import → 默认
 * 工厂 → 窄面）。每装配调用一次；缺失插件 = null（消费方降级），声明存在但
 * 工厂/形状不满足契约 = fail-closed。
 */
export async function loadPortsSeam(seedDir?: string | null): Promise<PortsSeam> {
  const faces = await loadHostLogicFaces(seedDir);
  return {
    storage: requiredPort('storage', faces, (inst) => ({
      create_storage: fn(inst, 'create_storage', 'storage') as StoragePortSeam['create_storage'],
    })),
    llm: requiredPort('llm', faces, (inst) => ({
      create_llm: fn(inst, 'create_llm', 'llm') as LlmPortSeam['create_llm'],
      register_adapter: fn(inst, 'register_adapter', 'llm') as LlmPortSeam['register_adapter'],
      adapter_names: fn(inst, 'adapter_names', 'llm') as LlmPortSeam['adapter_names'],
      get_adapter_class: fn(inst, 'get_adapter_class', 'llm') as LlmPortSeam['get_adapter_class'],
    })),
    mcpClient: requiredPort('mcp_client', faces, (inst) => ({
      McpClientManager: fn(inst, 'McpClientManager', 'mcp_client') as new () => McpClientManagerLike,
      McpServerConfig: fn(inst, 'McpServerConfig', 'mcp_client') as { from_dict(data: Record<string, unknown>): McpServerConfigLike },
      register_mcp_executor: fn(inst, 'register_mcp_executor', 'mcp_client') as (
        executors: unknown,
        manager: McpClientManagerLike,
      ) => void,
      BUILTIN_MCP_SERVERS: inst['BUILTIN_MCP_SERVERS'] as Readonly<Record<string, unknown>>,
      builtin_mcp_server_config: fn(inst, 'builtin_mcp_server_config', 'mcp_client') as (
        server_id: string,
        overrides?: Record<string, unknown>,
      ) => McpServerConfigLike | null,
    })),
    boot: requiredPort('boot', faces, (inst) => ({
      BOOT_EVENT_TYPES: inst['BOOT_EVENT_TYPES'] as readonly unknown[],
      BOOT_METATOOLS: inst['BOOT_METATOOLS'] as readonly unknown[],
      BOOT_SYSTEM_PROMPT: typeof inst['BOOT_SYSTEM_PROMPT'] === 'string'
        ? (inst['BOOT_SYSTEM_PROMPT'] as string)
        : '',
      BOOT_UI_SPEC: inst['BOOT_UI_SPEC'] as Record<string, unknown>,
      boot_harness_definition: fn(inst, 'boot_harness_definition', 'boot') as () => unknown,
      build_boot_seed_entries: fn(inst, 'build_boot_seed_entries', 'boot') as () => unknown[],
      BOOT_PROMPT_SEED_ID: typeof inst['BOOT_PROMPT_SEED_ID'] === 'string'
        ? (inst['BOOT_PROMPT_SEED_ID'] as string)
        : '',
    })),
  };
}