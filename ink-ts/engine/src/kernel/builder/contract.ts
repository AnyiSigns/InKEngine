/**
 * builder 机制件契约声明：本机构建管线（白名单命令 + 产物内容寻址哈希 +
 * 冒烟门禁）。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——builder 的构建与冒烟
 * 经 ProcessSandbox（白名单命令沙箱）执行 build/smoke 命令：run 命中沙箱
 * 内部注入口把守卫通过的命令交给宿主执行体，属 exec_envelope 端口面（构建
 * 命令进程执行 = 进程信封消费）。产物文件面（resolve/is_dir/read_bytes/
 * copy 等）走注入的 BuildFs 文件执行体 seam，是文件系统 seam 而非 storage
 * seam（builder 不读写 Storage 记录集合，构建全在内存编排 + 沙箱执行），
 * 不列 effects；built_at 经注入 clock 取 epoch 秒（确定性输入，非端口）。
 * 0-IO：不自持 IO，只调声明端口。
 *
 * depends：builder 组合 sandbox（value import ProcessSandbox 执行构建/
 * 冒烟，_path.is_absolute 做产物越界判定）。契约化归属见
 * engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';
import { PORT_EXEC_ENVELOPE } from '../../dock/ports.js';

/** builder 机制契约：依赖 sandbox，消费 exec_envelope 命令执行端口面。 */
export const builder_contract: MechanismContract = {
  id: 'builder',
  contract: {
    effects: [PORT_EXEC_ENVELOPE],
  },
  depends: ['sandbox'],
};
