/**
 * 命令插件共享私有件（非插件：无 spec.json，生成器跳过；同 ports/_shared 先例）。
 * 本文件 = hosts/lib/src/bridge/mcp.ts 原样迁入（S3 命令逻辑下沉，语义零改）：
 * mcp.status/enable/disable/install/remove 五命令共享服务守卫/参数抽取。
 */

import { BridgeError } from '@ink-ts/host';
import type { HostBridgeDeps } from '@ink-ts/host';

/** 服务缺省（plugins 源不可用 = mcp.* 域不可用）。 */
export function serviceOrThrow(deps: HostBridgeDeps) {
  if (deps.mcpPlugins === null || deps.mcpPlugins === undefined) {
    throw new BridgeError(
      'MCP 插件服务未装配（plugins 源不可用；serve 需 --seed-dir）',
      'runtime_unavailable',
    );
  }
  return deps.mcpPlugins;
}

export function stringParam(raw: unknown, keys: readonly string[]): string | null {
  const params = raw as Record<string, unknown> | null;
  if (params === null || typeof params !== 'object') return null;
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}
