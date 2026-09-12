/**
 * 工具执行沙箱（sandbox.py 移植）——文件系统守卫 + 写前快照 + 进程沙箱。
 *
 * 导出面镜像 Python __all__：FileSandbox / FileSnapshot / ProcessResult /
 * ProcessSandbox / snapshot_before；FS_OPERATIONS / FsOperation / FileOps /
 * SpawnHandle / SpawnSeam 为宿主注入面声明，单一真源在 `engine/src/dock/ports/exec.ts`
 * （§3.2 拆分），本桶不重复出口，消费方经端口面取用。
 */

export {
  FileSandbox,
  FileSnapshot,
  snapshot_before,
} from './file_sandbox.js';
export { ProcessResult, ProcessSandbox } from './process_sandbox.js';
