/**
 * tool_vetting 机制件契约声明：工具可信度闸门（清单校验 → 静态审查 → 判定，
 * 附影子运行观察模式）。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——tool_vetting 的清单
 * 校验与静态审查为纯判定（权限声明经 parse_permission 逐项解析，非法即拒绝；
 * 哈希声明逐项 hex/长度校验）；影子运行的工作区副本、快照 diff 与写虚拟化
 * 经注入的 FsSeam 执行（文件系统 seam，非 storage seam——不读写 Storage
 * 记录集合），观察执行体为注入的 ShadowExecutor 钩子（回调执行，非进程
 * spawn 信封面），本机制 src 不消费模型与回合端口。0-IO：不自持 IO。故
 * effects 为空。
 *
 * depends：tool_vetting 组合 permissions（parse_permission 权限声明解析）。
 * 契约化归属见 engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';

/** tool_vetting 机制契约：依赖 permissions，零副作用端口（可信度判定）。 */
export const tool_vetting_contract: MechanismContract = {
  id: 'tool_vetting',
  contract: {
    effects: [],
  },
  depends: ['permissions'],
};
