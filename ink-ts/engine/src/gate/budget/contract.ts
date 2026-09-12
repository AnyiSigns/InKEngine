/**
 * budget 机制件契约声明：执行预算检查的注册表 + fail-closed 终止式检查。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——budget 为纯内存的
 * 策略注册表：策略对象由业务/宿主注册，引擎在节点边界调用 check 终止式
 * 检查与 query_remaining 只读预检，超限抛 BudgetExceededError 收口终止。
 * 策略的判定输入（ctx）为调用方透传的运行态形状，本机制自身不消费存储/
 * 模型/执行/回合端口，也不自持 IO——预算维度的读取与计数在策略实现与
 * 引擎检查点接线侧，不在本机制。
 *
 * depends 为空：budget 不直接依赖任何其它机制件（策略经注册注入，判定
 * 语义 fail-closed 内置本模块）。契约化归属见
 * engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../../dock/registry/contract_types.js';

/** budget 机制契约：零机制间依赖，零副作用端口（策略经注入注册）。 */
export const budget_contract: MechanismContract = {
  id: 'budget',
  contract: {
    effects: [],
  },
  depends: [],
};
