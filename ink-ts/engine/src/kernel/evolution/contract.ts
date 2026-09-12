/**
 * evolution 机制件契约声明（离线变异-择优工厂）。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——evolution 本体为
 * 纯计算（零端口，effects 为空）：失败率优先入队、反思式变异、逐变体过
 * 三层闸门、保留不退化者全部是进程内数据操作。闸门与变异策略以结构 seam
 * 注入（EvolutionGate 鸭子形态，真实 KnowledgeGate 结构上满足）；变异无
 * LLM 默认实现，不落库、不执行外部进程，产物交使用方经写入管线落位。
 *
 * depends 为空：evolution 不直接依赖任何其它机制件（失败日志/条目由使用
 * 方驱动提供；闸门 seam 由调用方注入）。契约化归属见
 * engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../../dock/registry/contract_types.js';

/** 进化工厂机制契约：零机制间依赖，effects 为空（纯计算无端口）。 */
export const evolution_contract: MechanismContract = {
  id: 'evolution',
  contract: {
    effects: [],
  },
  depends: [],
};
