/**
 * exec 端口面（计划 §3.2 sandbox [拆分]）：文件/进程执行 seam 与操作域声明。
 *
 * 本面只承载宿主注入声明（类型 + 纯数据枚举），不含任何守卫/执行实现——
 * FileSandbox/ProcessSandbox 机制件在 `engine/src/gate/sandbox/`，构造时消费
 * 本面接口（FileSnapshot.restore / ProcessSandbox.run 的 fs/spawn 动作一律经
 * 注入执行体，引擎内核零 IO）。真实 spawn / fs 实现由宿主端口装填。
 */

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

/** 受限子进程句柄 seam（asyncio.subprocess.Process 的消费面镜像）。 */
export interface SpawnHandle {
  readonly exit_code: number | null;
  communicate(): Promise<{ stdout: Uint8Array; stderr: Uint8Array }>;
  kill(): void;
}

/** 进程执行体 seam（create_subprocess_exec 镜像；真实 spawn 由宿主注入）。
 *  执行对象 = 校验对象：run 只把守卫通过的 command/args 交给 seam。 */
export interface SpawnSeam {
  spawn(
    command: string,
    args: readonly string[],
    options: { cwd: string | null; env: Readonly<Record<string, string>> },
  ): Promise<SpawnHandle>;
}

/**
 * 进程沙箱消费面（P7-2 动作 C2）：graph/builder 只用「白名单查询 →
 * 派生副本 → 执行」三位；gate/sandbox 的 ProcessSandbox 以结构化满足本
 * 接口（形状兼容由 tsc 把关，类型位替换、运行零变），builder 不再直引
 * 机制类。
 */
export interface ProcessSandboxLike {
  /** 命令白名单（构建/冒烟执行前查许可）。 */
  readonly allowlist: readonly string[];
  /** 派生副本（覆盖 cwd/timeout，副本语义收在机制类）。 */
  derived(options?: { cwd?: string | null; timeout?: number }): ProcessSandboxLike;
  /** 守卫后执行（返回结果消费面：退出码/输出流/超时标记）。 */
  run(
    command: string,
    args?: readonly string[],
  ): Promise<{
    readonly exit_code: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly timed_out: boolean;
  }>;
}

/**
 * 文件系统 seam：os/shutil/tempfile 动作的注入面（核心零 IO）。真实实现由
 * 宿主注入（node:fs 后端）；本模块只按这些原语表达拷贝/快照/diff 机制。
 * 路径一律以字符串表达；mkdtemp/rmtree/copy2/symlink_to 对齐对应 stdlib 语义。
 */
export interface FsSeam {
  /** tempfile.mkdtemp(prefix)：建唯一临时目录，返回其路径。 */
  mkdtemp(prefix: string): string;
  /** shutil.rmtree(path, ignore_errors)：整树删除；ignore_errors=true 吞错。 */
  rmtree(path: string, ignore_errors: boolean): void;
  /** path.is_dir()。 */
  is_dir(path: string): boolean;
  /** path.is_file()。 */
  is_file(path: string): boolean;
  /** entry.is_symlink()。 */
  is_symlink(path: string): boolean;
  /** os.readlink(path)：读符号链接指向。 */
  readlink(path: string): string;
  /** shutil.copy2(source, target)：拷贝文件并保留元数据。 */
  copy2(source: string, target: string): void;
  /** target 处建符号链接指向 link_target（对齐 symlink_to）。 */
  symlink_to(link_target: string, link_path: string): void;
  /** Path.mkdir(parents=True, exist_ok=True)：含父目录的目录创建。 */
  mkdir(path: string): void;
  /** path.iterdir()：直接子项完整路径清单。 */
  iterdir(path: string): string[];
  /** path.rglob('*')：全部递归后代完整路径清单。 */
  rglob(path: string): string[];
  /** stat().st_size：文件字节数；失败（OSError）返回 null（快照跳过）。 */
  stat_size(path: string): number | null;
}
