/**
 * round_steps 机制件契约声明：回合步骤序列累积器（RoundSteps 主类）。
 *
 * 契约面：effects 为空——round_steps 为纯内存、无副作用的累积原语：把回合内
 * 事件发射顺序录制成 step_id 稳定的步骤序列（thinking/工具/节点/组装/回复
 * 分段/用户/记忆命中/审批卡/建议/错误各按类计数），快照落库与传输由宿主
 * 承接（写入 checkpoint 通道/回合完成落库 = 宿主职责），本机制不自持 IO、不
 * 读不写任何存储 seam，不调用模型，不经 exec 信封，也不消费回合端口。
 *
 * depends 为空：round_steps 不直接依赖任何其它机制件（仅消费 core JSON 数据
 * 面与同目录子机制模块）。契约化归属见
 * engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';

/** round_steps 机制契约：零机制间依赖，零副作用端口（纯内存步骤累积数据面）。 */
export const round_steps_contract: MechanismContract = {
  id: 'round_steps',
  contract: {
    effects: [],
  },
  depends: [],
};
