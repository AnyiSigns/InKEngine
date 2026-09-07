/**
 * simulation 机制件契约声明（决策点推演原语的数据面）。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——本机制承载推演清单
 * 的解析校验、分支规格/评估/调配结果的数据形态与择优调配策略：评估协议为
 * 注入回调（Evaluator/维度评分器），调配策略在纯内存数据上运算，跨分支
 * 组装复用 patch 机制的 PatchChain 纯内存链运算（无存储落点）；分支的独立
 * 子链执行由 executor 承接（本机制不启动进程、不落 checkpoint 记录），
 * 无模型调用（不列 llm_port）。0-IO：不自持 IO，故 effects 为空。
 *
 * depends：simulation 组合 patch（PatchChain 补丁链原语，跨分支组装与
 * 留痕的数据面复用）。契约化归属见
 * engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';

/** simulation 机制契约：依赖 patch，effects 为空（纯进程内数据面 + 链运算）。 */
export const simulation_contract: MechanismContract = {
  id: 'simulation',
  contract: {
    effects: [],
  },
  depends: ['patch'],
};
