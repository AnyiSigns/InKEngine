/**
 * 代码族验证沙箱的接口占位（E.2 纪律）。
 *
 * 沙箱的真实职责是子进程 + 墙钟超时 + 独立临时工作区：把被测代码与测试分别写入
 * 临时目录，再以子进程执行测试并取真实返回码，超时即判失败；资源硬限
 * （CPU/内存/文件大小 rlimit）仅 POSIX 可用，Windows 以墙钟超时兜底，绝不假装
 * 有内存硬限。世界当前没有代码族算子（B.2 无 code 节点），沙箱属于后续扩展资产，
 * 故这里只冻结签名与契约注释，调用即抛错，避免出现"看似可用实则无隔离"的假实现。
 */

export interface SandboxResult {
  readonly ok: boolean;
  readonly output: string;
}

export async function runSandboxed(
  _code: string,
  _tests: string,
  _timeoutS = 10,
): Promise<SandboxResult> {
  throw new Error('代码族验证未启用：沙箱为后续扩展资产的接口占位，当前世界无代码族节点');
}
