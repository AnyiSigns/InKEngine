/**
 * tuning 机制件契约声明（自适应调优）。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——tuning 本体为零端口
 * 消费（effects 为空）：回合指标聚合与调参（反馈降权/重试预算/web 验证
 * 阈值）是确定性纯计算；参数变更过 L2 效果评估回归经注入的 KnowledgeGate
 * 组合（默认以 ParamRegressionExecutor 为执行器，边界校验不调 LLM 端口）；
 * 调参结果经知识集域 API 回写条目（kind=weight，幂等不覆盖演化）、参数
 * 快照经注入落库回调交给存储侧——均不是本机制直持存储端口。
 *
 * depends：tuning 组合复用 knowledge_gate（L2 参数回归闸门）。契约化归属
 * 见 engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';

/** 调参机制契约：依赖 knowledge_gate，effects 为空（零端口）。 */
export const tuning_contract: MechanismContract = {
  id: 'tuning',
  contract: {
    effects: [],
  },
  depends: ['knowledge_gate'],
};
