/**
 * 工具执行沙箱（sandbox.py 移植）——文件系统守卫 + 写前快照 + 进程沙箱。
 *
 * 导出面镜像 Python __all__：FS_OPERATIONS / FileSandbox / FileSnapshot /
 * ProcessResult / ProcessSandbox / snapshot_before；FileOps / SpawnSeam 为
 * 宿主注入面（core 零 IO，fs/进程执行体一律由宿主经 seam 提供）。
 */

export {
  FS_OPERATIONS,
  FileSandbox,
  FileSnapshot,
  snapshot_before,
} from './file_sandbox.js';
export type { FileOps, FsOperation } from './file_sandbox.js';
export { ProcessResult, ProcessSandbox } from './process_sandbox.js';
export type { SpawnHandle, SpawnSeam } from './process_sandbox.js';
