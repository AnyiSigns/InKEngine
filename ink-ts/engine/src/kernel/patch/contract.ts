/**
 * patch 机制件契约声明：内容型补丁链 Event Sourcing 原语。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——PatchChain 的
 * append/replace/delete 应用、assemble/rebase/branch/truncate 与消息压缩
 * 链构造均为纯内存数据结构运算（值深拷贝隔离，组装不改链）；链的受守卫
 * 落库由宿主经 GuardedStorage 接线在演化资产写盘通道上，本机制自身不直接
 * 消费存储 seam，也不触模型/执行/回合端口。on_change 为观察方失效信号
 * 钩子，异常不阻断链演化。
 *
 * depends 为空：patch 不直接依赖任何其它机制件（仅 core json 类型面）。
 * 契约化归属见 engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';

/** patch 机制契约：零机制间依赖，零副作用端口（纯内存链运算）。 */
export const patch_contract: MechanismContract = {
  id: 'patch',
  contract: {
    effects: [],
  },
  depends: [],
};
