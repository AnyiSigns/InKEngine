/**
 * 工作区授权存储（host 本地持久化）。
 *
 * 授权根/挂载目录清单落 data_dir/workspace.json：单授权根（root，可为空）
 * + 额外挂载目录集合（mounts）。目录须为绝对路径且存在（授权前校验）。
 *
 * 信任模型 = 「纯授权台账 + 调用方自述」：workspace.json 只记录用户显式
 * 授权的工作区根/挂载清单（台账），本身不参与 os.run/doc 的工具执行裁决。
 * os.run/doc 请求中的 roots/allowlist 由请求方参数自述（随请求现取），宿主
 * 裁决面门（exec/envelope gateCoverage：越权命令/越根路径）做 fail-closed
 * 信封校验，不与 workspace.json 强制求交——工具执行面需要哪些根由调用侧
 * 按需声明并受信封校验约束；workspace 台账是授权根的用户可查记录与后续
 * 装配（如需给工具执行提供根集合）的数据源，不是裁决真源。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export interface WorkspaceState {
  root: string | null;
  mounts: string[];
}

export interface WorkspaceStore {
  state(): WorkspaceState;
  setRoot(path: string): WorkspaceState;
  revoke(): WorkspaceState;
  addMount(path: string): WorkspaceState;
  removeMount(path: string): WorkspaceState;
  /** 从磁盘重读缓存（data_dir 目录恢复后刷新为恢复态台账）。 */
  reload(): void;
}

export class WorkspaceStoreError extends Error {
  readonly code: string;
  constructor(message: string, code = 'workspace_error') {
    super(message);
    this.name = 'WorkspaceStoreError';
    this.code = code;
  }
}

/** 非持久化内存形态（测试/最小装配兜底；语义与持久化形态一致）。 */
export function createEphemeralWorkspaceStore(): WorkspaceStore {
  let root: string | null = null;
  let mounts: string[] = [];
  return {
    state: () => ({ root, mounts }),
    setRoot: (path: string) => {
      const abs = normalizeDir(path, '工作区根目录');
      if (mounts.includes(abs)) {
        throw new WorkspaceStoreError(`目录已在挂载清单，不能作根: ${abs}`, 'invalid_params');
      }
      root = abs;
      return { root, mounts };
    },
    revoke: () => {
      root = null;
      return { root, mounts };
    },
    addMount: (path: string) => {
      const abs = normalizeDir(path, '挂载目录');
      if (abs === root) {
        throw new WorkspaceStoreError(`目录已是授权根: ${abs}`, 'invalid_params');
      }
      if (!mounts.includes(abs)) mounts = [...mounts, abs];
      return { root, mounts };
    },
    removeMount: (path: string) => {
      mounts = mounts.filter((entry) => entry !== path);
      return { root, mounts };
    },
    reload: () => {
      // 内存兜底形态无磁盘真源：保持当前状态
    },
  };
}

function normalizeDir(raw: string, where: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new WorkspaceStoreError(`${where} 期望目录路径`, 'invalid_params');
  }
  const abs = isAbsolute(raw.trim()) ? raw.trim() : resolve(raw.trim());
  if (!existsSync(abs)) {
    throw new WorkspaceStoreError(`${where} 目录不存在: ${abs}`, 'invalid_params');
  }
  return abs;
}

export function createWorkspaceStore(dataDir: string): WorkspaceStore {
  mkdirSync(dataDir, { recursive: true });
  const file = resolve(dataDir, 'workspace.json');

  function readState(): WorkspaceState {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<WorkspaceState>;
      const root = typeof raw.root === 'string' && raw.root !== '' ? raw.root : null;
      const mounts = Array.isArray(raw.mounts)
        ? raw.mounts.filter((entry): entry is string => typeof entry === 'string')
        : [];
      return { root, mounts };
    } catch {
      return { root: null, mounts: [] };
    }
  }

  let cached = readState();

  function persist(next: WorkspaceState): WorkspaceState {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    renameSync(tmp, file);
    cached = next;
    return next;
  }

  return {
    state: (): WorkspaceState => cached,
    setRoot: (path: string): WorkspaceState => {
      const abs = normalizeDir(path, '工作区根目录');
      if (cached.mounts.includes(abs)) {
        throw new WorkspaceStoreError(`目录已在挂载清单，不能作根: ${abs}`, 'invalid_params');
      }
      return persist({ ...cached, root: abs });
    },
    revoke: (): WorkspaceState => persist({ ...cached, root: null }),
    addMount: (path: string): WorkspaceState => {
      const abs = normalizeDir(path, '挂载目录');
      if (abs === cached.root) {
        throw new WorkspaceStoreError(`目录已是授权根: ${abs}`, 'invalid_params');
      }
      if (cached.mounts.includes(abs)) return cached;
      return persist({ ...cached, mounts: [...cached.mounts, abs] });
    },
    removeMount: (path: string): WorkspaceState => {
      const mounts = cached.mounts.filter((entry) => entry !== path);
      if (mounts.length === cached.mounts.length) return cached;
      return persist({ ...cached, mounts });
    },
    reload: (): void => {
      cached = readState();
    },
  };
}
