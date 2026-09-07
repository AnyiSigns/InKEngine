/**
 * workspace 桥接组：工作区授权根/挂载清单查询与变更。
 *
 * 目录来源 = 原生目录选择（exec dialog op，见 dialog.ts）或手动路径；
 * 本组只收绝对路径并校验存在。状态持久化在 data_dir/workspace.json。
 */

import { BridgeError, type BridgeHandler } from './_types.js';
import { createEphemeralWorkspaceStore } from '../workspace/store.js';
import type { WorkspaceState, WorkspaceStore } from '../workspace/store.js';

function pathParam(raw: unknown, key: string): string {
  const value =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)[key]
      : undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BridgeError(`workspace 需 ${key}（目录绝对路径）`, 'invalid_params');
  }
  return value.trim();
}

/** workspace 命令声明（方法名唯一真源；装配由 index 聚合此表）。 */
export const WORKSPACE_COMMANDS = [
  'workspace.state',
  'workspace.set',
  'workspace.revoke',
  'workspace.mount.add',
  'workspace.mount.remove',
] as const;

export type WorkspaceCommand = (typeof WORKSPACE_COMMANDS)[number];

/** workspace 域桥接组（state/set/revoke + mount.add/remove；store 缺省内存兜底）。 */
export function buildWorkspaceCommands(storeInput: WorkspaceStore | undefined): Readonly<Record<WorkspaceCommand, BridgeHandler>> {
  const store = storeInput ?? createEphemeralWorkspaceStore();
  const view = (s: WorkspaceState) => ({
    authorized: s.root !== null,
    root: s.root,
    mounts: s.mounts,
  });
  return {
    'workspace.state': () => view(store.state()),
    'workspace.set': (params) => {
      const path = pathParam(params, 'path');
      try {
        return view(store.setRoot(path));
      } catch (err) {
        throw asBridgeError(err);
      }
    },
    'workspace.revoke': () => view(store.revoke()),
    'workspace.mount.add': (params) => {
      const path = pathParam(params, 'path');
      try {
        return view(store.addMount(path));
      } catch (err) {
        throw asBridgeError(err);
      }
    },
    'workspace.mount.remove': (params) => view(store.removeMount(pathParam(params, 'path'))),
  };
}

function asBridgeError(err: unknown): BridgeError {
  if (err instanceof Error && err.name === 'WorkspaceStoreError') {
    return new BridgeError(err.message, 'invalid_params');
  }
  return err instanceof BridgeError ? err : new BridgeError(String(err));
}
