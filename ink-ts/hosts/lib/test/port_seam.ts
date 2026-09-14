// gate: test-exempt - 测试侧端口提供方装配（S2：宿主测试经 loadPortsSeam
// 装载真实 plugins/ports 端口插件，验证装配链；引擎公共面已停供 adapter 符号）
/**
 * 测试侧端口提供方装配 helper：宿主测试经 `loadPortsSeam` 装载 plugins/ports
 * 真源（storage/llm/mcp_client/boot 端口提供方插件），取存储/LLM/引导资产。
 *
 * 用途：S2 前宿主测试直接 `import { create_storage, McpClientManager,
 * BOOT_SYSTEM_PROMPT } from '@ink-ts/engine'`；S2 后引擎公共面移出实现符号，
 * 测试改为装配真实端口提供方插件（与装配层同链，非测试桩）——既验证了
 * 端口装配面（face/loader + manifest ports 段），又保持宿主导航测试对真实
 * 存储/引导资产的依赖。装配失败（插件源缺失/契约不符）= 测试 fail-closed。
 */

import { loadPortsSeam } from '../src/assembly/ports.js';
import type { McpClientPortSeam } from '../src/assembly/ports.js';
import { DEFAULT_BOOT_ASSETS } from '../src/recipe.js';
import type { BootAssets } from '../src/recipe.js';

/** 装载端口 seam（每测试文件一次；返回真源装载面，消耗方按需取用）。 */
export async function loadTestPorts(): Promise<Awaited<ReturnType<typeof loadPortsSeam>>> {
  return await loadPortsSeam(null);
}

/** 测试侧 MCP 客户端 seam（真实 plugins/ports/mcp_client；factory → 实例）。 */
export async function loadTestMcpSeam(): Promise<McpClientPortSeam> {
  const ports = await loadTestPorts();
  if (ports.mcpClient === null) {
    throw new Error('测试需要 mcp_client 端口提供方（plugins/ports/mcp_client）未装配（manifest 缺插件）');
  }
  return ports.mcpClient;
}

/** 测试侧 MCP 管理器（真实 mcp_client 插件类；注入假 _sdk_open 会话打开器）。 */
export async function newTestMcpManager(
  opener: unknown,
): Promise<import('../src/assembly/ports.js').McpClientManagerLike> {
  const seam = await loadTestMcpSeam();
  const manager = new seam.McpClientManager();
  (manager as unknown as { _sdk_open: unknown })._sdk_open = opener;
  return manager as import('../src/assembly/ports.js').McpClientManagerLike;
}

/** 测试侧存储工厂（真实 plugins/ports/storage；S2 前 = @ink-ts/engine.create_storage 同槽）。 */
export async function loadTestStorage(): Promise<
  (connString: string) => Promise<import('@ink-ts/engine').Storage>
> {
  const ports = await loadTestPorts();
  const storageSeam = ports.storage;
  if (storageSeam === null) {
    throw new Error('测试需要 storage 端口提供方（plugins/ports/storage）未装配（manifest 缺插件）');
  }
  return async (connString: string) => storageSeam.create_storage(connString);
}

/** boot 引导资产（S2 后引擎公共面无 BOOT_*；配方/测试经此取 plugins/ports/boot 真源）。 */
export async function loadTestBootAssets(): Promise<BootAssets> {
  const ports = await loadTestPorts();
  const boot = ports.boot;
  if (boot === null) {
    throw new Error('测试需要 boot 端口提供方（plugins/ports/boot）未装配（manifest 缺插件）');
  }
  return boot as unknown as BootAssets;
}

/** 缺省 boot 资产（recipe 模块内建结束；测试注记「真源 = plugins/ports/boot」）。 */
export function defaultTestBootAssets(): BootAssets {
  return DEFAULT_BOOT_ASSETS;
}