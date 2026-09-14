/**
 * 命令插件共享私有件（非插件：无 spec.json，生成器跳过；同 ports/_shared 先例）。
 * 本文件 = hosts/lib/src/bridge/workspace.ts 原样迁入（S3 命令逻辑下沉，语义零改）。
 *
 * 关键：workspace 五命令共享 per-宿主 store（deps.workspace 缺省时用内存兜底
 * store——set→state 跨命令一致性要求同一 deps 共享同一兜底实例），故按 deps
 * 对象身份 WeakMap 缓存兜底 store。
 */

import { BridgeError } from '@ink-ts/host';
import type { HostBridgeDeps, WorkspaceState, WorkspaceStore } from '@ink-ts/host';
// S4：值随 plugins/domains/workspace（域逻辑唯一实现位）；装配契约类型
// （WorkspaceState/WorkspaceStore）仍从 @ink-ts/host 派生。兜底 store 工厂
// 随域插件同住——改台账语义只改域插件。
import { createEphemeralWorkspaceStore } from '../../domains/workspace/faces/logic/index.js';

export function pathParam(raw: unknown, key: string): string {
  const value =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)[key]
      : undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BridgeError(`workspace 需 ${key}（目录绝对路径）`, 'invalid_params');
  }
  return value.trim();
}

export function asBridgeError(err: unknown): BridgeError {
  if (err instanceof Error && err.name === 'WorkspaceStoreError') {
    return new BridgeError(err.message, 'invalid_params');
  }
  return err instanceof BridgeError ? err : new BridgeError(String(err));
}

export function view(s: WorkspaceState): Record<string, unknown> {
  return {
    authorized: s.root !== null,
    root: s.root,
    mounts: s.mounts,
  };
}

/** 每宿主兜底 store 缓存（deps.workspace 缺省时共享同一实例）。 */
const ephemeralStores = new WeakMap<HostBridgeDeps, WorkspaceStore>();

/** 命令 store 解析：deps.workspace 优先；缺省 = 内存兜底（每 deps 单例）。 */
export function storeFor(deps: HostBridgeDeps): WorkspaceStore {
  if (deps.workspace !== undefined) return deps.workspace;
  const cached = ephemeralStores.get(deps);
  if (cached !== undefined) return cached;
  const made = createEphemeralWorkspaceStore();
  ephemeralStores.set(deps, made);
  return made;
}
