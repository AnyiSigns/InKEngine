/**
 * sandbox 机制件契约声明：工具执行沙箱（文件系统守卫 + 写前快照 + 进程沙箱）。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——sandbox 自身即进程/
 * 文件沙箱 seam：ProcessSandbox.run 守卫通过后把 command/args 交给注入的
 * SpawnSeam（create_subprocess_exec 镜像，真实 spawn 由宿主实现），属
 * exec_envelope 端口面（进程信封消费）。FileSandbox 的前缀 resolve 校验与
 * symlink 逃逸检测、写前快照均为纯守卫运算（fs 动作经注入的 FileOps seam，
 * 是文件系统执行 seam 而非 storage seam），不列 effects；守卫失败以 core
 * SandboxViolation 表达（判定结果，非执行信封）。0-IO：不自持 IO，只调
 * 声明端口。
 *
 * depends：sandbox 引用 tool_pipeline 的共享常量
 * （DEFAULT_MAX_RESULT_CHARS，输出截断与工具结果文本同源同量级）。
 * 契约化归属见 engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';
import { PORT_EXEC_ENVELOPE } from '../registry/ports.js';

/** sandbox 机制契约：依赖 tool_pipeline，消费 exec_envelope 进程信封端口面。 */
export const sandbox_contract: MechanismContract = {
  id: 'sandbox',
  contract: {
    effects: [PORT_EXEC_ENVELOPE],
  },
  depends: ['tool_pipeline'],
};
