/**
 * 文件系统沙箱 + 写前快照（sandbox.py 的 FileSandbox / FileSnapshot /
 * snapshot_before 移植）。
 *
 * FileSandbox：根目录前缀 + resolve 校验 + symlink 逃逸检测（read/write/
 * delete/edit/search/search_paths 六类守卫，edit = 就地改写与 write 同属
 * 写守卫但作为一等操作域存在，权限/审计可与 write 区分）。resolve 返回
 * 解析后的绝对路径——调用方执行读写删除用解析结果，防二次拼接引入逃逸。
 * guards_operation/validate 语义与 tool_pipeline 的 SandboxSeam 鸭子类型
 * 吻合，是多端点流水线各司其职的依据。
 *
 * symlink 跟随 seam：Python 的 Path.resolve 会跟随已存在祖先的 symlink
 * （fs 动作，需 lstat/readlink），core 零 IO 无法内置——FileSandbox 构造
 * 接受可选 realpath（宿主 fs 实现，如 realpathSync.native）；缺省恒等 =
 * 纯词法解析。生产宿主必须注入 fs 版 realpath，否则 symlink 逃逸检测不
 * 生效（沙箱是机制、非安全边界承诺——默认拒绝兜底 + 纵深防御）。
 *
 * FileSnapshot/snapshot_before：写/删前快照（旧内容 + 存在性，可还原），
 * 事务性文件写入的机制底座。exists/is_file/read_bytes/mkdir/write_bytes/
 * unlink 等 fs 动作全部走 FileOps seam（宿主注入真实实现），快照数据形态
 * 与还原编排留在本模块（1:1 移植）；未注入 seam 时还原抛错提示
 * （fail-closed，不静默、不伪造快照数据）。
 */

import { SandboxViolation } from '../errors.js';
import { is_absolute, lexical_abs, path_under } from './_path.js';

/** FileSandbox 支持的操作（四类守卫 + 两类只读检索）。 */
export const FS_OPERATIONS = [
  'read',
  'write',
  'delete',
  'edit',
  'search',
  'search_paths',
] as const;

/** FS 操作域联合类型（声明式端点清单与守卫共用的判定口径）。 */
export type FsOperation = (typeof FS_OPERATIONS)[number];

const FS_OPS_SET = new Set<string>(FS_OPERATIONS);

/** 文件执行体 seam（宿主 fs 实现；Python Path 方法的一一映射面）。 */
export interface FileOps {
  exists(path: string): boolean;
  is_file(path: string): boolean;
  read_bytes(path: string): Uint8Array;
  /** mkdir(parents=True, exist_ok=True) 的镜像：还原前建父目录。 */
  mkdir_parents(path: string): void;
  write_bytes(path: string, data: Uint8Array): void;
  /** unlink(missing_ok=True) 的镜像：原不存在时还原即删除（幂等）。 */
  unlink(path: string): void;
}

/**
 * 文件系统沙箱：根目录前缀 + resolve 校验 + symlink 逃逸检测。
 *
 * validate(operation, target) 返回解析后的绝对路径；root 接受绝对路径串
 * （相对 root 无 cwd 可依，按词法以 '/' 为基准——core 零 IO 的边界，
 * 宿主配置沙箱时一律给绝对根目录）。
 */
export class FileSandbox {
  readonly root: string;
  readonly realpath: (path: string) => string;
  private readonly _root_abs: string;

  constructor(root: string, realpath?: (path: string) => string) {
    this.root = root;
    this.realpath = realpath ?? ((p) => p);
    this._root_abs = is_absolute(root) ? lexical_abs(root, root) : lexical_abs('/', root);
  }

  /** 是否本沙箱守卫的操作域（多端点流水线各司其职的依据）。 */
  guards_operation(operation: string): boolean {
    return FS_OPS_SET.has(operation);
  }

  /**
   * 路径解析：绝对化 → 词法归一 →（realpath seam）→ 前缀校验。
   *
   * symlink 逃逸检测 = resolve 后仍须落在根目录内（指向外部的链接经
   * realpath 越界即拒绝）。不存在的路径按词法解析（realpath seam 负责对
   * 已存在祖先的链接跟随，见模块头注）。
   */
  resolve(path: string): string {
    const resolved = this.realpath(lexical_abs(this._root_abs, path));
    if (!path_under(this.realpath(this._root_abs), resolved)) {
      throw new SandboxViolation(`路径越界: ${path}`);
    }
    return resolved;
  }

  validate(operation: string, target: string): string {
    if (!FS_OPS_SET.has(operation)) {
      throw new SandboxViolation(`不支持的 fs 操作: ${operation}`);
    }
    return this.resolve(target);
  }
}

/**
 * 写/删前快照（旧内容 + 存在性，可还原）。数据形态与 Python 的 frozen
 * dataclass 一致；restore 的 fs 动作经 FileOps seam 执行。
 */
export class FileSnapshot {
  readonly path: string;
  readonly existed: boolean;
  readonly content: Uint8Array | null;
  readonly ops: FileOps | null;

  constructor(
    path: string,
    existed: boolean,
    content: Uint8Array | null,
    ops: FileOps | null = null,
  ) {
    this.path = path;
    this.existed = existed;
    this.content = content;
    this.ops = ops;
  }

  /**
   * 还原：原存在恢复旧内容，原不存在删除（幂等）。未注入 FileOps 时抛错
   * 提示（core 零 IO，不能静默跳过还原）。
   */
  restore(): void {
    const ops = this.ops;
    if (ops === null) {
      throw new Error('快照还原需要宿主文件执行体（FileOps 未注入）');
    }
    if (this.existed) {
      ops.mkdir_parents(this.path);
      ops.write_bytes(this.path, this.content ?? new Uint8Array(0));
    } else {
      ops.unlink(this.path);
    }
  }
}

/** 写/删前快照：记录旧内容与存在性（宿主挂工具流水线写前调用）。 */
export function snapshot_before(path: string, ops: FileOps): FileSnapshot {
  if (ops.exists(path) && ops.is_file(path)) {
    return new FileSnapshot(path, true, ops.read_bytes(path), ops);
  }
  return new FileSnapshot(path, false, null, ops);
}
