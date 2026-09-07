/**
 * approval 机制件契约声明：工具调用前挂卡审批的标准辅助姿势。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——approval 主体是
 * 决议注入值/超时窗口的纯解析与 gate 卡构造（core/review_card），挂起/重入
 * 经节点上下文成员消费引擎 interrupt 原语（ApprovalInterruptContext 鸭子
 * 类型：ctx.interrupt / ctx.get_interrupt_payload），不落在本注册表 effects
 * 端口面内（interrupt 原语是节点 ctx 契约，非可注入的存储/模型/执行端口）。
 * 超时判定依赖注入 clock（确定性输入，非端口）。0-IO：不自持 IO，只按
 * 决议语义返回 accept/edit/reject/terminate/auto。
 *
 * depends 为空：approval 不直接依赖任何其它机制件模块（review_card 属
 * core；interrupt 语义经 ctx 成员消费，非模块级 import）。契约化归属见
 * engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';

/** approval 机制契约：零机制间依赖，零副作用端口（interrupt 经 ctx seam）。 */
export const approval_contract: MechanismContract = {
  id: 'approval',
  contract: {
    effects: [],
  },
  depends: [],
};
